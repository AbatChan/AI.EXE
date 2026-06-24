"""Logic tests for §2 file output manager (ProjectStore). No deps.

Run:  python backend/tests/smoke_projects.py
"""
import io
import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.projects import ProjectStore, slugify  # noqa: E402

store = ProjectStore(tempfile.mkdtemp())
passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


# slugify normalizes unsafe names.
assert slugify("My App! v2") == "My-App-v2"
assert slugify("../../etc") == "etc"
ok("slugify normalizes names and strips traversal")

# save + get.
info = store.save("Calc Tool", {"main.py": "print(1)", "lib/util.py": "X = 1"})
assert info["name"] == "Calc-Tool" and info["file_count"] == 2
assert set(info["files"]) == {"main.py", "lib/util.py"}
ok("save writes files (incl. nested) and reports them")

# list.
names = [p["name"] for p in store.list()]
assert "Calc-Tool" in names
ok("list includes the saved project")

# read a file back.
assert store.read_file("Calc Tool", "main.py") == "print(1)"
ok("read_file returns the saved content")

# traversal is refused on read.
assert store.read_file("Calc Tool", "../../../etc/passwd") is None
ok("read_file refuses path traversal")

# unsafe save path raises.
try:
    store.save("Calc Tool", {"../escape.py": "x"})
    raise SystemExit("FAIL: expected ValueError on unsafe path")
except ValueError:
    pass
ok("save refuses an unsafe file path")

# re-save merges (manifest keeps created_at, updates files).
info2 = store.save("Calc Tool", {"README.md": "# hi"})
assert info2["file_count"] == 3 and "README.md" in info2["files"]
ok("re-saving a project adds files and keeps it")

# zip download is a valid archive containing the files.
data = store.zip_bytes("Calc Tool")
zf = zipfile.ZipFile(io.BytesIO(data))
assert "main.py" in zf.namelist() and "lib/util.py" in zf.namelist()
ok("zip_bytes produces a valid archive of the project")

# delete.
assert store.delete("Calc Tool") is True and store.get("Calc Tool") is None
ok("delete removes the project")

print(f"\n{passed} checks passed.")
