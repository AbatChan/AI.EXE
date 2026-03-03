param(
  [string]$BundleRoot = "dist/AI_EXE_Phase1"
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
  "ui\\ui-config.js",
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
      Write-Warning "Backend adapter present but local inference engine is missing (llama-cli.exe)."
      Write-Warning "Bundle is runnable, but real generation is unavailable until engine is added."
    } else {
      throw "Backend self-test failed with exit code: $backendExitCode"
    }
  } elseif ($backendOutput.Trim() -ne "SELF_TEST_OK") {
    throw "Backend self-test returned unexpected output: $($backendOutput.Trim())"
  }

  Write-Host "Backend version: $($backendVersion.Trim())"
}

Write-Host "Bundle validation passed. ExitCode=$exitCode"
