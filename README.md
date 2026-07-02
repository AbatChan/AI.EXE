# AI.EXE

A desktop AI workbench for building software. You chat with a model, and in agent
mode it plans, writes, edits, and validates real multi-file projects in a local
workspace — with a file explorer, code editor, live preview, and one-click run.

Windows is the primary target. macOS builds are used for development and preview.

## Download

Grab the latest `AI.EXE-Windows.zip` from
[Releases](https://github.com/AbatChan/AI.EXE/releases). Unzip and run
`AI.EXE.exe` — no installer. The app checks for new releases and can update
itself in place; chats and settings survive updates.

## What it does

- **Chat** — talk to a hosted model of your choice. Bring your own API key for
  any OpenAI-compatible provider, or point it at a local Ollama-compatible
  endpoint. Reasoning ("Think") mode, canvas artifacts, file attachments.
- **Agent mode** — turns a prompt into a working project: it plans the file
  structure, writes and edits files, validates them, and runs the result.
  Large builds are split into phases you advance with Continue.
- **Workspace** — a real folder on disk with an explorer, CodeMirror editor,
  and Smart Run (web projects get served locally so modules and fetch work;
  Python runs with your system interpreter).
- **Local backend (optional)** — a FastAPI service that adds sandboxed code
  execution, project packaging (`.py` / native `.exe` / `.html`), and PDF/DOCX
  text extraction.

## Building from source

### Windows

Requires MSVC (VS 2022), CMake, and the WebView2 SDK (grab
`Microsoft.Web.WebView2` from NuGet so the GUI renders instead of falling back
to a plain window):

```powershell
nuget install Microsoft.Web.WebView2 -OutputDirectory packages -ExcludeVersion
cmake -S . -B build -G "Visual Studio 17 2022" -A x64 -DAI_EXE_WEBVIEW2_DIR="packages/Microsoft.Web.WebView2"
cmake --build build --config Release
```

Ship `WebView2Loader.dll` next to `ai_exe_gui.exe`. The exact steps CI uses are
in [`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml),
which builds and publishes every release.

### macOS (preview)

```bash
cmake -S . -B build
cmake --build build -j
open build/ai_exe_gui_mac.app   # or double-click RUN_MAC_PREVIEW.command
```

### Backend

```bash
cd backend
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8765
```

The app finds it automatically on `127.0.0.1:8765`. Smoke tests:
`.venv/bin/python tests/run_all.py`.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | Native hosts: Windows WebView2 GUI, macOS preview shell, sandboxed process runner, local static server |
| `ui/` | The entire app UI (vanilla HTML/CSS/JS): chat, agent loop, planner, executor, workspace, editor |
| `ui/prompts/` | Prompt templates for chat and the agent |
| `backend/` | Optional FastAPI backend: sandbox, packaging, provider passthrough |
| `scripts/` | Regression tests for agent behaviors, plus launch helpers |
| `.github/workflows/` | Windows release CI |

Versioning lives in `CMakeLists.txt` (`AI_EXE_APP_VERSION`) and is bumped on
every shipped change — the release tag comes from it.

## Notes

- The UI is plain HTML/CSS/JS on purpose: one codebase renders in WebView2 on
  Windows and WKWebView on macOS with no build step.
- API keys are stored locally on your machine and sent only to the provider
  you configured. Nothing phones home except the GitHub release check.
