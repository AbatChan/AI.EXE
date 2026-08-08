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
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Dict, List

EQUITY_URL = "https://api.nasdaq.com/api/quote/{symbol}/info?assetclass=stocks"
CRYPTO_URL = "https://api.coingecko.com/api/v3/simple/price?ids={ids}&vs_currencies=usd&include_last_updated_at=true"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36"

DEFAULT_TTL_SECONDS = 30
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
    return int(round(float(text) * 100))


class QuoteFeed:
    """Cached quote lookups. The fetcher is injectable so tests never hit the
    network — a suite that needs the internet is a suite that fails offline."""

    def __init__(self, ttl_seconds: int = DEFAULT_TTL_SECONDS, fetcher=None):
        self._ttl = int(ttl_seconds)
        self._fetch = fetcher or _http_get_json
        self._cache: Dict[str, dict] = {}
        self._blocked_until = 0.0
        self._lock = threading.RLock()

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
        payload = self._fetch(EQUITY_URL.format(symbol=urllib.parse.quote(symbol))) or {}
        status = payload.get("status") or {}
        if int(status.get("rCode") or 0) != 200:
            messages = status.get("bCodeMessage") or []
            detail = messages[0].get("errorMessage") if messages else "not found"
            raise QuoteUnavailable(f"{symbol}: {detail}")
        primary = ((payload.get("data") or {}).get("primaryData") or {})
        if not primary.get("lastSalePrice"):
            raise QuoteUnavailable(f"{symbol}: no price returned")
        return {
            "symbol": symbol,
            "price_cents": _to_cents(primary["lastSalePrice"]),
            "currency": "USD",
            "asset_class": "equity",
            "source": "nasdaq",
            "as_of": primary.get("lastTradeTimestamp") or "",
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

    def price_map(self, symbols: List[str]) -> Dict[str, int]:
        """symbol -> price_cents, shaped for PaperBroker.mark_to_market()."""
        return {s: q["price_cents"] for s, q in self.quotes(symbols)["quotes"].items()}
