"""Chat-card data: FX falls back for non-ECB currencies, history is optional, weather parses."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import live_data  # noqa: E402
from app.prices import QuoteUnavailable  # noqa: E402

calls = []


def fake(url):
    calls.append(url)
    if "frankfurter" in url and "NGN" in url:
        raise OSError("404")
    if "frankfurter" in url and "latest" in url:
        return {"date": "2026-09-22", "rates": {"EUR": 0.87}}
    if "frankfurter" in url:
        if "flaky" in calls[0]:
            raise OSError("tls")
        return {"rates": {"2026-09-20": {"EUR": 0.86}, "2026-09-21": {"EUR": 0.87}}}
    if "er-api" in url:
        return {"result": "success", "time_last_update_utc": "Wed, 23 Sep 2026 00:02:31 +0000", "rates": {"NGN": 1328.4}}
    if "geocoding" in url:
        return {"results": [{"name": "Lagos", "admin1": "Lagos", "country": "Nigeria", "latitude": 6.4, "longitude": 3.4}]}
    return {"timezone": "Africa/Lagos", "current": {"temperature_2m": 25, "weather_code": 51},
            "daily": {"time": ["2026-09-23"], "temperature_2m_max": [28], "temperature_2m_min": [24],
                      "weather_code": [61], "precipitation_probability_max": [90]}}


def main():
    live_data._http_get_json = fake
    eur = live_data.fx("usd", "eur", "1M")
    assert eur["rate"] == 0.87 and len(eur["points"]) == 2
    print("PASS: ECB pair has rate + history")
    ngn = live_data.fx("USD", "NGN")
    assert ngn["rate"] == 1328.4 and ngn["points"] == [] and "ExchangeRate-API" in ngn["source"]
    print("PASS: non-ECB currency (NGN) falls back to the wide-coverage source")
    try:
        live_data.fx("US", "EUR")
        raise AssertionError("bad code accepted")
    except QuoteUnavailable:
        pass
    print("PASS: currency codes are validated")
    w = live_data.weather("Lagos")
    assert w["place"] == "Lagos" and w["days"][0]["rain"] == 90 and w["units"] == "metric"
    print("PASS: weather geocodes and parses the forecast")
    print("\n4 checks passed.")


if __name__ == "__main__":
    main()
