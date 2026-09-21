# End-to-end check of a recording and an annotation in the real app: launch
# it, press the record hotkey, drag a region, wiggle the mouse inside it for a
# few seconds, press the hotkey again, then look at the MP4 that came out.
# Then take a still, open it in the editor from the pin, draw a rectangle,
# save, and look for the rectangle in the PNG. Takes over the screen and the
# mouse for about thirty seconds.
#
#   npm run verify:video
#
# The MP4 is read back through the shell's property system, which is the
# same Media Foundation the encoder wrote it with: width, height and length.

param(
    [string]$Exe = "$PSScriptRoot\src-tauri\target\debug\screenshot-studio.exe",
    [int]$X1 = 300, [int]$Y1 = 300,
    [int]$X2 = 701, [int]$Y2 = 541,   # odd sizes on purpose: the crop must come out even
    [int]$Seconds = 4
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\verify-lib.ps1"
$VK_E = 0x45; $VK_S = 0x53
$CAPTURE = Get-Chord 'hotkey'; $RECORD = Get-Chord 'record_hotkey'

if (-not (Test-Path $Exe)) { throw "no exe at $Exe. Run: cargo build in src-tauri" }

function Drag-Select([int]$ax, [int]$ay, [int]$bx, [int]$by) {
    [void][W32.Input]::SetCursorPos($ax, $ay); Start-Sleep -Milliseconds 300
    [W32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 200
    [void][W32.Input]::SetCursorPos([int](($ax + $bx) / 2), [int](($ay + $by) / 2)); Start-Sleep -Milliseconds 200
    [void][W32.Input]::SetCursorPos($bx, $by); Start-Sleep -Milliseconds 300
    [W32.Input]::mouse_event($LEFTUP, 0, 0, 0, [IntPtr]::Zero)
}

# Width, height and duration (seconds) of a media file, through the shell's
# property system: the same Media Foundation the encoder wrote it with.
# Canonical names, because the display names are localized.
function Get-MediaInfo([string]$Path) {
    $shell = New-Object -ComObject Shell.Application
    $dir = $shell.Namespace((Split-Path $Path))
    $item = $dir.ParseName((Split-Path $Path -Leaf))
    return @{
        Width  = [int]$item.ExtendedProperty('System.Video.FrameWidth')
        Height = [int]$item.ExtendedProperty('System.Video.FrameHeight')
        Secs   = [double]$item.ExtendedProperty('System.Media.Duration') / 1e7
    }
}

Get-Process screenshot-studio -EA 0 | Stop-Process -Force -EA 0
Start-Sleep -Milliseconds 500

$beforeMp4 = @(Get-ChildItem $OutDir -Filter *.mp4 -EA 0 | Select-Object -Expand FullName)
$beforePng = @(Get-ChildItem $OutDir -Filter *.png -EA 0 | Select-Object -Expand FullName)
$cursor = New-Object W32.Input+POINT
[void][W32.Input]::GetCursorPos([ref]$cursor)

$log = Join-Path $env:TEMP "screenshot-studio-verify-video"
$app = Start-Process $Exe -PassThru -NoNewWindow -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err"
try {
    # All three standing windows up, so nothing below waits on a cold webview.
    $ready = $false
    foreach ($i in 1..240) {
        if ((Get-Content "$log.err" -EA 0) -match 'editor window built') { $ready = $true; break }
        Start-Sleep -Milliseconds 250
    }
    Check $ready "overlay, pin and editor windows built ($(((Get-Content "$log.err" -EA 0) -match 'built') -join '; '))"
    Start-Sleep -Seconds 1

    # --- full screen ----------------------------------------------------
    # Tab lands on the hint's Full screen button, the only focusable thing
    # before a drag. It needs the monitor permissions in capabilities: without
    # them the click fails and the Record controls never show.
    Press-Chord $RECORD
    $up = Wait-Window $app.Id '*select a region*'
    Check (@($up | Where-Object Title -like '*select a region*').Count -eq 1) "the record hotkey raised the overlay for full screen"
    Start-Sleep -Milliseconds 500
    Press-Chord @(0x09); Start-Sleep -Milliseconds 200
    Press-Chord @(0x0D); Start-Sleep -Milliseconds 800
    Press-Chord @(0x0D) # Full screen focuses Record; Enter starts it.
    $bar = Wait-Window $app.Id '*pinned video*'
    $pin = @($bar | Where-Object Title -like '*pinned video*')
    Check ($pin.Count -eq 1) "Full screen + Record raised the stop bar (saw: $(($bar.Title) -join ', '))"
    if ($pin.Count -eq 1) {
        $r = New-Object W32.Input+RECT
        [void][W32.Input]::GetWindowRect($pin[0].H, [ref]$r)
        Check ($r.T -lt 100) "the stop bar sits at the top for a full-screen recording (top $($r.T))"
    }
    Start-Sleep -Seconds 1
    Press-Chord $RECORD
    $full = $null
    foreach ($i in 1..80) {
        $full = @(Get-ChildItem $OutDir -Filter *.mp4 -EA 0 | Where-Object { $beforeMp4 -notcontains $_.FullName })
        if ($full.Count -eq 1) { break }
        Start-Sleep -Milliseconds 250
    }
    Check ($full.Count -eq 1) "full-screen recording produced one mp4 (got $($full.Count))"
    if ($full.Count -eq 1) {
        Start-Sleep -Seconds 1
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $info = Get-MediaInfo $full[0].FullName
        Check (([Math]::Abs($info.Width - $screen.Width) -le 2) -and ([Math]::Abs($info.Height - $screen.Height) -le 2)) `
            "full-screen mp4 is $($info.Width)x$($info.Height), monitor is $($screen.Width)x$($screen.Height)"
    }
    # Esc closes the pinned recording so the region pass below starts clean.
    $vp = @((Wait-Window $app.Id '*pinned video*') | Where-Object Title -like '*pinned video*')
    if ($vp.Count -eq 1) {
        Start-Sleep -Seconds 1
        $r = New-Object W32.Input+RECT
        [void][W32.Input]::GetWindowRect($vp[0].H, [ref]$r)
        [void][W32.Input]::SetCursorPos($r.L + 80, $r.T + 90); Start-Sleep -Milliseconds 200
        [W32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60
        [W32.Input]::mouse_event($LEFTUP, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 300
        Press-Chord @(0x1B)
        foreach ($i in 1..40) {
            if (@(Get-AppWindows $app.Id | Where-Object Title -like '*pinned video*').Count -eq 0) { break }
            Start-Sleep -Milliseconds 250
        }
    }
    Check (@(Get-AppWindows $app.Id | Where-Object Title -like '*pinned video*').Count -eq 0) "the full-screen pin closed on Esc"
    $beforeMp4 = @(Get-ChildItem $OutDir -Filter *.mp4 -EA 0 | Select-Object -Expand FullName)
    Start-Sleep -Seconds 1

    # --- record ---------------------------------------------------------
    Press-Chord $RECORD
    $up = Wait-Window $app.Id '*select a region*'
    Check (@($up | Where-Object Title -like '*select a region*').Count -eq 1) "the record hotkey raised the overlay"

    Drag-Select $X1 $Y1 $X2 $Y2
    Start-Sleep -Milliseconds 300
    $startedEarly = @(Get-ChildItem $OutDir -Filter *.mp4 -EA 0 | Where-Object { $beforeMp4 -notcontains $_.FullName })
    Check ($startedEarly.Count -eq 0) "selecting the region waits for Record"
    Press-Chord @(0x0D) # Enter explicitly confirms the prepared region.
    $bar = Wait-Window $app.Id '*pinned video*'
    $pin = @($bar | Where-Object Title -like '*pinned video*')
    Check ($pin.Count -eq 1) "the stop bar appeared (saw: $(($bar.Title) -join ', '))"
    Check (@($bar | Where-Object Title -like '*select a region*').Count -eq 1) "the overlay stays up as the frame"
    if ($pin.Count -eq 1) {
        $r = New-Object W32.Input+RECT
        [void][W32.Input]::GetWindowRect($pin[0].H, [ref]$r)
        $bw = $r.R - $r.L; $bh = $r.B - $r.T
        Check (($bw -ge 160 -and $bw -le 260) -and ($bh -ge 30 -and $bh -le 60)) "the stop bar is bar-sized (${bw}x${bh})"
        Check ($r.T -gt $Y2 -or $r.B -lt $Y1) "the stop bar sits clear of the region (top $($r.T), region ends $Y2)"
    }

    # Something has to change inside the region for frames to arrive: the
    # cursor is captured, so walk it around in there.
    $t0 = Get-Date
    $stopAt = $t0.AddSeconds($Seconds)
    $k = 0
    while ((Get-Date) -lt $stopAt) {
        $k++
        [void][W32.Input]::SetCursorPos($X1 + 40 + ($k * 17 % 300), $Y1 + 40 + ($k * 11 % 150))
        Start-Sleep -Milliseconds 40
    }
    $recorded = ((Get-Date) - $t0).TotalSeconds

    Press-Chord $RECORD
    $new = $null
    foreach ($i in 1..80) {
        $new = @(Get-ChildItem $OutDir -Filter *.mp4 -EA 0 | Where-Object { $beforeMp4 -notcontains $_.FullName })
        $overlayGone = @(Get-AppWindows $app.Id | Where-Object Title -like '*select a region*').Count -eq 0
        if ($new.Count -eq 1 -and $overlayGone) { break }
        Start-Sleep -Milliseconds 250
    }
    Check ($new.Count -eq 1) "one new mp4 in $OutDir (got $($new.Count))"
    Check $overlayGone "the frame overlay went away on stop"
    [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)

    if ($new.Count -eq 1) {
        Check ($new[0].Name -match '^shot-\d{8}-\d{6}(-\d+)?\.mp4$') "named $($new[0].Name)"
        Check ($new[0].Length -gt 20000) "mp4 is $([math]::Round($new[0].Length / 1kb)) KB"
        $info = Get-MediaInfo $new[0].FullName
        $w = $info.Width; $h = $info.Height
        $wantW = [Math]::Abs($X2 - $X1) -band -bnot 1; $wantH = [Math]::Abs($Y2 - $Y1) -band -bnot 1
        Check (([Math]::Abs($w - $wantW) -le 6) -and ([Math]::Abs($h - $wantH) -le 6) -and ($w % 2 -eq 0) -and ($h % 2 -eq 0)) `
            "mp4 is ${w}x${h}, dragged $([Math]::Abs($X2 - $X1))x$([Math]::Abs($Y2 - $Y1)), even ${wantW}x${wantH} expected"
        # The clock starts at the first frame, and frames only come when the
        # region changes, so the wiggle is what the length is compared to.
        Check ([Math]::Abs($info.Secs - $recorded) -le 1.5) `
            "mp4 runs $([math]::Round($info.Secs, 1)) s, the region changed for $([math]::Round($recorded, 1)) s"
        $vpin = Wait-Window $app.Id '*pinned video*'
        $vp = @($vpin | Where-Object Title -like '*pinned video*')
        if ($vp.Count -eq 1) {
            $r = New-Object W32.Input+RECT
            [void][W32.Input]::GetWindowRect($vp[0].H, [ref]$r)
            Check (($r.B - $r.T) -gt 100) "the recording is pinned ($($r.R - $r.L)x$($r.B - $r.T))"
            $vrect = $r
            # N on the video pin starts another recording, not a still: the
            # window that comes back after the drag is the stop bar again.
            [void][W32.Input]::SetCursorPos($r.L + 80, $r.T + 90); Start-Sleep -Milliseconds 200
            [W32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60
            [W32.Input]::mouse_event($LEFTUP, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 300
            Press-Chord @(0x4E)
            $again = Wait-Window $app.Id '*select a region*'
            Check (@($again | Where-Object Title -like '*select a region*').Count -eq 1) "N on the video pin raised the overlay"
            Drag-Select $X1 $Y1 $X2 $Y2
            Press-Chord @(0x0D)
            $bar2 = Wait-Window $app.Id '*pinned video*'
            $vp2 = @($bar2 | Where-Object Title -like '*pinned video*')
            $r2 = New-Object W32.Input+RECT
            if ($vp2.Count -eq 1) { [void][W32.Input]::GetWindowRect($vp2[0].H, [ref]$r2) }
            Check ($vp2.Count -eq 1 -and ($r2.B - $r2.T) -lt 60) "N on the video pin started a recording (stop bar $($r2.R - $r2.L)x$($r2.B - $r2.T))"
            Start-Sleep -Seconds 1
            Press-Chord $RECORD
            $two = $null
            foreach ($i in 1..80) {
                $two = @(Get-ChildItem $OutDir -Filter *.mp4 -EA 0 | Where-Object { $beforeMp4 -notcontains $_.FullName })
                if ($two.Count -eq 2) { break }
                Start-Sleep -Milliseconds 250
            }
            Check ($two.Count -eq 2) "the second recording was saved too ($($two.Count) new mp4)"
            [void](Wait-Window $app.Id '*pinned video*')
            $vp = @(Get-AppWindows $app.Id | Where-Object Title -like '*pinned video*')
            if ($vp.Count -eq 1) { [void][W32.Input]::GetWindowRect($vp[0].H, [ref]$r); $vrect = $r }
        } else { Check $false "the recording is pinned" }
    }
    Start-Sleep -Milliseconds 800

    # --- annotate -------------------------------------------------------
    Press-Chord $CAPTURE
    $up = Wait-Window $app.Id '*select a region*'
    Check (@($up | Where-Object Title -like '*select a region*').Count -eq 1) "the capture hotkey raised the overlay"
    Drag-Select $X1 $Y1 $X2 $Y2
    $after = Wait-Window $app.Id 'Screenshot Studio - pinned'
    $pin = @($after | Where-Object Title -eq 'Screenshot Studio - pinned')
    Check ($pin.Count -eq 1) "the still is pinned"
    # Both pins up at once, the still stacked clear of the recording.
    $both = @(Get-AppWindows $app.Id | Where-Object Title -like '*pinned*')
    Check ($both.Count -eq 2) "the recording's pin stays up next to the still's ($(($both.Title) -join ', '))"
    if ($pin.Count -eq 1 -and $vrect) {
        $r = New-Object W32.Input+RECT
        [void][W32.Input]::GetWindowRect($pin[0].H, [ref]$r)
        Check ($r.B -le $vrect.T + 8 -or $r.T -ge $vrect.B - 8) "the two pins do not overlap (still $($r.T)-$($r.B), video $($vrect.T)-$($vrect.B))"
    }
    $png = @(Get-ChildItem $OutDir -Filter *.png -EA 0 | Where-Object { $beforePng -notcontains $_.FullName })
    Check ($png.Count -eq 1) "one new png"

    if ($pin.Count -eq 1 -and $png.Count -eq 1) {
        $wrote = $png[0].LastWriteTime
        # A click on the picture focuses the pin; E opens the editor.
        [void][W32.Input]::SetCursorPos($pin[0].X + 80, $pin[0].Y + 90); Start-Sleep -Milliseconds 200
        [W32.Input]::mouse_event($LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60
        [W32.Input]::mouse_event($LEFTUP, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 300
        Press-Chord @($VK_E)
        $ed = Wait-Window $app.Id '*edit*'
        $editor = @($ed | Where-Object Title -like '*edit*')
        Check ($editor.Count -eq 1) "E on the pin opened the editor (saw: $(($ed.Title) -join ', '))"
        if ($editor.Count -eq 1) {
            $r = New-Object W32.Input+RECT
            [void][W32.Input]::GetWindowRect($editor[0].H, [ref]$r)
            # A rectangle across the middle of the picture, well inside the canvas.
            $cx = [int](($r.L + $r.R) / 2); $cy = [int](($r.T + $r.B) / 2)
            Invoke-Drag ($cx - 80) ($cy - 40) ($cx + 80) ($cy + 40) 8
            Press-Chord @($VK_CTRL, $VK_S)
            $closed = $false
            foreach ($i in 1..40) {
                if (@(Get-AppWindows $app.Id | Where-Object Title -like '*edit*').Count -eq 0) { $closed = $true; break }
                Start-Sleep -Milliseconds 250
            }
            Check $closed "Ctrl+S closed the editor"
            Start-Sleep -Milliseconds 500
            $file = Get-Item $png[0].FullName
            Check ($file.LastWriteTime -gt $wrote) "the shot was rewritten ($($file.LastWriteTime.ToString('HH:mm:ss.fff')) after $($wrote.ToString('HH:mm:ss.fff')))"
            # The default colour is amber #e6a54c; a saved rectangle leaves it
            # in the file.
            $bmp = New-Object Drawing.Bitmap $png[0].FullName
            $amber = 0
            for ($y = 0; $y -lt $bmp.Height; $y += 2) {
                for ($x = 0; $x -lt $bmp.Width; $x += 2) {
                    $c = $bmp.GetPixel($x, $y)
                    if ([Math]::Abs($c.R - 230) -le 6 -and [Math]::Abs($c.G - 165) -le 6 -and [Math]::Abs($c.B - 76) -le 6) { $amber++ }
                }
            }
            $bmp.Dispose()
            Check ($amber -gt 40) "the saved png carries the amber rectangle ($amber sampled pixels)"
            $clip = [Windows.Forms.Clipboard]::GetImage()
            Check ($null -ne $clip) "the edited picture is on the clipboard"
            if ($clip) { $clip.Dispose() }
        }
        [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)
    }
}
finally {
    Stop-Process -Id $app.Id -Force -EA 0
    [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)
    "--- stderr ---"
    Get-Content "$log.err" -EA 0 | Select-Object -Last 25
}

if ($fails) { Write-Host "`nverify-video: $fails FAILED" -ForegroundColor Red; exit 1 }
"`nverify-video: all checks passed"
