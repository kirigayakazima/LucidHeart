@echo off
setlocal
cd /d "%~dp0.."
set "PYTHONPATH=%CD%\..;%CD%;%CD%\.venv\lib\site-packages"

set "PYTHON_EXE=C:\Users\xuaner\AppData\Roaming\uv\python\cpython-3.10-windows-x86_64-none\python.exe"
if not exist "%PYTHON_EXE%" (
    set "PYTHON_EXE=%CD%\.venv\Scripts\python.exe"
)

echo Running FullAwake tests...
"%PYTHON_EXE%" -m pytest tests/ -v
pause
