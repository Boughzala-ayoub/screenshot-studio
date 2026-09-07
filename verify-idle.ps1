# The app sitting in the tray must be idle. A pinned recording that keeps
# playing in a hidden window holds WebView2's display wake lock, and the screen
# never sleeps; a paused clip decodes nothing, so idle CPU is the tell.
# Needs at least one MP4 in the shots folder, or there is nothing to play.
#
#   npm run verify:idle

param(
    [string]$Exe = "$PSScriptRoot\src-tauri\target\debug\screenshot-studio.exe",
    [int]$Seconds = 8,
    [double]$MaxCpuSeconds = 0.1
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Exe)) { throw "no exe at $Exe. Run: npm run build; npx tauri build --debug --no-bundle" }
$shots = "$([Environment]::GetFolderPath('MyPictures'))\Screenshot Studio"
if (-not (Get-ChildItem $shots -Filter *.mp4 -EA 0)) { throw "no .mp4 in ${shots}: record something first" }

Get-Process screenshot-studio -EA 0 | Stop-Process -Force -EA 0
Start-Sleep -Milliseconds 800
$app = Start-Process $Exe -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\ss-idle.out" -RedirectStandardError "$env:TEMP\ss-idle.err"
try {
    Start-Sleep -Seconds 15   # every window loads, and the pins fetch their newest shot
    $before = Get-Process msedgewebview2, screenshot-studio -EA 0 | Select-Object Id, CPU
    Start-Sleep -Seconds $Seconds
    $used = 0.0
    foreach ($p in (Get-Process msedgewebview2, screenshot-studio -EA 0)) {
        $was = ($before | Where-Object Id -eq $p.Id).CPU
        if ($null -ne $was) { $used += $p.CPU - $was }
    }
    $used = [math]::Round($used, 2)
    if ($used -gt $MaxCpuSeconds) { throw "FAIL: ${used}s CPU over ${Seconds}s idle - something is still playing" }
    "OK: ${used}s CPU over ${Seconds}s idle"
} finally { Stop-Process -Id $app.Id -Force -EA 0 }
