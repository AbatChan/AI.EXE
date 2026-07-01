"""§3 — POST /api/run-python: run generated Python in a sandbox, return logs+errors.

Not credit-metered (local compute, not an LLM call). The structured result (exit code,
stderr, retry_hint) is what the LLM auto-correction loop (item 4) will use to fix+re-run.
"""
from fastapi import APIRouter, HTTPException

from ..config import settings
from ..models import RunPythonRequest, RunPythonResult
from ..sandbox import run_python

router = APIRouter(tags=["run"])


@router.post("/run-python", response_model=RunPythonResult)
def run_python_endpoint(payload: RunPythonRequest) -> RunPythonResult:
    if not payload.code and not payload.files:
        raise HTTPException(status_code=400, detail="Provide `code` or `files`.")
    result = run_python(
        base_dir=settings.data_dir,
        code=payload.code,
        files=payload.files,
        entry=payload.entry,
        requirements=payload.requirements,
        stdin=payload.stdin,
        args=payload.args,
        timeout_seconds=payload.timeout_seconds,
    )
    return RunPythonResult(**result)
