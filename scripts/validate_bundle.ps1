param(
  [string]$BundleRoot = "dist/AI_EXE_Phase1",
  [switch]$AllowMissingInferenceEngine
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bundleDir = Join-Path $repoRoot $BundleRoot

if (-not (Test-Path $bundleDir)) {
  throw "Bundle directory not found: $bundleDir"
}

$required = @(
  "AI.exe",
  "ui\\ai-exe.html",
  "ui\\ai-exe.css",
  "ui\\ui-config.js",
  "ui\\ai-exe.js",
  "ui\\markdown-renderer.js",
  "ui\\prompt-core.js",
  "ui\\agent-core.js",
  "ui\\agent-planner.js",
  "ui\\agent-runtime.js",
  "ui\\agent-executor.js",
  "ui\\agent-loop.js",
  "ui\\chat-shell.js",
  "ui\\chat-renderer.js",
  "ui\\file-viewer.js",
  "ui\\preflight-router.js",
  "ui\\workspace-core.js",
  "ui\\workspace-actions.js",
  "ui\\workspace-renderer.js",
  "ui\\prompts\\chat_main.md",
  "ui\\prompts\\developer_agent_decision.md",
  "ui\\prompts\\developer_agent_decision_repair.md",
  "ui\\prompts\\developer_agent_plan.md",
  "ui\\prompts\\developer_agent_write_file.md",
  "ui\\prompts\\developer_agent_edit_file.md",
  "ui\\prompts\\developer_agent_rewrite_file.md",
  "ui\\prompts\\developer_agent_completion.md",
  "ui\\vendor\\markdown-it\\markdown-it.min.js",
  "ui\\vendor\\katex\\katex.min.js",
  "ui\\vendor\\katex\\katex.min.css",
  "ui\\vendor\\texmath\\texmath.js",
  "ui\\vendor\\texmath\\texmath.css",
  "ui\\vendor\\codemirror\\file-editor.bundle.js",
  "RUN_AI.cmd",
  "RELEASE_INFO.txt",
  "data\\model",
  "data\\runtime",
  "data\\logs",
  "data\\memory",
  "data\\snapshots",
  "data\\sandbox",
  "manifest.sha256"
)

foreach ($item in $required) {
  $path = Join-Path $bundleDir $item
  if (-not (Test-Path $path)) {
    throw "Missing required bundle path: $item"
  }
}

$htmlPath = Join-Path $bundleDir "ui\\ai-exe.html"
$html = Get-Content -Path $htmlPath -Raw
$scriptRefs = [regex]::Matches($html, '<script\s+[^>]*src="([^"]+)"') |
  ForEach-Object { $_.Groups[1].Value } |
  Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
foreach ($scriptRef in $scriptRefs) {
  $scriptPath = Join-Path (Join-Path $bundleDir "ui") $scriptRef
  if (-not (Test-Path $scriptPath)) {
    throw "HTML references missing script: $scriptRef"
  }
}

$cssRefs = [regex]::Matches($html, '<link\s+[^>]*href="([^"]+)"') |
  ForEach-Object { $_.Groups[1].Value } |
  Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
foreach ($cssRef in $cssRefs) {
  $cssPath = Join-Path (Join-Path $bundleDir "ui") $cssRef
  if (-not (Test-Path $cssPath)) {
    throw "HTML references missing stylesheet: $cssRef"
  }
}

$uiConfigPath = Join-Path $bundleDir "ui\\ui-config.js"
$uiConfig = Get-Content -Path $uiConfigPath -Raw
if ($uiConfig -notmatch "remoteProvidersEnabled\s*:\s*true") {
  Write-Warning "Packaged UI config does not explicitly enable remote provider selection."
}
if ($uiConfig -notmatch "devPlannerEnabled\s*:\s*false") {
  throw "Packaged UI config must disable the localhost development planner for release validation."
}

$modelPath = Join-Path $bundleDir "data\\model\\model.gguf"
if (-not (Test-Path $modelPath)) {
  if ($AllowMissingInferenceEngine.IsPresent) {
    Write-Warning "Model file is missing: data\\model\\model.gguf"
  } else {
    throw "Model file is missing: data\\model\\model.gguf. Pass -AllowMissingInferenceEngine only for demo bundles."
  }
}

$enginePath = Join-Path $bundleDir "data\\runtime\\llama-cli.exe"
if (-not (Test-Path $enginePath)) {
  if ($AllowMissingInferenceEngine.IsPresent) {
    Write-Warning "Local inference engine is missing: data\\runtime\\llama-cli.exe"
  } else {
    throw "Local inference engine is missing: data\\runtime\\llama-cli.exe. Pass -AllowMissingInferenceEngine only for demo bundles."
  }
}

$manifestPath = Join-Path $bundleDir "manifest.sha256"
$manifestLines = Get-Content -Path $manifestPath
foreach ($line in $manifestLines) {
  if ([string]::IsNullOrWhiteSpace($line)) {
    continue
  }

  $m = [regex]::Match($line, '^([A-Fa-f0-9]{64})\s+(.+)$')
  if (-not $m.Success) {
    throw "Invalid manifest line: $line"
  }

  $expected = $m.Groups[1].Value.ToUpperInvariant()
  $relative = $m.Groups[2].Value.Trim()
  $filePath = Join-Path $bundleDir $relative
  if (-not (Test-Path $filePath)) {
    throw "Manifest entry missing file: $relative"
  }

  $actual = (Get-FileHash -Path $filePath -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actual -ne $expected) {
    throw "Manifest hash mismatch: $relative"
  }
}

$output = ":quit" | & (Join-Path $bundleDir "AI.exe") 2>&1 | Out-String
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0 -and $exitCode -ne 1) {
  throw "Unexpected exit code from AI.exe: $exitCode"
}

if ($output -notmatch "Hardware Diagnostics") {
  throw "Runtime output did not include diagnostics header."
}

$backendPath = Join-Path $bundleDir "data\\runtime\\infer_backend.exe"
if (Test-Path $backendPath) {
  $backendVersion = & $backendPath --version 2>&1 | Out-String
  $backendVersionExitCode = $LASTEXITCODE
  if ($backendVersionExitCode -ne 0) {
    throw "Backend version check failed with exit code: $backendVersionExitCode"
  }

  $backendOutput = & $backendPath --self-test 2>&1 | Out-String
  $backendExitCode = $LASTEXITCODE
  if ($backendExitCode -ne 0) {
    if ($backendOutput -match "missing local engine") {
      if ($AllowMissingInferenceEngine.IsPresent) {
        Write-Warning "Backend adapter present but local inference engine is missing (llama-cli.exe)."
        Write-Warning "Bundle is runnable, but real generation is unavailable until engine is added."
      } else {
        throw "Backend adapter present but local inference engine is missing (llama-cli.exe). Pass -AllowMissingInferenceEngine only for demo bundles."
      }
    } else {
      throw "Backend self-test failed with exit code: $backendExitCode"
    }
  } elseif ($backendOutput.Trim() -ne "SELF_TEST_OK") {
    throw "Backend self-test returned unexpected output: $($backendOutput.Trim())"
  }

  Write-Host "Backend version: $($backendVersion.Trim())"
}

Write-Host "Bundle validation passed. ExitCode=$exitCode"
