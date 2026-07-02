"""§8 — usage + API-key endpoints.

  GET  /api/usage      -> credit + rate-limit counters (read-only, not metered)
  POST /api/api-key    -> store provider key server-side (never echoed back raw)
  GET  /api/api-key    -> whether a key is set + masked form
"""
from fastapi import APIRouter

from fastapi import HTTPException

from ..llm import LLMClient, LLMError
from ..models import (ApiKeySetRequest, ApiKeyStatusResponse, ProviderCompleteRequest,
                      ProviderCompleteResponse, ProviderHealthResponse, ProviderInfo,
                      ProviderRequest, ProviderUsageResponse, UsageResponse)
from ..provider import is_local_provider
from ..provider_usage import read_provider_balance, read_provider_health
from ..services import api_key_store, provider_store, usage_manager

router = APIRouter(tags=["usage"])


@router.post("/provider/complete", response_model=ProviderCompleteResponse)
def provider_complete(payload: ProviderCompleteRequest) -> ProviderCompleteResponse:
    """Server-side chat passthrough for the desktop agent when it uses a local/Ollama
    provider (the Venice Pro adapter) — the WebView can't reach the adapter directly
    (no CORS), but the backend can. Restricted to local/Ollama so remote providers keep
    going through the metered path."""
    base, model = provider_store.resolve()
    kind = provider_store.kind()
    if not base:
        raise HTTPException(status_code=400, detail="No provider configured.")
    if kind != "ollama" and not is_local_provider(base):
        raise HTTPException(status_code=400, detail="Passthrough is for local/adapter providers only.")
    api_key = api_key_store.get_for_internal_use() or "local"
    llm = LLMClient(base, model, api_key, kind=kind)
    try:
        content = llm.complete(payload.messages, temperature=payload.temperature,
                               max_tokens=payload.max_tokens, chat_id=payload.chat_id)
        return ProviderCompleteResponse(ok=bool(content.strip()), content=content)
    except LLMError as exc:
        return ProviderCompleteResponse(ok=False, error=str(exc))


@router.get("/provider-usage", response_model=ProviderUsageResponse)
def provider_usage() -> ProviderUsageResponse:
    """The provider's REAL balance (Venice). Separate from /api/usage (the local meter)
    because it makes a network call — call it on demand, not on every poll."""
    base, _model = provider_store.resolve()
    key = api_key_store.get_for_internal_use()
    return ProviderUsageResponse(**read_provider_balance(base, key))


@router.get("/provider-health", response_model=ProviderHealthResponse)
def provider_health() -> ProviderHealthResponse:
    """Monitor: is the configured provider (incl. the Venice Pro adapter) reachable, and
    what models does it expose? Network call — poll on demand."""
    base, _model = provider_store.resolve()
    return ProviderHealthResponse(**read_provider_health(base, provider_store.kind()))


@router.post("/provider", response_model=ProviderInfo)
def set_provider(payload: ProviderRequest) -> ProviderInfo:
    provider_store.set(payload.base_url, payload.model, payload.kind)
    base, model = provider_store.resolve()
    return ProviderInfo(base_url=base, model=model, kind=provider_store.kind(),
                        configured=provider_store.configured())


@router.get("/provider", response_model=ProviderInfo)
def get_provider() -> ProviderInfo:
    base, model = provider_store.resolve()
    return ProviderInfo(base_url=base, model=model, kind=provider_store.kind(),
                        configured=provider_store.configured())


@router.get("/usage", response_model=UsageResponse)
def usage() -> UsageResponse:
    return UsageResponse(**usage_manager.snapshot())


@router.post("/api-key", response_model=ApiKeyStatusResponse)
def set_api_key(payload: ApiKeySetRequest) -> ApiKeyStatusResponse:
    api_key_store.set(payload.api_key)
    return ApiKeyStatusResponse(set=api_key_store.is_set(), masked=api_key_store.masked())


@router.get("/api-key", response_model=ApiKeyStatusResponse)
def get_api_key() -> ApiKeyStatusResponse:
    return ApiKeyStatusResponse(set=api_key_store.is_set(), masked=api_key_store.masked())
