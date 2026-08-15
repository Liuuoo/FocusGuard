param(
    [Parameter(Mandatory = $true)]
    [long]$Hwnd
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class FocusGuardTabCloser {
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
"@

$target = [IntPtr]::new($Hwnd)
if (-not [FocusGuardTabCloser]::IsWindow($target)) {
    exit 0
}

$previous = [FocusGuardTabCloser]::GetForegroundWindow()
[void][FocusGuardTabCloser]::SetForegroundWindow($target)
Start-Sleep -Milliseconds 100

$keyUp = 0x0002
[FocusGuardTabCloser]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[FocusGuardTabCloser]::keybd_event(0x57, 0, 0, [UIntPtr]::Zero)
[FocusGuardTabCloser]::keybd_event(0x57, 0, $keyUp, [UIntPtr]::Zero)
[FocusGuardTabCloser]::keybd_event(0x11, 0, $keyUp, [UIntPtr]::Zero)

Start-Sleep -Milliseconds 100
if ($previous -ne [IntPtr]::Zero -and [FocusGuardTabCloser]::IsWindow($previous)) {
    [void][FocusGuardTabCloser]::SetForegroundWindow($previous)
}
