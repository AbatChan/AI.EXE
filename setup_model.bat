@echo off
title AI.EXE - Model Setup
echo.
echo   =============================================
echo     AI.EXE - Downloading AI Model (~8.5 GB)
echo   =============================================
echo.
echo   This downloads the Qwen2.5-Coder-14B model.
echo   If interrupted, run this script again to resume.
echo.

if not exist "data\model" (
    mkdir "data\model"
    echo   Created data\model directory.
    echo.
)

if exist "data\model\model.gguf" (
    echo   Model file already exists at data\model\model.gguf
    echo   Delete it manually if you want to re-download.
    echo.
    pause
    exit /b 0
)

echo   Starting download...
echo   URL: huggingface.co/mradermacher/Qwen2.5-Coder-14B-Instruct-Uncensored-GGUF
echo.

curl.exe -L -C - --fail --retry 999 --retry-delay 5 --retry-all-errors ^
    --progress-bar ^
    -o "data\model\model.gguf" ^
    "https://huggingface.co/mradermacher/Qwen2.5-Coder-14B-Instruct-Uncensored-GGUF/resolve/main/Qwen2.5-Coder-14B-Instruct-Uncensored.Q4_K_M.gguf?download=true"

if %errorlevel% equ 0 (
    echo.
    echo   =============================================
    echo     Download complete! You can now run AI.EXE
    echo   =============================================
) else (
    echo.
    echo   =============================================
    echo     Download interrupted or failed.
    echo     Run this script again to resume.
    echo   =============================================
)
echo.
pause
