"""Logic test for the Venice Pro adapter process manager. No network/Chrome needed —
a fake long-lived script stands in for the real adapter.

Run:  python backend/tests/smoke_adapter.py
"""
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.adapter import AdapterManager  # noqa: E402

d = tempfile.mkdtemp()
passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


m = AdapterManager(d, port=9788)  # a free port so the probe doesn't hit a real adapter

st = m.status()
assert st["installed"] is False and st["running"] is False
ok("status: not installed / not running before install")

r = m.start("user", "pass")
assert r["ok"] is False and "not installed" in r["detail"]
ok("start refuses cleanly when adapter not installed")

# Lifecycle with a fake long-lived server (stands in for the real adapter).
fake = os.path.join(d, "fake_server.py")
with open(fake, "w") as fh:
    fh.write("import time\nwhile True:\n    time.sleep(1)\n")

r = m.start("user", "pass", port=9788, headless=True, python_exe=sys.executable, script=fake)
assert r["ok"] is True and r["pid"]
ok("start spawns the process")

time.sleep(0.5)
assert m.running() is True and m.status()["running"] is True
ok("status: running after start")

r2 = m.start("user", "pass", python_exe=sys.executable, script=fake)
assert r2["ok"] is True and "already running" in r2["detail"]
ok("start is idempotent while running")

r = m.stop()
assert r["ok"] is True
time.sleep(0.3)
assert m.running() is False and m.status()["running"] is False
ok("stop kills the process")

print(f"\n{passed} checks passed.")
