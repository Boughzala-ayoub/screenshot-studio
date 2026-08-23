# Hotkey to a usable overlay, measured the way it is felt: the overlay only
# becomes visible once its page can take a pointer event, so the moment it shows
# is the moment the capture is actually usable.
param(
    [string]$Exe = "$env:LOCALAPPDATA\Screenshot Studio\screenshot-studio.exe",
    [int]$Runs = 5
)

$ErrorActionPreference = 'Stop'
Add-Type -Name P -Namespace Lat -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.IntPtr extra);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.IntPtr e);
'@

Get-Process screenshot-studio -EA 0 | Stop-Process -Force -EA 0
Start-Sleep -Milliseconds 600
$app = Start-Process $Exe -PassThru
$target = $app.Id

function Overlay {
    $script:seen = $false
    $cb = [Lat.P+EnumProc] {
        param($h, $l)
        $p = 0
        [void][Lat.P]::GetWindowThreadProcessId($h, [ref]$p)
        if ($p -eq $target -and [Lat.P]::IsWindowVisible($h)) {
            $t = New-Object Text.StringBuilder 128
            [void][Lat.P]::GetWindowTextW($h, $t, 128)
            if ($t.ToString() -like '*select a region*') { $script:seen = $true }
        }
        return $true
    }
    [void][Lat.P]::EnumWindows($cb, [IntPtr]::Zero)
    return $script:seen
}

function Hotkey {
    [Lat.P]::keybd_event(0x11, 0, 0, [IntPtr]::Zero)
    [Lat.P]::keybd_event(0x10, 0, 0, [IntPtr]::Zero)
    [Lat.P]::keybd_event(0x34, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [Lat.P]::keybd_event(0x34, 0, 2, [IntPtr]::Zero)
    [Lat.P]::keybd_event(0x10, 0, 2, [IntPtr]::Zero)
    [Lat.P]::keybd_event(0x11, 0, 2, [IntPtr]::Zero)
}

Start-Sleep -Seconds 30  # settle: tray, hotkey, and the one-off webview warm-up
$times = @()
foreach ($i in 1..$Runs) {
    while (Overlay) { Start-Sleep -Milliseconds 100 }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Hotkey
    $ok = $false
    while ($sw.ElapsedMilliseconds -lt 15000) {
        if (Overlay) { $ok = $true; break }
        Start-Sleep -Milliseconds 25
    }
    $sw.Stop()
    if ($ok) {
        $times += $sw.ElapsedMilliseconds
        "run $i : $($sw.ElapsedMilliseconds) ms"
    } else {
        "run $i : TIMED OUT"
    }
    # Esc, so the next run starts from nothing on screen.
    [Lat.P]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero)
    [Lat.P]::keybd_event(0x1B, 0, 2, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 900
}
if ($times.Count) {
    $sorted = $times | Sort-Object
    "median $($sorted[[int]($sorted.Count/2)]) ms   min $($sorted[0])   max $($sorted[-1])"
}
Stop-Process -Id $target -Force -EA 0
