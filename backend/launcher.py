"""Frozen and source entry point for the local AI.EXE API backend."""
import os
import sys


def configure_frozen_runtime() -> None:
    if not getattr(sys, "frozen", False):
        return
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    os.environ.setdefault("AIEXE_BACKEND_DATA_DIR", os.path.join(base, "AI_EXE", "backend"))
    os.environ.setdefault("AIEXE_PARENT_WATCH", "1")
    os.makedirs(os.environ["AIEXE_BACKEND_DATA_DIR"], exist_ok=True)


def main() -> None:
    configure_frozen_runtime()
    if len(sys.argv) > 1 and sys.argv[1] == "--adapter-boot":
        from app import adapter_boot
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        adapter_boot.main()
        return

    import uvicorn
    from app.config import settings
    from app.main import app
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
