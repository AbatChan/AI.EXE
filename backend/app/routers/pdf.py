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
