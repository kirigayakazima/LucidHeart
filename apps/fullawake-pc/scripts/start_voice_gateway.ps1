param(
    [switch]$Background,
    [string[]]$VoiceClients = @('127.0.0.1', '::1'),
    [string]$VoiceProfile = '',
    [string]$VoicePython = '',
    [string]$BindAddress = '127.0.0.1'
)
$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$SuiteDir = Split-Path -Parent (Split-Path -Parent $ProjectDir)
$pythonExe = "C:\Users\xuaner\AppData\Roaming\uv\python\cpython-3.10-windows-x86_64-none\python.exe"
if (-not (Test-Path -LiteralPath $pythonExe)) {
    $pythonExe = Join-Path $ProjectDir '.venv/Scripts/python.exe'
}
if (-not (Test-Path -LiteralPath $pythonExe)) { throw 'Create the project uv environment first.' }
if (Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue) {
    Write-Output "Port 8765 is already in use; gateway is already running."
    return
}
if (-not $VoiceProfile) { $VoiceProfile = Join-Path $SuiteDir 'local/feiyu/rvc-onnx-phasefix/voice-profile.json' }
$gpuPython = Join-Path (Split-Path -Parent $SuiteDir) 'rvc/.venv-gpu/Scripts/python.exe'
$cpuPython = Join-Path (Split-Path -Parent $SuiteDir) 'rvc/.venv310/Scripts/python.exe'
if (-not $VoicePython) {
    if (Test-Path -LiteralPath $gpuPython) {
        $VoicePython = $gpuPython
    } else {
        $VoicePython = $cpuPython
    }
}
if (-not (Test-Path -LiteralPath $VoiceProfile) -or -not (Test-Path -LiteralPath $VoicePython)) {
    throw 'Voice profile or its uv Python environment is unavailable.'
}
$rvcSitePackages = Join-Path (Split-Path -Parent $SuiteDir) 'rvc/.venv310/Lib/site-packages'
$gpuSitePackages = Join-Path (Split-Path -Parent $SuiteDir) 'rvc/.venv-gpu/Lib/site-packages'
$torchLib = Join-Path $rvcSitePackages 'torch/lib'

$pythonPathEntries = @("$($ProjectDir)\src")
if (Test-Path -LiteralPath $gpuSitePackages) {
    $pythonPathEntries += $gpuSitePackages
}
$pythonPathEntries += $rvcSitePackages
$env:PYTHONPATH = ($pythonPathEntries -join ';') + ";$($env:PYTHONPATH)"
if (Test-Path -LiteralPath $torchLib) {
    $env:PATH = "$($torchLib);$($env:PATH)"
}
$env:FULLAWAKE_BIND_HOST = $BindAddress
$env:PYTHONUTF8 = '1'
$env:FULLAWAKE_VOICE_ENABLED = '1'
$env:FULLAWAKE_VOICE_PROFILE = (Resolve-Path -LiteralPath $VoiceProfile).Path
$env:FULLAWAKE_VOICE_PYTHON = (Resolve-Path -LiteralPath $VoicePython).Path
$env:FULLAWAKE_VOICE_CLIENTS = $VoiceClients -join ','
$runDir = Join-Path $SuiteDir 'local/fullawake'
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$env:FULLAWAKE_VOICE_WORK_DIR = Join-Path $runDir 'voice-work'
if ($Background) {
    $stdoutFile = Join-Path $runDir 'gateway.stdout.log'
    $stderrFile = Join-Path $runDir 'gateway.stderr.log'
    $batScript = Join-Path $runDir 'run_gateway.bat'
    $batContent = @"
@echo off
set "PATH=$($torchLib);%PATH%"
set "PYTHONPATH=$($pythonPathEntries -join ';');%PYTHONPATH%"
set "FULLAWAKE_BIND_HOST=$BindAddress"
set "FULLAWAKE_VOICE_ENABLED=1"
set "FULLAWAKE_VOICE_PROFILE=$($env:FULLAWAKE_VOICE_PROFILE)"
set "FULLAWAKE_VOICE_PYTHON=$($env:FULLAWAKE_VOICE_PYTHON)"
set "FULLAWAKE_VOICE_CLIENTS=$($env:FULLAWAKE_VOICE_CLIENTS)"
set "FULLAWAKE_VOICE_WORK_DIR=$($env:FULLAWAKE_VOICE_WORK_DIR)"
set "PYTHONUTF8=1"
cd /d "$ProjectDir"
"$pythonExe" -m fullawake.gateway.mcp_server > "$stdoutFile" 2> "$stderrFile"
"@
    [IO.File]::WriteAllText($batScript, $batContent)
    $process = Start-Process -FilePath "cmd.exe" -ArgumentList @('/c', $batScript) -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText((Join-Path $runDir 'gateway.pid'), [string]$process.Id)
    Write-Output "FullAwake voice started: pid=$($process.Id); bind=$BindAddress"
} else {
    & $pythonExe -m fullawake.gateway.mcp_server
}
