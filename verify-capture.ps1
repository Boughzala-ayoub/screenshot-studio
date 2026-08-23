# End-to-end check of the real app: launch it, press the hotkey for real, drag a
# real rectangle, then look at what came out. Takes over the screen and the mouse
# for about fifteen seconds.
#
#   npm run verify:capture
#
# The drag is in physical pixels and so is the PNG it should produce, so the size
# assertion below is what catches a broken CSS-to-physical conversion on a scaled
# display. On a 150% monitor a wrong conversion gives 600x360, not 400x240.

param(
    [string]$Exe = "$PSScriptRoot\src-tauri\target\debug\screenshot-studio.exe",
    [int]$X1 = 300, [int]$Y1 = 300,
    [int]$X2 = 700, [int]$Y2 = 540
)

# Without this a failed Add-Type is non-terminating and every later check quietly
# skips, which reads as a pass. It is not one.
$ErrorActionPreference = 'Stop'

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

if (-not (Test-Path $Exe)) { throw "no exe at $Exe. Run: npm run tauri build -- --debug --no-bundle" }

# A leftover instance from an earlier run would own the hotkey and answer it,
# and the run would test that copy instead of this build.
Get-Process screenshot-studio -EA 0 | Stop-Process -Force -EA 0
Start-Sleep -Milliseconds 500

$before = @(Get-ChildItem $OutDir -Filter *.png -EA 0 | Select-Object -Expand FullName)
$cursor = New-Object W32.Input+POINT
[void][W32.Input]::GetCursorPos([ref]$cursor)
[Windows.Forms.Clipboard]::Clear()

