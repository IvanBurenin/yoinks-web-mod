@echo off
rem Quick launcher for the yoinks web UI (Windows).
rem Double-click this file: it installs dependencies on first run, starts the
rem server and opens the browser. Extra arguments are passed through, e.g.
rem   start-yoinks.cmd --port 5000
rem   start-yoinks.cmd --host 0.0.0.0
setlocal
title yoinks web
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

rem If the default instance is already running, just open it instead of
rem starting a second server that would fail with EADDRINUSE.
if "%~1"=="" (
  curl -sf --max-time 2 http://127.0.0.1:4321/api/health >nul 2>nul
  if not errorlevel 1 (
    echo yoinks web is already running - opening the browser.
    start "" "http://127.0.0.1:4321"
    exit /b 0
  )
)

if not exist "node_modules\.bin\tsx.cmd" (
  echo First start: installing dependencies. This happens only once...
  call npm install
  if errorlevel 1 goto installfail
)

echo.
echo Starting yoinks web UI. The browser will open automatically.
echo Close this window (or press Ctrl+C) to stop the server.
echo.

"%~dp0node_modules\.bin\tsx.cmd" "%~dp0src\server.ts" --open %*
set "code=%errorlevel%"
rem 0 = normal shutdown, 130 = Ctrl+C (SIGINT) - do not treat those as a crash
if "%code%"=="130" exit /b 0
if "%code%"=="0" exit /b 0
goto crashed

:nonode
echo.
echo Node.js was not found.
echo Install it from https://nodejs.org (LTS version), then run this file again.
echo.
pause
exit /b 1

:installfail
echo.
echo npm install failed. Check your internet connection and try again.
echo.
pause
exit /b 1

:crashed
echo.
echo The yoinks web server stopped with an error (see the message above).
echo.
pause
exit /b 1
