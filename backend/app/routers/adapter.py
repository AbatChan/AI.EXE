"""Manage the Venice Pro adapter process: install / start / stop / status.

The desktop Settings 'Start adapter' button drives these. Credentials arrive per start()
and are passed to the subprocess env only — never persisted server-side.
"""
from fastapi import APIRouter

from ..models import AdapterActionResponse, AdapterStartRequest, AdapterStatusResponse
from ..services import adapter_manager

router = APIRouter(tags=["adapter"])


@router.get("/adapter/status", response_model=AdapterStatusResponse)
def adapter_status() -> AdapterStatusResponse:
    return AdapterStatusResponse(**adapter_manager.status())


@router.post("/adapter/install", response_model=AdapterActionResponse)
def adapter_install() -> AdapterActionResponse:
    # Synchronous: git clone + venv + pip can take a few minutes on first use.
    return AdapterActionResponse(**adapter_manager.install())


@router.post("/adapter/start", response_model=AdapterActionResponse)
def adapter_start(payload: AdapterStartRequest) -> AdapterActionResponse:
    return AdapterActionResponse(**adapter_manager.start(
        payload.username, payload.password, payload.port, payload.headless,
        hide_prompt=payload.hide_prompt, model=payload.model))


@router.post("/adapter/stop", response_model=AdapterActionResponse)
def adapter_stop() -> AdapterActionResponse:
    return AdapterActionResponse(**adapter_manager.stop())


@router.get("/adapter/logs")
def adapter_logs() -> dict:
    """Tail of the adapter's own output — so the fragile browser automation's failures
    (Chrome missing, login failed, Venice site changed) are visible in the UI."""
    return {"log": adapter_manager.read_log()}
