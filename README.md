# AI.EXE Phase 1 Foundation (Offline-Only)

This repository contains a zero-dependency C++ foundation for AI.EXE Phase 1:

- 100% offline runtime
- No external APIs
- Diagnostics before model load
- Local persistent memory
- Local logging
- Config snapshot + rollback
- Sandboxed filesystem operations
- Local inference interface (model integration point)

## Build

### Windows (MSVC)

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

Output binary:

- `build/Release/ai_exe.exe`
- `build/Release/ai_exe_gui.exe` (Windows dashboard UI, WebView host for `ui/ai-exe.html`)
- `build/Release/infer_backend_stub.exe` (local backend adapter; invokes bundled `llama-cli.exe`)

### Other OS (dev-only)

The project also compiles on non-Windows for development, but hardware diagnostics are conservative stubs outside Windows.

```bash
cmake -S . -B build
cmake --build build -j
```

macOS preview UI output:

- `build/ai_exe_gui_mac.app` (native Cocoa dashboard for preview/demo only)

## Runtime layout (created automatically)

- `data/model/` model file location
- `data/runtime/infer_backend.exe` local backend adapter (Windows runtime)
- `data/runtime/infer_backend` local backend adapter (non-Windows preview runtime)
- `data/runtime/llama-cli.exe` or `data/runtime/llama-cli` local inference engine binary (no network)
- `data/logs/events.log` JSONL event log
- `data/memory/state.kv` persistent key-value memory
- `data/snapshots/` rollback snapshots
- `data/sandbox/` allowed execution workspace

## Phase 1 scope

This is a controlled local AI shell, not autonomous self-modifying AGI.

## Controlled execution

- `:exec <relative-exe> [args]` runs a child process only from `data/sandbox/`
- Windows build attempts restricted-token launch first, then controlled fallback.
- Windows build enforces single-process job object limits.
- Windows build enforces a per-process memory cap.
- Windows build applies per-process CPU rate cap when supported.
- Windows build enforces runtime timeout kill.
- Windows build enforces output capture size limits.
- Pre-checkpoint snapshots run before mutable writes (`:mem-set`, overwriting `:sandbox-write`).

## Inference backend contract

- If present, `data/runtime/infer_backend.exe` (Windows) or `data/runtime/infer_backend` (non-Windows preview) is invoked locally by `InferenceEngine`.
- Arguments passed include `--model <absolute-path-to-model.gguf>`.
- Arguments passed include `--prompt <user-prompt>`.
- Healthcheck argument `--self-test` should be supported.
- Version argument `--version` should be supported.
- Backend should print response text to stdout.
- Backend should return exit code `0` on success.
- `--self-test` should print `SELF_TEST_OK` on success.
- Backend should not use network access.

## Backend adapter (included target)

- `infer_backend_stub` is a local adapter target that launches a colocated `llama-cli` binary.
- For Windows packaging, copy `infer_backend_stub.exe` to `data/runtime/infer_backend.exe`.
- For macOS preview, copy `infer_backend_stub` to `data/runtime/infer_backend`.
- Place `llama-cli(.exe)` in the same `data/runtime/` folder or set `AI_EXE_LLM_ENGINE_PATH`.
- Runtime now keeps a persistent local `llama-cli` session (model stays loaded between prompts) and falls back to one-shot backend calls if the persistent path fails.
- Set `AI_EXE_DISABLE_PERSISTENT_SESSION=1` to force legacy one-shot behavior for troubleshooting.

## CLI runtime visibility

- `:status` prints model/backend/memory/snapshot/log-path summary.
- `:backend-selftest` runs backend healthcheck and disables backend if it fails.
- `:backend-reload` reconfigures backend path and reruns healthcheck at runtime.
- `:backend-status` includes backend version and health state.
- `:log-tail [n]` prints recent JSONL activity from `data/logs/events.log`.
- `:timeline [n]` prints parsed timeline entries (`ts/level/event/message`).

## GUI

- Windows: launch `ai_exe_gui.exe` for a non-terminal dashboard.
- Windows GUI loads local HTML from `ui/ai-exe.html` (copied next to executable after build).
- GUI/window/panel behavior is centrally configured in CMake cache vars (`AI_EXE_MIN_WIDTH`, `AI_EXE_MIN_HEIGHT`, `AI_EXE_DEFAULT_WIDTH`, `AI_EXE_DEFAULT_HEIGHT`, `AI_EXE_SIDEBAR_*`, `AI_EXE_RIGHT_*`, `AI_EXE_MIDDLE_MIN_WIDTH`, `AI_EXE_RESIZER_WIDTH`, `AI_EXE_UI_*`).
- CMake generates shared config files: `generated/ui_constants.h` (native hosts) and `generated/ui/ui-config.js` (HTML).
- Windows GUI uses WebView2 at runtime; include `WebView2Loader.dll` in bundle for portable/offline deployment.
- macOS preview: run `open build/ai_exe_gui_mac.app`.
- macOS one-click: double-click `/Users/macbookair2020/Downloads/AI EXE/RUN_MAC_PREVIEW.command`.
- macOS preview uses a bundled WebView UI from `/Users/macbookair2020/Downloads/AI EXE/ui/ai-exe.html`.
- bundled copy path inside app: `build/ai_exe_gui_mac.app/Contents/Resources/ai-exe.html`.

## Release packaging

- Windows bundle script: `/Users/macbookair2020/Downloads/AI EXE/scripts/package_windows.ps1`
- Bundle validation script: `/Users/macbookair2020/Downloads/AI EXE/scripts/validate_bundle.ps1`
- Deployment guide: `/Users/macbookair2020/Downloads/AI EXE/docs/DEPLOYMENT.md`
