#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v cmake >/dev/null 2>&1; then
  echo "CMake is not installed."
  echo "Install it with: brew install cmake"
  exit 1
fi

echo "[AI.EXE] Configuring macOS preview build..."
cmake -S . -B build

echo "[AI.EXE] Building targets..."
cmake --build build -j

mkdir -p "$SCRIPT_DIR/data/runtime"
if [ -f "$SCRIPT_DIR/build/infer_backend_stub" ]; then
  cp "$SCRIPT_DIR/build/infer_backend_stub" "$SCRIPT_DIR/data/runtime/infer_backend"
  chmod +x "$SCRIPT_DIR/data/runtime/infer_backend"
fi

APP_PATH="$SCRIPT_DIR/build/ai_exe_gui_mac.app"
if [ ! -d "$APP_PATH" ]; then
  echo "Expected app bundle not found at: $APP_PATH"
  exit 1
fi

echo "[AI.EXE] Launching macOS preview UI..."
open "$APP_PATH"
echo "[AI.EXE] Preview launched."
