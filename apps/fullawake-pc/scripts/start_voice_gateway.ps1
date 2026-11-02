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
$pythonExe = Join-Path $ProjectDir '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) { throw 'Create the project uv environment first.' }
if (Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue) {
    throw 'Port 8765 is already in use; inspect the existing gateway before starting another.'
}
if (-not $VoiceProfile) { $VoiceProfile = Join-Path $SuiteDir 'local/feiyu/rvc-onnx-phasefix/voice-profile.json' }
if (-not $VoicePython) { $VoicePython = Join-Path (Split-Path -Parent $SuiteDir) 'rvc/.venv310/Scripts/python.exe' }
if (-not (Test-Path -LiteralPath $VoiceProfile) -or -not (Test-Path -LiteralPath $VoicePython)) {
    throw 'Voice profile or its uv Python environment is unavailable.'
}
$env:PYTHONPATH = Join-Path $ProjectDir 'src'
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
    $process = Start-Process -FilePath $pythonExe -ArgumentList @('-m', 'fullawake.gateway.mcp_server') `
        -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runDir 'gateway.stdout.log') `
        -RedirectStandardError (Join-Path $runDir 'gateway.stderr.log')
    [IO.File]::WriteAllText((Join-Path $runDir 'gateway.pid'), [string]$process.Id)
    Write-Output "FullAwake voice started: pid=$($process.Id); bind=$BindAddress"
} else {
    & $pythonExe -m fullawake.gateway.mcp_server
}
