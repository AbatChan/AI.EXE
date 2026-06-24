#!/usr/bin/env bash
# Start the AI.EXE backend (FastAPI) on 127.0.0.1:8765 in a local venv.
set -e
cd "$(dirname "$0")"
python3 -m venv .venv 2>/dev/null || true
# shellcheck disable=SC1091
. .venv/bin/activate
pip install -q --disable-pip-version-check -r requirements.txt
exec uvicorn app.main:app --host "${AIEXE_BACKEND_HOST:-127.0.0.1}" --port "${AIEXE_BACKEND_PORT:-8765}" "$@"
