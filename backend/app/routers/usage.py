"""§8 — usage + API-key endpoints.

  GET  /api/usage      -> credit + rate-limit counters (read-only, not metered)
  POST /api/api-key    -> store provider key server-side (never echoed back raw)
  GET  /api/api-key    -> whether a key is set + masked form
"""
from fastapi import APIRouter

from ..models import (ApiKeySetRequest, ApiKeyStatusResponse, ProviderInfo,
                      ProviderRequest, ProviderUsageResponse, UsageResponse)
from ..provider_usage import read_provider_balance
from ..services import api_key_store, provider_store, usage_manager

router = APIRouter(tags=["usage"])


@router.get("/provider-usage", response_model=ProviderUsageResponse)
def provider_usage() -> ProviderUsageResponse:
    """The provider's REAL balance (Venice). Separate from /api/usage (the local meter)
    because it makes a network call — call it on demand, not on every poll."""
    base, _model = provider_store.resolve()
    key = api_key_store.get_for_internal_use()
    return ProviderUsageResponse(**read_provider_balance(base, key))


@router.post("/provider", response_model=ProviderInfo)
def set_provider(payload: ProviderRequest) -> ProviderInfo:
    provider_store.set(payload.base_url, payload.model)
    base, model = provider_store.resolve()
    return ProviderInfo(base_url=base, model=model, configured=provider_store.configured())


@router.get("/provider", response_model=ProviderInfo)
def get_provider() -> ProviderInfo:
    base, model = provider_store.resolve()
    return ProviderInfo(base_url=base, model=model, configured=provider_store.configured())


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
