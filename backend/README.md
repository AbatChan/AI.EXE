# AI.EXE Backend

FastAPI service that exposes the AI.EXE core, Python runner, and packagers as a local HTTP API.

Architecture (from the requirements doc §9):

```
Frontend UI  ->  Backend API (this)  ->  AI.EXE core / Python runner / packagers
```

## Run

```bash
cd backend
./run.sh                 # creates .venv, installs deps, serves on 127.0.0.1:8765
# or manually:
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload
```

Interactive docs: http://127.0.0.1:8765/docs
Workshop UI: http://127.0.0.1:8765/workshop  (the frontend that drives the whole pipeline)

## Endpoints

| Method | Path | Status |
|--------|------|--------|
| GET | `/health` | ✅ live |
| GET | `/api/status` | ✅ live (reports each subsystem's build state) |
| GET | `/api/usage` | ✅ live (credits + rate-limit counters) |
| POST | `/api/api-key` | ✅ live (stores key server-side, masked) |
| GET | `/api/api-key` | ✅ live (set? + masked) |
| POST | `/api/provider` | ✅ live (set Venice/OpenAI-compatible base_url + model) |
| GET | `/api/provider` | ✅ live (current provider + configured?) |
| GET | `/api/provider-usage` | ✅ live (Venice real balance; graceful if unavailable) |
| POST | `/api/run-python` | ✅ live (sandboxed run: logs, exit code, retry hint) |
| POST | `/api/generate` | ✅ live (LLM → code → run → auto-correct, metered) |
| POST | `/api/projects` | ✅ live (save files to a named output folder) |
| GET | `/api/projects` | ✅ live (list) |
| GET | `/api/projects/{name}` | ✅ live (files + manifest) |
| GET | `/api/projects/{name}/file?path=` | ✅ live (read one file) |
| GET | `/api/projects/{name}/download` | ✅ live (zip) |
| DELETE | `/api/projects/{name}` | ✅ live |
| POST | `/api/package` | ✅ live (`.py` bundle / native `.exe`) |
| GET | `/api/artifacts/{id}/download` | ✅ live (download the built artifact) |
| POST | `/api/modules/upload` | ✅ live (multipart; .exe/.dll/.py/.wasm/.zip/.js/.bin) |
| GET | `/api/modules` | ✅ live (list + status) |
| GET | `/api/modules/{id}` | ✅ live |
| POST | `/api/modules/{id}/connect` | ✅ live (handshake → connected + token) |
| DELETE | `/api/modules/{id}` | ✅ live |
| POST | `/api/pdf-to-software` | ✅ live (PDF → agents → stitched project) |

## §8 limits (env-overridable defaults)

- Rate limit: **20 requests / 60s** (`AIEXE_RATE_LIMIT_MAX`, `AIEXE_RATE_LIMIT_WINDOW`)
- Credits: **7,500 / month**, 1 request = 1 credit, calendar-month reset (`AIEXE_CREDIT_LIMIT`, `AIEXE_CREDIT_COST`)
- Metered endpoints add `Depends(meter)` → 429 (rate) / 402 (credits) with clear messages.
- State persists to `.data/usage.json`; the API key to `.data/apikey.json` (0600, never echoed raw).

## §3 Python sandbox (`POST /api/run-python`)

Body: `{ code | files, entry, requirements[], stdin, args[], timeout_seconds }`.
Runs in an isolated temp workdir with a scrubbed env, POSIX resource limits (CPU,
file-size, process count, no core dumps), a wall-clock timeout that kills the process
group, and a static guard that refuses obviously destructive code. `requirements`
installs into a per-run venv. Returns `{ ok, exit_code, stdout, stderr, timed_out,
blocked, block_reason, install_log, retry_hint, sandbox_dir }`. Not credit-metered.

Known limit: true FS/network isolation needs a container; subprocess isolation is the
offline-portable path. On Windows the rlimits no-op (timeout + scrubbed env still apply).

## §2 Generate loop (`POST /api/generate`)

Body: `{ prompt, entry, run, auto_correct, max_retries, requirements[], timeout_seconds }`.
Calls the configured OpenAI-compatible provider with the stored key → separates code from
prose → runs it in the §3 sandbox → on failure feeds the error back and retries (up to
`max_retries`) → returns `{ ok, files, stdout, stderr, attempts[], prose, stopped_reason }`.
**Credit-metered per LLM call** (initial + each retry). Config:
`AIEXE_LLM_BASE_URL` (e.g. `https://api.openai.com/v1`), `AIEXE_LLM_MODEL`. The key comes
from `POST /api/api-key`. Clear errors: 400 (no key/provider), 429/402 (rate/credits),
401/403 (provider rejected), 502 (provider/network).

## §4/§5 Packaging (`POST /api/package`)

Body: `{ target: "py"|"exe", project | files, entry, name, timeout_seconds }`. Stages the
source (a saved project or inline files), then:
- **`py`** → the source as a single `.py` (or a `.zip` if multi-file).
- **`exe`** → a one-file **native** executable via PyInstaller (`.exe` on Windows, a
  Mach-O/ELF binary on macOS/Linux). PyInstaller can't cross-compile — the Windows `.exe`
  is produced when the backend runs on Windows. It's installed lazily into `.data/.tools/`
  on first use (not a hard dependency). Returns `download_path`; fetch the artifact at
  `GET /api/artifacts/{id}/download`.

## §9/§6 Workshop UI (`GET /workshop`)

`ui/workshop.html` is the frontend (served by the backend, and loaded by the desktop
WebView): backend connection status + subsystem pills, API-key entry, usage/credits,
a prompt box, and the **output-type selector** (item 6: Python `.py` / Executable `.exe`
/ Web `.html`). Generate → run/auto-correct (for code) → package → download link. The
selector drives `language` on `/api/generate` (web = static files, no sandbox run) and
`target` on `/api/package`. CORS is open so the page works from `file://` or the WebView.

## §6/§7 Workshop modules (`/api/modules*`)

Upload software (.exe/.dll/.py/.wasm/.zip/.js/.bin or a zipped folder) → it lands under
`<workshop>/modules/<id>/` (env `AIEXE_WORKSHOP_DIR`, default `.data/workshop`) with a
`manifest.json`. Status tracks the EXE-Connect pipeline: pending → connecting → connected
→ live → error. `connect` performs a registration handshake (status + token). Zip-slip and
malicious ids are refused. The Workshop UI's "EXE Connect" panel drives all of this.

## §10 PDF-to-software (`POST /api/pdf-to-software`)

Multipart `file` = a spec PDF (+ `name`, `max_sections`). Extracts text (pypdf), splits
into sections, dispatches each to a specialized agent (foundation / intelligence /
optimization / runtime / advanced), aggregates + stitches the files, validates `main.py`
in the sandbox, and saves a project with `BUILD_LOG.md` + `MAPPING.md` (section→file).
Returns the mapping, build log, and a download link. Metered per agent call. Known limit:
cross-agent code coherence is hard — v1 delivers the pipeline + mapping + ready project,
not a guaranteed unified program (PDF-to-software is the doc's most aspirational item).

Tests: `python tests/smoke_usage.py` · `smoke_sandbox.py` · `smoke_generate.py` · `smoke_projects.py` · `smoke_packager.py` · `smoke_modules.py` · `smoke_pdf.py`

## Layout

```
backend/
  requirements.txt
  run.sh
  app/
    main.py          # FastAPI app + router wiring + CORS
    config.py        # host/port/version/origins (env-overridable)
    models.py        # pydantic response models
    routers/
      health.py      # GET /health
      status.py      # GET /api/status
```

Each new Build-Order subsystem adds one router module under `app/routers/` and one
`include_router(...)` line in `main.py`, and flips its entry in `status.py` to `ready`.

Config via env: `AIEXE_BACKEND_HOST`, `AIEXE_BACKEND_PORT`, `AIEXE_BACKEND_ORIGINS`.
