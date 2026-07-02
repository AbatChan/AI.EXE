"""Logic tests for §3 sandbox runner. No network (no requirements). No deps.

Run:  python backend/tests/smoke_sandbox.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.sandbox import run_python, static_guard  # noqa: E402

_SEATBELT = sys.platform == "darwin" and os.path.exists("/usr/bin/sandbox-exec")

base = tempfile.mkdtemp()
passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


def run(**kw):
    kw.setdefault("code", None)
    kw.setdefault("files", None)
    kw.setdefault("entry", "main.py")
    kw.setdefault("requirements", [])
    kw.setdefault("stdin", None)
    kw.setdefault("args", [])
    kw.setdefault("timeout_seconds", 10)
    return run_python(base, **kw)

# 1) Happy path: runs and captures stdout.
r = run(code="print('hello from sandbox')")
assert r["ok"] and r["exit_code"] == 0 and "hello from sandbox" in r["stdout"], r
ok("runs a program and captures stdout + exit 0")

# 2) Runtime error: non-zero exit, traceback in stderr, not ok.
r = run(code="raise ValueError('boom')")
assert (not r["ok"]) and r["exit_code"] != 0 and "ValueError: boom" in r["stderr"], r
ok("captures a runtime error (traceback + non-zero exit)")

# 3) Missing dependency: retry_hint points at the package.
r = run(code="import definitely_not_a_real_pkg_xyz")
assert r["retry_hint"] and "definitely_not_a_real_pkg_xyz" in r["retry_hint"], r
ok("retry_hint surfaces a missing dependency")

# 4) Infinite loop: killed by the timeout.
r = run(code="while True:\n    pass", timeout_seconds=2)
assert r["timed_out"] and not r["ok"], r
ok("infinite loop is killed by the wall-clock timeout")

# 5) Stdin is delivered.
r = run(code="import sys; print('got:' + sys.stdin.read().strip())", stdin="ping")
assert "got:ping" in r["stdout"], r
ok("stdin is passed through to the program")

# 6) Multi-file project runs from entry.
r = run(files={"main.py": "import helper; helper.go()", "helper.py": "def go():\n    print('helper ran')"})
assert r["ok"] and "helper ran" in r["stdout"], r
ok("multi-file project runs and imports a sibling module")

# 7) Static guard blocks an obviously destructive program (does NOT run it).
r = run(code="import os; os.system('rm -rf /')")
assert r["blocked"] and r["exit_code"] is None and "guard" in (r["block_reason"] or ""), r
ok("destructive code is blocked before execution")

# 8) Path traversal in files is refused.
r = run(files={"../escape.py": "x=1"}, entry="main.py", code="print(1)")
assert r["blocked"] and "unsafe file path" in (r["block_reason"] or ""), r
ok("path traversal in file paths is refused")

# 9) static_guard unit: clean code is allowed.
assert static_guard("print('ok')") is None
ok("static_guard passes clean code")

# 10) macOS seatbelt FS jail: writes outside the sandbox and reads of $HOME are denied,
#     while the program itself still runs. Skipped where no seatbelt is available.
if _SEATBELT:
    home = os.path.expanduser("~")
    esc = os.path.join(home, "AIEXE_SMOKE_ESCAPE.txt")
    r = run(code=f"""
open('inside.txt','w').write('ok')
try:
    open({esc!r},'w').write('x'); print('WROTE-OUTSIDE')
except Exception: print('write-denied')
""")
    assert r["isolation"] == "seatbelt", r
    assert "write-denied" in r["stdout"] and "WROTE-OUTSIDE" not in r["stdout"], r
    assert not os.path.exists(esc), "seatbelt let a write escape the sandbox"
    ok("seatbelt confines writes to the sandbox (no escape to $HOME)")

    secret_dir = tempfile.mkdtemp(dir=home)
    secret = os.path.join(secret_dir, "secret.txt")
    with open(secret, "w") as fh:
        fh.write("TOPSECRET")
    r = run(code=f"""
try:
    print('READ:' + open({secret!r}).read())
except Exception: print('read-denied')
""")
    assert "read-denied" in r["stdout"] and "TOPSECRET" not in r["stdout"], r
    ok("seatbelt denies reading user files under $HOME")
    import shutil as _sh
    _sh.rmtree(secret_dir, ignore_errors=True)
else:
    ok("seatbelt FS jail not available on this platform (isolation=none) — skipped")

print(f"\n{passed} checks passed.")
