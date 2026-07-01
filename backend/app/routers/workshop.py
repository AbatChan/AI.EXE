"""§9/§6 — serve the Workshop frontend (the UI that drives the backend pipeline).

The page lives in the desktop app's `ui/workshop.html`; the backend serves it for
dev/standalone use. In the packaged desktop app the same file is loaded by the WebView.
"""
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(tags=["workshop"])

# backend/app/routers/workshop.py -> repo root -> ui/workshop.html
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
_CANDIDATES = [
    os.path.join(_REPO_ROOT, "ui", "workshop.html"),
    os.path.join(os.path.dirname(_REPO_ROOT), "ui", "workshop.html"),
]


@router.get("/workshop")
def workshop():
    for path in _CANDIDATES:
        if os.path.isfile(path):
            return FileResponse(path, media_type="text/html")
    raise HTTPException(status_code=404, detail="workshop.html not found (expected in ui/).")
