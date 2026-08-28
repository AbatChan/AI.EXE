"""Smoke test for the live quote feed.

Every case uses a stubbed fetcher: a suite that needs the internet is a suite
that fails offline and in CI.
"""
import sys
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.prices import QuoteFeed, QuoteUnavailable, crypto_id


def equity_payload(price="$313.33", code=200, message=None):
    status = {"rCode": code}
    if message:
        status["bCodeMessage"] = [{"code": 1001, "errorMessage": message}]
    return {"status": status,
            "data": {"primaryData": {"lastSalePrice": price, "lastTradeTimestamp": "Aug 6, 2026"}}}


def crypto_payload(coin="bitcoin", usd=64974):
    return {coin: {"usd": usd, "last_updated_at": 1786181770}}


def history_payload(count=90):
    rows = []
    for index in range(count):
        rows.append({"date": f"08/{(index % 28) + 1:02d}/2026", "close": f"${300 + index / 10:.2f}"})
    return {"status": {"rCode": 200}, "data": {"tradesTable": {"rows": rows}}}


def chart_payload():
    return {
        "status": {"rCode": 200},
        "data": {
            "symbol": "AAPL", "company": "Apple Inc.", "marketStatus": "Open",
            "isRealTime": True, "timeAsOf": "Aug 10, 2026 12:07 PM ET",
            "lastSalePrice": "$313.335", "previousClose": "$310.00",
            "netChange": "+3.335", "percentageChange": "+1.08%",
            "deltaIndicator": "up", "volume": "12,345",
            "chart": [
                {"x": 1786334400000, "y": 310.125},
                {"x": 1786334460000, "z": {"value": "313.335"}},
            ],
        },
    }


def search_payload():
    return {"status": {"rCode": 200}, "data": [
        {"symbol": "AAPL", "name": "Apple Inc. Common Stock",
         "exchange": "NASDAQ-GS", "asset": "STOCKS"},
        {"symbol": "APLE", "name": "Apple Hospitality REIT, Inc.",
         "exchange": "NYSE", "asset": "STOCKS"},
        {"symbol": "AAPLX", "name": "Example fund", "exchange": "OTC", "asset": "FUNDS"},
    ]}


def crypto_chart_payload():
    return {"retCode": 0, "result": {"list": [
        ["1786334460000", "65000", "65100", "64900", "65050", "1", "1"],
        ["1786334400000", "64900", "65020", "64850", "65000", "1", "1"],
    ]}}


