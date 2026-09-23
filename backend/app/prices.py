"""Live quote feed.

The ONLY networked piece of the trading stack, deliberately separate from
broker.py: the broker never fetches anything, it is handed prices by its caller.
That is what lets the broker keep its no-network guarantee while fills stop
being hand-typed.

Two keyless sources, chosen because they answer Python:
  * equities  -> api.nasdaq.com (covers NASDAQ and NYSE)
  * crypto    -> api.coingecko.com

Yahoo's endpoint is not used despite being the obvious choice: it serves curl
fine but answers Python's TLS handshake with 429 no matter what headers are
sent, so it fails only once packaged, which is the worst time to find out.

Prices are integer cents — nothing downstream ever sees a float.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Dict, List

EQUITY_URL = "https://api.nasdaq.com/api/quote/{symbol}/info?assetclass={assetclass}"
EQUITY_CHART_URL = "https://api.nasdaq.com/api/quote/{symbol}/chart?assetclass={assetclass}"
EQUITY_SEARCH_URL = "https://api.nasdaq.com/api/autocomplete/slookup/10?search={query}"
EQUITY_HISTORY_URL = (
    "https://api.nasdaq.com/api/quote/{symbol}/historical?assetclass={assetclass}"
    "&fromdate={from_date}&todate={to_date}&limit=5000"
)
# Nasdaq keys every endpoint by asset class — SPY is an etf, not a stock.
ASSET_CLASSES = ("stocks", "etf", "index")
CRYPTO_URL = "https://api.coingecko.com/api/v3/simple/price?ids={ids}&vs_currencies=usd&include_last_updated_at=true"
CRYPTO_CHART_URL = "https://api.bybit.com/v5/market/kline?category=spot&symbol={pair}&interval=1&limit=240"
CRYPTO_TICKERS_URL = "https://api.bybit.com/v5/market/tickers?category=spot"
CRYPTO_KLINE_URL = "https://api.bybit.com/v5/market/kline?category=spot&symbol={pair}&interval={interval}&limit={limit}"
CRYPTO_TICKER_URL = "https://api.bybit.com/v5/market/tickers?category=spot&symbol={pair}"
# Chart range -> (Bybit interval, bars, cache seconds).
CHART_RANGES = {"1D": ("5", 288, 30), "5D": ("30", 240, 60), "1M": ("240", 186, 300),
                "6M": ("D", 183, 900), "1Y": ("D", 365, 900), "MAX": ("W", 1000, 3600)}
CRYPTO_HOURLY_URL = "https://api.bybit.com/v5/market/kline?category=spot&symbol={pair}&interval=60&limit=300"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36"

DEFAULT_TTL_SECONDS = 30
INTRADAY_TTL_SECONDS = 8
# A replayed chart is a placeholder, not a price — past this it is just wrong.
REPLAY_MAX_AGE_SECONDS = 900
REQUEST_TIMEOUT = 8
# Retrying into a rate limit just extends it; stop calling out until it clears.
RATE_LIMIT_COOLDOWN = 90

# Majors only. Anything not listed is looked up as an equity.
CRYPTO_IDS = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "XRP": "ripple",
    "ADA": "cardano", "DOGE": "dogecoin", "LTC": "litecoin", "DOT": "polkadot",
    "LINK": "chainlink", "AVAX": "avalanche-2", "MATIC": "matic-network",
    "TRX": "tron", "BCH": "bitcoin-cash", "XLM": "stellar", "ATOM": "cosmos",
}

DEFAULT_ASSETS = [
    {"symbol": "BAC", "name": "Bank of America", "exchange": "NYSE", "asset_class": "equity"},
    {"symbol": "AAPL", "name": "Apple", "exchange": "NASDAQ", "asset_class": "equity"},
    {"symbol": "MSFT", "name": "Microsoft", "exchange": "NASDAQ", "asset_class": "equity"},
    {"symbol": "NVDA", "name": "NVIDIA", "exchange": "NASDAQ", "asset_class": "equity"},
    {"symbol": "SPY", "name": "SPDR S&P 500 ETF", "exchange": "NYSE ARCA", "asset_class": "equity",
     "nasdaq_class": "etf"},
    {"symbol": "BTC-USD", "name": "Bitcoin", "exchange": "Bybit spot", "asset_class": "crypto"},
    {"symbol": "ETH-USD", "name": "Ethereum", "exchange": "Bybit spot", "asset_class": "crypto"},
    {"symbol": "SOL-USD", "name": "Solana", "exchange": "Bybit spot", "asset_class": "crypto"},
]


class QuoteUnavailable(RuntimeError):
    """No usable price — unknown symbol, or the feed is unreachable."""


def _http_get_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def crypto_id(symbol: str):
    """BTC, BTC-USD and BTCUSD all mean bitcoin."""
    base = (symbol or "").strip().upper()
    for suffix in ("-USD", "/USD", "USD"):
        if base.endswith(suffix) and len(base) > len(suffix):
            base = base[: -len(suffix)]
            break
    return CRYPTO_IDS.get(base)


def _to_cents(value) -> int:
    text = str(value).replace("$", "").replace(",", "").strip()
    if not text:
        raise QuoteUnavailable("empty price")
    try:
        return int((Decimal(text) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except InvalidOperation as exc:
        raise QuoteUnavailable(f"invalid price: {text}") from exc


def _to_optional_cents(value) -> int:
    try:
        return _to_cents(value or 0)
    except QuoteUnavailable:
        return 0


def _to_bps(value) -> int:
    text = str(value or "0").replace("%", "").replace(",", "").strip()
    try:
        return int((Decimal(text) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except InvalidOperation:
        return 0


class QuoteFeed:
    """Cached quote lookups. The fetcher is injectable so tests never hit the
    network — a suite that needs the internet is a suite that fails offline."""

    def __init__(self, ttl_seconds: int = DEFAULT_TTL_SECONDS, fetcher=None):
        self._ttl = int(ttl_seconds)
        self._fetch = fetcher or _http_get_json
        self._cache: Dict[str, dict] = {}
        self._intraday_cache: Dict[str, dict] = {}
        self._search_cache: Dict[str, dict] = {}
        # Seeded so a known ETF never pays for a wrong-class miss first.
        self._asset_class: Dict[str, str] = {
            asset["symbol"]: asset["nasdaq_class"]
            for asset in DEFAULT_ASSETS if asset.get("nasdaq_class")
        }
        self._blocked_until = 0.0
        self._lock = threading.RLock()

    def _fetch_nasdaq(self, template: str, symbol: str, **fields) -> dict:
        """Nasdaq rejects a symbol under the wrong asset class, so try the
        classes in turn and remember the one that answered."""
        with self._lock:
            known = self._asset_class.get(symbol)
        order = [known] + [c for c in ASSET_CLASSES if c != known] if known else list(ASSET_CLASSES)
        last: dict = {}
        for asset_class in order:
            payload = self._fetch(template.format(
                symbol=urllib.parse.quote(symbol), assetclass=asset_class, **fields)) or {}
            if int((payload.get("status") or {}).get("rCode") or 0) == 200:
                with self._lock:
                    self._asset_class[symbol] = asset_class
                return payload
            last = payload
        return last

    def _fetch_crypto(self, symbol: str, coin: str) -> dict:
        payload = self._fetch(CRYPTO_URL.format(ids=urllib.parse.quote(coin))) or {}
        row = payload.get(coin) or {}
        if row.get("usd") is None:
            raise QuoteUnavailable(f"{symbol}: no price returned")
        return {
            "symbol": symbol,
            "price_cents": _to_cents(row["usd"]),
            "currency": "USD",
            "asset_class": "crypto",
            "source": "coingecko",
            "fetched_at": _now_iso(),
        }

    def _fetch_equity(self, symbol: str) -> dict:
        payload = self._fetch_nasdaq(EQUITY_URL, symbol)
        status = payload.get("status") or {}
        if int(status.get("rCode") or 0) != 200:
            messages = status.get("bCodeMessage") or []
            detail = messages[0].get("errorMessage") if messages else "not found"
            raise QuoteUnavailable(f"{symbol}: {detail}")
        data = payload.get("data") or {}
        primary = data.get("primaryData") or {}
        if not primary.get("lastSalePrice"):
            raise QuoteUnavailable(f"{symbol}: no price returned")
        return {
            "symbol": symbol,
            "price_cents": _to_cents(primary["lastSalePrice"]),
            "currency": "USD",
            "asset_class": "equity",
            "source": "nasdaq",
            "as_of": primary.get("lastTradeTimestamp") or "",
            "market_status": data.get("marketStatus") or "Unknown",
            "is_realtime": bool(primary.get("isRealTime")),
            "net_change_cents": _to_optional_cents(primary.get("netChange")),
            "percentage_change_bps": _to_bps(primary.get("percentageChange")),
            "delta": primary.get("deltaIndicator") or "unchanged",
            "fetched_at": _now_iso(),
        }

    def quote(self, symbol: str, allow_stale: bool = True) -> dict:
        symbol = (symbol or "").strip().upper()
        if not symbol:
            raise QuoteUnavailable("symbol is required")
        with self._lock:
            cached = self._cache.get(symbol)
            if cached and (time.time() - cached["_at"]) < self._ttl:
                return dict(cached["quote"])
            if time.time() < self._blocked_until:
                if cached and allow_stale:
                    stale = dict(cached["quote"])
                    stale["stale"] = True
                    return stale
                raise QuoteUnavailable(f"{symbol}: quote feed rate-limited, retry shortly")
        coin = crypto_id(symbol)
        try:
            parsed = self._fetch_crypto(symbol, coin) if coin else self._fetch_equity(symbol)
        except QuoteUnavailable:
            raise
        except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError) as exc:
            # A stale price beats blanking the dashboard mid-session, but it must
            # be labelled so nothing records it as a fresh mark.
            with self._lock:
                if getattr(exc, "code", None) == 429:
                    self._blocked_until = time.time() + RATE_LIMIT_COOLDOWN
                cached = self._cache.get(symbol)
            if cached and allow_stale:
                stale = dict(cached["quote"])
                stale["stale"] = True
                return stale
            raise QuoteUnavailable(f"{symbol}: {exc}")
        with self._lock:
            self._cache[symbol] = {"_at": time.time(), "quote": parsed}
        return dict(parsed)

    def quotes(self, symbols: List[str], allow_stale: bool = True) -> dict:
        """Never raises for a partial failure — returns what it got plus why."""
        found: Dict[str, dict] = {}
        errors: Dict[str, str] = {}
        for symbol in symbols:
            try:
                quote = self.quote(symbol, allow_stale=allow_stale)
                found[quote["symbol"]] = quote
            except QuoteUnavailable as exc:
                errors[(symbol or "").strip().upper()] = str(exc)
        return {"quotes": found, "errors": errors}

    def search(self, query: str = "", limit: int = 10) -> List[dict]:
        """Company/symbol lookup with useful offline defaults."""
        clean = (query or "").strip()
        needle = clean.casefold()
        limit = max(1, min(int(limit), 12))
        defaults = [dict(item) for item in DEFAULT_ASSETS if not needle or needle in (
            f"{item['symbol']} {item['name']} {item['exchange']}".casefold()
        )]
        if not clean:
            return defaults[:limit]
        with self._lock:
            cached = self._search_cache.get(needle)
            if cached and (time.time() - cached["_at"]) < 300:
                return [dict(item) for item in cached["results"][:limit]]
        remote = []
        try:
            payload = self._fetch(EQUITY_SEARCH_URL.format(
                query=urllib.parse.quote(clean, safe=""))) or {}
            for item in payload.get("data") or []:
                symbol = str(item.get("symbol") or "").strip().upper()
                name = str(item.get("name") or "").strip()
                if not symbol or not name or str(item.get("asset") or "").upper() != "STOCKS":
                    continue
                remote.append({
                    "symbol": symbol,
                    "name": name,
                    "exchange": str(item.get("exchange") or "US market"),
                    "asset_class": "equity",
                })
        except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError):
            remote = []
        results = []
        seen = set()
        for item in defaults + remote:
            if item["symbol"] in seen:
                continue
            seen.add(item["symbol"])
            results.append(item)
        with self._lock:
            self._search_cache[needle] = {"_at": time.time(), "results": results}
        return [dict(item) for item in results[:limit]]

    def cached_intraday(self, symbol: str):
        """Last known chart for an instant first paint. None means nothing seen
        yet; anything returned is labelled stale until a fresh fetch lands."""
        symbol = (symbol or "").strip().upper()
        with self._lock:
            cached = self._intraday_cache.get(symbol)
        if not cached or (time.time() - cached["_at"]) > REPLAY_MAX_AGE_SECONDS:
            return None
        data = dict(cached["data"])
        data["stale"] = True
        return data

    def history(self, symbol: str, lookback_days: int = 550) -> dict:
        """Daily equity closes from the same approved Nasdaq feed."""
        symbol = (symbol or "").strip().upper()
        if not symbol or crypto_id(symbol):
            raise QuoteUnavailable("strategy history currently supports US equities")
        to_date = date.today()
        from_date = to_date - timedelta(days=max(120, min(int(lookback_days), 730)))
        try:
            payload = self._fetch_nasdaq(
                EQUITY_HISTORY_URL, symbol,
                from_date=from_date.isoformat(), to_date=to_date.isoformat())
            status = payload.get("status") or {}
            if int(status.get("rCode") or 0) != 200:
                raise QuoteUnavailable(f"{symbol}: historical prices unavailable")
            raw = ((((payload.get("data") or {}).get("tradesTable") or {}).get("rows")) or [])
            rows = []
            for item in reversed(raw):
                rows.append({
                    "date": datetime.strptime(item["date"], "%m/%d/%Y").date().isoformat(),
                    "close_cents": _to_cents(item["close"]),
                })
            if len(rows) < 80:
                raise QuoteUnavailable(f"{symbol}: only {len(rows)} daily closes returned")
            return {"symbol": symbol, "source": "nasdaq", "rows": rows, "fetched_at": _now_iso()}
        except QuoteUnavailable:
            raise
        except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError) as exc:
            raise QuoteUnavailable(f"{symbol}: {exc}")

    def crypto_intraday_points(self, symbol: str) -> List[dict]:
        """Recent one-minute closes to seed the exchange stream chart."""
        symbol = (symbol or "").strip().upper()
        if not crypto_id(symbol):
            raise QuoteUnavailable("crypto intraday history requires a supported crypto symbol")
        base = symbol
        for suffix in ("-USD", "/USD", "USD"):
            if base.endswith(suffix) and len(base) > len(suffix):
                base = base[:-len(suffix)]
                break
        # Re-fetching a minute chart on every reconnect just delays the paint.
        cache_key = f"crypto:{symbol}"
        with self._lock:
            cached = self._intraday_cache.get(cache_key)
            if cached and (time.time() - cached["_at"]) < INTRADAY_TTL_SECONDS * 4:
                return list(cached["data"])
        try:
            payload = self._fetch(CRYPTO_CHART_URL.format(pair=urllib.parse.quote(f"{base}USDT"))) or {}
            if int(payload.get("retCode") or 0) != 0:
                raise QuoteUnavailable(f"{symbol}: crypto chart unavailable")
            rows = ((payload.get("result") or {}).get("list")) or []
            points = [{"ts_ms": int(item[0]), "price_mills": int(round(float(item[4]) * 1000))}
                      for item in reversed(rows) if len(item) >= 5]
            if not points:
                raise QuoteUnavailable(f"{symbol}: no crypto chart prices returned")
            with self._lock:
                self._intraday_cache[cache_key] = {"_at": time.time(), "data": list(points)}
            return points
        except QuoteUnavailable:
            raise
        except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError) as exc:
            raise QuoteUnavailable(f"{symbol}: {exc}")

    def crypto_universe(self, limit: int = 20, min_turnover_usd: float = 10_000_000) -> List[str]:
        """Most-traded Bybit USDT spot coins, pegged assets and leveraged tokens left out."""
        with self._lock:
            cached = self._intraday_cache.get("universe")
            if cached and (time.time() - cached["_at"]) < 3600:
                return list(cached["data"])
        try:
            payload = self._fetch(CRYPTO_TICKERS_URL) or {}
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise QuoteUnavailable(f"coin list: {exc}")
        rows = ((payload.get("result") or {}).get("list")) or []
        picks = []
        for row in rows:
            pair = str(row.get("symbol") or "")
            if not pair.endswith("USDT"):
                continue
            base = pair[:-4]
            if re.search(r"\d[LS]$", base):  # leveraged tokens (BTC3L, ETH2S…)
                continue
            try:
                price = float(row.get("lastPrice") or 0)
                span = (float(row.get("highPrice24h") or 0) - float(row.get("lowPrice24h") or 0)) / price
                turnover = float(row.get("turnover24h") or 0)
            except (TypeError, ValueError, ZeroDivisionError):
                continue
            if turnover < min_turnover_usd or span < 0.004:  # thin, or pegged (stablecoins)
                continue
            picks.append((turnover, base))
        coins = [base for _, base in sorted(picks, reverse=True)[:limit]]
        if not coins:
            raise QuoteUnavailable("coin list: no liquid coins returned")
        with self._lock:
            self._intraday_cache["universe"] = {"_at": time.time(), "data": list(coins)}
        return coins

    @staticmethod
    def _crypto_pair(symbol: str) -> str:
        base = "".join(ch for ch in str(symbol or "").upper() if ch.isalnum())
        for quote in ("USDT", "USDC", "USD"):
            if base.endswith(quote) and len(base) > len(quote):
                base = base[:-len(quote)]
                break
        if not base:
            raise QuoteUnavailable("symbol is required")
        return base

    def _cached_fetch(self, key: str, url: str, ttl: float) -> dict:
        with self._lock:
            cached = self._intraday_cache.get(key)
            if cached and (time.time() - cached["_at"]) < ttl:
                return cached["data"]
        try:
            payload = self._fetch(url) or {}
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise QuoteUnavailable(str(exc))
        if int(payload.get("retCode") or 0) != 0:
            raise QuoteUnavailable(str(payload.get("retMsg") or "exchange error"))
        with self._lock:
            self._intraday_cache[key] = {"_at": time.time(), "data": payload}
        return payload

    def crypto_chart(self, symbol: str, span: str = "1D") -> dict:
        """Close prices for a chart range plus 24h/1y stats, any Bybit USDT pair."""
        base = self._crypto_pair(symbol)
        span = (span or "1D").upper()
        if span == "YTD":
            start = datetime(datetime.now(timezone.utc).year, 1, 1, tzinfo=timezone.utc)
            interval, bars, ttl = "D", max(2, (datetime.now(timezone.utc) - start).days + 1), 900
        elif span in CHART_RANGES:
            interval, bars, ttl = CHART_RANGES[span]
        else:
            raise QuoteUnavailable("range must be 1D, 5D, 1M, 6M, YTD, 1Y or MAX")
        pair = urllib.parse.quote(f"{base}USDT")
        rows = (self._cached_fetch(f"chart:{base}:{span}", CRYPTO_KLINE_URL.format(
            pair=pair, interval=interval, limit=min(bars, 1000)), ttl).get("result") or {}).get("list") or []
        points = [{"t": int(r[0]), "open": float(r[1]), "close": float(r[4])} for r in reversed(rows) if len(r) >= 5]
        if not points:
            raise QuoteUnavailable(f"{base}: no chart data")
        ticker = ((self._cached_fetch(f"ticker:{base}", CRYPTO_TICKER_URL.format(pair=pair), 5)
                   .get("result") or {}).get("list") or [{}])[0]
        year = (self._cached_fetch(f"chart:{base}:1Y", CRYPTO_KLINE_URL.format(
            pair=pair, interval="D", limit=365), 3600).get("result") or {}).get("list") or []
        num = lambda key: float(ticker.get(key) or 0) or None
        return {
            "symbol": base, "range": span, "interval": interval,
            "points": [{"t": p["t"], "close": p["close"]} for p in points],
            "range_open": points[0]["open"],
            "price": num("lastPrice") or points[-1]["close"],
            "stats": {
                "open_24h": num("prevPrice24h"), "high_24h": num("highPrice24h"), "low_24h": num("lowPrice24h"),
                "volume_24h_usd": num("turnover24h"),
                "high_1y": max((float(r[2]) for r in year), default=None),
                "low_1y": min((float(r[3]) for r in year), default=None),
            },
        }

    def stock_chart(self, symbol: str, span: str = "1D") -> dict:
        """US stock chart from the Nasdaq feed: today's minutes for 1D, daily closes otherwise."""
        symbol = (symbol or "").strip().upper()
        if not symbol or crypto_id(symbol):
            raise QuoteUnavailable("stock charts need a US stock or ETF ticker")
        span = (span or "1D").upper()
        days = {"5D": 8, "1M": 31, "6M": 183, "1Y": 366, "5Y": 1830, "MAX": 1830}  # Nasdaq serves ~5 years
        today = date.today()
        if span == "YTD":
            days["YTD"] = (today - date(today.year, 1, 1)).days + 1
        if span != "1D" and span not in days:
            raise QuoteUnavailable("range must be 1D, 5D, 1M, 6M, YTD, 1Y, 5Y or MAX")
        live = self.intraday(symbol)
        day_points = [{"t": p["ts_ms"], "close": p["price_mills"] / 1000} for p in (live.get("points") or [])]
        year_rows = self._stock_daily(symbol, 366)
        if span == "1D":
            step = max(1, len(day_points) // 390)
            points = day_points[::step] or [{"t": int(time.time() * 1000), "close": live["price_cents"] / 100}]
            range_open = (live.get("previous_close_cents") or 0) / 100 or points[0]["close"]
        else:
            rows = self._stock_daily(symbol, days[span])
            cutoff = (today - timedelta(days=days[span])).isoformat()
            rows = [r for r in rows if r["date"] >= cutoff] or rows
            step = max(1, len(rows) // 400)
            points = [{"t": int(datetime.fromisoformat(r["date"]).replace(tzinfo=timezone.utc).timestamp() * 1000),
                       "close": r["close"]} for r in rows[::step]]
            range_open = points[0]["close"]
        closes = [p["close"] for p in day_points] or [live["price_cents"] / 100]
        return {
            "symbol": symbol, "company": live.get("company") or symbol, "range": span,
            "market_status": live.get("market_status"), "points": points, "range_open": range_open,
            "price": live["price_cents"] / 100,
            "stats": {"previous_close": (live.get("previous_close_cents") or 0) / 100 or None,
                      "volume": live.get("volume") or None,
                      "low_24h": min(closes), "high_24h": max(closes),
                      "low_1y": min((r["close"] for r in year_rows), default=None),
                      "high_1y": max((r["close"] for r in year_rows), default=None)},
        }

    def _stock_daily(self, symbol: str, days: int) -> List[dict]:
        key = f"stockdaily:{symbol}:{days}"
        with self._lock:
            cached = self._intraday_cache.get(key)
            if cached and (time.time() - cached["_at"]) < 900:
                return list(cached["data"])
        to_date = date.today()
        payload = self._fetch_nasdaq(EQUITY_HISTORY_URL, symbol,
                                     from_date=(to_date - timedelta(days=days)).isoformat(), to_date=to_date.isoformat())
        raw = ((((payload.get("data") or {}).get("tradesTable") or {}).get("rows")) or [])
        rows = []
        for item in reversed(raw):
            try:
                rows.append({"date": datetime.strptime(item["date"], "%m/%d/%Y").date().isoformat(),
                             "close": _to_cents(item["close"]) / 100})
            except (KeyError, ValueError, TypeError):
                continue
        if not rows:
            raise QuoteUnavailable(f"{symbol}: no daily prices")
        with self._lock:
            self._intraday_cache[key] = {"_at": time.time(), "data": list(rows)}
        return rows

    def crypto_hourly_candles(self, symbol: str) -> List[dict]:
        """300 hourly Bybit candles, oldest first; the open bar is flagged partial."""
        base = (symbol or "").strip().upper()
        for suffix in ("-USD", "/USD", "USD"):
            if base.endswith(suffix) and len(base) > len(suffix):
                base = base[:-len(suffix)]
                break
        cache_key = f"hourly:{base}"
        with self._lock:
            cached = self._intraday_cache.get(cache_key)
            if cached and (time.time() - cached["_at"]) < 30:
                return list(cached["data"])
        try:
            payload = self._fetch(CRYPTO_HOURLY_URL.format(pair=urllib.parse.quote(f"{base}USDT"))) or {}
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise QuoteUnavailable(f"{base}: {exc}")
        if int(payload.get("retCode") or 0) != 0:
            raise QuoteUnavailable(f"{base}: hourly candles unavailable")
        rows = ((payload.get("result") or {}).get("list")) or []
        now_ms = time.time() * 1000
        candles = [{"t": int(r[0]), "open": float(r[1]), "high": float(r[2]), "low": float(r[3]),
                    "close": float(r[4]), "partial": int(r[0]) + 3_600_000 > now_ms}
                   for r in reversed(rows) if len(r) >= 5]
        if not candles:
            raise QuoteUnavailable(f"{base}: no hourly candles returned")
        with self._lock:
            self._intraday_cache[cache_key] = {"_at": time.time(), "data": list(candles)}
        return candles

    def intraday(self, symbol: str, allow_stale: bool = True) -> dict:
        """Current Nasdaq session, normalized for the local live display."""
        symbol = (symbol or "").strip().upper()
        if not symbol or crypto_id(symbol):
            raise QuoteUnavailable("intraday chart currently supports US equities")
        with self._lock:
            cached = self._intraday_cache.get(symbol)
            if cached and (time.time() - cached["_at"]) < INTRADAY_TTL_SECONDS:
                return dict(cached["data"])
            if time.time() < self._blocked_until:
                if cached and allow_stale:
                    stale = dict(cached["data"])
                    stale["stale"] = True
                    return stale
                raise QuoteUnavailable(f"{symbol}: quote feed rate-limited, retry shortly")
        try:
            payload = self._fetch_nasdaq(EQUITY_CHART_URL, symbol)
            status = payload.get("status") or {}
            if int(status.get("rCode") or 0) != 200:
                raise QuoteUnavailable(f"{symbol}: intraday chart unavailable")
            data = payload.get("data") or {}
            raw_points = data.get("chart") or []
            points = []
            for item in raw_points:
                value = item.get("y")
                if value is None:
                    value = (item.get("z") or {}).get("value")
                if value is None or item.get("x") is None:
                    continue
                points.append({
                    "ts_ms": int(item["x"]),
                    "price_mills": int(round(float(value) * 1000)),
                })
            if not points:
                raise QuoteUnavailable(f"{symbol}: no intraday prices returned")
            parsed = {
                "symbol": symbol,
                "company": data.get("company") or symbol,
                "source": "nasdaq",
                "market_status": data.get("marketStatus") or "Unknown",
                "is_realtime": bool(data.get("isRealTime", True)),
                "as_of": data.get("timeAsOf") or "",
                "price_cents": _to_cents(data.get("lastSalePrice")),
                "previous_close_cents": _to_optional_cents(data.get("previousClose")),
                "net_change_cents": _to_optional_cents(data.get("netChange")),
                "percentage_change_bps": _to_bps(data.get("percentageChange")),
                "delta": data.get("deltaIndicator") or "unchanged",
                "volume": str(data.get("volume") or ""),
                "points": points[-720:],
                "fetched_at": _now_iso(),
                "stale": False,
            }
        except QuoteUnavailable:
            raise
        except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError) as exc:
            with self._lock:
                if getattr(exc, "code", None) == 429:
                    self._blocked_until = time.time() + RATE_LIMIT_COOLDOWN
                cached = self._intraday_cache.get(symbol)
            if cached and allow_stale:
                stale = dict(cached["data"])
                stale["stale"] = True
                return stale
            raise QuoteUnavailable(f"{symbol}: {exc}")
        with self._lock:
            self._intraday_cache[symbol] = {"_at": time.time(), "data": parsed}
        return dict(parsed)

    def price_map(self, symbols: List[str]) -> Dict[str, int]:
        """symbol -> price_cents, shaped for PaperBroker.mark_to_market()."""
        return {s: q["price_cents"] for s, q in self.quotes(symbols)["quotes"].items()}
