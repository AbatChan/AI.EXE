"""Logic tests for §4 .py packaging (fast, no deps). The .exe/PyInstaller path is
verified via the live HTTP smoke (it's a slow real build).

Run:  python backend/tests/smoke_packager.py
"""
import io
import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.packager import package_py, slug_name  # noqa: E402

passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


assert slug_name("My Tool! v2") == "My-Tool-v2" and slug_name("") == "app"
ok("slug_name normalizes and falls back to 'app'")

# Single-file project -> a .py artifact.
src = tempfile.mkdtemp()
out = tempfile.mkdtemp()
with open(os.path.join(src, "main.py"), "w") as fh:
    fh.write("print('hi')")
res = package_py(src, "main.py", out, "hello")
assert res["ok"] and res["artifact"] == "hello.py" and os.path.exists(res["path"])
assert open(res["path"]).read() == "print('hi')"
ok("single-file project packages to a .py")

# Multi-file project -> a .zip of the source.
src2 = tempfile.mkdtemp()
out2 = tempfile.mkdtemp()
os.makedirs(os.path.join(src2, "lib"))
with open(os.path.join(src2, "main.py"), "w") as fh:
    fh.write("import lib.u")
with open(os.path.join(src2, "lib", "u.py"), "w") as fh:
    fh.write("x=1")
res = package_py(src2, "main.py", out2, "proj")
assert res["ok"] and res["artifact"] == "proj.zip"
zf = zipfile.ZipFile(io.BytesIO(open(res["path"], "rb").read()))
assert {"main.py", "lib/u.py"} <= set(zf.namelist())
ok("multi-file project packages to a .zip of the source")

print(f"\n{passed} checks passed.")
