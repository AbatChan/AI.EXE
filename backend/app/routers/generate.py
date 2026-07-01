"""§2 — POST /api/generate: prompt -> code -> sandbox run -> auto-correct.

Credit-metered PER LLM CALL (initial + each retry), via usage_manager.consume() inside
the loop — so a 2-retry generation costs up to 3 credits, matching "1 request = 1 credit".
"""
from fastapi import APIRouter, HTTPException

from ..config import settings
from ..generate import run_generation, system_for
from ..llm import LLMClient, LLMError
from ..models import GenerateRequest, GenerateResult
from ..provider import is_local_provider
from ..sandbox import run_python
from ..services import api_key_store, project_store, provider_store, usage_manager
from ..usage import CreditExhausted, RateLimited

router = APIRouter(tags=["generate"])


@router.post("/generate", response_model=GenerateResult)
def generate(payload: GenerateRequest) -> GenerateResult:
    # Validate config BEFORE metering so a misconfigured call never costs a credit.
    base_url, model = provider_store.resolve()
    if not base_url:
        raise HTTPException(status_code=400, detail="No LLM provider configured — POST /api/provider or set AIEXE_LLM_BASE_URL.")
    # A local model (Ollama/llama.cpp) needs no key and costs no credits.
    local = is_local_provider(base_url)
    api_key = api_key_store.get_for_internal_use() or ("local" if local else None)
    if not api_key:
        raise HTTPException(status_code=400, detail="No API key set — POST /api/api-key first.")

    llm = LLMClient(base_url, model, api_key, kind=provider_store.kind())
    charge = (lambda: None) if local else usage_manager.consume

    def sandbox_runner(files, requirements, timeout):
        return run_python(
            base_dir=settings.data_dir, code=None, files=files, entry=payload.entry,
            requirements=requirements or [], stdin=None, args=[], timeout_seconds=timeout,
        )

    try:
        result = run_generation(
            prompt=payload.prompt, llm=llm, sandbox_runner=sandbox_runner,
            charge=charge, system_prompt=system_for(payload.language),
            run=payload.run, auto_correct=payload.auto_correct,
            max_retries=payload.max_retries, requirements=payload.requirements,
            timeout_seconds=payload.timeout_seconds, entry=payload.entry,
        )
    except RateLimited as exc:
        retry_after = int(exc.retry_after) + 1
        raise HTTPException(status_code=429, detail=f"Rate limit reached. Retry in ~{retry_after}s.",
                            headers={"Retry-After": str(retry_after)})
    except CreditExhausted:
        raise HTTPException(status_code=402, detail="Monthly credit limit reached.")
    except LLMError as exc:
        status = exc.status if exc.status in (401, 402, 403) else 502
        raise HTTPException(status_code=status, detail=str(exc))

    # §2 step 5 — persist the output to a named project folder when requested.
    if payload.project and result.get("files"):
        try:
            saved = project_store.save(payload.project, result["files"], meta={"prompt": payload.prompt})
            result["project"] = saved["name"]
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    return GenerateResult(**result)
