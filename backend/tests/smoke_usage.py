"""Logic tests for §8 (rate limit, credits, persistence, key masking). No deps.

Run:  python backend/tests/smoke_usage.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.usage import ApiKeyStore, CreditExhausted, RateLimited, UsageManager  # noqa: E402

passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


# Rate limit: 3 allowed in window, 4th blocked.
d1 = tempfile.mkdtemp()
m = UsageManager(d1, rate_max=3, rate_window=60, credit_limit=100, cost=1, warn_ratio=0.9)
for _ in range(3):
    m.consume()
try:
    m.consume()
    raise SystemExit("FAIL: expected RateLimited on 4th request")
except RateLimited as exc:
    assert exc.retry_after > 0
ok("rate limit blocks the request past the window cap")

# Credit limit: 2 allowed, 3rd blocked.
d2 = tempfile.mkdtemp()
c = UsageManager(d2, rate_max=1000, rate_window=60, credit_limit=2, cost=1, warn_ratio=0.5)
c.consume()
c.consume()
try:
    c.consume()
    raise SystemExit("FAIL: expected CreditExhausted")
except CreditExhausted:
    pass
ok("credit limit blocks once the monthly cap is reached")

# Persistence: a fresh manager on the same dir keeps the count.
c2 = UsageManager(d2, rate_max=1000, rate_window=60, credit_limit=2, cost=1, warn_ratio=0.5)
snap = c2.snapshot()
assert snap["credits_used"] == 2 and snap["credits_remaining"] == 0, snap
ok("credit counters persist across restart")

# Warning surfaces at/near the limit.
assert snap["warning"], snap
ok("warning surfaces near/at the credit limit")

# Monthly reset: a stale period zeroes credits on next access.
c2._state["period"] = "1999-01"
c2._persist()
c3 = UsageManager(d2, rate_max=1000, rate_window=60, credit_limit=2, cost=1, warn_ratio=0.5)
assert c3.snapshot()["credits_used"] == 0
ok("new billing period resets credits to zero")

# API key: stored, masked, raw never leaks through masked().
ks = ApiKeyStore(d1)
assert ks.is_set() is False
ks.set("sk-1234567890ABCDEF")
masked = ks.masked()
assert ks.is_set() and masked and "…" in masked and masked.endswith("CDEF")
assert "234567890AB" not in masked
ok("api key stored server-side + masked (raw never exposed)")

print(f"\n{passed} checks passed.")
