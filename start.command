#!/usr/bin/env bash
# AI.EXE — start the backend + desktop app together, and stop the backend on exit.
# Double-click this file (or run ./start.command). One process from your side.
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_URL="http://127.0.0.1:8765"
APP="$ROOT/build-mac-preview/ai_exe_gui_mac.app/Contents/MacOS/ai_exe_gui_mac"

if [ ! -x "$APP" ]; then
  echo "App not built. Build it first:"
  echo "  cmake -S \"$ROOT\" -B \"$ROOT/build-mac-preview\" && cmake --build \"$ROOT/build-mac-preview\" -j4"
  exit 1
fi

STARTED_BACKEND=""
if curl -s -o /dev/null "$BACKEND_URL/health"; then
  echo "Backend already running — reusing it."
else
  echo "Starting AI.EXE backend…"
  ( cd "$ROOT/backend" && ./run.sh ) >/tmp/aiexe_backend.log 2>&1 &
  STARTED_BACKEND="yes"
fi

cleanup() {
  if [ -n "$STARTED_BACKEND" ]; then
    echo "Stopping backend…"
    pkill -f "uvicorn app.main:app" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

# First run builds a venv + installs deps, so allow generous time.
printf "Waiting for backend"
for _ in $(seq 1 180); do
  if curl -s -o /dev/null "$BACKEND_URL/health"; then printf " ready\n"; break; fi
  printf "."; sleep 1
done
if ! curl -s -o /dev/null "$BACKEND_URL/health"; then
  echo
  echo "Backend did not come up — see /tmp/aiexe_backend.log"
  exit 1
fi

echo "Launching AI.EXE…  (quit the app to stop everything)"
"$APP"
