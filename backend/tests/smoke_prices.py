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


def main():
    # --- symbol routing: tickers, pairs and suffixes all resolve ----------
    assert crypto_id("BTC") == "bitcoin"
    assert crypto_id("btc-usd") == "bitcoin"
    assert crypto_id("BTCUSD") == "bitcoin"
    assert crypto_id("ETH-USD") == "ethereum"
    assert crypto_id("AAPL") is None, "equities must not route to the crypto feed"
    assert crypto_id("") is None

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

    print("prices smoke test: ok")


if __name__ == "__main__":
    main()
