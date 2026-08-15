$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $root "install-startup-task.ps1"

$elevated = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$installer`"" `
    -WorkingDirectory $root `
    -Verb RunAs `
    -WindowStyle Normal `
    -Wait `
    -PassThru

if ($elevated.ExitCode -ne 0) {
    throw "Administrator installer exited with code $($elevated.ExitCode)."
}

Write-Host "FocusGuard administrator startup installation completed."
