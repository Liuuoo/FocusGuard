Option Explicit

Dim shell
Dim fileSystem
Dim root
Dim launcher
Dim command

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcher = root & "\start-focusguard-task.ps1"
command = "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & launcher & """"

' Start the PowerShell bootstrapper without creating a visible console window.
shell.Run command, 0, False
