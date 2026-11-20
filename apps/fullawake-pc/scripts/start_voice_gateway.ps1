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
$venvPythonExe = Join-Path $ProjectDir '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $venvPythonExe)) { throw 'Create the project uv environment first.' }
$pythonExe = $venvPythonExe
$pyvenvCfg = Join-Path $ProjectDir '.venv/pyvenv.cfg'
if (Test-Path -LiteralPath $pyvenvCfg) {
    $homeLine = Get-Content -LiteralPath $pyvenvCfg | Where-Object { $_ -match '^\s*home\s*=' } | Select-Object -First 1
    if ($homeLine) {
        $baseHome = ($homeLine -split '=', 2)[1].Trim()
        $basePython = Join-Path $baseHome 'python.exe'
        if (Test-Path -LiteralPath $basePython) {
            $pythonExe = $basePython
        }
    }
}
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

$pythonPathEntries = @(
    "$($ProjectDir)\src",
    (Join-Path $ProjectDir '.venv/Lib/site-packages'),
    (Join-Path $ProjectDir '.venv/Lib/site-packages/win32'),
    (Join-Path $ProjectDir '.venv/Lib/site-packages/win32/lib')
)
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
if (-not $env:FULLAWAKE_BREEZE_API_KEY) {
    $env:FULLAWAKE_BREEZE_API_KEY = 'brz_XfxyZyDQK9a6Ex5-5l_9W9aJ9cMq9H8j'
}
$env:FULLAWAKE_VOICE_PROFILE = (Resolve-Path -LiteralPath $VoiceProfile).Path
$env:FULLAWAKE_VOICE_PYTHON = (Resolve-Path -LiteralPath $VoicePython).Path
$env:FULLAWAKE_VOICE_CLIENTS = $VoiceClients -join ','
$runDir = Join-Path $SuiteDir 'local/fullawake'
if (-not $env:FULLAWAKE_ASR_BACKEND) { $env:FULLAWAKE_ASR_BACKEND = 'auto' }
if (-not $env:FULLAWAKE_SENSEVOICE_MODEL_DIR) { $env:FULLAWAKE_SENSEVOICE_MODEL_DIR = Join-Path $runDir 'sensevoice-small' }
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$env:FULLAWAKE_VOICE_WORK_DIR = Join-Path $runDir 'voice-work'
if (-not $env:FULLAWAKE_ASR_MODEL_DIR) {
    $env:FULLAWAKE_ASR_MODEL_DIR = Join-Path $runDir 'faster-whisper-base'
}
if (-not $env:FULLAWAKE_WATCH_TOKEN) {
    $env:FULLAWAKE_WATCH_TOKEN = 'xiaoman-watch-loopback-token-2026'
}
if (-not $env:FULLAWAKE_VAD_DEVICE_MODE) {
    $env:FULLAWAKE_VAD_DEVICE_MODE = 'speaker'
}
if (-not $env:FULLAWAKE_PTT_KEY) {
    $env:FULLAWAKE_PTT_KEY = 'rctrl'
}
if (-not $env:FULLAWAKE_LOG_FILE) {
    $env:FULLAWAKE_LOG_FILE = Join-Path $runDir 'gateway.log'
}
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
set "FULLAWAKE_BREEZE_API_KEY=$($env:FULLAWAKE_BREEZE_API_KEY)"
set "FULLAWAKE_VOICE_PROFILE=$($env:FULLAWAKE_VOICE_PROFILE)"
set "FULLAWAKE_VOICE_PYTHON=$($env:FULLAWAKE_VOICE_PYTHON)"
set "FULLAWAKE_VOICE_CLIENTS=$($env:FULLAWAKE_VOICE_CLIENTS)"
set "FULLAWAKE_VOICE_WORK_DIR=$($env:FULLAWAKE_VOICE_WORK_DIR)"
set "FULLAWAKE_ASR_MODEL_DIR=$($env:FULLAWAKE_ASR_MODEL_DIR)"
set "FULLAWAKE_WATCH_TOKEN=$($env:FULLAWAKE_WATCH_TOKEN)"
set "FULLAWAKE_AUTH_TOKEN=$($env:FULLAWAKE_AUTH_TOKEN)"
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
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
