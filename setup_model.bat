@echo off
setlocal enabledelayedexpansion
title AI.EXE - Local (Offline) Model Setup

:menu
cls
echo ==================================================================
echo            AI.EXE  -  Choose a Local UNCENSORED Model
echo ==================================================================
echo.
echo  Optional / offline use. Online (Venice API) needs none of this.
echo  This downloads a model to  data\model\model.gguf  and the app uses
echo  it when you pick "Local Model" in Settings.
echo.
echo  All options are UNCENSORED. Bigger = smarter but heavier. With no
echo  GPU it runs on CPU (works, just slower) - prefer a smaller size.
echo.
echo  ------------------------------------------------------------------
echo   [1]  Qwen2.5-Coder 7B (uncensored)    ~4.7 GB
echo        Best on CPU-only / no GPU. Fast, strong coder.
echo.
echo   [2]  Qwen2.5-Coder 14B (uncensored)   ~9.0 GB   *** RECOMMENDED ***
echo        Best quality if you have ~16 GB+ RAM or a 12 GB GPU.
echo.
echo   [3]  Qwen2.5-Coder 32B (uncensored)   ~19.9 GB
echo        Top quality. Needs a big GPU (24 GB) or lots of RAM; slow on CPU.
echo  ------------------------------------------------------------------
echo.
echo   [Q]  Quit
echo.
set "choice="
set /p choice=  Enter 1-3 (or Q to quit):

if /i "%choice%"=="Q" exit /b 0
if "%choice%"=="1" goto m1
if "%choice%"=="2" goto m2
if "%choice%"=="3" goto m3
echo.
echo   "%choice%" is not a valid option.
timeout /t 2 >nul
goto menu

:m1
set "NAME=Qwen2.5-Coder 7B uncensored (Q4_K_M, ~4.7 GB)"
set "URL=https://huggingface.co/mradermacher/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-abliterated.Q4_K_M.gguf?download=true"
goto download
:m2
set "NAME=Qwen2.5-Coder 14B uncensored (Q4_K_M, ~9.0 GB)"
set "URL=https://huggingface.co/mradermacher/Qwen2.5-Coder-14B-Instruct-Uncensored-GGUF/resolve/main/Qwen2.5-Coder-14B-Instruct-Uncensored.Q4_K_M.gguf?download=true"
goto download
:m3
set "NAME=Qwen2.5-Coder 32B uncensored (Q4_K_M, ~19.9 GB)"
set "URL=https://huggingface.co/mradermacher/Qwen2.5-Coder-32B-Instruct-abliterated-GGUF/resolve/main/Qwen2.5-Coder-32B-Instruct-abliterated.Q4_K_M.gguf?download=true"
goto download

:download
if not exist "data\model" mkdir "data\model"
if exist "data\model\model.gguf" (
    echo.
    echo   A model already exists at data\model\model.gguf
    set "ow="
    set /p ow=  Overwrite it? (Y/N):
    if /i not "!ow!"=="Y" goto menu
    del /f /q "data\model\model.gguf"
)
cls
echo ==================================================================
echo   Downloading: %NAME%
echo ==================================================================
echo.
echo   Saving to: data\model\model.gguf
echo   Large file. If it stops, run this script again and pick the SAME
echo   model - the download resumes where it left off.
echo.
curl.exe -L -C - --fail --retry 999 --retry-delay 5 --retry-all-errors ^
    --progress-bar ^
    -o "data\model\model.gguf" ^
    "%URL%"

if errorlevel 1 (
    echo.
    echo   =============================================
    echo     Download interrupted or failed.
    echo     Run this script again to resume.
    echo   =============================================
) else (
    echo.
    echo   =============================================
    echo     Done! Launch AI.EXE.exe and choose
    echo     "Local Model" in Settings to run offline.
    echo   =============================================
)
echo.
pause
