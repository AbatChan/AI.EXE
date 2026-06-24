"""GET /api/status — AI.EXE core + subsystem status (acceptance: core status shown).

Each subsystem flips from "not_implemented" to "ready" as it is built, so the UI's
core-status indicator stays honest about what actually works.
"""
import time

from fastapi import APIRouter

from ..config import settings
from ..models import StatusResponse, SubsystemStatus

router = APIRouter(tags=["status"])

# The spine, in Build-Order (§12). Update `state` as each lands.
_SUBSYSTEMS = [
    ("api", "ready", "§1 backend skeleton"),
    ("api_key_credits", "ready", "§8 rate limit 20/60s, 7.5k credits/mo (Venice Pro+), key server-side"),
    ("python_sandbox", "ready", "§3 subprocess sandbox: temp workdir, rlimits, timeout, guard"),
    ("generate", "ready", "§2 LLM -> code -> sandbox run -> auto-correct (metered)"),
    ("file_output", "ready", "§2 project/output folders: save, list, read, zip download"),
    ("output_selector", "ready", "§4/§6 Workshop UI selector (py/exe/web) at /workshop"),
    ("packager", "ready", "§4/§5 .py + native .exe (PyInstaller); .apk/.pt later"),
    ("modules", "ready", "§6/§7 upload/list/connect under <workshop>/modules/"),
    ("pdf_to_software", "ready", "§10 PDF → sections → agents → stitched project (metered)"),
]


@router.get("/status", response_model=StatusResponse)
def status() -> StatusResponse:
    subsystems = [SubsystemStatus(name=n, state=s, detail=d) for n, s, d in _SUBSYSTEMS]
    return StatusResponse(
        service="ai-exe-backend",
        version=settings.backend_version,
        core_state="online",
        uptime_seconds=round(time.time() - settings.started_at, 3),
        subsystems=subsystems,
    )
