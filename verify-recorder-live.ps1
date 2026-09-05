# Run against an idle, built app: powershell -File verify-recorder-live.ps1
# A headed Chrome is required: headless Chrome has no native window occlusion.
# Opens an isolated animation, selects/resizes a recording region, and cancels.
param([string]$Exe = "$PSScriptRoot/src-tauri/target/debug/screenshot-studio.exe")
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/verify-lib.ps1"
Add-Type -Name Window -Namespace Motion -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
'@
$appExe = (Resolve-Path $Exe).Path
$app = @(Get-Process screenshot-studio -ErrorAction SilentlyContinue | Where-Object Path -eq $appExe)
if ($app.Count -ne 1) { throw 'Start the built app first.' }
if (@(Get-AppWindows $app[0].Id | Where-Object Title -ne 'dev.ayoub.screenshotstudio-siw').Count) { throw 'App is busy.' }
$cursor = New-Object W32.Input+POINT
[void][W32.Input]::GetCursorPos([ref]$cursor)
$scratch = New-Item -ItemType Directory -Path "$PSScriptRoot/.ui-check/live-regression-$([Guid]::NewGuid().ToString('N'))"
$pagePath = Join-Path $scratch.FullName 'motion.html'
@'
<!doctype html><title>Recorder motion check</title>
<style>html,body{margin:0;background:#191919;color:white;overflow:hidden}#bar{position:absolute;top:180px;bottom:100px;width:180px;background:lime}p{margin:50px}</style>
<p>Recorder motion check</p><div id="bar"></div>
<script>window.framesPainted=0;function paint(){framesPainted++;bar.style.left=(framesPainted*17%(innerWidth-180))+'px';requestAnimationFrame(paint)}paint()</script>
'@ | Set-Content -LiteralPath $pagePath -Encoding ASCII
$probe = @'
const pages = await (await fetch('http://127.0.0.1:9336/json/list')).json();
const page = pages.find(p => p.url.includes('/motion.html'));
if (!page) throw new Error('No motion check page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const timeout = setTimeout(() => { console.error('CDP timed out'); process.exit(1); }, 5000);
await new Promise(r => ws.addEventListener('open', r, {once:true}));
const result = new Promise(r => ws.addEventListener('message', e => { const m = JSON.parse(e.data); if(m.id === 1) r(m); }));
ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'({frames:window.framesPainted,visibility:document.visibilityState})',returnByValue:true}}));
console.log(JSON.stringify((await result).result.result.value));
clearTimeout(timeout); ws.close();
'@
function Read-Motion {
    $json = $probe | node --input-type=module
    if ($LASTEXITCODE -ne 0) { throw 'Browser probe failed.' }
    $json | ConvertFrom-Json
}
function Assert-Motion([string]$Stage) {
    $first = Read-Motion
    Start-Sleep -Seconds 1
    $second = Read-Motion
    $advanced = $second.frames - $first.frames
    if ($second.visibility -ne 'visible' -or $advanced -lt 10) { throw "$Stage froze: visibility=$($second.visibility), frames advanced=$advanced" }
    "ok    $Stage stays visible, $advanced frames advanced"
}
$profile = Join-Path $scratch.FullName 'profile'
$page = ([uri]$pagePath).AbsoluteUri
$browser = Start-Process 'C:/Program Files/Google/Chrome/Application/chrome.exe' -WindowStyle Hidden -PassThru -ArgumentList "--user-data-dir=`"$profile`" --no-first-run --no-default-browser-check --remote-debugging-port=9336 --window-position=0,0 --window-size=1920,1080 --app=$page"
try {
    $script:browserWindow = [IntPtr]::Zero
    $cb = [W32.Input+EnumProc] {
        param($h, $l)
        $owner = 0
        [void][W32.Input]::GetWindowThreadProcessId($h, [ref]$owner)
        $title = New-Object Text.StringBuilder 256
        [void][W32.Input]::GetWindowTextW($h, $title, 256)
        if ($owner -eq $browser.Id -and $title.ToString() -like '*motion*') { $script:browserWindow = $h }
        return $true
    }
    foreach ($i in 1..40) {
        [void][W32.Input]::EnumWindows($cb, [IntPtr]::Zero)
        if ($script:browserWindow -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($script:browserWindow -eq [IntPtr]::Zero) { throw 'Browser test window did not open' }
    [void][Motion.Window]::ShowWindow($script:browserWindow, 3)
    [void][Motion.Window]::SetWindowPos($script:browserWindow, [IntPtr](-1), 0, 0, 0, 0, 0x43)
    [void][Motion.Window]::SetForegroundWindow($script:browserWindow)
    Start-Sleep -Milliseconds 500
    Assert-Motion 'Browser alone'
    Press-Chord (Get-Chord 'record_hotkey')
    $overlay = @(Wait-Window $app[0].Id '*select a region*' | Where-Object Title -like '*select a region*')
    if ($overlay.Count -ne 1) { throw 'No selection overlay' }
    Assert-Motion 'Before selection'
    Invoke-Drag 300 300 900 700
    Assert-Motion 'Selected region before Record'
    Invoke-Drag 450 400 500 430
    Invoke-Drag 940 720 980 760
    Assert-Motion 'Moved and resized region before Record'
    if (@(Get-AppWindows $app[0].Id | Where-Object Title -like '*pinned video*').Count) { throw 'Setup started recording' }
    Press-Chord @(0x1B)
    Assert-Motion 'After cancelling'
} finally {
    $overlay = @(Get-AppWindows $app[0].Id | Where-Object Title -like '*select a region*')
    if ($overlay.Count) { [void][Motion.Window]::SetForegroundWindow($overlay[0].H); Press-Chord @(0x1B) }
    if (-not $browser.HasExited) { Stop-Process -Id $browser.Id }
    [void][W32.Input]::SetCursorPos($cursor.X, $cursor.Y)
}
