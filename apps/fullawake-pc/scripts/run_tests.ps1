# Run FullAwake test suite
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

Write-Host "Running FullAwake test suite with $pythonExe..." -ForegroundColor Cyan
& $pythonExe -m pytest tests/ -v
