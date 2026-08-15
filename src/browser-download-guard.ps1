$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptRoot
$guardStartedAt = [DateTime]::UtcNow
$quarantineRoot = Join-Path $root "data\quarantine\browser-installers"
New-Item -ItemType Directory -Force -Path $quarantineRoot | Out-Null

$scanRoots = @(
    (Join-Path $env:USERPROFILE "Downloads"),
    [Environment]::GetFolderPath("Desktop")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

$packageExtensions = @(
    ".exe", ".msi", ".msix", ".appx", ".zip", ".7z", ".rar", ".crx", ".xpi", ".cab"
)

$browserTokens = @(
    "chrome", "googlechrome", "firefox", "360se", "360chrome", "360browser",
    "2345explorer", "2345chrome", "2345browser", "quark", "quarkbrowser",
    "opera", "operagx", "brave", "vivaldi", "sogouexplorer", "qqbrowser",
    "ucbrowser", "maxthon", "torbrowser", "yandex", "librewolf", "waterfox",
    "baidubrowser", "liebao"
)

$stableFiles = @{}

function Get-FileIdentity($file) {
    $version = $null
    try { $version = $file.VersionInfo } catch {}
    return "{0} {1} {2} {3} {4}" -f `
        $file.Name, $file.BaseName, $version.ProductName, $version.CompanyName, $version.FileDescription
}

function Is-BlockedBrowserPackage($file) {
    $extension = $file.Extension.ToLowerInvariant()
    if ($packageExtensions -notcontains $extension) { return $false }

    $identity = (Get-FileIdentity $file).ToLowerInvariant()
    if ($identity -match "chromedriver|geckodriver|msedgedriver|webdriver") { return $false }
    foreach ($token in $browserTokens) {
        if ($identity.Contains($token)) { return $true }
    }
    return $false
}

function Quarantine-BrowserPackage($file) {
    if (-not (Test-Path -LiteralPath $file.FullName)) { return }
    $safeName = "{0}_{1}{2}" -f `
        [System.IO.Path]::GetFileNameWithoutExtension($file.Name),
        (Get-Date -Format "yyyyMMdd_HHmmssfff"),
        $file.Extension
    $destination = Join-Path $quarantineRoot $safeName
    try {
        Move-Item -LiteralPath $file.FullName -Destination $destination -Force
        [ordered]@{
            timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            event = "browser-package-quarantined"
            originalPath = $file.FullName
            quarantinePath = $destination
        } | ConvertTo-Json -Compress
    } catch {}
}

function Scan-Root($scanRoot) {
    Get-ChildItem -LiteralPath $scanRoot -File -Force -Recurse -Depth 2 -ErrorAction SilentlyContinue | ForEach-Object {
        $file = $_
        if ($packageExtensions -notcontains $file.Extension.ToLowerInvariant()) { return }
        if ($file.LastWriteTimeUtc -lt $guardStartedAt) { return }

        $signature = "{0}|{1}" -f $file.Length, $file.LastWriteTimeUtc.Ticks
        if ($stableFiles[$file.FullName] -ne $signature) {
            $stableFiles[$file.FullName] = $signature
            return
        }

        if (Is-BlockedBrowserPackage $file) {
            Quarantine-BrowserPackage $file
            $stableFiles.Remove($file.FullName)
        } else {
            $stableFiles.Remove($file.FullName)
        }
    }
}

while ($true) {
    foreach ($scanRoot in $scanRoots) { Scan-Root $scanRoot }
    Start-Sleep -Seconds 5
}
