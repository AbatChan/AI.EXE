"""GET /health — liveness probe (Build Order §1, acceptance: /health)."""
from fastapi import APIRouter

from ..config import settings
from ..models import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="ai-exe-backend", version=settings.backend_version)