$log = Join-Path $env:TEMP "screenshot-studio-verify"
$app = Start-Process $Exe -PassThru -NoNewWindow -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err"
try {
    Start-Sleep -Seconds 5   # tray icon + RegisterHotKey

    # Virtual key codes, not SendKeys: on an AZERTY layout SendKeys('4') injects
    # its own Shift and the combination stops being reproducible.
    [W32.Input]::keybd_event($VK_CTRL, 0, 0, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_SHIFT, 0, 0, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_4, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [W32.Input]::keybd_event($VK_4, 0, $KEYUP, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_SHIFT, 0, $KEYUP, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_CTRL, 0, $KEYUP, [IntPtr]::Zero)

    # The overlay only becomes visible once its page can take a pointer event, so
    # waiting for it is also the wait for "safe to drag".
    $up = Wait-Window $app.Id '*select a region*'
    $ov = @($up | Where-Object Title -like '*select a region*')
    Check ($ov.Count -eq 1) "the hotkey raised the overlay (saw: $(($up.Title) -join ', '))"

    # The overlay has to cover the whole desktop, not just one screen, or a
    # selection cannot cross a monitor edge. Only the origin is compared exactly:
    # an undecorated window still reports a few pixels of invisible border.
    if ($ov.Count -eq 1) {
        $vs = [Windows.Forms.SystemInformation]::VirtualScreen
        $r = New-Object W32.Input+RECT
        [void][W32.Input]::GetWindowRect($ov[0].H, [ref]$r)
        Check ($r.L -le $vs.Left -and $r.T -le $vs.Top -and
               $r.R -ge $vs.Right -and $r.B -ge $vs.Bottom -and
               ($vs.Left - $r.L) -le 24 -and ($r.R - $vs.Right) -le 24) `
            "the overlay spans the virtual screen ($($r.L),$($r.T))-($($r.R),$($r.B)) vs $vs"
    }

    [void][W32.Input]::SetCursorPos($X1, $Y1); Start-Sleep -Milliseconds 300
    $from = New-Object W32.Input+POINT; [void][W32.Input]::GetCursorPos([ref]$from)
    [W32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 200
    [void][W32.Input]::SetCursorPos([int](($X1 + $X2) / 2), [int](($Y1 + $Y2) / 2)); Start-Sleep -Milliseconds 200
    [void][W32.Input]::SetCursorPos($X2, $Y2); Start-Sleep -Milliseconds 300
    $to = New-Object W32.Input+POINT; [void][W32.Input]::GetCursorPos([ref]$to)
    [W32.Input]::mouse_event($LEFTUP, 0, 0, 0, [IntPtr]::Zero)

    $after = Wait-Window $app.Id '*pinned*'
    [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)

    Check (@($after | Where-Object Title -like '*select a region*').Count -eq 0) "the overlay closed on mouse-up"
    $pin = @($after | Where-Object Title -like '*pinned*')
    Check ($pin.Count -eq 1) "the crop is pinned (saw: $(($after.Title) -join ', '))"

    $new = @(Get-ChildItem $OutDir -Filter *.png -EA 0 | Where-Object { $before -notcontains $_.FullName })
    Check ($new.Count -eq 1) "one new png in $OutDir (got $($new.Count))"

    if ($new.Count -eq 1) {
        Check ($new[0].Name -match '^shot-\d{8}-\d{6}(-\d+)?\.png$') "named $($new[0].Name)"

        # Measured from where the cursor actually was, not where it was told to
        # go, so a stray hand on the mouse cannot fail the run. A few pixels of
        # slack on top of that; the failure this catches is a scale-factor
        # mix-up, which is off by hundreds, not by three.
        $wantW = [Math]::Abs($to.X - $from.X); $wantH = [Math]::Abs($to.Y - $from.Y)
        $png = [Drawing.Image]::FromFile($new[0].FullName)
        $w = $png.Width; $h = $png.Height
        $png.Dispose()
        Check (([Math]::Abs($w - $wantW) -le 6) -and ([Math]::Abs($h - $wantH) -le 6)) `
            "png is ${w}x${h}, dragged ${wantW}x${wantH} physical px"

        $clip = [Windows.Forms.Clipboard]::GetImage()
        Check ($null -ne $clip) "clipboard holds an image"
        if ($clip) {
            Check (($clip.Width -eq $w) -and ($clip.Height -eq $h)) `
                "clipboard image is $($clip.Width)x$($clip.Height), same as the png"
            $clip.Dispose()
        }
    }

    # data-tauri-drag-region is a no-op without core:window:allow-start-dragging
    # and it fails silently, so drag the grip strip and watch the pin move.
    if ($pin.Count -eq 1) {
        # Past the arrows and the counter, on the part of the bar that drags.
        Invoke-Drag ($pin[0].X + 150) ($pin[0].Y + 14) ($pin[0].X - 60) ($pin[0].Y - 90) 6
        [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)
        $moved = @(Get-AppWindows $app.Id | Where-Object Title -like '*pinned*')
        Check ($moved.Count -eq 1 -and ($moved[0].X -ne $pin[0].X -or $moved[0].Y -ne $pin[0].Y)) `
            "the title bar moves the pin (from $($pin[0].X),$($pin[0].Y) to $($moved[0].X),$($moved[0].Y))"
        $pin = $moved
    }

    # Drag the image out into a real Explorer folder. Nothing about the drag
    # source reports failure on its own, so the only honest check is whether a
    # file lands somewhere else.
    if ($pin.Count -eq 1) {
        $drop = Join-Path $env:TEMP "ss-drop-target"
        Remove-Item -Recurse -Force $drop -EA 0
        [void](New-Item -ItemType Directory -Force $drop)
        Start-Process explorer.exe $drop
        $folder = $null
        foreach ($i in 1..40) {
            $folder = @(Get-WindowsOfClass 'CabinetWClass' | Where-Object Title -like '*ss-drop-target*')[0]
            if ($folder) { break }
            Start-Sleep -Milliseconds 250
        }
        Check ($null -ne $folder) "opened an Explorer window to drop into"

        if ($folder) {
            [void][W32.Input]::MoveWindow($folder.H, 40, 40, 760, 520, $true)
            Start-Sleep -Milliseconds 800
            # Below the 28px title bar, so this is the image, not the move handle.
            Invoke-Drag ($pin[0].X + 60) ($pin[0].Y + 120) 400 340
            [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)

            $dropped = @(Get-ChildItem $drop -Filter *.png -EA 0)
            Check ($dropped.Count -eq 1) "dropping the pin into Explorer wrote $($dropped.Count) png there"

            $stayed = @(Get-AppWindows $app.Id | Where-Object Title -like '*pinned*')
            Check ($stayed.Count -eq 1 -and $stayed[0].X -eq $pin[0].X -and $stayed[0].Y -eq $pin[0].Y) `
                "dragging the image dragged the file, not the window"
            # Close that one folder window. Killing explorer.exe would take the
            # whole shell down with it.
            [void][W32.Input]::PostMessageW($folder.H, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
        }
        Remove-Item -Recurse -Force $drop -EA 0
    }

    $sizeOf = {
        param($w)
        $r = New-Object W32.Input+RECT
        [void][W32.Input]::GetWindowRect($w.H, [ref]$r)
        return "$($r.R - $r.L)x$($r.B - $r.T)"
    }
    # Everything below needs a pin. Without one the earlier checks have already
    # failed, and pressing on regardless just buries them in cast errors.
    if ($pin.Count -ne 1) { throw "no pin to work with; see the failures above" }
    $shape1 = & $sizeOf $pin[0]

    [W32.Input]::keybd_event($VK_CTRL, 0, 0, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_SHIFT, 0, 0, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_4, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [W32.Input]::keybd_event($VK_4, 0, $KEYUP, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_SHIFT, 0, $KEYUP, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_CTRL, 0, $KEYUP, [IntPtr]::Zero)
    [void](Wait-Window $app.Id '*select a region*')
    # Deliberately a different shape from the first shot.
    [void][W32.Input]::SetCursorPos(200, 200); Start-Sleep -Milliseconds 300
    [W32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 250
    [void][W32.Input]::SetCursorPos(800, 320); Start-Sleep -Milliseconds 350
    [W32.Input]::mouse_event($LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Seconds 4
    [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)

    $two = @(Get-AppWindows $app.Id | Where-Object Title -like '*pinned*')
    Check ($two.Count -eq 1) "the pin survives a second capture"
    if ($two.Count -eq 1) {
        $shape2 = & $sizeOf $two[0]
        Check ($shape2 -ne $shape1) "the pin refit to the new shot ($shape1 -> $shape2)"

        # The left arrow sits at the very start of the title bar.
        [void][W32.Input]::SetCursorPos(($two[0].X + 14), ($two[0].Y + 14))
        Start-Sleep -Milliseconds 300
        [W32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 120
        [W32.Input]::mouse_event($LEFTUP, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Seconds 2
        [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)

        $back = @(Get-AppWindows $app.Id | Where-Object Title -like '*pinned*')
        $shape3 = if ($back.Count -eq 1) { & $sizeOf $back[0] } else { "gone" }
        Check ($shape3 -eq $shape1) "the arrow steps back to the older shot ($shape2 -> $shape3, want $shape1)"
        $pin = $back

        # Dragging has to follow the arrows, not stay stuck on the newest shot.
        if ($back.Count -eq 1) {
            $newest = (Get-ChildItem $OutDir -Filter *.png | Sort-Object LastWriteTime -Descending)[0].Name
            $second = Join-Path $env:TEMP "ss-drop-older"
            Remove-Item -Recurse -Force $second -EA 0
            [void](New-Item -ItemType Directory -Force $second)
            Start-Process explorer.exe $second
            $win2 = $null
            foreach ($i in 1..40) {
                $win2 = @(Get-WindowsOfClass 'CabinetWClass' | Where-Object Title -like '*ss-drop-older*')[0]
                if ($win2) { break }
                Start-Sleep -Milliseconds 250
            }
            if ($win2) {
                [void][W32.Input]::MoveWindow($win2.H, 40, 40, 760, 520, $true)
                Start-Sleep -Milliseconds 800
                Invoke-Drag ($back[0].X + 60) ($back[0].Y + 120) 400 340
                [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)
                $got = @(Get-ChildItem $second -Filter *.png -EA 0)
                Check ($got.Count -eq 1 -and $got[0].Name -ne $newest) `
                    "dragging after stepping back gave '$($got[0].Name)', not the newest '$newest'"
                [void][W32.Input]::PostMessageW($win2.H, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
            }
            Remove-Item -Recurse -Force $second -EA 0
        }
    }

    # Every check so far would pass with the crop taken from the wrong place, as
    # long as it were the right size. Put a magenta block on screen at a known
    # spot, capture a rectangle around it, and look at where it landed. An
    # overlay whose client area is inset by Windows' invisible border shifts the
    # block by exactly that inset.
    $marker = Join-Path $env:TEMP "ss-marker.ps1"
    @'
param([int]$X, [int]$Y, [int]$W, [int]$H)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$f = New-Object Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.Location = New-Object Drawing.Point $X, $Y
$f.Size = New-Object Drawing.Size $W, $H
$f.BackColor = [Drawing.Color]::FromArgb(255, 0, 255)
$f.TopMost = $true
$f.ShowInTaskbar = $false
[Windows.Forms.Application]::Run($f)
'@ | Set-Content -Path $marker -Encoding utf8
    $mx = 500; $my = 300; $mw = 240; $mh = 160          # marker, screen coords
    $cx = 400; $cy = 200; $cw = 500; $ch = 400          # capture, screen coords
    $flag = Start-Process powershell -PassThru -WindowStyle Hidden `
        -ArgumentList '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $marker, $mx, $my, $mw, $mh
    Start-Sleep -Seconds 2
    try {
        $mark = @(Get-ChildItem $OutDir -Filter *.png -EA 0 | Select-Object -Expand FullName)
        [W32.Input]::keybd_event($VK_CTRL, 0, 0, [IntPtr]::Zero)
        [W32.Input]::keybd_event($VK_SHIFT, 0, 0, [IntPtr]::Zero)
        [W32.Input]::keybd_event($VK_4, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [W32.Input]::keybd_event($VK_4, 0, $KEYUP, [IntPtr]::Zero)
        [W32.Input]::keybd_event($VK_SHIFT, 0, $KEYUP, [IntPtr]::Zero)
        [W32.Input]::keybd_event($VK_CTRL, 0, $KEYUP, [IntPtr]::Zero)
        [void](Wait-Window $app.Id '*select a region*')

        [void][W32.Input]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 300
        [W32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 250
        [void][W32.Input]::SetCursorPos(($cx + $cw), ($cy + $ch)); Start-Sleep -Milliseconds 400
        [W32.Input]::mouse_event($LEFTUP, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Seconds 3
        [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)

        $aimed = @(Get-ChildItem $OutDir -Filter *.png -EA 0 | Where-Object { $mark -notcontains $_.FullName })
        Check ($aimed.Count -eq 1) "the aimed capture saved $($aimed.Count) png"
        if ($aimed.Count -eq 1) {
            $bmp = New-Object Drawing.Bitmap $aimed[0].FullName
            $magenta = { param($p) $p.R -gt 200 -and $p.G -lt 60 -and $p.B -gt 200 }
            $l = $mx - $cx; $t = $my - $cy                    # marker within the crop
            $r = $l + $mw; $b = $t + $mh
            $inTL = & $magenta $bmp.GetPixel(($l + 3), ($t + 3))
            $inBR = & $magenta $bmp.GetPixel(($r - 4), ($b - 4))
            $outTL = & $magenta $bmp.GetPixel(($l - 4), ($t - 4))
            $outBR = & $magenta $bmp.GetPixel(($r + 3), ($b + 3))
            $bmp.Dispose()
            Check ($inTL -and $inBR -and -not $outTL -and -not $outBR) `
                "the marker lands within 3px of ($l,$t)-($r,$b) in the crop (in $inTL/$inBR, out $outTL/$outBR)"
            Remove-Item $aimed[0].FullName -Force -EA 0
        }
    } finally {
        Stop-Process -Id $flag.Id -Force -EA 0
        Remove-Item $marker -Force -EA 0
    }

    # Launching again must hand the request to the running copy, not start a
    # second tray icon that then fights over the hotkey.
    $second = Start-Process $Exe -PassThru -NoNewWindow
    $again = Wait-Window $app.Id '*select a region*'
    Check (@($again | Where-Object Title -like '*select a region*').Count -eq 1) `
        "a second launch asks the running copy for a capture"
    $second.WaitForExit(8000) | Out-Null
    Check ($second.HasExited) "the second launch exited instead of staying resident"

    # That overlay is still up, so use it: drag a selection straight across the
    # seam between two screens. With a (0, 0) origin instead of the real one, a
    # press at negative x would not even land on the overlay.
    $vs = [Windows.Forms.SystemInformation]::VirtualScreen
    $wide = $vs.Width -gt [Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    if ($wide -and @($again | Where-Object Title -like '*select a region*').Count -eq 1) {
        $seam = [Windows.Forms.Screen]::PrimaryScreen.Bounds.Left
        $mark = @(Get-ChildItem $OutDir -Filter *.png -EA 0 | Select-Object -Expand FullName)
        # Start two pixels from the far top-left of the desktop. If the client
        # area is even slightly inside the frame, this press misses the overlay
        # entirely and nothing gets saved.
        [void][W32.Input]::SetCursorPos(($vs.Left + 2), 40); Start-Sleep -Milliseconds 300
        $a = New-Object W32.Input+POINT; [void][W32.Input]::GetCursorPos([ref]$a)
        [W32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 250
        [void][W32.Input]::SetCursorPos($seam, 300); Start-Sleep -Milliseconds 250
        [void][W32.Input]::SetCursorPos(($seam + 150), 500); Start-Sleep -Milliseconds 300
        $b = New-Object W32.Input+POINT; [void][W32.Input]::GetCursorPos([ref]$b)
        [W32.Input]::mouse_event($LEFTUP, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Seconds 3
        [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)

        $span = @(Get-ChildItem $OutDir -Filter *.png -EA 0 | Where-Object { $mark -notcontains $_.FullName })
        Check ($span.Count -eq 1) "a selection across the monitor seam saved $($span.Count) png"
        if ($span.Count -eq 1) {
            $sw = [Math]::Abs($b.X - $a.X); $sh = [Math]::Abs($b.Y - $a.Y)
            $img = [Drawing.Image]::FromFile($span[0].FullName)
            $gw = $img.Width; $gh = $img.Height
            $img.Dispose()
            Check (([Math]::Abs($gw - $sw) -le 6) -and ([Math]::Abs($gh - $sh) -le 6)) `
                "the seam crop is ${gw}x${gh}, dragged ${sw}x${sh} from the desktop edge across x=$seam"
            Remove-Item $span[0].FullName -Force -EA 0
        }
    } else {
        if (-not $wide) { "note  only one monitor here, seam selection not exercised" }
        [W32.Input]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero)
        [W32.Input]::keybd_event(0x1B, 0, $KEYUP, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 800
    }

    # Only the newest KEEP survive. Seeding the folder is far quicker than taking
    # six more screenshots, and it pins down which ones get deleted.
    $KEEP = 5
    Get-ChildItem $OutDir -Filter *.png -EA 0 | Remove-Item -Force -EA 0
    foreach ($n in 1..8) {
        $stub = Join-Path $OutDir ("shot-20200101-0000{0:d2}.png" -f $n)
        [byte[]](0) | Set-Content -Path $stub -Encoding Byte
        (Get-Item $stub).LastWriteTime = (Get-Date).AddMinutes(-100 + $n)
    }
    $keeper = Join-Path $OutDir "not-a-shot.txt"
    Set-Content -Path $keeper -Value 'left alone' -Encoding utf8

    [W32.Input]::keybd_event($VK_CTRL, 0, 0, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_SHIFT, 0, 0, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_4, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [W32.Input]::keybd_event($VK_4, 0, $KEYUP, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_SHIFT, 0, $KEYUP, [IntPtr]::Zero)
    [W32.Input]::keybd_event($VK_CTRL, 0, $KEYUP, [IntPtr]::Zero)
    [void](Wait-Window $app.Id '*select a region*')
    [void][W32.Input]::SetCursorPos(300, 300); Start-Sleep -Milliseconds 300
    [W32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 250
    [void][W32.Input]::SetCursorPos(600, 500); Start-Sleep -Milliseconds 350
    [W32.Input]::mouse_event($LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Seconds 3
    [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)

    $left = @(Get-ChildItem $OutDir -Filter *.png -EA 0 | Sort-Object LastWriteTime -Descending)
    Check ($left.Count -eq $KEEP) "8 stubs plus 1 capture leaves $($left.Count) png, want $KEEP"
    Check ($left[0].Length -gt 1000) "the survivor at the top is the real capture ($($left[0].Length) bytes)"
    Check (@($left | Where-Object Name -eq 'shot-20200101-000001.png').Count -eq 0) "the oldest stub is gone"
    Check (Test-Path $keeper) "a non-shot file in the folder is left alone"
    Remove-Item $keeper -Force -EA 0

    Check ($null -ne (Get-Process -Id $app.Id -EA 0)) "app still running after the capture"
} finally {
    Stop-Process -Id $app.Id -Force -EA 0
}

if ($fails) {
    # The app's own complaint is usually the whole answer.
    Start-Sleep -Milliseconds 500
    $said = @(Get-Content "$log.err", "$log.out" -EA 0) -ne ''
    if ($said) { "`n--- app said ---"; $said }
    Write-Host "`nverify-capture: FAILED ($fails)" -ForegroundColor Red
    exit 1
}
"`nverify-capture: all checks passed"
