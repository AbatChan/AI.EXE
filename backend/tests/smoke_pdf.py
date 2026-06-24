"""Logic tests for §10 PDF-to-software. Builds a real minimal PDF to test extraction,
then runs the multi-agent pipeline with a fake LLM + the real sandbox.

Run:  python backend/tests/smoke_pdf.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.pdf import extract_text, split_sections  # noqa: E402
from app.pdf_pipeline import render_mapping_md, run_pdf_to_software  # noqa: E402
from app.sandbox import run_python  # noqa: E402

base = tempfile.mkdtemp()
passed = 0


def ok(name):
    global passed
    passed += 1
    print(f"PASS: {name}")


def make_pdf(lines):
    """A minimal single-page PDF with extractable text (Tj operators)."""
    text_ops = " ".join(f"({ln}) Tj 0 -16 Td" for ln in lines)
    content = f"BT /F1 12 Tf 72 760 Td {text_ops} ET".encode()
    parts = [b"%PDF-1.4\n"]
    offsets = {}

    def add(n, body):
        offsets[n] = sum(len(p) for p in parts)
        parts.append(f"{n} 0 obj\n".encode() + body + b"\nendobj\n")

    add(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    add(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    add(3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
           b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>")
    add(4, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    add(5, f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
    xref_pos = sum(len(p) for p in parts)
    xref = [b"xref\n0 6\n0000000000 65535 f \n"]
    for n in range(1, 6):
        xref.append(f"{offsets[n]:010d} 00000 n \n".encode())
    parts.append(b"".join(xref))
    parts.append(f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF".encode())
    return b"".join(parts)


# 1) Extract text from a real PDF.
pdf_bytes = make_pdf(["Build a greeter tool", "It should print a friendly hello"])
text = extract_text(pdf_bytes)
assert "greeter" in text.lower() and "hello" in text.lower(), repr(text)
ok("extracts text from a real PDF")

# 2) Section splitting.
secs = split_sections("Foundation part one.\n\nLogic part two.\n\nRuntime part three.", max_sections=5)
assert len(secs) == 3 and secs[0]["title"].startswith("Foundation")
ok("splits a spec into sections")


# 3) Multi-agent pipeline with a fake LLM + real sandbox.
class FakeLLM:
    def __init__(self):
        self.calls = 0

    def complete(self, messages, **kw):
        self.calls += 1
        # first agent produces a runnable main.py; others add helper files.
        if self.calls == 1:
            return "```python\n# main.py\nprint('assembled from pdf')\n```"
        return f"```python\n# mod_{self.calls}.py\nVALUE = {self.calls}\n```"


def runner(files, reqs, timeout):
    return run_python(base, code=None, files=files, entry="main.py",
                      requirements=reqs or [], stdin=None, args=[], timeout_seconds=timeout)


llm = FakeLLM()
res = run_pdf_to_software(secs, llm, runner, lambda: None)
assert res["ok"] and "main.py" in res["files"] and llm.calls == 3
assert len(res["mapping"]) == 3 and res["build_log"]
ok("runs one agent per section and aggregates files")

# 4) main.py is validated in the sandbox.
assert res["run_ok"] is True
ok("stitched project's main.py is validated (runs clean)")

# 5) Mapping renders to markdown.
md = render_mapping_md(res["mapping"])
assert md.startswith("# PDF section") and "agent:" in md
ok("section→file mapping renders to markdown")

print(f"\n{passed} checks passed.")
