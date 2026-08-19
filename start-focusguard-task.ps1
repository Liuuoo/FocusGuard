$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 37831
$node = (Get-Command node.exe -ErrorAction Stop).Source
$server = Join-Path $root "src\server.js"
$logDir = Join-Path $root "logs"
$stdoutLog = Join-Path $logDir "focusguard-task.log"
$stderrLog = Join-Path $logDir "focusguard-task-error.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$deepseekKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
if ($deepseekKey) {
    $env:DEEPSEEK_API_KEY = $deepseekKey
}
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    exit 0
}
Set-Location $root
$process = Start-Process `
    -FilePath $node `
    -ArgumentList @("`"$server`"") `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

if (-not $process) {
    throw "FocusGuard Node process could not be started."
}
