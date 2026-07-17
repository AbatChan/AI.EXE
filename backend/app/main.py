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
from .routers import (adapter, finance, generate, health, modules, package, pdf, projects, run,
                      status, usage, workshop)
from .services import adapter_manager


def _stop_children() -> None:
    """Stop subprocesses the backend owns (the Venice Pro adapter) so nothing orphans."""
    try:
        adapter_manager.stop()
    except Exception:
        pass


def _watch_parent_and_exit() -> None:
    """When the desktop app launches us (AIEXE_PARENT_WATCH=1), exit as soon as it dies —
    so the backend never orphans on a crash/force-quit. No-op for standalone runs."""
    if not os.environ.get("AIEXE_PARENT_WATCH"):
        return
    parent = os.getppid()
    if os.name == "nt":
        _watch_parent_windows(parent)
    else:
        _watch_parent_posix(parent)


def _watch_parent_posix(parent: int) -> None:
    def loop():
        while True:
            time.sleep(2)
            try:
                os.kill(parent, 0)            # signal 0 = harmless existence probe (POSIX only)
            except (ProcessLookupError, PermissionError, OSError):
                _stop_children()              # app is gone — take the adapter with us
                os._exit(0)
            if os.getppid() != parent:        # reparented (parent died)
                _stop_children()
                os._exit(0)

    threading.Thread(target=loop, daemon=True).start()


def _watch_parent_windows(parent: int) -> None:
    # NEVER use os.kill(pid, 0) here: on Windows any non-CTRL signal maps to
    # TerminateProcess, and OpenProcess(PROCESS_ALL_ACCESS) on the GUI parent gets
    # access-denied -> OSError -> the backend used to kill itself ~2s after boot.
    # SYNCHRONIZE is grantable to a same-user child; wait on the parent handle instead.
    import ctypes
    from ctypes import wintypes

    SYNCHRONIZE = 0x00100000
    INFINITE = 0xFFFFFFFF
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent)
    if not handle:
        return  # can't observe the parent — keep serving rather than suicide

    def loop():
        kernel32.WaitForSingleObject(handle, INFINITE)  # blocks until parent exits
        _stop_children()
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
app.include_router(finance.router, prefix="/api")
app.include_router(pdf.router, prefix="/api")
app.include_router(adapter.router, prefix="/api")


app.include_router(workshop.router)


@app.on_event("startup")
def _on_startup() -> None:
    _watch_parent_and_exit()


@app.on_event("shutdown")
def _on_shutdown() -> None:
    # Graceful stop (app quit -> SIGTERM -> uvicorn shutdown): retire the adapter now.
    _stop_children()


@app.get("/")
def root():
    return {"service": "ai-exe-backend", "version": settings.backend_version,
            "docs": "/docs", "workshop": "/workshop"}
