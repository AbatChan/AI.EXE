"""AI.EXE backend (FastAPI) — exposes the AI.EXE core, Python runner, and packagers
as HTTP endpoints for the desktop UI / future separate frontend.

Run:  uvicorn app.main:app --host 127.0.0.1 --port 8765
Docs: http://127.0.0.1:8765/docs
"""
import os
import threading
import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import (adapter, generate, health, modules, package, pdf, projects, run,
                      status, usage, workshop)


def _watch_parent_and_exit() -> None:
    """When the desktop app launches us (AIEXE_PARENT_WATCH=1), exit as soon as it dies —
    so the backend never orphans on a crash/force-quit. No-op for standalone runs."""
    if not os.environ.get("AIEXE_PARENT_WATCH"):
        return
    parent = os.getppid()

    def loop():
        while True:
            time.sleep(2)
            try:
                os.kill(parent, 0)            # parent still alive?
            except (ProcessLookupError, PermissionError, OSError):
                os._exit(0)                   # app is gone — stop the backend too
            if os.getppid() != parent:        # reparented (parent died)
                os._exit(0)

    threading.Thread(target=loop, daemon=True).start()

app = FastAPI(
    title="AI.EXE Backend",
    version=settings.backend_version,
    description="Frontend -> Backend API -> AI.EXE core / Python runner / packagers.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# §1 spine. Later routers (generate, run-python, package, modules, usage, api-key)
# attach the same way under /api.
app.include_router(health.router)
app.include_router(status.router, prefix="/api")
app.include_router(usage.router, prefix="/api")
app.include_router(run.router, prefix="/api")
app.include_router(generate.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(package.router, prefix="/api")
app.include_router(modules.router, prefix="/api")
app.include_router(pdf.router, prefix="/api")
app.include_router(adapter.router, prefix="/api")


app.include_router(workshop.router)


@app.on_event("startup")
def _on_startup() -> None:
    _watch_parent_and_exit()


@app.get("/")
def root():
    return {"service": "ai-exe-backend", "version": settings.backend_version,
            "docs": "/docs", "workshop": "/workshop"}
