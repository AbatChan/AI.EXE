param(
  [string]$BuildRoot = "build",
  [string]$BuildConfig = "Release",
  [string]$OutRoot = "dist/AI_EXE_Phase1",
  [switch]$Zip
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildDir = Join-Path $repoRoot (Join-Path $BuildRoot $BuildConfig)
$outDir = Join-Path $repoRoot $OutRoot

$mainExe = Join-Path $buildDir "ai_exe.exe"
if (-not (Test-Path $mainExe)) {
  throw "Missing build output: $mainExe"
}

if (Test-Path $outDir) {
  Remove-Item -Recurse -Force $outDir
}

$null = New-Item -ItemType Directory -Path $outDir
$null = New-Item -ItemType Directory -Path (Join-Path $outDir "data")
$null = New-Item -ItemType Directory -Path (Join-Path $outDir "data\model")
$null = New-Item -ItemType Directory -Path (Join-Path $outDir "data\runtime")
$null = New-Item -ItemType Directory -Path (Join-Path $outDir "data\logs")
$null = New-Item -ItemType Directory -Path (Join-Path $outDir "data\memory")
$null = New-Item -ItemType Directory -Path (Join-Path $outDir "data\snapshots")
$null = New-Item -ItemType Directory -Path (Join-Path $outDir "data\sandbox")
$null = New-Item -ItemType Directory -Path (Join-Path $outDir "ui")
$null = New-Item -ItemType Directory -Path (Join-Path $outDir "ui\prompts")

Copy-Item $mainExe (Join-Path $outDir "AI.exe")

$guiExe = Join-Path $buildDir "ai_exe_gui.exe"
if (Test-Path $guiExe) {
  Copy-Item $guiExe (Join-Path $outDir "AI_GUI.exe")
}

$uiHtml = Join-Path $repoRoot "ui\ai-exe.html"
if (Test-Path $uiHtml) {
  Copy-Item $uiHtml (Join-Path $outDir "ui\ai-exe.html")
}

$uiConfigFromBuild = Join-Path $buildDir "ui\ui-config.js"
$uiConfigFromGenerated = Join-Path $repoRoot (Join-Path $BuildRoot "generated\ui\ui-config.js")
$uiConfigFromSource = Join-Path $repoRoot "ui\ui-config.js"
if (Test-Path $uiConfigFromBuild) {
  Copy-Item $uiConfigFromBuild (Join-Path $outDir "ui\ui-config.js")
} elseif (Test-Path $uiConfigFromGenerated) {
  Copy-Item $uiConfigFromGenerated (Join-Path $outDir "ui\ui-config.js")
} elseif (Test-Path $uiConfigFromSource) {
  Copy-Item $uiConfigFromSource (Join-Path $outDir "ui\ui-config.js")
}

$promptFiles = @(
  "chat_main.md",
  "developer_agent_decision.md"
)
foreach ($promptFile in $promptFiles) {
  $promptSrc = Join-Path $repoRoot (Join-Path "ui\prompts" $promptFile)
  if (Test-Path $promptSrc) {
    Copy-Item $promptSrc (Join-Path $outDir (Join-Path "ui\prompts" $promptFile))
  }
}

Get-ChildItem -Path $buildDir -Filter "*.dll" -File | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $outDir $_.Name)
}

$backendStub = Join-Path $buildDir "infer_backend_stub.exe"
if (Test-Path $backendStub) {
  Copy-Item $backendStub (Join-Path $outDir "data\runtime\infer_backend.exe")
}

$engineFromBuild = Join-Path $buildDir "llama-cli.exe"
$engineFromRepo = Join-Path $repoRoot "data\runtime\llama-cli.exe"
if (Test-Path $engineFromBuild) {
  Copy-Item $engineFromBuild (Join-Path $outDir "data\runtime\llama-cli.exe")
} elseif (Test-Path $engineFromRepo) {
  Copy-Item $engineFromRepo (Join-Path $outDir "data\runtime\llama-cli.exe")
}

$modelSrc = Join-Path $repoRoot "data\model\model.gguf"
if (Test-Path $modelSrc) {
  Copy-Item $modelSrc (Join-Path $outDir "data\model\model.gguf")
} else {
  Set-Content -Path (Join-Path $outDir "data\model\PLACE_MODEL_HERE.txt") -Value "Drop quantized GGUF model as data/model/model.gguf"
}

Set-Content -Path (Join-Path $outDir "RUN_AI.cmd") -Value "@echo off`r`ncd /d `%~dp0`r`nAI.exe`r`n"
if (Test-Path (Join-Path $outDir "AI_GUI.exe")) {
  Set-Content -Path (Join-Path $outDir "RUN_AI_GUI.cmd") -Value "@echo off`r`ncd /d `%~dp0`r`nAI_GUI.exe`r`n"
}
Set-Content -Path (Join-Path $outDir "RELEASE_INFO.txt") -Value @(
  "name=AI_EXE_Phase1"
  "build_config=$BuildConfig"
  "packaged_utc=$([DateTime]::UtcNow.ToString(\"yyyy-MM-ddTHH:mm:ssZ\"))"
)

$manifestPath = Join-Path $outDir "manifest.sha256"
Get-ChildItem -Path $outDir -Recurse -File |
  Where-Object { $_.FullName -ne $manifestPath } |
  Get-FileHash -Algorithm SHA256 |
  ForEach-Object { "{0}  {1}" -f $_.Hash, ($_.Path.Replace($outDir + '\\', '')) } |
  Set-Content -Path $manifestPath

Write-Host "Package created at: $outDir"

if ($Zip.IsPresent) {
  $zipPath = "$outDir.zip"
  if (Test-Path $zipPath) {
    Remove-Item -Force $zipPath
  }
  Compress-Archive -Path (Join-Path $outDir "*") -DestinationPath $zipPath
  Write-Host "Zip created at: $zipPath"
}
