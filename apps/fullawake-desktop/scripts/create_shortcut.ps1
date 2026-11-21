# Create Windows shortcuts with the Dafeiyu (大肥鱼) icon pointing to launch_desktop.vbs.
param(
    [switch]$IncludeDesktop
)

$ErrorActionPreference = 'Stop'
$scriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path -Parent $scriptsDir
$vbsPath = Join-Path $scriptsDir 'launch_desktop.vbs'
$icoPath = Join-Path $appDir 'src\fullawake_desktop\assets\dafeiyu.ico'
$workspaceRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $appDir)))

if (-not (Test-Path $vbsPath)) { throw "Missing $vbsPath" }
if (-not (Test-Path $icoPath)) { throw "Missing $icoPath" }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
    (Join-Path $scriptsDir 'FullAwake · 小满工作台.lnk'),
    (Join-Path $workspaceRoot 'FullAwake · 小满工作台.lnk')
)
if ($IncludeDesktop) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if ($desktop) { $targets += (Join-Path $desktop 'FullAwake · 小满工作台.lnk') }
}

foreach ($lnkPath in $targets) {
    $shortcut = $shell.CreateShortcut($lnkPath)
    $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
    $shortcut.Arguments = "`"$vbsPath`""
    $shortcut.WorkingDirectory = $appDir
    $shortcut.IconLocation = "$icoPath,0"
    $shortcut.Description = 'FullAwake · 小满的桌面工作台（大肥鱼专属快捷方式）'
    $shortcut.Save()
    Write-Host "Created shortcut: $lnkPath"
}