def main():
    # --- symbol routing: tickers, pairs and suffixes all resolve ----------
    assert crypto_id("BTC") == "bitcoin"
    assert crypto_id("btc-usd") == "bitcoin"
    assert crypto_id("BTCUSD") == "bitcoin"
    assert crypto_id("ETH-USD") == "ethereum"
    assert crypto_id("AAPL") is None, "equities must not route to the crypto feed"
    assert crypto_id("") is None

    # --- search accepts company names and keeps offline defaults ----------
    defaults = QuoteFeed(fetcher=lambda u: search_payload()).search("")
    assert [item["symbol"] for item in defaults[:3]] == ["BAC", "AAPL", "MSFT"]
    search_calls = []
    def search_fetch(url):
        search_calls.append(url)
        return search_payload()
    matches = QuoteFeed(fetcher=search_fetch).search("apple")
    assert [item["symbol"] for item in matches] == ["AAPL", "APLE"]
    assert matches[0]["name"] == "Apple"
    assert "autocomplete" in search_calls[0] and "apple" in search_calls[0]

    # --- equities: dollar sign and commas are stripped, not parsed as float
    calls = []

    def equity_fetch(url):
        calls.append(url)
        return equity_payload()

    feed = QuoteFeed(ttl_seconds=60, fetcher=equity_fetch)
    quote = feed.quote("aapl")
    assert quote["symbol"] == "AAPL"
    assert quote["price_cents"] == 31333, quote
    assert isinstance(quote["price_cents"], int)
    assert quote["asset_class"] == "equity" and quote["source"] == "nasdaq"
    assert "nasdaq.com" in calls[0]

    # --- historical closes are normalized oldest-first -------------------
    history_calls = []

    def history_fetch(url):
        history_calls.append(url)
        return history_payload()

    history = QuoteFeed(fetcher=history_fetch).history("AAPL")
    assert history["source"] == "nasdaq" and len(history["rows"]) == 90
    assert history["rows"][0]["close_cents"] == 30890
    assert history["rows"][-1]["close_cents"] == 30000
    assert "historical" in history_calls[0] and "fromdate=" in history_calls[0]
    try:
        QuoteFeed(fetcher=history_fetch).history("BTC-USD")
        raise AssertionError("crypto history is not supported by this feed")
    except QuoteUnavailable:
        pass

    # --- intraday prices keep chart precision and market metadata ----------
    intraday = QuoteFeed(fetcher=lambda u: chart_payload()).intraday("aapl")
    assert intraday["symbol"] == "AAPL" and intraday["market_status"] == "Open"
    assert intraday["is_realtime"] is True and intraday["price_cents"] == 31334
    assert intraday["percentage_change_bps"] == 108
    assert intraday["points"] == [
        {"ts_ms": 1786334400000, "price_mills": 310125},
        {"ts_ms": 1786334460000, "price_mills": 313335},
    ]
    unavailable_change = chart_payload()
    unavailable_change["data"].update({
        "previousClose": "N/A", "netChange": "N/A", "percentageChange": "N/A",
    })
    degraded_intraday = QuoteFeed(fetcher=lambda u: unavailable_change).intraday("BAC")
    assert degraded_intraday["price_cents"] == 31334
    assert degraded_intraday["previous_close_cents"] == 0
    assert degraded_intraday["net_change_cents"] == 0
    assert degraded_intraday["percentage_change_bps"] == 0
    try:
        QuoteFeed(fetcher=lambda u: chart_payload()).intraday("BTC-USD")
        raise AssertionError("crypto intraday chart is not supported by this feed")
    except QuoteUnavailable:
        pass

    big = QuoteFeed(fetcher=lambda u: equity_payload("$1,234.50")).quote("BRK")
    assert big["price_cents"] == 123450, big

    # --- cache: a second call inside the TTL does not hit the network -----
    feed.quote("AAPL")
    assert len(calls) == 1, f"expected one fetch, got {len(calls)}"

    # --- crypto goes to the other source ---------------------------------
    crypto_calls = []

    def crypto_fetch(url):
        crypto_calls.append(url)
        return crypto_payload()

    btc = QuoteFeed(fetcher=crypto_fetch).quote("BTC-USD")
    assert btc["price_cents"] == 6497400, btc
    assert btc["asset_class"] == "crypto" and btc["source"] == "coingecko"
    assert "coingecko.com" in crypto_calls[0]
    crypto_points = QuoteFeed(fetcher=lambda u: crypto_chart_payload()).crypto_intraday_points("BTC-USD")
    assert crypto_points == [
        {"ts_ms": 1786334400000, "price_mills": 65000000},
        {"ts_ms": 1786334460000, "price_mills": 65050000},
    ]

    # --- sub-cent prices round rather than truncate -----------------------
    assert QuoteFeed(fetcher=lambda u: equity_payload("$2.346")).quote("X")["price_cents"] == 235
    assert QuoteFeed(fetcher=lambda u: equity_payload("$2.344")).quote("X")["price_cents"] == 234

    # --- unknown symbol is a clean error, not a crash ---------------------
    unknown = QuoteFeed(fetcher=lambda u: equity_payload(None, 400, "Symbol not exists."))
    try:
        unknown.quote("NOTREAL")
        raise AssertionError("an unknown symbol must raise")
    except QuoteUnavailable as exc:
        assert "Symbol not exists" in str(exc), exc

    no_price = QuoteFeed(fetcher=lambda u: {"status": {"rCode": 200}, "data": {"primaryData": {}}})
    try:
        no_price.quote("X")
        raise AssertionError("a missing price must raise")
    except QuoteUnavailable:
        pass

    empty_crypto = QuoteFeed(fetcher=lambda u: {"bitcoin": {}})
    try:
        empty_crypto.quote("BTC")
        raise AssertionError("a crypto response with no usd price must raise")
    except QuoteUnavailable:
        pass

    # --- network failure falls back to the cached price, LABELLED stale ---
    state = {"fail": False}

    def flaky(url):
        if state["fail"]:
            raise urllib.error.URLError("no route to host")
        return equity_payload()

    warm = QuoteFeed(ttl_seconds=0, fetcher=flaky)
    assert warm.quote("AAPL")["price_cents"] == 31333
    state["fail"] = True
    degraded = warm.quote("AAPL")
    assert degraded["price_cents"] == 31333
    assert degraded["stale"] is True, "a fallback price must be labelled stale"

    # with no cache to fall back on it raises rather than inventing a price
    cold = QuoteFeed(ttl_seconds=0, fetcher=flaky)
    try:
        cold.quote("AAPL")
        raise AssertionError("no cache and no network must raise")
    except QuoteUnavailable:
        pass

    # --- a 429 stops further calls until the cooldown clears --------------
    hits = {"n": 0}

    def limited(url):
        hits["n"] += 1
        raise urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)

    blocked = QuoteFeed(ttl_seconds=0, fetcher=limited)
    for _ in range(4):
        try:
            blocked.quote("AAPL")
        except QuoteUnavailable:
            pass
    assert hits["n"] == 1, f"rate limit must stop further calls, made {hits['n']}"

    # --- quotes() reports partial failure instead of throwing it all away --
    def mixed(url):
        if "BAD" in url:
            raise urllib.error.URLError("nope")
        return equity_payload()

    partial = QuoteFeed(ttl_seconds=0, fetcher=mixed).quotes(["AAPL", "BAD"])
    assert "AAPL" in partial["quotes"]
    assert "BAD" in partial["errors"]

    # --- price_map is shaped for PaperBroker.mark_to_market() -------------
    assert QuoteFeed(fetcher=equity_fetch).price_map(["AAPL"]) == {"AAPL": 31333}

    # --- ETFs answer under a different Nasdaq asset class ----------------
    seen = []

    def etf_only(url):
        seen.append(url)
        if "assetclass=etf" not in url:
            return {"status": {"rCode": 400}}
        return chart_payload() if "/chart" in url else equity_payload()

    etf_feed = QuoteFeed(ttl_seconds=0, fetcher=etf_only)
    assert etf_feed.intraday("VOO")["points"], "an ETF chart must fall back off assetclass=stocks"
    assert etf_feed.quote("VOO")["price_cents"] == 31333
    tried = [u for u in seen if "/chart" in u]
    assert "assetclass=stocks" in tried[0], "the stock class must still be tried first"
    seen.clear()
    etf_feed.intraday("VOO")
    assert all("assetclass=etf" in u for u in seen), f"the working class must be remembered, retried {seen}"

    # --- a cached chart is available without touching the network --------
    warm = QuoteFeed(ttl_seconds=0, fetcher=lambda url: chart_payload())
    assert warm.cached_intraday("AAPL") is None, "nothing seen yet means nothing to replay"
    warm.intraday("AAPL")
    replay = warm.cached_intraday("AAPL")
    assert replay and replay["stale"] is True, "a replayed chart must be labelled stale"
    for entry in warm._intraday_cache.values():
        entry["_at"] -= 1000
    assert warm.cached_intraday("AAPL") is None, "an old chart must not be replayed as a placeholder"

    print("prices smoke test: ok")


if __name__ == "__main__":
    main()
