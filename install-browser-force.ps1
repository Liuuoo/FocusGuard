param(
    [ValidateSet("Both", "Edge", "Chrome")]
    [string]$Browser = "Edge",
    [int]$Port = 37831,
    [switch]$BlockAllEdgeDownloads
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root "logs"
$logPath = Join-Path $logDir "browser-policy-installer.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

trap {
    $detail = "[$(Get-Date -Format o)] " + ($_ | Out-String).Trim()
    Add-Content -LiteralPath $logPath -Value $detail -Encoding UTF8
    Write-Error $detail
    exit 1
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
    $argumentList = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-Browser", $Browser,
        "-Port", $Port
    )
    if ($BlockAllEdgeDownloads) { $argumentList += "-BlockAllEdgeDownloads" }
    $elevated = Start-Process -FilePath "powershell.exe" `
        -ArgumentList $argumentList `
        -WorkingDirectory $root `
        -Verb RunAs `
        -WindowStyle Normal `
        -Wait `
        -PassThru
    if ($elevated.ExitCode -ne 0) {
        throw "Browser policy installer exited with code $($elevated.ExitCode)."
    }
    exit 0
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$manifestPath = Join-Path $root "browser-extension\manifest.json"
$extensionDir = Join-Path $root "browser-extension"
$dataDir = Join-Path $root "data\browser-extension"
$stagingDir = Join-Path $dataDir "package"
$packProfileDir = Join-Path $dataDir "pack-profile"
$keyPath = Join-Path $dataDir "focusguard.pem"
$crxPath = Join-Path $dataDir "focusguard.crx"
$metadataPath = Join-Path $dataDir "metadata.json"

$browserPaths = [ordered]@{
    Edge = @(
        "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    )
    Chrome = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    )
}

$targets = @()
if ($Browser -eq "Both" -or $Browser -eq "Edge") { $targets += "Edge" }
if ($Browser -eq "Both" -or $Browser -eq "Chrome") { $targets += "Chrome" }

$packBrowser = $null
foreach ($target in $targets) {
    foreach ($candidate in $browserPaths[$target]) {
        if (Test-Path -LiteralPath $candidate) {
            $packBrowser = $candidate
            break
        }
    }
    if ($packBrowser) { break }
}
if (-not $packBrowser) {
    throw "Could not find an installed Edge or Chrome browser to package the extension."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

if (Test-Path -LiteralPath $stagingDir) {
    $resolvedStaging = (Resolve-Path -LiteralPath $stagingDir).Path
    $resolvedData = (Resolve-Path -LiteralPath $dataDir).Path
    if (-not $resolvedStaging.StartsWith("$resolvedData\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove an unexpected packaging directory: $resolvedStaging"
    }
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
Copy-Item -LiteralPath (Join-Path $extensionDir "manifest.json") -Destination $stagingDir -Force
Copy-Item -LiteralPath (Join-Path $extensionDir "background.js") -Destination $stagingDir -Force

if (Test-Path -LiteralPath $packProfileDir) {
    $resolvedPackProfile = (Resolve-Path -LiteralPath $packProfileDir).Path
    $resolvedDataForProfile = (Resolve-Path -LiteralPath $dataDir).Path
    if (-not $resolvedPackProfile.StartsWith("$resolvedDataForProfile\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove an unexpected packaging profile directory: $resolvedPackProfile"
    }
    Remove-Item -LiteralPath $resolvedPackProfile -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $packProfileDir | Out-Null

$stagedCrx = "$stagingDir.crx"
$stagedPem = "$stagingDir.pem"
Remove-Item -LiteralPath $stagedCrx, $stagedPem -Force -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $keyPath) {
    $packArguments = @(
        "--user-data-dir=$packProfileDir",
        "--no-first-run",
        "--pack-extension=$stagingDir",
        "--pack-extension-key=$keyPath"
    )
} else {
    $packArguments = @(
        "--user-data-dir=$packProfileDir",
        "--no-first-run",
        "--pack-extension=$stagingDir"
    )
}
$packProcess = Start-Process -FilePath $packBrowser `
    -ArgumentList $packArguments `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
$packExitCode = $packProcess.ExitCode
if (-not (Test-Path -LiteralPath $keyPath) -and (Test-Path -LiteralPath $stagedPem)) {
    Move-Item -LiteralPath $stagedPem -Destination $keyPath -Force
}

$packDeadline = (Get-Date).AddSeconds(15)
while (-not (Test-Path -LiteralPath $stagedCrx) -and (Get-Date) -lt $packDeadline) {
    Start-Sleep -Milliseconds 250
}
if (-not (Test-Path -LiteralPath $keyPath)) {
    throw "The browser did not produce the extension signing key."
}
if (-not (Test-Path -LiteralPath $stagedCrx)) {
    throw "The browser failed to package the FocusGuard extension."
}
if ($packExitCode -ne 0) {
    Write-Warning "Edge returned exit code $packExitCode, but the CRX package was created successfully; continuing."
}
Copy-Item -LiteralPath $stagedCrx -Destination $crxPath -Force

$idScript = Join-Path $root "src\extension-id.js"
$extensionId = (& $node $idScript $keyPath).Trim()
if ($extensionId -notmatch "^[a-p]{32}$") {
    throw "Could not calculate a valid extension ID: $extensionId"
}

function Set-OnlyPolicyList {
    param(
        [string]$PolicyPath,
        [string]$Value
    )
    $registryPath = $PolicyPath -replace '^HKLM:\\', 'HKLM\'
    New-Item -ItemType Directory -Force -Path $PolicyPath | Out-Null
    $current = Get-ItemProperty -LiteralPath $PolicyPath
    $names = @($current.PSObject.Properties.Name | Where-Object { $_ -match "^\d+$" })
    foreach ($name in $names) {
        & reg.exe DELETE $registryPath /v $name /f | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not remove registry value $registryPath\$name." }
    }
    & reg.exe ADD $registryPath /v "1" /t REG_SZ /d $Value /f | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not write registry value $registryPath\1." }
}

function Set-PolicyDword {
    param(
        [string]$PolicyPath,
        [string]$Name,
        [int]$Value
    )
    $registryPath = $PolicyPath -replace '^HKLM:\\', 'HKLM\'
    & reg.exe ADD $registryPath /v $Name /t REG_DWORD /d $Value /f | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not write registry value $registryPath\$Name." }
}

if ($targets -contains "Edge") {
    $edgePolicyPath = "HKLM:\SOFTWARE\Policies\Microsoft\Edge"
    $edgeBlocklistPath = Join-Path $edgePolicyPath "ExtensionInstallBlocklist"
    $edgeAllowlistPath = Join-Path $edgePolicyPath "ExtensionInstallAllowlist"
    Set-PolicyDword $edgePolicyPath "ExtensionDeveloperModeSettings" 1
    Set-OnlyPolicyList $edgeBlocklistPath "*"
    Set-OnlyPolicyList $edgeAllowlistPath $extensionId
    Set-PolicyDword $edgePolicyPath "DownloadRestrictions" $(if ($BlockAllEdgeDownloads) { 3 } else { 0 })
}

if ($targets -contains "Chrome") {
    $chromePolicyPath = "HKLM:\SOFTWARE\Policies\Google\Chrome"
    $chromeBlocklistPath = Join-Path $chromePolicyPath "ExtensionInstallBlocklist"
    $chromeAllowlistPath = Join-Path $chromePolicyPath "ExtensionInstallAllowlist"
    Set-OnlyPolicyList $chromeBlocklistPath "*"
    Set-OnlyPolicyList $chromeAllowlistPath $extensionId
}

$previous = $null
if (Test-Path -LiteralPath $metadataPath) {
    try { $previous = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json } catch {}
}
foreach ($entry in @($previous.policyEntries)) {
    if ($entry.path -and $entry.name) {
        Remove-ItemProperty -LiteralPath $entry.path -Name $entry.name -Force -ErrorAction SilentlyContinue
    }
}

$updateUrl = "http://127.0.0.1:$Port/api/browser-extension/update.xml"
$policyEntries = @()
foreach ($target in $targets) {
    $policyPath = if ($target -eq "Edge") {
        "HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist"
    } else {
        "HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"
    }
    New-Item -ItemType Directory -Force -Path $policyPath | Out-Null
    $properties = Get-ItemProperty -LiteralPath $policyPath
    $usedNames = @($properties.PSObject.Properties.Name | Where-Object { $_ -match "^\d+$" })
    $index = 1
    while ($usedNames -contains [string]$index) { $index++ }
    $value = "$extensionId;$updateUrl"
    New-ItemProperty -LiteralPath $policyPath -Name ([string]$index) -Value $value -PropertyType String -Force | Out-Null
    $policyEntries += [pscustomobject]@{
        browser = $target
        path = $policyPath
        name = [string]$index
        value = $value
    }
}

$metadata = [ordered]@{
    id = $extensionId
    version = [string]$manifest.version
    policyEntries = $policyEntries
    installedAt = (Get-Date).ToString("o")
}
$metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadataPath -Encoding UTF8

Remove-Item -LiteralPath $stagingDir -Recurse -Force
Remove-Item -LiteralPath $packProfileDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stagedCrx -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stagedPem -Force -ErrorAction SilentlyContinue

Write-Host "FocusGuard browser extension packaged with fixed ID: $extensionId"
Write-Host "Forced installation policy applied to: $($targets -join ', ')"
Write-Host "Restart Edge/Chrome to load the policy. Check edge://policy or chrome://policy if needed."
