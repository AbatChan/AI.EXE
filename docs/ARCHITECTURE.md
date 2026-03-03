# Architecture Overview

## Core layers

1. Executable layer (`src/main.cpp`)
- Bootstraps directories
- Runs diagnostics
- Loads persistent memory
- Loads local model through `InferenceEngine`
- Provides controlled command loop
- Provides runtime status/log inspection and backend health controls (`:status`, `:log-tail`, `:timeline`, `:backend-reload`)

1b. Desktop UI layer (`src/gui_main_win.cpp`)
- Native Win32 dashboard executable (`ai_exe_gui.exe`)
- Client-facing controls for diagnostics, backend health, status, timeline, and prompt send
- Reuses the same local runtime modules (no network, no external APIs)

2. Hardware diagnostics (`src/diagnostics.*`)
- GPU presence (Windows DXGI)
- VRAM availability
- RAM availability
- Storage availability
- CUDA driver presence/version probe (`nvcuda.dll`)

3. Inference engine interface (`src/inference_engine.*`)
- Local-only model path
- No network calls
- GGUF header validation
- Optional local backend execution (`data/runtime/infer_backend.exe`) through constrained process runner
- Backend startup/health self-test (`--self-test`) with safe fallback to placeholder

4. Process runner (`src/process_runner.*`)
- Centralized Windows process launch controls
- Restricted-token attempt
- Job object limits (single process + memory cap)
- CPU rate limiting (when supported by host OS)
- Timeout enforcement + output capture cap

5. Sandboxed runtime (`src/sandbox.*`)
- Restricts file operations to whitelisted roots
- Canonical path checks
- Basic prompt safety checks for code-like inputs
- Uses process runner for controlled `.exe` execution in allowed roots

6. Persistent memory (`src/memory_store.*`)
- Durable local key-value memory
- Atomic save with temporary file swap

7. Logging + rollback (`src/logger.*`, `src/rollback.*`)
- JSONL event logging
- Snapshot creation and restore for target files

8. Packaging and validation (`scripts/*.ps1`)
- Offline bundle creation for Windows release binaries
- Manifest-backed bundle integrity and startup/backend verification checks

## Security controls

- Prompt validation and suspicious token filtering
- Runtime command restrictions
- Filesystem root whitelisting
- Execution restricted to sandbox-local `.exe` targets
- No registry writes or driver interaction

## Next integration tasks

- Replace inference placeholder with embedded quantized runtime
- Harden sandboxing with restricted token/AppContainer isolation where available
- Add GPU/VRAM live telemetry panel in GUI shell
