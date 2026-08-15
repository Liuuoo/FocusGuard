$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 37831
$deepseekKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
if ($deepseekKey) {
    $env:DEEPSEEK_API_KEY = $deepseekKey
}

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "FocusGuard is already running."
    Write-Host "Management UI: http://127.0.0.1:$port"
    exit 0
}

Start-Process -FilePath "node.exe" -ArgumentList "src/server.js" -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Seconds 2

Write-Host "FocusGuard started."
Write-Host "Management UI: http://127.0.0.1:$port"
