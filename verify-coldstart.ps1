# The check no other script covers: a hotkey pressed right after launch, while
# the overlay's page is still crawling through its first load on a cold WebView2,
# must be answered late rather than lost. Launch, press at 2 s, and the overlay
# must appear -- eventually is fine, never is the bug. Then four warm presses,
# which must each be answered promptly.
#
#   npm run verify:coldstart
#
# Takes over the keyboard for up to a minute. Escape is sent after every press so
# nothing is left on screen.

param(
    [string]$Exe = "$PSScriptRoot\src-tauri\target\debug\screenshot-studio.exe",
    # WebView2 environment creation measured 3-35 s on this machine depending on
    # load; the ceiling is above the worst observed, because the check is "the
    # press is answered", not "the machine is fast".
    [int]$ColdCeilingMs = 60000,
    [int]$WarmCeilingMs = 5000
)

$ErrorActionPreference = 'Stop'
Add-Type -Name P -Namespace Cold -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.IntPtr extra);
'@

if (-not (Test-Path $Exe)) { throw "no exe at $Exe. Run: npm run tauri build -- --debug --no-bundle" }

function Overlay {
    $script:seen = $false
    $cb = [Cold.P+EnumProc] {
        param($h, $l)
        $p = 0
        [void][Cold.P]::GetWindowThreadProcessId($h, [ref]$p)
        if ($p -eq $target -and [Cold.P]::IsWindowVisible($h)) {
            $t = New-Object Text.StringBuilder 128
            [void][Cold.P]::GetWindowTextW($h, $t, 128)
            if ($t.ToString() -like '*select a region*') { $script:seen = $true }
        }
        return $true
    }
    [void][Cold.P]::EnumWindows($cb, [IntPtr]::Zero)
    return $script:seen
}

function Hotkey {
    # Virtual key codes, not SendKeys: on an AZERTY layout SendKeys('4') injects
    # its own Shift and the combination stops being reproducible.
    [Cold.P]::keybd_event(0x11, 0, 0, [IntPtr]::Zero)
    [Cold.P]::keybd_event(0x10, 0, 0, [IntPtr]::Zero)
    [Cold.P]::keybd_event(0x34, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [Cold.P]::keybd_event(0x34, 0, 2, [IntPtr]::Zero)
    [Cold.P]::keybd_event(0x10, 0, 2, [IntPtr]::Zero)
    [Cold.P]::keybd_event(0x11, 0, 2, [IntPtr]::Zero)
}

function Escape {
    [Cold.P]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero)
    [Cold.P]::keybd_event(0x1B, 0, 2, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 800
}

# One press, answered or not within the ceiling. Returns the milliseconds or -1.
function Press([int]$CeilingMs) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Hotkey
    while ($sw.ElapsedMilliseconds -lt $CeilingMs) {
        if (Overlay) { return $sw.ElapsedMilliseconds }
        Start-Sleep -Milliseconds 50
    }
    return -1
}

# A leftover instance would answer the hotkey warm and pass a cold start it
# never took.
Get-Process screenshot-studio -EA 0 | Stop-Process -Force -EA 0
Start-Sleep -Milliseconds 600

$fails = 0
$app = Start-Process $Exe -PassThru
$target = $app.Id
try {
    # The point of the whole exercise: pressed two seconds in, while the
    # overlay's page may not have run a single statement yet.
    Start-Sleep -Seconds 2
    $cold = Press $ColdCeilingMs
    if ($cold -ge 0) {
        "ok    cold press answered in $cold ms"
    } else {
        $fails++
        Write-Host "FAIL  cold press lost: no overlay within $ColdCeilingMs ms" -ForegroundColor Red
    }
    Escape

    foreach ($i in 1..4) {
        $warm = Press $WarmCeilingMs
        if ($warm -ge 0) {
            "ok    warm press $i answered in $warm ms"
        } else {
            $fails++
            Write-Host "FAIL  warm press $i lost: no overlay within $WarmCeilingMs ms" -ForegroundColor Red
        }
        Escape
    }
} finally {
    Stop-Process -Id $target -Force -EA 0
}

if ($fails) { Write-Host "`nverify-coldstart: FAILED ($fails)" -ForegroundColor Red; exit 1 }
"`nverify-coldstart: all presses answered"
