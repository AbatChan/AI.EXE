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
BUILD_DIR="${AI_EXE_MAC_PREVIEW_BUILD_DIR:-$SCRIPT_DIR/build-mac-preview}"
cmake -S . -B "$BUILD_DIR"

echo "[AI.EXE] Building targets..."
cmake --build "$BUILD_DIR" -j

mkdir -p "$SCRIPT_DIR/data/runtime"
if [ -f "$BUILD_DIR/infer_backend_stub" ]; then
  cp "$BUILD_DIR/infer_backend_stub" "$SCRIPT_DIR/data/runtime/infer_backend"
  chmod +x "$SCRIPT_DIR/data/runtime/infer_backend"
fi

APP_PATH="$BUILD_DIR/ai_exe_gui_mac.app"
if [ ! -d "$APP_PATH" ]; then
  echo "Expected app bundle not found at: $APP_PATH"
  exit 1
fi

echo "[AI.EXE] Launching macOS preview UI..."
open -W -n "$APP_PATH" &
OPEN_PID=$!
sleep 0.5
if ! kill -0 "$OPEN_PID" >/dev/null 2>&1; then
  echo "[AI.EXE] macOS open failed; launching bundle executable directly..."
  "$APP_PATH/Contents/MacOS/ai_exe_gui_mac" &
fi
echo "[AI.EXE] Preview launched."
