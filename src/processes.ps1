$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

while ($true) {
    $items = @()

    Get-Process | ForEach-Object {
        $path = ""
        try {
            if ($_.Path) {
                $path = $_.Path
            }
        } catch {}

        $exe = ""
        if ($path) {
            $exe = [System.IO.Path]::GetFileName($path)
        } elseif ($_.ProcessName) {
            $exe = "$($_.ProcessName).exe"
        }

        if ($exe) {
            $items += [ordered]@{
                pid = $_.Id
                processName = $_.ProcessName
                exe = $exe
                path = $path
            }
        }
    }

    $payload = [ordered]@{
        timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        processes = $items
    }

    $payload | ConvertTo-Json -Compress -Depth 4
    Start-Sleep -Milliseconds 1000
}
