$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Win32FocusGuard {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hWnd, uint attribute, out int value, uint size);

    public static bool IsCloaked(IntPtr hWnd) {
        int value;
        return DwmGetWindowAttribute(hWnd, 14, out value, sizeof(int)) == 0 && value != 0;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public class WindowInfo {
        public long hwnd;
        public int left;
        public int top;
        public int right;
        public int bottom;
        public int zIndex;
        public bool minimized;
        public bool visible;
        public string title;
    }

    public static List<WindowInfo> GetWindows() {
        var result = new List<WindowInfo>();
        var order = 0;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            if (IsCloaked(hWnd)) return true;

            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;
            if (rect.Right <= rect.Left || rect.Bottom <= rect.Top) return true;

            var buffer = new StringBuilder(1024);
            GetWindowText(hWnd, buffer, buffer.Capacity);
            result.Add(new WindowInfo {
                hwnd = hWnd.ToInt64(),
                left = rect.Left,
                top = rect.Top,
                right = rect.Right,
                bottom = rect.Bottom,
                zIndex = order++,
                minimized = IsIconic(hWnd),
                visible = true,
                title = buffer.ToString()
            });
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

function Get-WindowProcessInfo($window) {
    $pidValue = 0
    $hwnd = [IntPtr]::new([long]$window.hwnd)
    [void][Win32FocusGuard]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)

    $process = $null
    if ($pidValue -gt 0) {
        $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    }

    $path = ""
    try {
        if ($process -and $process.Path) {
            $path = $process.Path
        }
    } catch {}

    $exe = ""
    if ($path) {
        $exe = [System.IO.Path]::GetFileName($path)
    } elseif ($process -and $process.ProcessName) {
        $exe = "$($process.ProcessName).exe"
    }

    [ordered]@{
        hwnd = [long]$window.hwnd
        pid = $pidValue
        processName = if ($process) { $process.ProcessName } else { "" }
        exe = $exe
        path = $path
        title = [string]$window.title
        left = [int]$window.left
        top = [int]$window.top
        right = [int]$window.right
        bottom = [int]$window.bottom
        zIndex = [int]$window.zIndex
        minimized = [bool]$window.minimized
        visible = [bool]$window.visible
    }
}

while ($true) {
    $hwnd = [Win32FocusGuard]::GetForegroundWindow()
    $pidValue = 0
    [void][Win32FocusGuard]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)

    $buffer = New-Object System.Text.StringBuilder 1024
    [void][Win32FocusGuard]::GetWindowText($hwnd, $buffer, $buffer.Capacity)
    $title = $buffer.ToString()

    $process = $null
    if ($pidValue -gt 0) {
        $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    }

    $path = ""
    try {
        if ($process -and $process.Path) {
            $path = $process.Path
        }
    } catch {}

    $windows = @([Win32FocusGuard]::GetWindows() | ForEach-Object {
        Get-WindowProcessInfo $_
    })

    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $foreground = [ordered]@{
        hwnd = if ($hwnd -ne [IntPtr]::Zero) { $hwnd.ToInt64() } else { 0 }
        timestamp = $timestamp
        pid = $pidValue
        processName = if ($process) { $process.ProcessName } else { "" }
        exe = if ($path) { [System.IO.Path]::GetFileName($path) } else { "" }
        path = $path
        title = $title
    }

    $payload = [ordered]@{
        timestamp = $timestamp
        foreground = $foreground
        windows = $windows
        pid = $foreground.pid
        processName = $foreground.processName
        exe = $foreground.exe
        path = $foreground.path
        title = $foreground.title
    }

    $payload | ConvertTo-Json -Compress -Depth 5
    Start-Sleep -Milliseconds 1000
}
