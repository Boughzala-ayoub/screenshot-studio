# Shared by verify-capture.ps1 and verify-video.ps1: raw input, window
# enumeration and the drag helper. Dot-source it; it defines, it runs nothing.

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Name Input -Namespace W32 -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.IntPtr extra);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.IntPtr extra);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool MoveWindow(System.IntPtr h, int x, int y, int w, int t, bool repaint);
[DllImport("user32.dll")] public static extern bool PostMessageW(System.IntPtr h, uint msg, System.IntPtr wp, System.IntPtr lp);
'@

$LEFTDOWN = 0x0002; $LEFTUP = 0x0004; $KEYUP = 0x0002
$VK_CTRL = 0x11; $VK_SHIFT = 0x10; $VK_4 = 0x34
$OutDir = "$env:USERPROFILE\Pictures\Screenshot Studio"

# A Tauri shortcut string ("Ctrl+Shift+4", "Alt+K") as virtual-key codes, in
# press order, from the app's config.json so the test presses whatever the
# user actually chose.
function Get-Chord([string]$Which) {
    $cfg = Get-Content "$env:APPDATA\dev.ayoub.screenshotstudio\config.json" -EA 0 | ConvertFrom-Json
    $s = if ($cfg -and $cfg.$Which) { $cfg.$Which } elseif ($Which -eq 'record_hotkey') { 'Ctrl+Shift+5' } else { 'Ctrl+Shift+4' }
    $keys = foreach ($k in $s.Split('+')) {
        switch -Regex ($k) {
            '^Ctrl$'  { 0x11 }
            '^Shift$' { 0x10 }
            '^Alt$'   { 0x12 }
            '^Super$' { 0x5B }
            '^F(\d+)$' { 0x6F + [int]$matches[1] }
            '^[A-Z0-9]$' { [int][char]$k }
            default { throw "cannot press $k" }
        }
    }
    return ,[byte[]]$keys
}

# Press and release a chord, modifiers first, in the order Get-Chord gives.
function Press-Chord([byte[]]$Keys) {
    $Keys = [byte[]]$Keys.Clone() # reversed below; the caller keeps its order
    foreach ($k in $Keys) { [W32.Input]::keybd_event($k, 0, 0, [IntPtr]::Zero) }
    Start-Sleep -Milliseconds 60
    [array]::Reverse($Keys)
    foreach ($k in $Keys) { [W32.Input]::keybd_event($k, 0, $KEYUP, [IntPtr]::Zero) }
}

$fails = 0
function Check($ok, $msg) {
    if ($ok) { "ok    $msg" } else { $script:fails++; Write-Host "FAIL  $msg" -ForegroundColor Red }
}

# The app's visible top-level windows, with position. WebView2 draws through
# DirectComposition, which a GDI screen grab does not see, so window titles are
# the reliable way to tell whether the overlay and the preview are really up.
function Get-AppWindows([int]$ProcId) {
    $seen = New-Object Collections.ArrayList
    $cb = [W32.Input+EnumProc] {
        param($h, $l)
        $p = 0
        [void][W32.Input]::GetWindowThreadProcessId($h, [ref]$p)
        if ($p -eq $ProcId -and [W32.Input]::IsWindowVisible($h)) {
            $sb = New-Object Text.StringBuilder 256
            [void][W32.Input]::GetWindowTextW($h, $sb, 256)
            if ($sb.Length) {
                $r = New-Object W32.Input+RECT
                [void][W32.Input]::GetWindowRect($h, [ref]$r)
                [void]$seen.Add([pscustomobject]@{ H = $h; Title = $sb.ToString(); X = $r.L; Y = $r.T })
            }
        }
        return $true
    }
    [void][W32.Input]::EnumWindows($cb, [IntPtr]::Zero)
    return $seen
}

# Any top-level window of a given class, whoever owns it. Used to find the
# Explorer folder that the pin gets dropped onto.
function Get-WindowsOfClass([string]$Class) {
    $seen = New-Object Collections.ArrayList
    $cb = [W32.Input+EnumProc] {
        param($h, $l)
        if ([W32.Input]::IsWindowVisible($h)) {
            $c = New-Object Text.StringBuilder 256
            [void][W32.Input]::GetClassNameW($h, $c, 256)
            if ($c.ToString() -eq $Class) {
                $t = New-Object Text.StringBuilder 256
                [void][W32.Input]::GetWindowTextW($h, $t, 256)
                [void]$seen.Add([pscustomobject]@{ H = $h; Title = $t.ToString() })
            }
        }
        return $true
    }
    [void][W32.Input]::EnumWindows($cb, [IntPtr]::Zero)
    return $seen
}

# DoDragDrop only tracks movement it actually sees, so creep towards the target.
function Invoke-Drag([int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY, [int]$Steps = 12) {
    [void][W32.Input]::SetCursorPos($FromX, $FromY); Start-Sleep -Milliseconds 300
    [W32.Input]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 250
    foreach ($i in 1..$Steps) {
        [void][W32.Input]::SetCursorPos(
            [int]($FromX + ($ToX - $FromX) * $i / $Steps),
            [int]($FromY + ($ToY - $FromY) * $i / $Steps))
        Start-Sleep -Milliseconds 70
    }
    Start-Sleep -Milliseconds 400
    [W32.Input]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 800
}

function Wait-Window([int]$ProcId, [string]$Like, [int]$Tries = 120) {
    foreach ($i in 1..$Tries) {
        $w = @(Get-AppWindows $ProcId)
        if (@($w | Where-Object Title -like $Like).Count) { return $w }
        Start-Sleep -Milliseconds 250
    }
    return @(Get-AppWindows $ProcId)
}

