"""Keyless public data for chat cards: currency rates (ECB via Frankfurter) and weather (Open-Meteo)."""
import threading
import time
import urllib.parse
from datetime import date, timedelta

from .prices import QuoteUnavailable, _http_get_json

FX_URL = "https://api.frankfurter.dev/v1"
# Wider coverage (e.g. NGN) but latest-only; used when the ECB set lacks a currency.
FX_FALLBACK_URL = "https://open.er-api.com/v6/latest/{base}"
GEO_URL = "https://geocoding-api.open-meteo.com/v1/search?name={name}&count=1&language=en&format=json"
WEATHER_URL = ("https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
               "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day"
               "&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max"
               "&timezone=auto&forecast_days=7&temperature_unit={temp}&wind_speed_unit={wind}")
_cache = {}
_lock = threading.Lock()


def _get(url: str, ttl: float) -> dict:
    with _lock:
        hit = _cache.get(url)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
    data, last = None, None
    for attempt in range(2):  # one retry: TLS/connection hiccups are common and brief
        try:
            data = _http_get_json(url)
            break
        except Exception as exc:
            last = exc
            time.sleep(0.4)
    if data is None:
        raise QuoteUnavailable("the data service didn't respond — try again shortly") from last
    with _lock:
        _cache[url] = (time.time(), data)
    return data


def _code(value: str) -> str:
    code = "".join(ch for ch in str(value or "").upper() if ch.isalpha())[:3]
    if len(code) != 3:
        raise QuoteUnavailable("use 3-letter currency codes, e.g. USD")
    return code


def fx(base: str, quote: str, span: str = "1M") -> dict:
    base, quote = _code(base), _code(quote)
    if base == quote:
        raise QuoteUnavailable("choose two different currencies")
    q = urllib.parse.urlencode({"base": base, "symbols": quote})
    try:
        latest = _get(f"{FX_URL}/latest?{q}", 600)
        rate = (latest.get("rates") or {}).get(quote)
    except QuoteUnavailable:
        rate = None
    if not rate:
        wide = _get(FX_FALLBACK_URL.format(base=base), 3600)
        rate = (wide.get("rates") or {}).get(quote)
        if wide.get("result") != "success" or not rate:
            raise QuoteUnavailable(f"no exchange rate available for {base}/{quote}")
        return {"base": base, "quote": quote, "rate": rate, "date": str(wide.get("time_last_update_utc") or "")[:16],
                "range": (span or "1M").upper(), "points": [],
                "source": "ExchangeRate-API (daily, no history for this pair)"}
    days = {"1M": 31, "6M": 183, "1Y": 366, "5Y": 1830}.get((span or "1M").upper(), 31)
    start = (date.today() - timedelta(days=days)).isoformat()
    try:
        history = _get(f"{FX_URL}/{start}..?{q}", 3600)
    except QuoteUnavailable:
        history = {}  # rate still shows; the chart just waits for the next refresh
    points = [{"t": d, "close": r.get(quote)} for d, r in sorted((history.get("rates") or {}).items()) if r.get(quote)]
    return {"base": base, "quote": quote, "rate": rate, "date": latest.get("date"), "range": span.upper(),
            "points": points, "source": "European Central Bank reference rates (daily)"}


def weather(place: str, units: str = "metric") -> dict:
    name = str(place or "").strip()[:80]
    if not name:
        raise QuoteUnavailable("which place?")
    geo = (_get(GEO_URL.format(name=urllib.parse.quote(name)), 86400).get("results") or [])
    if not geo:
        raise QuoteUnavailable(f"couldn't find {name}")
    spot = geo[0]
    imperial = units == "imperial"
    data = _get(WEATHER_URL.format(lat=spot["latitude"], lon=spot["longitude"],
                                   temp="fahrenheit" if imperial else "celsius", wind="mph" if imperial else "kmh"), 600)
    daily = data.get("daily") or {}
    days = [{"date": d, "high": hi, "low": lo, "code": c, "rain": p}
            for d, hi, lo, c, p in zip(daily.get("time", []), daily.get("temperature_2m_max", []),
                                        daily.get("temperature_2m_min", []), daily.get("weather_code", []),
                                        daily.get("precipitation_probability_max", []))]
    return {"place": spot.get("name"), "region": spot.get("admin1"), "country": spot.get("country"),
            "timezone": data.get("timezone"), "units": "imperial" if imperial else "metric",
            "current": data.get("current") or {}, "days": days}
