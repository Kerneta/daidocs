@echo off
REM DaiDocs capture server launcher (plain cmd, lowest antivirus-flag profile).
REM Runs node directly, no PowerShell and no execution-policy bypass, so it does
REM not match the "cmd launches powershell -ExecutionPolicy Bypass" pattern that
REM antivirus heuristics watch for. Keep this window open: closing it stops capture.

setlocal
set HERE=%~dp0
set REPO=%HERE%..
if "%DAIDOCS_CAPTURE_PORT%"=="" set DAIDOCS_CAPTURE_PORT=41100

echo.
echo   DaiDocs capture server
echo   Keep this window open. Closing it stops capture.
echo.

where node >nul 2>&1
if not %errorlevel%==0 (
  echo   PROBLEM: Node.js not found on PATH.
  echo   FIX: install Node.js from https://nodejs.org (LTS), then run this again.
  pause
  goto :eof
)

if not exist "%REPO%\capture_server.mjs" (
  echo   PROBLEM: capture_server.mjs not found next to the launcher.
  echo   Expected: %REPO%\capture_server.mjs
  echo   FIX: keep this launcher folder inside the DaiDocs folder.
  pause
  goto :eof
)

echo   Loading...
node "%REPO%\capture_server.mjs"

echo.
echo   The capture server stopped. Capture is off until you launch it again.
echo   If it exited immediately: the port may be in use (set DAIDOCS_CAPTURE_PORT
echo   to a free port and match it in the extension Options), or run 'npm install'
echo   in the DaiDocs folder.
pause
