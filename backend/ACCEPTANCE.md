# Acceptance checklist (requirements doc §13)

Status of each acceptance item against the backend (`backend/`) + Workshop UI
(`ui/workshop.html`). Run the suite with `python tests/run_all.py`.

| # | Acceptance item | Status | Evidence |
|---|---|---|---|
| 1 | User can choose output type before generation | ✅ | Workshop selector: Python `.py` / Executable `.exe` / Web `.html` |
| 2 | Backend receives the selected output type | ✅ | `language` on `/api/generate`, `target` on `/api/package` |
| 3 | Python runs in a sandbox, not raw host execution | ✅ | `/api/run-python` — temp workdir, rlimits, timeout, static guard (`smoke_sandbox`) |
| 4 | Failed code → readable error + retry | ✅ | `/api/generate` auto-correct loop + `retry_hint` (`smoke_generate`) |
| 5 | Generated files appear in an output folder | ✅ | `/api/projects` under `.data/projects/<slug>/` (`smoke_projects`) |
| 6 | At least `.py` and one packaged executable works | ✅ | `/api/package` → `.py` + a real native binary (verified built + run) |
| 7 | API key is not exposed in frontend code | ✅ | stored server-side `0600`, only ever returned masked (`smoke_usage`) |
| 8 | Requests respect 20/min | ✅ | sliding-window limiter (`smoke_usage`) |
| 9 | Usage counter tracks up to 7,500 monthly credits (Venice Pro+) | ✅ | persisted credit tracker, monthly reset (`smoke_usage`) |
| 10 | Workshop button exists inside AI.EXE | ⚠️ partial | Workshop UI exists + backend-served at `/workshop`; the in-app SPA button + bundling into the packaged app is deferred |
| 11 | Workshop starts blank, not prefilled with fakes | ✅ | empty state "No modules uploaded yet" |
| 12 | User can upload a module/software folder | ✅ | `/api/modules/upload` (files or zipped folder) (`smoke_modules`) |
| 13 | Uploaded module gets a visible status | ✅ | pending→connecting→connected→live→error + status dot |
| 14 | AI.EXE core connection status is shown | ✅ | Workshop status dot + per-subsystem pills from `/api/status` |
| 15 | Logs / build notes available for generated projects | ✅ | `build_log` (package/pdf), `BUILD_LOG.md` + `MAPPING.md`, generate `attempts` |

**14 of 15 fully met; #10 partial** (UI is built and served; wiring it into the packaged
desktop SPA is the one remaining integration, runtime-unverifiable in this environment).

## To run live end-to-end
Set a provider + key (the only external dependency):

```bash
export AIEXE_LLM_BASE_URL="https://api.openai.com/v1"   # or Venice/deepseek/qwen (OpenAI-compatible)
export AIEXE_LLM_MODEL="..."
cd backend && ./run.sh
# open http://127.0.0.1:8765/workshop ,  POST /api/api-key , then generate / package / pdf
```
