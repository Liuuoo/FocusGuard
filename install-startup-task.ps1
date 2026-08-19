param(
    [string]$TaskName = "FocusGuard",
    [int]$Port = 37831
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $root "start-focusguard-silent.vbs"
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "The portable launcher was not found: $launcher"
}

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
$actionArguments = "`"$launcher`""
$action = New-ScheduledTaskAction -Execute $wscript -Argument $actionArguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$trigger.Delay = "PT15S"
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit 0 `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -Hidden

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "FocusGuard local usage monitor" -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Host "FocusGuard scheduled task installed."
} catch {
    Write-Host "Could not install highest-privilege scheduled task: $($_.Exception.Message)"
    Write-Host "Installing current-user startup fallback instead."

    $runCommand = "wscript.exe `"$launcher`""
    New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Force | Out-Null
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name $TaskName -Value $runCommand
    Start-Process -FilePath $wscript -ArgumentList $actionArguments -WorkingDirectory $root -WindowStyle Hidden
    Write-Host "FocusGuard current-user startup fallback installed."
}

Write-Host "Management UI: http://127.0.0.1:$Port"
