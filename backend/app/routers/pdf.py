"""§10 — POST /api/pdf-to-software: PDF spec -> multi-agent build -> ready project.

Metered per agent call. Saves the stitched project (+ BUILD_LOG.md, MAPPING.md) and
returns the section→file mapping, build log, and a download link.
"""
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..config import settings
from ..llm import LLMClient, LLMError
from ..models import PdfToSoftwareResult
from ..pdf import extract_text, split_sections
from ..pdf_pipeline import render_mapping_md, run_pdf_to_software
from ..provider import is_local_provider
from ..sandbox import run_python
from ..services import api_key_store, project_store, provider_store, usage_manager
from ..usage import CreditExhausted, RateLimited

router = APIRouter(tags=["pdf"])


def _extract_docx(data: bytes) -> str:
    """Dependency-free .docx text: it's a zip; pull text from word/document.xml."""
    import io as _io
    import re as _re
    import zipfile
    with zipfile.ZipFile(_io.BytesIO(data)) as z:
        xml = z.read("word/document.xml").decode("utf-8", "replace")
    xml = _re.sub(r"</w:p>", "\n", xml)          # paragraph breaks
    xml = _re.sub(r"<w:tab[^>]*/>", "\t", xml)
    return _re.sub(r"<[^>]+>", "", xml).strip()  # drop remaining tags


ARCHIVE_MAX_FILES = 200
ARCHIVE_MAX_FILE_BYTES = 1_000_000
ARCHIVE_MAX_TOTAL_BYTES = 20_000_000
ARCHIVE_MAX_RATIO = 100  # zip-bomb guard (uncompressed / compressed)


def _archive_member_text(name: str, data: bytes) -> str:
    low = name.lower()
    if low.endswith(".pdf"):
        return extract_text(data)
    if low.endswith(".docx"):
        return _extract_docx(data)
    if b"\x00" in data[:4096]:
        return ""  # binary
    return data.decode("utf-8", "replace")


def _extract_archive(name: str, data: bytes) -> tuple[str, list[str]]:
    """Read text files inside a .zip/.tar(.gz) in memory — never written to disk."""
    import io as _io
    import tarfile
    import zipfile
    members: list[tuple[str, bytes]] = []
    skipped: list[str] = []
    total = 0
    if name.endswith(".zip"):
        with zipfile.ZipFile(_io.BytesIO(data)) as z:
            for info in z.infolist()[: ARCHIVE_MAX_FILES * 2]:
                path = info.filename
                if info.is_dir() or path.startswith("__MACOSX/") or "/." in f"/{path}":
                    continue
                if len(members) >= ARCHIVE_MAX_FILES or info.file_size > ARCHIVE_MAX_FILE_BYTES \
                        or (info.compress_size and info.file_size / info.compress_size > ARCHIVE_MAX_RATIO) \
                        or total + info.file_size > ARCHIVE_MAX_TOTAL_BYTES:
                    skipped.append(path)
                    continue
                total += info.file_size
                members.append((path, z.read(info)))
    else:
        with tarfile.open(fileobj=_io.BytesIO(data), mode="r:*") as t:
            for info in t.getmembers()[: ARCHIVE_MAX_FILES * 2]:
                if not info.isfile() or "/." in f"/{info.name}":
                    continue
                if len(members) >= ARCHIVE_MAX_FILES or info.size > ARCHIVE_MAX_FILE_BYTES \
                        or total + info.size > ARCHIVE_MAX_TOTAL_BYTES:
                    skipped.append(info.name)
                    continue
                handle = t.extractfile(info)
                if handle is None:
                    continue
                total += info.size
                members.append((info.name, handle.read()))
    parts, listing = [], []
    for path, blob in members:
        try:
            text = _archive_member_text(path, blob).strip()
        except Exception:
            text = ""
        if text:
            parts.append(f"=== {path} ===\n{text}")
            listing.append(path)
        else:
            skipped.append(path)
    header = f"Archive {name}: {len(listing)} readable file(s)" + (f", {len(skipped)} skipped (binary or too large)" if skipped else "")
    return header + "\n\n" + "\n\n".join(parts), listing


@router.post("/extract-text")
async def extract_text_endpoint(file: UploadFile = File(...)) -> dict:
    """Real text extraction for attached documents (PDF via pypdf, docx via zip). The desktop
    attachment flow POSTs docs here — reading a PDF's bytes as text only yields its structure."""
    data = await file.read()
    if not data:
        return {"ok": False, "detail": "empty upload", "text": ""}
    name = (file.filename or "").lower()
    try:
        if name.endswith(".pdf"):
            text = extract_text(data)
        elif name.endswith(".docx"):
            text = _extract_docx(data)
        elif name.endswith((".zip", ".tar", ".tar.gz", ".tgz")):
            text, _ = _extract_archive(name, data)
        else:
            text = data.decode("utf-8", "replace")
        text = (text or "").strip()
        return {"ok": bool(text), "text": text[:200000], "chars": len(text),
                "detail": "" if text else "no extractable text (scanned/image PDF?)"}
    except Exception as exc:  # never 500 the attach flow
        return {"ok": False, "detail": f"extract failed: {exc}", "text": ""}


@router.post("/pdf-to-software", response_model=PdfToSoftwareResult)
async def pdf_to_software(file: UploadFile = File(...), name: str = Form(None),
                          max_sections: int = Form(5)) -> PdfToSoftwareResult:
    base_url, model = provider_store.resolve()
    if not base_url:
        raise HTTPException(status_code=400, detail="No LLM provider configured — POST /api/provider or set AIEXE_LLM_BASE_URL.")
    local = is_local_provider(base_url)
    api_key = api_key_store.get_for_internal_use() or ("local" if local else None)
    if not api_key:
        raise HTTPException(status_code=400, detail="No API key set — POST /api/api-key first.")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload.")
    try:
        text = extract_text(data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read PDF: {exc}")
    sections = split_sections(text, max_sections)
    if not sections:
        raise HTTPException(status_code=400, detail="No extractable text in the PDF.")

    llm = LLMClient(base_url, model, api_key, kind=provider_store.kind())

    def sandbox_runner(files, requirements, timeout):
        return run_python(base_dir=settings.data_dir, code=None, files=files, entry="main.py",
                          requirements=requirements or [], stdin=None, args=[], timeout_seconds=timeout)

    try:
        charge = (lambda: None) if local else usage_manager.consume
        result = run_pdf_to_software(sections, llm, sandbox_runner, charge)
    except RateLimited as exc:
        raise HTTPException(status_code=429, detail="Rate limit reached.",
                            headers={"Retry-After": str(int(exc.retry_after) + 1)})
    except CreditExhausted:
        raise HTTPException(status_code=402, detail="Monthly credit limit reached.")
    except LLMError as exc:
        status = exc.status if exc.status in (401, 402, 403) else 502
        raise HTTPException(status_code=status, detail=str(exc))

    project = name or (file.filename or "pdf-project").rsplit(".", 1)[0]
    files = dict(result["files"])
    files["BUILD_LOG.md"] = result["build_log"]
    files["MAPPING.md"] = render_mapping_md(result["mapping"])
    saved = project_store.save(project, files, meta={"source": "pdf", "file": file.filename})
    result["project"] = saved["name"]
    result["download_path"] = f"/api/projects/{saved['name']}/download"
    return PdfToSoftwareResult(**result)
