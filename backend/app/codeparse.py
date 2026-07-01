"""Separate code from prose in an LLM response (§2 step 3).

Pulls fenced code blocks into files. Filenames come from a ```lang title=foo.py info
string or a leading `# foo.py` / `// foo.py` comment; otherwise the first block is the
entry file and later unnamed blocks get file_N.py.
"""
import re
from typing import Dict

_FENCE = re.compile(r"```([^\n]*)\n([\s\S]*?)```", re.MULTILINE)
_TITLE = re.compile(r"(?:title|file|name)\s*[=:]\s*([\w./-]+)", re.IGNORECASE)
_LEADING_NAME = re.compile(r"^(?:#|//)\s*([\w./-]+\.\w+)\s*$")


def extract_code_files(text: str, default_entry: str = "main.py") -> Dict[str, object]:
    text = str(text or "")
    files: Dict[str, str] = {}
    prose_parts = []
    last = 0
    idx = 0
    for m in _FENCE.finditer(text):
        prose_parts.append(text[last:m.start()])
        last = m.end()
        info = m.group(1) or ""
        body = m.group(2)
        name = None
        tm = _TITLE.search(info)
        if tm:
            name = tm.group(1)
        if not name:
            first_line = body.strip().split("\n", 1)[0].strip()
            cm = _LEADING_NAME.match(first_line)
            if cm:
                name = cm.group(1)
                body = body.split("\n", 1)[1] if "\n" in body else ""
        if not name:
            name = default_entry if idx == 0 else f"file_{idx}.py"
        files[name.lstrip("/")] = body
        idx += 1
    prose_parts.append(text[last:])
    prose = "".join(prose_parts).strip()
    if not files:
        # Tolerate a truncated/unterminated ``` fence (long HTML cut off by the token
        # limit), or a model that returned raw code/HTML with no fences at all.
        opener = re.search(r"```[^\n]*\n", text)
        if opener:
            body = re.sub(r"\n?```\s*$", "", text[opener.end():]).rstrip()
            if body.strip():
                files[default_entry] = body
        elif re.match(r"\s*(?:<!doctype html|<html|<\?php|#!|import\s|from\s|def\s|class\s)",
                      text, re.IGNORECASE):
            files[default_entry] = text.strip()
    return {"files": files, "prose": prose}
