Option Explicit
Dim shell, fs, project, venv, stream, line, base, python
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
shell.CurrentDirectory = project
shell.Environment("PROCESS")("PYTHONPATH") = fs.BuildPath(project, "src") & ";" & fs.BuildPath(venv, "Lib\site-packages")
shell.Environment("PROCESS")("PYTHONUTF8") = "1"
shell.Run Chr(34) & python & Chr(34) & " -m fullawake_desktop", 0, False
