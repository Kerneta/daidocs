# DaiDocs capture server launcher (PowerShell).
# Starts the local capture server, shows it loading, verifies it is up, and
# prints clear troubleshooting if it fails. Leave this window open (or minimise
# it): closing it stops capture. No em dashes, per project rule.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$port = if ($env:DAIDOCS_CAPTURE_PORT) { $env:DAIDOCS_CAPTURE_PORT } else { '41100' }
$log  = Join-Path $here 'launcher.log'

function Log($m) { $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Write-Host $line; Add-Content -Path $log -Value $line }

Write-Host ""
Write-Host "  DaiDocs capture server" -ForegroundColor Cyan
Write-Host "  Keep this window open. Closing it stops capture." -ForegroundColor DarkGray
Write-Host ""

# 1. Is it already running?
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
  if ($h.ok) { Log "Already running on port $port (store: $($h.store)). Nothing to do."; Write-Host "  Already running." -ForegroundColor Green; Start-Sleep 2; exit 0 }
} catch { }

# 2. Find node.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Log "ERROR: Node.js not found on PATH."
  Write-Host ""
  Write-Host "  PROBLEM: Node.js is not installed or not on PATH." -ForegroundColor Red
  Write-Host "  FIX: install Node.js from https://nodejs.org (LTS), then run this again." -ForegroundColor Yellow
  Write-Host ""
  Read-Host "  Press Enter to close"
  exit 1
}
Log "Using node at $node"

# 3. Start the server.
$server = Join-Path $repo 'capture_server.mjs'
if (-not (Test-Path $server)) {
  Log "ERROR: capture_server.mjs not found at $server"
  Write-Host "  PROBLEM: capture_server.mjs not found next to the launcher." -ForegroundColor Red
  Write-Host "  Expected: $server" -ForegroundColor Yellow
  Read-Host "  Press Enter to close"
  exit 1
}

Log "Starting: node capture_server.mjs (port $port)"
Write-Host "  Loading..." -ForegroundColor Gray

# Start in THIS window (NoNewWindow inherits the console) so the user sees the
# server's own output. No 2>&1 pipe, which avoids PowerShell wrapping the
# server's stderr banner as an error.
$proc = Start-Process -FilePath $node -ArgumentList "`"$server`"" -NoNewWindow -PassThru

# Wait for it to answer /health, then confirm. If it never answers, troubleshoot.
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if ($proc.HasExited) { break }
  try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1; if ($h.ok) { $ok = $true; break } } catch { }
}

if ($ok) {
  Log "Capture server up on port $port."
  Write-Host ""
  Write-Host "  Capture server is running on port $port. You can minimise this window." -ForegroundColor Green
  Write-Host "  Closing it stops capture." -ForegroundColor DarkGray
  Write-Host ""
} else {
  Log "ERROR: server did not answer /health (exited=$($proc.HasExited))."
  Write-Host ""
  Write-Host "  PROBLEM: the server did not come up." -ForegroundColor Red
  Write-Host "  Common causes and fixes:" -ForegroundColor Yellow
  Write-Host "   - Port $port already in use by another server: close it, or set" -ForegroundColor Yellow
  Write-Host "     DAIDOCS_CAPTURE_PORT to a free port and match it in the extension Options." -ForegroundColor Yellow
  Write-Host "   - A dependency is missing: run 'npm install' in the DaiDocs folder." -ForegroundColor Yellow
  Write-Host "   - See the last lines of the log below:" -ForegroundColor Yellow
  if (Test-Path $log) { Get-Content $log -Tail 8 | ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray } }
}

# Keep the window alive while the server runs; the user closing it stops capture.
if (-not $proc.HasExited) { $proc.WaitForExit() }
Log "Server process ended."
Write-Host ""
Write-Host "  The capture server stopped. Capture is off until you launch it again." -ForegroundColor Yellow
Read-Host "  Press Enter to close"
