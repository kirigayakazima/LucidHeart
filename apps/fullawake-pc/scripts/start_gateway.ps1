# FullAwake Gateway Startup Script
# Run in an interactive Windows desktop user session (NOT as SYSTEM service)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectDir = Split-Path -Parent $ScriptDir
$ProjectsDir = Split-Path -Parent $ProjectDir

Set-Location $ProjectDir
$env:PYTHONPATH = "$ProjectsDir;$ProjectDir;$ProjectDir\.venv\lib\site-packages"

# Prefer global uv python 3.10 which has full DLL linkage
$pythonExe = "C:\Users\xuaner\AppData\Roaming\uv\python\cpython-3.10-windows-x86_64-none\python.exe"
if (-not (Test-Path $pythonExe)) {
    $pythonExe = "$ProjectDir\.venv\Scripts\python.exe"
}

# Find local IP address
$localIp = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi*", "以太网*", "Ethernet*" -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "169.254*" } | Select-Object -First 1).IPAddress
if (-not $localIp) {
    $localIp = "127.0.0.1"
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  FullAwake PC Bridge Gateway (v0.1)" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Local PC IP   : http://${localIp}:8765" -ForegroundColor Yellow
Write-Host "DSH MCP SSE   : http://${localIp}:8765/sse" -ForegroundColor Yellow
Write-Host "DSH MCP HTTP  : http://${localIp}:8765/mcp" -ForegroundColor Yellow
Write-Host "Auth Token    : xiaoman-pc-bridge-secret-2026" -ForegroundColor Yellow
Write-Host "Python Runner : $pythonExe" -ForegroundColor Gray
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Starting FullAwake Gateway..." -ForegroundColor Cyan

& $pythonExe -m fullawake.gateway.mcp_server
