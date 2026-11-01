@echo off
setlocal
cd /d "%~dp0.."
set "PYTHONPATH=%CD%\..;%CD%;%CD%\.venv\lib\site-packages"

set "PYTHON_EXE=C:\Users\xuaner\AppData\Roaming\uv\python\cpython-3.10-windows-x86_64-none\python.exe"
if not exist "%PYTHON_EXE%" (
    set "PYTHON_EXE=%CD%\.venv\Scripts\python.exe"
)

echo ==========================================
echo   FullAwake PC Bridge Gateway (v0.1)
echo ==========================================
echo Starting Gateway on port 8765...
"%PYTHON_EXE%" -m fullawake.gateway.mcp_server
pause
