"""Logic tests for §6/§7 module store. No deps.

Run:  python backend/tests/smoke_modules.py
"""
import io
import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.modules import ModuleStore, detect_type  # noqa: E402

store = ModuleStore(tempfile.mkdtemp())
passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


assert detect_type("a.exe") == "exe" and detect_type("a.weird") == "file"
ok("detect_type maps known extensions")

# Upload a single .py module -> pending, listed, has the file as entry.
m = store.create("My Mod", "main.py", b"print('module')")
assert m["status"] == "pending" and m["type"] == "py" and m["entry"] == "main.py"
ok("create stores a single-file module as pending")

# List + get.
assert any(x["id"] == m["id"] for x in store.list())
got = store.get(m["id"])
assert got and "main.py" in got["files"]
ok("list + get return the module")

# Connect -> connected + registration token.
c = store.connect(m["id"])
assert c["status"] == "connected" and c["connected_at"] and c["registration_token"]
ok("connect registers the module (status + token)")

# Upload a zip (folder) -> extracted, multiple files.
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as zf:
    zf.writestr("main.py", "print(1)")
    zf.writestr("lib/helper.py", "x=1")
z = store.create("Zipped", "bundle.zip", buf.getvalue())
assert set(z["files"]) >= {"main.py", "lib/helper.py"} and z["type"] == "zip"
ok("zip upload is extracted into the module folder")

# Zip-slip is refused.
evil = io.BytesIO()
with zipfile.ZipFile(evil, "w") as zf:
    zf.writestr("../escape.py", "x")
try:
    store.create("Evil", "evil.zip", evil.getvalue())
    raise SystemExit("FAIL: expected ValueError on zip traversal")
except ValueError:
    pass
ok("zip-slip path traversal is refused")

# Bad module id can't traverse out.
assert store.get("../../etc") is None
ok("malicious module id is sanitized (no traversal)")

# Delete.
assert store.delete(m["id"]) is True and store.get(m["id"]) is None
ok("delete removes the module")

print(f"\n{passed} checks passed.")
