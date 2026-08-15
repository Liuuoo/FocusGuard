$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root "start-focusguard-admin-target.ps1"

Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$target`"" -WorkingDirectory $root -WindowStyle Hidden -Verb RunAs

Write-Host "FocusGuard is starting with administrator privileges."
Write-Host "Management UI: http://127.0.0.1:37831"
