Option Explicit
Dim shell, fs, project, venv, stream, line, base, python, cleanup
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
project = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
venv = fs.BuildPath(project, ".venv")
If Not fs.FileExists(fs.BuildPath(venv, "pyvenv.cfg")) Then
    MsgBox "Run uv sync in fullawake-desktop first.", vbExclamation, "FullAwake"
    WScript.Quit 1
End If
Set stream = fs.OpenTextFile(fs.BuildPath(venv, "pyvenv.cfg"), 1)
base = ""
Do Until stream.AtEndOfStream
    line = stream.ReadLine
    If Left(line, 7) = "home = " Then base = Mid(line, 8)
Loop
stream.Close
python = fs.BuildPath(base, "pythonw.exe")
If Not fs.FileExists(python) Then
    MsgBox "The uv base Python is missing.", vbExclamation, "FullAwake"
    WScript.Quit 1
End If
' Clean up any lingering FullAwake desktop app or gateway holding port 8765 before launch.
cleanup = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command " & _
    """$pids = @(); " & _
    "$pids += (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'fullawake_desktop|fullawake\.gateway\.mcp_server' } | Select-Object -ExpandProperty ProcessId); " & _
    "$pids += (Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess); " & _
    "$pids | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; " & _
    "Start-Sleep -Milliseconds 300"""
shell.Run cleanup, 0, True
shell.CurrentDirectory = project
shell.Environment("PROCESS")("PYTHONPATH") = fs.BuildPath(project, "src") & ";" & fs.BuildPath(venv, "Lib\site-packages")
shell.Environment("PROCESS")("PYTHONUTF8") = "1"
shell.Run Chr(34) & python & Chr(34) & " -m fullawake_desktop", 1, False
