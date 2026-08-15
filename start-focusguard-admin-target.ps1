$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root "src\server.js"
$deepseekKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
if ($deepseekKey) {
    $env:DEEPSEEK_API_KEY = $deepseekKey
}

Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*src/server.js*" } |
    ForEach-Object {
        try {
            Stop-Process -Id $_.ProcessId -Force
        } catch {}
    }

Start-Process -FilePath "node.exe" -ArgumentList "`"$server`"" -WorkingDirectory $root -WindowStyle Hidden
