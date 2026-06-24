"""§10 — PDF parsing + sectioning for the PDF-to-software pipeline."""
import io
import math
import re
from typing import Dict, List


def extract_text(data: bytes) -> str:
    from pypdf import PdfReader  # lazy: only needed for PDF input
    reader = PdfReader(io.BytesIO(data))
    return "\n".join((page.extract_text() or "") for page in reader.pages).strip()


def split_sections(text: str, max_sections: int = 5) -> List[Dict[str, str]]:
    """Split a spec into logical sections (by blank-line paragraphs, grouped into at most
    `max_sections` contiguous chunks). Each chunk is dispatched to one agent."""
    text = (text or "").strip()
    if not text:
        return []
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()] or [text]
    max_sections = max(1, int(max_sections or 5))
    if len(paras) <= max_sections:
        groups = [[p] for p in paras]
    else:
        size = math.ceil(len(paras) / max_sections)
        groups = [paras[i:i + size] for i in range(0, len(paras), size)]
    out = []
    for g in groups:
        body = "\n\n".join(g)
        out.append({"title": body.split("\n", 1)[0][:60], "text": body})
    return out
