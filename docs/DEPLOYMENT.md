# Deployment Guide (Windows Offline Bundle)

## Build release binaries

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

Release builds enable hosted/API inference provider selection by default. Configure CMake with `-DAI_EXE_ENABLE_REMOTE_PROVIDERS=OFF` only when producing a strictly offline-only build. The localhost planner bridge remains disabled unless CMake is configured with `-DAI_EXE_ENABLE_DEV_PLANNER=ON`.

## Create bundle

```powershell
pwsh ./scripts/package_windows.ps1 -BuildRoot build -BuildConfig Release -OutRoot dist/AI_EXE_Phase1 -Zip
```

Output layout:

- `dist/AI_EXE_Phase1/AI.exe`
- `dist/AI_EXE_Phase1/AI_GUI.exe` (if GUI target built)
- `dist/AI_EXE_Phase1/ui/ai-exe.html` (GUI layout source loaded locally by AI_GUI.exe)
- `dist/AI_EXE_Phase1/RELEASE_INFO.txt`
- `dist/AI_EXE_Phase1/data/model/model.gguf` (if present) or placeholder file
- `dist/AI_EXE_Phase1/data/runtime/infer_backend.exe` (backend adapter)
- `dist/AI_EXE_Phase1/data/runtime/llama-cli.exe` (optional but required for real generation)
- `dist/AI_EXE_Phase1/manifest.sha256`

## Validate bundle

```powershell
pwsh ./scripts/validate_bundle.ps1 -BundleRoot dist/AI_EXE_Phase1
```

Release validation is strict by default: `data/model/model.gguf`, `data/runtime/infer_backend.exe`, and `data/runtime/llama-cli.exe` must be present. For a demo-only bundle that intentionally has no real generation engine, pass `-AllowMissingInferenceEngine`.

Validation checks:

- required files and directories exist
- GUI HTML script and stylesheet references resolve inside the bundle
- required prompt templates and vendored UI libraries are present
- packaged UI config keeps hosted/API providers disabled for offline release builds
- manifest hashes match packaged files
- executable starts and prints diagnostics
- startup exits safely (exit code `0` or `1` accepted)
- backend version handshake (`--version`) succeeds when backend is present
- backend self-test executes when `data/runtime/infer_backend.exe` is present
- local model and inference engine are present unless demo validation explicitly allows them to be missing

## Run (non-technical demo)

Double-click either:

- `RUN_AI_GUI.cmd` (preferred, if present)
- `RUN_AI.cmd` (CLI)

## CUDA runtime packaging notes

The project does not download runtime files. If your backend requires additional local DLLs, copy only the required DLLs into the bundle root next to `AI.exe`.

Recommended process:

1. Build backend on target-like machine.
2. Identify required DLLs with dependency tooling.
3. Copy minimal required DLL set into bundle.
4. For Windows GUI web preview, include `WebView2Loader.dll` next to `AI_GUI.exe` if target does not already provide WebView2 runtime.
5. Include `llama-cli.exe` next to `data/runtime/infer_backend.exe`.
6. Re-run `validate_bundle.ps1`.
