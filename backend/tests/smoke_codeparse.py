"""Tests for extract_code_files, incl. the tolerant fallbacks (truncated fence / raw
HTML) that fixed the live "model did not return any code" on web generation.

Run:  python backend/tests/smoke_codeparse.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.codeparse import extract_code_files  # noqa: E402

passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


# Normal fenced block -> entry.
r = extract_code_files("here:\n```python\nprint(1)\n```", "main.py")
assert list(r["files"]) == ["main.py"] and r["files"]["main.py"].strip() == "print(1)"
ok("extracts a normal fenced block")

# Filename comment names the file.
r = extract_code_files("```python\n# util.py\nX=1\n```", "main.py")
assert "util.py" in r["files"]
ok("honors a # filename.py comment")

# Truncated/unterminated fence (long HTML cut off) -> still extracted.
r = extract_code_files("Sure:\n```html\n<!doctype html><html><body>cleaning", "index.html")
assert "index.html" in r["files"] and "<!doctype html" in r["files"]["index.html"]
ok("recovers a truncated/unterminated fence")

# Raw HTML with no fences at all -> treated as the entry file.
r = extract_code_files("<!DOCTYPE html>\n<html><body>hi</body></html>", "index.html")
assert r["files"].get("index.html", "").startswith("<!DOCTYPE html>")
ok("treats raw HTML (no fences) as the entry file")

# Pure prose, no code/HTML -> no files (honest empty).
r = extract_code_files("I recommend a clean, modern layout with a hero section.", "index.html")
assert r["files"] == {}
ok("returns no files for pure prose")

print(f"\n{passed} checks passed.")
