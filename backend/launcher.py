"""Frozen and source entry point for the local AI.EXE API backend."""
import os
import sys
import traceback


_backend_log = None


def configure_frozen_runtime() -> None:
    if not getattr(sys, "frozen", False):
        return
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    os.environ.setdefault("AIEXE_BACKEND_DATA_DIR", os.path.join(base, "AI_EXE", "backend"))
    os.environ.setdefault("AIEXE_PARENT_WATCH", "1")
    os.makedirs(os.environ["AIEXE_BACKEND_DATA_DIR"], exist_ok=True)


def redirect_frozen_server_logs() -> None:
    global _backend_log
    if not getattr(sys, "frozen", False):
        return
    path = os.path.join(os.environ["AIEXE_BACKEND_DATA_DIR"], "backend.log")
    _backend_log = open(path, "a", encoding="utf-8", buffering=1)
    sys.stdout = _backend_log
    sys.stderr = _backend_log


def main() -> None:
    configure_frozen_runtime()
    if len(sys.argv) > 1 and sys.argv[1] == "--adapter-selfcheck":
        # CI guard: prove the adapter's runtime deps are frozen in (flask/gevent were
        # missing -> ModuleNotFoundError only when the adapter actually launched).
        import flask  # noqa: F401
        import gevent  # noqa: F401
        from gevent.pywsgi import WSGIServer  # noqa: F401
        import selenium  # noqa: F401
        import webdriver_manager  # noqa: F401
        print("adapter-selfcheck ok")
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--adapter-boot":
        from app import adapter_boot
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        adapter_boot.main()
        return

    redirect_frozen_server_logs()
    import uvicorn
    from app.config import settings
    from app.main import app
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        raise
