# Architecture Overview

AI.EXE is a desktop AI workbench: a native shell hosting a web UI that contains
the entire product brain (chat + a multi-tool coding agent), talking to hosted
model providers, with an optional local FastAPI backend for sandboxed execution
and packaging. Windows is the shipped target; macOS is the dev/preview host.

The four layers below are peers — none of them is "the app" alone.

## 1. Host shells (`src/gui_main_*.cpp|mm`)

Two thin native executables load the SAME `ui/` bundle:

- `src/gui_main_win_webview.cpp` — WebView2, the shipped `AI.EXE.exe`.
- `src/gui_main_mac_web.mm` — WKWebView, dev/preview builds (`build-mac-preview/`).

Each shell exposes a JSON-action native bridge (`web_runtime_bridge` + per-host
handlers) that the UI calls for everything that needs the OS:

- Workspace filesystem (list/read/write/move/trash), jailed to the open project root.
- Smart Run (`src/run_target.h`): web → local static server (`src/local_app_server`),
  Vite → generated launcher with `npm install` + `--legacy-peer-deps` retry,
  Python → system interpreter in a console.
- Terminal runner (`src/command_runner.h` → `src/process_runner`): allowlisted
  argv-only project commands (no raw shell), timeouts, output caps.
- Dev server manager (`src/dev_server_manager.h`): long-running servers tracked
  with pid/logs/Stop; killed with the app (POSIX process groups / Windows Job objects).
- Backend lifecycle, auto-update download/swap, window management.

## 2. UI harness (`ui/`) — the product brain

All product logic is JavaScript in the webview. Main pieces:

- `ai-exe.js` — app shell: chats, settings, providers, composer, send gating,
  confirmation cards (project scope / command approval / delete), update badge.
- Chat stack: `chat-shell.js`, `chat-renderer.js`, `markdown-renderer.js` —
  streaming, activity cards (writes/edits/commands/dev-servers), work panel.
- **Agent stack** (the part with years of failure-mode encoding — see
  `docs/DECISION_AUTHORITY.md` before changing it):
  - `preflight-router.js` — routes a message (chat / inspect / agent / confirm).
  - `agent-planner.js` — plan + per-step decision prompts, pending requirements,
    generated-content sanitizers.
  - `agent-loop.js` — the run loop: phased builds (`.aiexe/plan.md` is the
    cross-run source of truth), guards, checklist, finalization honesty.
  - `agent-executor.js` — tool execution (read/write/edit/validate/run_command/
    dev servers), command policy (auto-safe / ask-first / blocked).
  - `agent-core.js`, `agent-runtime.js` — shared helpers, file generation.
- Workspace stack: `workspace-core/actions/renderer.js`, `file-viewer.js`
  (CodeMirror 6 — rebuild the vendor bundle with `npm run build:codemirror`).
- Prompts live in `ui/prompts/*.md` with fallbacks in `prompt-core.js` — keep
  the two in sync; new prompt files need a CMake reconfigure to bundle.

## 3. Inference providers

- **Hosted APIs** (the shipped path): any OpenAI-compatible endpoint with the
  user's key; model lists fetched live from the provider.
- **Venice Pro browser adapter** (`backend/app/venice_adapter_server.py`):
  Selenium-driven venice.ai session exposed as an Ollama-like local API
  (port 9999), managed by the backend. Powerful but experimental — browser
  automation against a changing site.
- **Local GGUF runtime** (`infer_backend` stub): placeholder-grade; the strict
  offline story is a future/phase-3 deliverable, not the live product.

## 4. Optional FastAPI backend (`backend/`, port 8765)

Adds what a webview can't do alone: the adapter lifecycle, sandboxed code
execution (macOS seatbelt jail; **Windows jail not yet implemented — known
gap**), project packaging (`.py` / native `.exe` / `.html`), PDF/DOCX text
extraction, and the Workshop pipeline (prompt → generate → run → auto-correct →
package). The Workshop is a **separate, simpler agent** from the desktop UI
agent — a batch pipeline without the UI harness's guards. That split is
intentional; don't assume fixes in one apply to the other.

## Legacy layer (kept building, not the product)

`src/main.cpp` (`ai_exe` CLI), `memory_store`, `rollback`, and the phase-1
offline bundle scripts (`scripts/package_windows.ps1`, `validate_bundle.ps1`)
are the original offline-first deliverable. See the release matrix in
`docs/DEPLOYMENT.md` — the live release is the hosted GUI zip from CI.

## Security posture (honest version)

Real today: workspace-jailed file bridge, argv-allowlisted terminal commands
(enforced in both JS policy and C++), shell metacharacters blocked, ask-first
approval cards for installs/publishes, per-action delete confirmation, macOS
seatbelt jail for backend code runs, processes die with the app.

Known gaps: no Windows filesystem jail for backend code execution (the client
platform — top of the security backlog); the Venice adapter is browser
automation and inherits that fragility.
