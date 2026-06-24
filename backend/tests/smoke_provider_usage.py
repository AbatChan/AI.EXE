"""Tests for the provider balance reader (§8 real-usage). Parser + guards only — the
live Venice call needs a real key.

Run:  python backend/tests/smoke_provider_usage.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.provider_usage import _find_balances, read_provider_balance  # noqa: E402

passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


# Deep-search finds a Venice-shaped balances object.
venice_like = {"data": {"apiTier": {"id": "pro+"}, "balances": {"VCU": 7421.5, "USD": 3.2, "DIEM": 0}}}
b = _find_balances(venice_like)
assert b == {"VCU": 7421.5, "USD": 3.2, "DIEM": 0}, b
ok("extracts balances from a Venice-shaped response")

# Finds balances nested inside a list too.
assert _find_balances({"items": [{"balances": {"VCU": 10}}]}) == {"VCU": 10}
ok("finds balances nested in a list")

# No balances => empty.
assert _find_balances({"foo": {"bar": 1}}) == {}
ok("returns empty when there is no balances field")

# Guards: no key / no base => unavailable, never raises.
assert read_provider_balance("", "")["available"] is False
ok("unavailable with no provider/key")

# Non-Venice provider => skipped (no standard endpoint), not a network call.
r = read_provider_balance("https://api.openai.com/v1", "sk-x")
assert r["available"] is False and r["source"] == "other"
ok("non-Venice provider is skipped gracefully")

print(f"\n{passed} checks passed.")
