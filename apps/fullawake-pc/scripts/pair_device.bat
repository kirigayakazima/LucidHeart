@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pair_device.ps1"
pause
