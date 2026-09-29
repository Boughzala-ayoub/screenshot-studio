//! Screenshot Studio v0: hotkey -> freeze the whole desktop -> drag a region,
//! across monitors if you like -> clipboard, disk, and a pinned preview you can
//! drag back out into another app.

use std::borrow::Cow;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

mod dragout;
mod record;

/// The defaults only; the user's choice lives in config.json. Ctrl+Shift+4
/// borrows the macOS region-capture muscle memory and stays clear of
/// Win+Shift+S; Ctrl+Shift+5 is macOS's recording key for the same reason.
const DEFAULT_HOTKEY: &str = "Ctrl+Shift+4";
const DEFAULT_RECORD_HOTKEY: &str = "Ctrl+Shift+5";
const OVERLAY: &str = "overlay";
/// Two pins, one per kind, so a still and a recording can stay up together.
const PREVIEW: &str = "preview";
const VPIN: &str = "vpin";
const SETTINGS: &str = "settings";
const EDITOR: &str = "editor";
const TRAY: &str = "main";
/// Longest edge of the pinned preview, in logical pixels.
const PREVIEW_MAX: f64 = 420.0;
/// Height of the pin's title bar, in logical pixels. Kept in step with
/// preview.css, which reserves the same strip.
const PREVIEW_BAR: f64 = 32.0;
/// The pin while it is the recording's stop bar, logical pixels.
const REC_BAR: (f64, f64) = (196.0, 36.0);
/// How many files of each kind survive in the folder.
const KEEP_SHOTS: usize = 5;

/// Where a recording's pin goes once it stops, remembered from the start.
struct RecPlace {
    w: u32,
    h: u32,
    scale: f64,
    mon_pos: PhysicalPosition<i32>,
    mon_size: PhysicalSize<u32>,
}

struct Shot {
    /// True while the armed capture is a recording rather than a still.
    video: std::sync::atomic::AtomicBool,
    /// The recording in progress, if any.
    recording: Mutex<Option<(record::Recording, RecPlace)>>,
    /// The shot the editor window is showing, or about to.
    editing: Mutex<Option<PathBuf>>,
    /// Every monitor composited into one frame, physical pixels, and the same
    /// frame encoded once for the overlay to paint.
    frame: Mutex<Option<RgbaImage>>,
    /// Desktop coordinate of the frame's top-left pixel. Not (0, 0) whenever a
    /// monitor sits left of or above the primary one.
    origin: Mutex<(i32, i32)>,
    /// Where the overlay has to sit for this capture, in physical pixels.
    bounds: Mutex<(PhysicalPosition<i32>, PhysicalSize<u32>)>,
    /// The frame encoded once for the overlay to paint. BMP, not PNG: nobody
    /// keeps these bytes, so encode time is all that matters, and a BMP is a
    /// header plus one memcpy where even a fast PNG is a filter pass and a
    /// deflate over tens of megabytes.
    frame_bmp: Mutex<Vec<u8>>,
    /// Bumped once per capture, after the frame is stored. The overlay's page
    /// parks on await_frame until this passes the generation it has painted, so
    /// a hotkey pressed before the page has even run is answered the moment it
    /// does, instead of being pushed at a webview that cannot hear it yet.
    generation: tokio::sync::watch::Sender<u64>,
    /// One per pin window, by label: [PREVIEW, VPIN].
    pins: [Pin; 2],
}

#[derive(Default)]
struct Pin {
    /// False until the first capture asks for the pin. The pin window is built
    /// hidden at startup and its page runs once right away; preview_ready from
    /// that warm-up load must not show a window nobody asked for.
    wanted: std::sync::atomic::AtomicBool,
    /// True while a retake from the pin has it hidden. Only that hide may be
    /// undone by cancel_capture: the pin window always exists, so an
    /// unconditional show would resurrect a pin the user had dismissed.
    parked: std::sync::atomic::AtomicBool,
}

impl Shot {
    fn pin(&self, label: &str) -> &Pin {
        &self.pins[(label == VPIN) as usize]
    }

    fn crop(&self, rect: CssRect, scale: f64) -> Result<(RgbaImage, (u32, u32)), String> {
        // Selection is finished: release the desktop before encoding the crop.
        let frame = self
            .frame
            .lock()
            .unwrap()
            .take()
            .ok_or("nothing captured")?;
        let (x, y, w, h) = css_rect_to_physical(rect, scale, frame.width(), frame.height())
            .ok_or("empty selection")?;
        let crop = if (x, y, w, h) == (0, 0, frame.width(), frame.height()) {
            frame
        } else {
            image::imageops::crop_imm(&frame, x, y, w, h).to_image()
        };
        Ok((crop, (x, y)))
    }
}

/// The still pin's twin for recordings: the other label, the other kind.
fn pin_label(video: bool) -> &'static str {
    if video {
        VPIN
    } else {
        PREVIEW
    }
}

impl Default for Shot {
    fn default() -> Self {
        Self {
            video: std::sync::atomic::AtomicBool::new(false),
            recording: Mutex::default(),
            editing: Mutex::default(),
            frame: Mutex::default(),
            origin: Mutex::default(),
            bounds: Mutex::default(),
            frame_bmp: Mutex::default(),
            generation: tokio::sync::watch::channel(0).0,
            pins: Default::default(),
        }
    }
}

/// What the user can change, persisted as config.json in the app config dir.
/// serde(default) so a file from an older build that lacks a field still loads.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
struct Settings {
    hotkey: String,
    record_hotkey: String,
    autostart: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.into(),
            record_hotkey: DEFAULT_RECORD_HOTKEY.into(),
            // On by default: WebView2's first environment creation costs 3-35 s
            // on this machine, and paying it at login instead of at the first
            // hotkey press is most of the cold-start fix.
            autostart: true,
        }
    }
}

struct Cfg(Mutex<Settings>);

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("config.json"))
}

/// (settings, first_run). Any unreadable or unparsable file counts as a first
/// run: the defaults are safe and the next save rewrites it.
fn load_settings(app: &AppHandle) -> (Settings, bool) {
    settings_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .map_or((Settings::default(), true), |s| (s, false))
}

fn save_settings(app: &AppHandle, s: &Settings) {
    let Some(path) = settings_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, serde_json::to_vec_pretty(s).unwrap()) {
        eprintln!("settings save: {e}");
    }
}

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "Screenshot Studio";

/// The HKCU Run value, via reg.exe: no registry crate features for one value.
/// Debug builds never touch it, or `cargo run` would enroll target\debug in the
/// user's login.
fn set_autostart_reg(on: bool) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("reg");
    if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // Quoted in the value itself: an unquoted path with spaces in a Run key
        // is parsed at the first space.
        cmd.args(["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ", "/d"])
            .arg(format!("\"{}\"", exe.display()))
            .arg("/f");
    } else {
        cmd.args(["delete", RUN_KEY, "/v", RUN_NAME, "/f"]);
    }
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = cmd
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    // Deleting a value that is not there fails, and that is fine.
    if on && !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
struct CssRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// The overlay reports CSS pixels, the frozen frame is physical pixels. At 125%
/// or 150% Windows scaling those differ, and getting it wrong crops the wrong
/// area without ever erroring. None means the selection is empty or off-frame.
fn css_rect_to_physical(r: CssRect, scale: f64, fw: u32, fh: u32) -> Option<(u32, u32, u32, u32)> {
    let x = (r.x * scale).round().clamp(0.0, fw as f64) as u32;
    let y = (r.y * scale).round().clamp(0.0, fh as f64) as u32;
    let w = (r.w * scale).round().max(0.0) as u32;
    let h = (r.h * scale).round().max(0.0) as u32;
    let w = w.min(fw - x);
    let h = h.min(fh - y);
    (w > 0 && h > 0).then_some((x, y, w, h))
}

/// Bounding box of every monitor, in physical desktop coordinates, as
/// (x, y, width, height). The origin is negative whenever a second monitor sits
/// left of or above the primary one, which is the ordinary way people arrange
/// two screens.
fn virtual_bounds(monitors: &[(i32, i32, u32, u32)]) -> (i32, i32, u32, u32) {
    let left = monitors.iter().map(|m| m.0).min().unwrap_or(0);
    let top = monitors.iter().map(|m| m.1).min().unwrap_or(0);
    let right = monitors.iter().map(|m| m.0 + m.2 as i32).max().unwrap_or(0);
    let bottom = monitors.iter().map(|m| m.1 + m.3 as i32).max().unwrap_or(0);
    (
        left,
        top,
        (right - left).max(0) as u32,
        (bottom - top).max(0) as u32,
    )
}

/// Which shots to delete, newest kept. Split out from the deleting so the rule
/// can be tested without a folder full of real screenshots behind it.
fn stale_shots(mut shots: Vec<(SystemTime, PathBuf)>, keep: usize) -> Vec<PathBuf> {
    if shots.len() <= keep {
        return Vec::new();
    }
    shots.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    shots.into_iter().skip(keep).map(|(_, p)| p).collect()
}

/// Every shot in the folder with its timestamp. Only the files this app
/// writes; anything else the user put there is invisible to pruning and to
/// the pin.
fn list_shots(dir: &Path) -> Vec<(SystemTime, PathBuf)> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("list shots: {e}");
            return Vec::new();
        }
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_shot_name(p))
        .filter_map(|p| {
            let at = std::fs::metadata(&p).and_then(|m| m.modified()).ok()?;
            Some((at, p))
        })
        .collect()
}

fn is_shot_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("shot-") && (n.ends_with(".png") || n.ends_with(".mp4")))
}

/// Keep the newest `keep` screenshots and recordings independently.
fn prune_shots(dir: &Path, keep: usize) {
    let shots = list_shots(dir);
    for ext in ["png", "mp4"] {
        let matching = shots
            .iter()
            .filter(|(_, p)| p.extension().is_some_and(|e| e == ext))
            .cloned()
            .collect();
        for path in stale_shots(matching, keep) {
            if let Err(e) = std::fs::remove_file(&path) {
                eprintln!("prune {}: {e}", path.display());
            }
        }
    }
}

/// A path the webview handed back, checked to be one of our own shots. Without
/// this, the page could ask the backend to read or drag any file on the disk.
fn checked_shot(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let dir = shots_dir(app)?;
    let path = PathBuf::from(path);
    if path.parent() == Some(dir.as_path()) && is_shot_name(&path) && path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "not a shot in {}: {}",
            dir.display(),
            path.display()
        ))
    }
}

/// Where shots live, created if it is not there yet.
fn shots_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .picture_dir()
        .map_err(|e| e.to_string())?
        .join("Screenshot Studio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Local wall-clock stamp for the filename. Straight to Win32 rather than
/// pulling in chrono for one strftime; this app is Windows-only anyway.
fn stamp() -> String {
    #[repr(C)]
    #[derive(Default)]
    struct Systemtime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        millis: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocalTime(st: *mut Systemtime);
    }
    let mut t = Systemtime::default();
    unsafe { GetLocalTime(&mut t) };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

/// For the shot that gets kept. Fast compression, not the default: the pin
/// waits on this write, and on a full-screen crop the default deflate costs
/// hundreds of milliseconds for ~25% smaller files nobody keeps more than five
/// of.
fn png_bytes(img: &RgbaImage) -> Result<Vec<u8>, String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    let mut buf = Vec::new();
    let enc = PngEncoder::new_with_quality(
        Cursor::new(&mut buf),
        CompressionType::Fast,
        // Fixed filtering avoids trying all PNG filters for every scanline.
        FilterType::Sub,
    );
    img.write_with_encoder(enc).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// For the frozen desktop, which is thrown away as soon as the overlay closes.
/// A 32-bit top-down BMP: fourteen bytes of file header, forty of info header,
/// then the pixels with red and blue swapped. Encoding is one pass with no
/// compression, an order of magnitude quicker than even a fast PNG, and the
/// webview decodes it just as happily. The alpha byte is forced opaque because
/// BI_RGB readers treat it as padding anyway and some captures arrive with
/// alpha zero, which a PNG would have turned invisible.
fn bmp_bytes(img: &RgbaImage) -> Vec<u8> {
    const HEADER: usize = 54;
    let (w, h) = img.dimensions();
    let pixels = (w as usize * 4) * h as usize; // 4 bytes per pixel: no row padding at 32bpp
    let mut out = vec![0u8; HEADER + pixels];

    out[0..2].copy_from_slice(b"BM");
    out[2..6].copy_from_slice(&((HEADER + pixels) as u32).to_le_bytes());
    out[10..14].copy_from_slice(&(HEADER as u32).to_le_bytes()); // pixel data offset
    out[14..18].copy_from_slice(&40u32.to_le_bytes()); // BITMAPINFOHEADER size
    out[18..22].copy_from_slice(&(w as i32).to_le_bytes());
    out[22..26].copy_from_slice(&(-(h as i32)).to_le_bytes()); // negative: top-down rows
    out[26..28].copy_from_slice(&1u16.to_le_bytes()); // planes
    out[28..30].copy_from_slice(&32u16.to_le_bytes()); // bits per pixel
    out[34..38].copy_from_slice(&(pixels as u32).to_le_bytes()); // compression stays 0: BI_RGB

    for (dst, src) in out[HEADER..]
        .chunks_exact_mut(4)
        .zip(img.as_raw().chunks_exact(4))
    {
        dst[0] = src[2]; // B
        dst[1] = src[1]; // G
        dst[2] = src[0]; // R
        dst[3] = 0xff;
    }
    out
}

/// A fresh, unique name in the shots folder for this moment. Two captures
/// inside the same second would otherwise share a name and the second would
/// quietly replace the first.
fn fresh_shot_path(dir: &Path, ext: &str) -> PathBuf {
    let base = stamp();
    let mut path = dir.join(format!("shot-{base}.{ext}"));
    for n in 2..100 {
        if !path.exists() {
            break;
        }
        path = dir.join(format!("shot-{base}-{n}.{ext}"));
    }
    path
}

/// Prepare the desktop bounds for selection and freeze pixels only for stills.
/// Video setup looks through the transparent overlay until Record is pressed.
fn begin_capture(app: &AppHandle, video: bool) -> Result<(), String> {
    let visible = app
        .get_webview_window(OVERLAY)
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    if visible {
        return Ok(()); // already selecting, or the overlay is framing a recording
    }
    app.state::<Shot>()
        .video
        .store(video, std::sync::atomic::Ordering::Relaxed);
    let monitors: Vec<(i32, i32, u32, u32)> = app
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|m| {
            let (p, s) = (m.position(), m.size());
            (p.x, p.y, s.width, s.height)
        })
        .collect();
    if monitors.is_empty() {
        return Err("no monitors".into());
    }
    let (vx, vy, vw, vh) = virtual_bounds(&monitors);

    // Each screen is grabbed on its own thread: the copies are independent
    // BitBlts, and with two or three monitors the wait is the slowest screen
    // rather than the sum of all of them. One screen skips the threads.
    let grabs: Vec<(i32, i32, Result<RgbaImage, xcap::XCapError>)> = if video {
        Vec::new()
    } else if monitors.len() == 1 {
        let (mx, my, mw, mh) = monitors[0];
        let shot = xcap::Monitor::from_point(mx + mw as i32 / 2, my + mh as i32 / 2)
            .and_then(|m| m.capture_image());
        vec![(mx, my, shot)]
    } else {
        std::thread::scope(|s| {
            let handles: Vec<_> = monitors
                .iter()
                .map(|&(mx, my, mw, mh)| {
                    s.spawn(move || {
                        let shot =
                            xcap::Monitor::from_point(mx + mw as i32 / 2, my + mh as i32 / 2)
                                .and_then(|m| m.capture_image());
                        (mx, my, shot)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        })
    };

    let mut frame: Option<RgbaImage> = None;
    for (mx, my, grab) in grabs {
        match grab {
            // One screen is the common case, and there its grab already is the
            // frame: compositing it would copy eight megabytes for nothing.
            Ok(shot) if monitors.len() == 1 && shot.dimensions() == (vw, vh) => frame = Some(shot),
            // Gaps between monitors in an L-shaped layout stay transparent, and
            // so does any screen that refuses to be read. Losing one screen is
            // better than losing the capture.
            Ok(shot) => {
                let onto = frame.get_or_insert_with(|| RgbaImage::new(vw, vh));
                image::imageops::replace(onto, &shot, (mx - vx) as i64, (my - vy) as i64);
            }
            Err(e) => eprintln!("monitor at {mx},{my}: {e}"),
        }
    }
    if !video && frame.is_none() {
        return Err("no screen could be read".into());
    }
    let bmp = frame.as_ref().map(bmp_bytes).unwrap_or_default();

    let state = app.state::<Shot>();
    *state.frame.lock().unwrap() = frame;
    *state.origin.lock().unwrap() = (vx, vy);
    *state.frame_bmp.lock().unwrap() = bmp;

    *state.bounds.lock().unwrap() = (PhysicalPosition::new(vx, vy), PhysicalSize::new(vw, vh));
    // Everything the page needs is in place; wake it. send_modify rather than
    // send so a bump with no receiver parked yet is kept, not dropped.
    state.generation.send_modify(|g| *g += 1);
    eprintln!(
        "capture: gen {} armed, t+{}ms",
        *state.generation.borrow(),
        uptime_ms()
    );
    Ok(())
}

fn place_overlay(
    w: &tauri::WebviewWindow,
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> Result<(), String> {
    w.set_position(pos).map_err(|e| e.to_string())?;
    w.set_size(size).map_err(|e| e.to_string())?;
    undo_frame_inset(w, pos)
}

/// An undecorated window still carries Windows' invisible resize border, so
/// set_position lands the frame where we asked and the client area, which is
/// what the page draws and clicks in, ends up several pixels inside the desktop.
/// Left alone, every selection is offset by that much and the far edges of the
/// screen cannot be selected at all. Measure it and take it back.
fn undo_frame_inset(w: &tauri::WebviewWindow, pos: PhysicalPosition<i32>) -> Result<(), String> {
    let outer = w.outer_position().map_err(|e| e.to_string())?;
    let inner = w.inner_position().map_err(|e| e.to_string())?;
    if inner != outer {
        let fixed = PhysicalPosition::new(pos.x - (inner.x - outer.x), pos.y - (inner.y - outer.y));
        w.set_position(fixed).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The overlay's page parks here with the generation it has already painted and
/// wakes up with the next one, however long that takes. Pull instead of push:
/// the window is declared in tauri.conf.json so Tauri builds it at startup, but
/// on a cold WebView2 its page can take ten-plus seconds to run, and anything
/// pushed at it in that gap (an eval, an event, a reload) is simply lost. A
/// request the backend completes cannot be.
#[derive(Serialize)]
struct FrameInfo {
    gen: u64,
    video: bool,
}

#[tauri::command]
async fn await_frame(state: State<'_, Shot>, seen: u64) -> Result<FrameInfo, String> {
    // The one cold-start telemetry line: how long after launch the overlay's
    // page first ran. Free in release, where stderr goes nowhere.
    eprintln!("await_frame: page at gen {seen}, t+{}ms", uptime_ms());
    let mut rx = state.generation.subscribe();
    // wait_for checks the current value first, so a capture that fired before
    // the page ever ran is answered immediately.
    let gen = *rx
        .wait_for(|g| *g > seen)
        .await
        .map_err(|e| e.to_string())?;
    let video = state.video.load(std::sync::atomic::Ordering::Relaxed);
    Ok(FrameInfo { gen, video })
}

/// The page has painted the frame: put the overlay where the capture said and
/// show it. Geometry re-applied here, right before show, because a hidden
/// window can sit on a resize until it is shown, and monitors get plugged in
/// and unplugged between captures.
#[tauri::command]
fn overlay_ready(app: AppHandle, state: State<Shot>) {
    let Some(w) = app.get_webview_window(OVERLAY) else {
        return;
    };
    let (pos, size) = *state.bounds.lock().unwrap();
    if let Err(e) = place_overlay(&w, pos, size) {
        eprintln!("overlay: {e}");
    }
    let _ = w.show();
    let _ = w.set_focus();
    // Chromium treats a screen-sized ordinary window as occluding the browser,
    // even when WebView2 paints it transparent. A tool window keeps the browser
    // underneath drawing while the user selects and resizes the video region.
    // Apply after show/focus: Tao reapplies the window styles when showing it.
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = w.hwnd() {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
        };
        let hwnd = windows::Win32::Foundation::HWND(hwnd.0 as isize);
        unsafe {
            let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
            SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_TOOLWINDOW.0 as i32);
        }
    }
}

#[tauri::command]
fn frozen_frame(state: State<Shot>) -> Result<tauri::ipc::Response, String> {
    // Taken, not cloned: the page fetches each frame exactly once, and cloning
    // here copied a desktop-sized buffer on every capture. A reloaded page (dev
    // only) finds it empty and simply waits for the next generation.
    let bmp = std::mem::take(&mut *state.frame_bmp.lock().unwrap());
    // An empty raw response never settles on the JS side, and the page would
    // wait on it for ever. At startup there is genuinely nothing to hand over.
    if bmp.is_empty() {
        return Err("nothing frozen".into());
    }
    Ok(tauri::ipc::Response::new(bmp))
}

/// The shots the calling pin can flip through, newest first: stills for the
/// still pin, recordings for the video pin.
#[tauri::command]
fn recent_shots(app: AppHandle, window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    let ext = if window.label() == VPIN { "mp4" } else { "png" };
    let mut shots = list_shots(&shots_dir(&app)?);
    shots.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(shots
        .into_iter()
        .filter(|(_, p)| p.extension().is_some_and(|e| e == ext))
        .take(KEEP_SHOTS)
        .map(|(_, p)| p.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
fn shot_png(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let path = checked_shot(&app, &path)?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The path as clipboard text, for somewhere that wants characters.
#[tauri::command]
fn copy_path(app: AppHandle, path: String) -> Result<(), String> {
    let path = checked_shot(&app, &path)?;
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(path.to_string_lossy().into_owned()))
        .map_err(|e| e.to_string())
}

/// Put a kept shot back on the clipboard. A fresh capture is already there, but
/// flipping the pin to an older shot and pressing copy is the way to get that
/// one back without re-taking it. async: the decode is off the UI thread.
#[tauri::command(async)]
fn copy_shot(app: AppHandle, path: String) -> Result<(), String> {
    let path = checked_shot(&app, &path)?;
    let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
    arboard::Clipboard::new()
        .and_then(|mut c| {
            c.set_image(arboard::ImageData {
                width: img.width() as usize,
                height: img.height() as usize,
                bytes: Cow::Borrowed(img.as_raw()),
            })
        })
        .map_err(|e| e.to_string())
}

/// Open the shots folder in Explorer, from the pin as well as the tray.
#[tauri::command]
fn open_folder(app: AppHandle) -> Result<(), String> {
    open_shots_dir(&app);
    Ok(())
}

fn open_shots_dir(app: &AppHandle) {
    match shots_dir(app) {
        // explorer.exe exits 1 even when it worked, so its status says nothing
        // worth checking.
        Ok(dir) => {
            let _ = std::process::Command::new("explorer").arg(dir).spawn();
        }
        Err(e) => eprintln!("folder: {e}"),
    }
}

/// async so the reading and scaling happen off the UI thread; the drag itself
/// has to run on the thread that owns the windows, and blocks until it ends.
#[tauri::command(async)]
fn drag_shot(app: AppHandle, path: String) -> Result<(), String> {
    let path = checked_shot(&app, &path)?;
    let thumb = dragout::thumbnail(&path);
    app.run_on_main_thread(move || {
        if let Err(e) = dragout::start(&path, thumb) {
            eprintln!("drag: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

/// Resize the calling pin around whichever shot it is showing, keeping its
/// corner put.
#[tauri::command]
fn fit_pin(window: tauri::WebviewWindow, w: u32, h: u32) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    window
        .set_size(pin_size(w, h, scale))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_capture(app: AppHandle, state: State<Shot>) {
    state.frame.lock().unwrap().take();
    *state.frame_bmp.lock().unwrap() = Vec::new();
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.hide(); // kept alive so the next capture is instant
    }
    // A retake started from a pin hid it to keep it out of the frame, so a
    // cancelled retake has to put it back or the shot is left with no window.
    // Only that hide: the user closing a pin parks nothing.
    for label in [PREVIEW, VPIN] {
        if state
            .pin(label)
            .parked
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.show();
                clip_playing(&w, true);
            }
        }
    }
}

/// Retake, from a pin's own button: a new still from the still pin, a new
/// recording from the video pin. The pin is sitting on top of whatever is
/// about to be shot, so it leaves the screen before the frame is frozen. Hidden
/// rather than closed: the next crop reuses this window, and a cancel puts it
/// straight back.
#[tauri::command(async)]
fn new_capture(app: AppHandle, state: State<Shot>, window: tauri::WebviewWindow) -> Result<(), String> {
    let video = window.label() == VPIN;
    if window.is_visible().unwrap_or(false) {
        clip_playing(&window, false);
        let _ = window.hide();
        state
            .pin(window.label())
            .parked
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // ponytail: fixed wait for the desktop to repaint where the pin was.
        // Nothing announces that repaint short of watching the pixels. Raise it
        // if a ghost of the pin ever turns up in a shot.
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
    // A capture that never armed would leave the pin hidden with no way back.
    begin_capture(&app, video).inspect_err(|_| {
        let s = app.state::<Shot>();
        cancel_capture(app.clone(), s)
    })
}

/// Playback follows the window. A pinned recording that keeps playing while its
/// window is hidden holds WebView2's display wake lock, so the screen never
/// sleeps and a renderer decodes frames nobody can see. The still pin's <video>
/// has no source; pausing it is a no-op.
fn clip_playing(w: &tauri::WebviewWindow, on: bool) {
    let _ = w.eval(if on {
        "document.getElementById('clip')?.play()"
    } else {
        "document.getElementById('clip')?.pause()"
    });
}

#[tauri::command]
fn close_preview(window: tauri::WebviewWindow) {
    // Hidden, never closed: building a webview window costs 3-11 s on this
    // machine (measured), and a closed pin made every next capture pay it.
    // Hidden, the next capture is a ~100 ms reload.
    clip_playing(&window, false);
    let _ = window.hide();
}

// async so it lands on a worker thread. A sync command runs on the main thread,
// and building the preview window from there deadlocks: the builder waits for
// the event loop that is busy running this very command. It also keeps the PNG
// encode and the clipboard write off the UI thread.
#[tauri::command(async)]
fn finish_capture(app: AppHandle, state: State<Shot>, rect: CssRect) -> Result<String, String> {
    // The overlay is already gone by the time most of this can fail, so a bare
    // Err would look exactly like the hotkey never firing.
    // ponytail: stderr only, which is nothing in a release build. Worth a tray
    // balloon once there is anything else to report.
    if state.video.load(std::sync::atomic::Ordering::Relaxed) {
        start_recording(app, state, rect).inspect_err(|e| eprintln!("start_recording: {e}"))
    } else {
        crop_and_deliver(app, state, rect).inspect_err(|e| eprintln!("finish_capture: {e}"))
    }
}

/// Start recording the selection. The overlay stays up as a click-through
/// frame around the region, and the pin becomes the stop bar.
fn start_recording(app: AppHandle, state: State<Shot>, rect: CssRect) -> Result<String, String> {
    let overlay = app.get_webview_window(OVERLAY).ok_or("overlay is gone")?;
    let scale = overlay.scale_factor().map_err(|e| e.to_string())?;
    let size = state.bounds.lock().unwrap().1;
    let (x, y, w, h) =
        css_rect_to_physical(rect, scale, size.width, size.height).ok_or("empty selection")?;
    let origin = *state.origin.lock().unwrap();
    let (dx, dy) = (origin.0 + x as i32, origin.1 + y as i32); // desktop coordinates
    let centre = (dx + w as i32 / 2, dy + h as i32 / 2);

    // Graphics Capture records one monitor; the region is clipped to the one
    // under its centre. ponytail: a selection spanning two screens records
    // only the part on that screen.
    let monitor = app
        .monitor_from_point(centre.0 as f64, centre.1 as f64)
        .map_err(|e| e.to_string())?
        .ok_or("no monitor under the selection")?;
    let (mon_pos, mon_size) = (*monitor.position(), *monitor.size());
    let crop = record::even_crop(
        dx - mon_pos.x,
        dy - mon_pos.y,
        w,
        h,
        mon_size.width,
        mon_size.height,
    )
    .ok_or("selection too small to record")?;
    let hmonitor = unsafe {
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
        MonitorFromPoint(
            windows::Win32::Foundation::POINT {
                x: centre.0,
                y: centre.1,
            },
            MONITOR_DEFAULTTONEAREST,
        )
        .0
    };

    let dir = shots_dir(&app)?;
    let path = fresh_shot_path(&dir, "mp4");
    let rec = record::start(hmonitor, crop, path.clone())?;
    let place = RecPlace {
        w: crop.w,
        h: crop.h,
        scale,
        mon_pos,
        mon_size,
    };
    *state.recording.lock().unwrap() = Some((rec, place));
    eprintln!("record: {}x{} -> {}", crop.w, crop.h, path.display());

    // The overlay turns into the frame: transparent, mouse passes through.
    let _ = overlay.set_ignore_cursor_events(true);
    let _ = overlay.eval(&format!(
        "recFrame({},{},{},{})",
        rect.x, rect.y, rect.w, rect.h
    ));

    // The stop bar sits at the bottom of the recorded monitor, or the top if
    // the region reaches down there, so it stays out of the recording.
    let bar = PhysicalSize::new(
        (REC_BAR.0 * scale).round() as u32,
        (REC_BAR.1 * scale).round() as u32,
    );
    let margin = (24.0 * scale) as i32;
    let bx = mon_pos.x + (mon_size.width as i32 - bar.width as i32) / 2;
    let bottom = mon_pos.y + mon_size.height as i32 - bar.height as i32 - margin;
    let region_bottom = dy + h as i32;
    let by = if region_bottom > bottom - margin {
        mon_pos.y + margin
    } else {
        bottom
    };
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let shot = handle.state::<Shot>();
        let pin = shot.pin(VPIN);
        pin.wanted.store(true, std::sync::atomic::Ordering::Relaxed);
        pin.parked.store(false, std::sync::atomic::Ordering::Relaxed);
        if let Some(w) = handle.get_webview_window(VPIN) {
            let _ = w.set_size(bar);
            let _ = w.set_position(PhysicalPosition::new(bx, by));
            let _ = w.eval("location.hash='rec';location.reload()");
        }
        refresh_tray(&handle);
    })
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Stop the recording, from the pin's stop button, the hotkey or the tray.
/// The file is then pinned like a still.
#[tauri::command(async)]
fn stop_recording(app: AppHandle, state: State<Shot>) -> Result<(), String> {
    let Some((rec, place)) = state.recording.lock().unwrap().take() else {
        return Ok(());
    };
    let t = std::time::Instant::now();
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.hide();
        let _ = w.set_ignore_cursor_events(false);
        let _ = w.eval("recDone()");
    }
    let path = record::stop(rec)?;
    eprintln!(
        "record: stopped in {}ms, {}",
        t.elapsed().as_millis(),
        path.display()
    );
    prune_shots(&shots_dir(&app)?, KEEP_SHOTS);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || refresh_tray(&handle));
    show_preview(
        &app,
        VPIN,
        place.w,
        place.h,
        place.scale,
        place.mon_pos,
        place.mon_size,
    )
}

/// How long the recording has been running, pauses excluded, for the stop
/// bar's clock.
#[tauri::command]
fn recording_ms(state: State<Shot>) -> u64 {
    state
        .recording
        .lock()
        .unwrap()
        .as_ref()
        .map_or(0, |(r, _)| r.elapsed().as_millis() as u64)
}

/// Pause or resume the recording from the stop bar. The frame around the
/// region shows the state too, since the bar may be on another monitor.
#[tauri::command]
fn pause_recording(app: AppHandle, state: State<Shot>, on: bool) -> bool {
    let guard = state.recording.lock().unwrap();
    let Some((rec, _)) = guard.as_ref() else {
        return false;
    };
    rec.set_paused(on);
    let paused = rec.paused();
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.eval(&format!("recPaused({paused})"));
    }
    paused
}

/// The record hotkey toggles: press to frame, press again to stop.
fn toggle_record(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let recording = app.state::<Shot>().recording.lock().unwrap().is_some();
        let done = if recording {
            stop_recording(app.clone(), app.state::<Shot>())
        } else {
            begin_capture(&app, true)
        };
        if let Err(e) = done {
            eprintln!("record: {e}");
        }
    });
}

fn crop_and_deliver(app: AppHandle, state: State<Shot>, rect: CssRect) -> Result<String, String> {
    let overlay = app.get_webview_window(OVERLAY).ok_or("overlay is gone")?;
    let scale = overlay.scale_factor().map_err(|e| e.to_string())?;
    let _ = overlay.hide();

    let (crop, at) = state.crop(rect, scale)?;

    // The overlay covers every screen, so the pin belongs on whichever one the
    // selection came from rather than on whichever one the overlay called its own.
    let origin = *state.origin.lock().unwrap();
    let centre = (
        (origin.0 + at.0 as i32 + crop.width() as i32 / 2) as f64,
        (origin.1 + at.1 as i32 + crop.height() as i32 / 2) as f64,
    );
    let monitor = app
        .monitor_from_point(centre.0, centre.1)
        .map_err(|e| e.to_string())?
        .or(app.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("no monitor to pin to")?;
    let (mon_pos, mon_size) = (*monitor.position(), *monitor.size());

    let t = std::time::Instant::now();
    let dir = shots_dir(&app)?;
    let path = fresh_shot_path(&dir, "png");
    std::fs::write(&path, png_bytes(&crop)?).map_err(|e| e.to_string())?;
    prune_shots(&dir, KEEP_SHOTS);

    // Pin first, clipboard second. The pin only needs the file, so it is queued
    // as soon as the PNG is on disk. The clipboard goes to its own thread:
    // arboard encodes a DIB and a second PNG, and OpenClipboard blocks for as
    // long as any clipboard manager (Win+V history, cloud sync, remote-desktop
    // tools) holds the lock -- the "sometimes seconds" delay, and none of it
    // is the pin's business.
    show_preview(
        &app,
        PREVIEW,
        crop.width(),
        crop.height(),
        scale,
        mon_pos,
        mon_size,
    )?;
    eprintln!(
        "capture: {}x{} png+pin in {}ms",
        crop.width(),
        crop.height(),
        t.elapsed().as_millis()
    );
    std::thread::spawn(move || {
        let done = arboard::Clipboard::new().and_then(|mut c| {
            c.set_image(arboard::ImageData {
                width: crop.width() as usize,
                height: crop.height() as usize,
                bytes: Cow::Borrowed(crop.as_raw()),
            })
        });
        match done {
            Ok(()) => eprintln!("capture: clipboard in {}ms", t.elapsed().as_millis()),
            // The shot is saved and pinned either way; the pin's copy button
            // is the retry.
            Err(e) => eprintln!("clipboard: {e}"),
        }
    });
    Ok(path.to_string_lossy().into_owned())
}

/// The pin's window for a shot of this size: the picture shrunk to fit, plus the
/// title bar. Never narrower than the bar's buttons need, whatever the shot,
/// and the minimums are logical so 150% scaling does not shrink them.
fn pin_size(cw: u32, ch: u32, scale: f64) -> PhysicalSize<u32> {
    let shrink = (PREVIEW_MAX * scale / cw.max(ch).max(1) as f64).min(1.0);
    PhysicalSize::new(
        ((cw as f64 * shrink).round() as u32).max((272.0 * scale).round() as u32),
        ((ch as f64 * shrink).round() as u32).max((72.0 * scale).round() as u32)
            + (PREVIEW_BAR * scale).round() as u32,
    )
}

/// Pin the crop bottom-right of the monitor it came from, shrunk to fit.
fn show_preview(
    app: &AppHandle,
    label: &'static str,
    cw: u32,
    ch: u32,
    scale: f64,
    mon_pos: PhysicalPosition<i32>,
    mon_size: PhysicalSize<u32>,
) -> Result<(), String> {
    let size = pin_size(cw, ch, scale);
    let margin = (24.0 * scale) as i32;
    let pos = PhysicalPosition::new(
        mon_pos.x + mon_size.width as i32 - size.width as i32 - margin,
        mon_pos.y + mon_size.height as i32 - size.height as i32 - margin,
    );

    // Same rule as the overlay: windows get built on the event loop thread. Built
    // from a command thread instead, this one came up at the builder's default
    // size and position and never became visible.
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = build_preview(&handle, label, pos, size, mon_pos.y) {
            eprintln!("preview: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

/// Where a pin goes when the other one is already up: stacked above it, so a
/// still and a recording can both stay on screen. Falls back to the corner
/// when there is no room above.
fn stack_above(
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    other: Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>,
    top: i32,
    gap: i32,
) -> PhysicalPosition<i32> {
    let Some((op, os)) = other else { return pos };
    let y = op.y - size.height as i32 - gap;
    if y < top {
        return pos;
    }
    PhysicalPosition::new(op.x + os.width as i32 - size.width as i32, y)
}

fn build_preview(
    app: &AppHandle,
    label: &str,
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    mon_top: i32,
) -> Result<(), String> {
    let shot = app.state::<Shot>();
    let pin = shot.pin(label);
    pin.wanted.store(true, std::sync::atomic::Ordering::Relaxed);
    // The retake, if this is one, delivered; there is nothing left to restore.
    pin.parked.store(false, std::sync::atomic::Ordering::Relaxed);
    // The other pin, if it is showing, keeps its spot; this one goes above it.
    let other = app
        .get_webview_window(pin_label(label != VPIN))
        .filter(|w| w.is_visible().unwrap_or(false))
        .and_then(|w| Some((w.outer_position().ok()?, w.outer_size().ok()?)));
    let scale = app
        .get_webview_window(label)
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let pos = stack_above(pos, size, other, mon_top, (12.0 * scale) as i32);
    // The pin window stands from startup and is only ever hidden, so this is
    // normally a reload: the page re-fetches the newest shot and calls
    // preview_ready, which shows the window. The build below is the fallback
    // for a window that somehow died, and costs seconds.
    if let Some(w) = app.get_webview_window(label) {
        eprintln!("pin: reusing window, t+{}ms", uptime_ms());
        w.set_size(size).map_err(|e| e.to_string())?;
        w.set_position(pos).map_err(|e| e.to_string())?;
        // The hash is cleared too: a recording just left it at #rec.
        w.eval("location.hash='';location.reload()")
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    eprintln!("pin: building window, t+{}ms", uptime_ms());
    let w = pin_window(app, label == VPIN)?;
    w.set_size(size).map_err(|e| e.to_string())?;
    w.set_position(pos).map_err(|e| e.to_string())?;
    eprintln!("pin: window built, t+{}ms", uptime_ms());
    Ok(()) // preview.html calls preview_ready once the crop is painted
}

/// A pin's window, hidden. Its page loads immediately and calls fit_pin and
/// preview_ready; preview_ready keeps it hidden until a capture wants it.
/// The page learns which pin it is from the URL.
fn pin_window(app: &AppHandle, video: bool) -> Result<tauri::WebviewWindow, String> {
    let (label, url, title) = if video {
        (VPIN, "preview.html?kind=video", "Screenshot Studio - pinned video")
    } else {
        (PREVIEW, "preview.html", "Screenshot Studio - pinned")
    };
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn preview_ready(state: State<Shot>, window: tauri::WebviewWindow) {
    // The startup warm-up load ends here too; only a capture may show a pin.
    if !state
        .pin(window.label())
        .wanted
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        // The warm-up load already started the newest recording playing.
        clip_playing(&window, false);
        return;
    }
    eprintln!("pin: {} shown, t+{}ms", window.label(), uptime_ms());
    let _ = window.show();
}

/// Open the editor on a kept shot. The window stands hidden from startup;
/// this sizes it to the picture, centred on the pin's monitor, and reloads
/// its page, which fetches the target and calls editor_ready.
#[tauri::command(async)]
fn open_editor(app: AppHandle, state: State<Shot>, path: String) -> Result<(), String> {
    let path = checked_shot(&app, &path)?;
    let (iw, ih) = image::image_dimensions(&path).map_err(|e| e.to_string())?;
    let pin = app.get_webview_window(PREVIEW).ok_or("no pin")?;
    let monitor = pin
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(app.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("no monitor")?;
    let (mp, ms, scale) = (*monitor.position(), *monitor.size(), monitor.scale_factor());
    // The picture at 1:1 plus the toolbar and some breathing room, capped at
    // most of the screen; the page shrinks the canvas to fit from there.
    let (bar, pad) = (52.0 * scale, 40.0 * scale);
    let w = (iw as f64 + pad)
        .clamp(640.0 * scale, ms.width as f64 * 0.92)
        .round() as u32;
    let h = (ih as f64 + pad + bar)
        .clamp(420.0 * scale, ms.height as f64 * 0.92)
        .round() as u32;
    let pos = PhysicalPosition::new(
        mp.x + (ms.width as i32 - w as i32) / 2,
        mp.y + (ms.height as i32 - h as i32) / 2,
    );
    *state.editing.lock().unwrap() = Some(path);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(e) = handle.get_webview_window(EDITOR) {
            let _ = e.set_size(PhysicalSize::new(w, h));
            let _ = e.set_position(pos);
            let _ = e.eval("location.reload()");
        }
    })
    .map_err(|e| e.to_string())
}

/// What the editor page should load, or nothing on the startup warm-up.
#[tauri::command]
fn edit_target(state: State<Shot>) -> Option<String> {
    state
        .editing
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn editor_ready(app: AppHandle, state: State<Shot>) {
    if state.editing.lock().unwrap().is_none() {
        return;
    }
    if let Some(w) = app.get_webview_window(EDITOR) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn close_editor(app: AppHandle, state: State<Shot>) {
    *state.editing.lock().unwrap() = None;
    if let Some(w) = app.get_webview_window(EDITOR) {
        let _ = w.hide();
    }
}

/// The PNG the page rendered, sent as the raw request body: no base64, no
/// JSON, the bytes as they are.
fn png_body<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if !bytes.is_empty() => Ok(bytes),
        _ => Err("expected PNG bytes".into()),
    }
}

fn clipboard_png(bytes: &[u8]) -> Result<(), String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    arboard::Clipboard::new()
        .and_then(|mut c| {
            c.set_image(arboard::ImageData {
                width: img.width() as usize,
                height: img.height() as usize,
                bytes: Cow::Borrowed(img.as_raw()),
            })
        })
        .map_err(|e| e.to_string())
}

/// Save the annotated picture over the shot it came from, put it on the
/// clipboard and close the editor. The pin reloads so it shows the new one.
#[tauri::command(async)]
fn save_edited(
    app: AppHandle,
    state: State<Shot>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let bytes = png_body(&request)?;
    let path = state
        .editing
        .lock()
        .unwrap()
        .clone()
        .ok_or("nothing being edited")?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    clipboard_png(bytes)?;
    close_editor(app.clone(), state);
    if let Some(w) = app.get_webview_window(PREVIEW) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.eval("location.reload()");
        }
    }
    Ok(())
}

/// Clipboard only; the file on disk stays as it was.
#[tauri::command(async)]
fn copy_edited(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    clipboard_png(png_body(&request)?)
}

#[tauri::command]
fn get_settings(cfg: State<Cfg>) -> Settings {
    cfg.0.lock().unwrap().clone()
}

/// Register the new combination first, drop the old one only once that worked:
/// a combination another app owns, or one the plugin cannot parse, errors back
/// to the settings page and the old hotkey keeps working. `record` picks which
/// of the two hotkeys is being changed.
#[tauri::command]
fn set_hotkey(app: AppHandle, cfg: State<Cfg>, hotkey: String, record: bool) -> Result<(), String> {
    let (old, other) = {
        let s = cfg.0.lock().unwrap();
        if record {
            (s.record_hotkey.clone(), s.hotkey.clone())
        } else {
            (s.hotkey.clone(), s.record_hotkey.clone())
        }
    };
    if hotkey == old {
        return Ok(());
    }
    if hotkey == other {
        return Err("that is the other shortcut".into());
    }
    let gs = app.global_shortcut();
    let handler = if record { on_record_hotkey } else { on_hotkey };
    gs.on_shortcut(hotkey.as_str(), handler)
        .map_err(|e| e.to_string())?;
    let _ = gs.unregister(old.as_str()); // may never have registered; fine
    {
        let mut s = cfg.0.lock().unwrap();
        if record {
            s.record_hotkey = hotkey;
        } else {
            s.hotkey = hotkey;
        }
        save_settings(&app, &s);
    }
    // The tray's menu lines show the hotkeys; keep them honest.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || refresh_tray(&handle));
    Ok(())
}

/// Rebuild the tray menu from the current hotkeys and recording state.
/// Main thread only.
fn refresh_tray(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

#[tauri::command]
fn set_autostart(app: AppHandle, cfg: State<Cfg>, on: bool) -> Result<(), String> {
    set_autostart_reg(on)?;
    let mut s = cfg.0.lock().unwrap();
    s.autostart = on;
    save_settings(&app, &s);
    Ok(())
}

/// One handler for whatever the hotkey currently is, shared by the startup
/// registration and every later change.
fn on_hotkey(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() == ShortcutState::Pressed {
        capture_off_thread(app);
    }
}

fn on_record_hotkey(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() == ShortcutState::Pressed {
        toggle_record(app);
    }
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let (hotkey, rec_hotkey) = {
        let s = app.state::<Cfg>();
        let s = s.0.lock().unwrap();
        (s.hotkey.clone(), s.record_hotkey.clone())
    };
    let recording = app.state::<Shot>().recording.lock().unwrap().is_some();
    let capture = MenuItem::with_id(app, "capture", "Capture region", true, Some(&hotkey))?;
    let record_label = if recording {
        "Stop recording"
    } else {
        "Record region"
    };
    let record = MenuItem::with_id(app, "record", record_label, true, Some(&rec_hotkey))?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Open shots folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&capture, &record, &settings, &folder, &quit])
}

/// Only ever called from the tray's menu handler, which runs on the main
/// thread, so the window can be built right here.
fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("settings.html".into()))
        .title("Screenshot Studio settings")
        .inner_size(400.0, 440.0)
        .resizable(false)
        .maximizable(false)
        .build();
    if let Err(e) = built {
        eprintln!("settings: {e}");
    }
}

/// The overlay window, built after the event loop is already running rather
/// than declared in tauri.conf.json. Config windows are created before setup,
/// so on a cold machine the 3-35 s WebView2 environment stall used to happen
/// before the tray icon existed and the app looked dead. Built here, the tray
/// is up within milliseconds, the hotkey already works, and a press during the
/// stall is answered by the overlay page's await_frame pull whenever it does
/// finish loading.
fn build_overlay(app: &AppHandle) {
    let built = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("overlay.html".into()))
        .title("Screenshot Studio - select a region")
        .visible(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        // The page paints a frozen still or shows the live desktop for video.
        .transparent(true)
        .build();
    match built {
        Ok(_) => eprintln!("overlay window built, t+{}ms", uptime_ms()),
        Err(e) => eprintln!("overlay build: {e}"),
    }
    // The pins too, while nobody is waiting: built on demand they cost 3-11 s
    // (measured) between mouse-up and the preview. preview_ready keeps them
    // hidden until a capture asks.
    for video in [false, true] {
        match pin_window(app, video) {
            Ok(_) => eprintln!("pin window built, t+{}ms", uptime_ms()),
            Err(e) => eprintln!("pin prebuild: {e}"),
        }
    }
    // And the editor, for the same reason. editor_ready keeps it hidden
    // until a shot is opened in it.
    let editor = WebviewWindowBuilder::new(app, EDITOR, WebviewUrl::App("editor.html".into()))
        .title("Screenshot Studio - edit")
        .visible(false)
        .inner_size(900.0, 620.0)
        .min_inner_size(640.0, 420.0)
        .build();
    match editor {
        Ok(_) => eprintln!("editor window built, t+{}ms", uptime_ms()),
        Err(e) => eprintln!("editor prebuild: {e}"),
    }
}

fn capture_off_thread(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = begin_capture(&app, false) {
            eprintln!("capture: {e}");
        }
    });
}

static T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
fn uptime_ms() -> u128 {
    T0.get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis()
}

pub fn run() {
    let _ = uptime_ms(); // start the clock at launch, not at first use
    tauri::Builder::default()
        // Must be first. A second launch is someone reaching for a capture, not
        // someone asking for a second tray icon.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            capture_off_thread(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // The hotkey is registered from a plugin hook, not from setup: Tauri
        // creates the config windows before setup runs, and on a cold machine
        // the overlay's WebView2 environment blocks that for 10-30 s (measured
        // here). Plugins initialize before the windows, so the hotkey exists
        // within milliseconds and a press during the stall queues on the main
        // thread instead of going to whatever else has focus.
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("early-hotkey")
                .setup(|app, _api| {
                    let (settings, first_run) = load_settings(app);
                    // Not fatal. Another app can already own the combination,
                    // and losing the hotkey is no reason to lose the tray icon
                    // along with it.
                    let gs = app.global_shortcut();
                    if let Err(e) = gs.on_shortcut(settings.hotkey.as_str(), on_hotkey) {
                        eprintln!(
                            "{} is taken, capture from the tray instead: {e}",
                            settings.hotkey
                        );
                    }
                    if let Err(e) =
                        gs.on_shortcut(settings.record_hotkey.as_str(), on_record_hotkey)
                    {
                        eprintln!(
                            "{} is taken, record from the tray instead: {e}",
                            settings.record_hotkey
                        );
                    }
                    if first_run {
                        save_settings(app, &settings);
                    }
                    // Reconciled every launch, not just the first: it heals a
                    // Run key left pointing at an old install path, and it is
                    // what makes the on-by-default actually stick. Off-thread
                    // so reg.exe never sits in the startup path. Autostart is
                    // the cold-start fix: WebView2's first environment creation
                    // costs 3-35 s here, paid at login instead of at the first
                    // hotkey press.
                    let autostart = settings.autostart;
                    std::thread::spawn(move || {
                        if let Err(e) = set_autostart_reg(autostart) {
                            eprintln!("autostart: {e}");
                        }
                    });
                    app.manage(Cfg(Mutex::new(settings)));
                    Ok(())
                })
                .build(),
        )
        .manage(Shot::default())
        .invoke_handler(tauri::generate_handler![
            frozen_frame,
            recent_shots,
            shot_png,
            copy_path,
            copy_shot,
            open_folder,
            drag_shot,
            fit_pin,
            await_frame,
            overlay_ready,
            preview_ready,
            cancel_capture,
            new_capture,
            close_preview,
            finish_capture,
            stop_recording,
            recording_ms,
            pause_recording,
            open_editor,
            edit_target,
            editor_ready,
            close_editor,
            save_edited,
            copy_edited,
            get_settings,
            set_hotkey,
            set_autostart
        ])
        .setup(|app| {
            prune_shots(&shots_dir(app.handle())?, KEEP_SHOTS);
            TrayIconBuilder::with_id(TRAY)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Screenshot Studio")
                .menu(&tray_menu(app.handle())?)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "capture" => capture_off_thread(app),
                    "record" => toggle_record(app),
                    "settings" => open_settings(app),
                    "folder" => open_shots_dir(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Overlay build queued behind the event loop start, so the tray is
            // on screen before the WebView2 environment stall begins.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || build_overlay(&h));
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            match event {
                tauri::RunEvent::Ready => eprintln!("event loop ready, t+{}ms", uptime_ms()),
                // No main window, so closing the overlay or preview must not
                // quit. `code` is Some only when the tray's Quit item asked.
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    if code.is_none() {
                        api.prevent_exit();
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> CssRect {
        CssRect { x, y, w, h }
    }

    #[test]
    fn pins_stack_above_each_other() {
        let corner = PhysicalPosition::new(1500, 800);
        let size = PhysicalSize::new(400, 250);
        // Nothing else up: the corner.
        assert_eq!(stack_above(corner, size, None, 0, 12), corner);
        // The other pin holds the corner: this one goes right above it,
        // right-aligned with it.
        let other = Some((PhysicalPosition::new(1480, 900), PhysicalSize::new(440, 156)));
        assert_eq!(
            stack_above(corner, size, other, 0, 12),
            PhysicalPosition::new(1520, 638)
        );
        // No room above (the other pin is near the top): overlap the corner
        // rather than leave the screen.
        let high = Some((PhysicalPosition::new(1480, 100), PhysicalSize::new(440, 156)));
        assert_eq!(stack_above(corner, size, high, 0, 12), corner);
    }

    #[test]
    fn prunes_screenshots_and_videos_separately_on_disk() {
        let dir = std::env::temp_dir().join(format!(
            "ss-retention-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        for ext in ["png", "mp4"] {
            for n in 1..=7 {
                let file = std::fs::File::create(dir.join(format!("shot-{n}.{ext}"))).unwrap();
                file.set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(n * 10))
                    .unwrap();
            }
        }
        std::fs::write(dir.join("personal.mp4"), b"keep").unwrap();

        prune_shots(&dir, KEEP_SHOTS);
        let mut remaining: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        for name in &remaining {
            std::fs::remove_file(dir.join(name)).unwrap();
        }
        std::fs::remove_dir(&dir).unwrap();
        remaining.sort();
        let mut expected = vec!["personal.mp4".to_owned()];
        for n in 3..=7 {
            expected.push(format!("shot-{n}.mp4"));
            expected.push(format!("shot-{n}.png"));
        }
        assert_eq!(remaining, expected);
    }

    #[test]
    fn keeps_only_the_newest_shots() {
        let at = |secs| SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        let shots: Vec<_> = (1..=7)
            .map(|n| (at(n * 10), PathBuf::from(format!("shot-{n}.png"))))
            .collect();
        // Deleting is not reversible, so the rule is spelled out: newest five stay.
        let doomed = stale_shots(shots.clone(), 5);
        assert_eq!(
            doomed,
            vec![PathBuf::from("shot-2.png"), PathBuf::from("shot-1.png")]
        );
        // Under the limit nothing is touched, whatever the order they arrive in.
        assert!(stale_shots(shots[..5].to_vec(), 5).is_empty());
        assert!(stale_shots(Vec::new(), 5).is_empty());
        // Timestamps out of order must not change which files survive.
        let mut jumbled = shots.clone();
        jumbled.reverse();
        assert_eq!(stale_shots(jumbled, 5).len(), 2);
    }

    #[test]
    fn fast_png_round_trips() {
        // The encoder switched to CompressionType::Fast for the pin's sake;
        // what lands on disk must still be a PNG every decoder reads back
        // pixel-for-pixel, transparency included.
        let mut img = RgbaImage::new(3, 2);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        img.put_pixel(2, 1, image::Rgba([0, 0, 255, 128]));
        let png = png_bytes(&img).unwrap();
        assert_eq!(&png[1..4], b"PNG");
        let back = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(back.dimensions(), (3, 2));
        assert_eq!(back, img);
    }

    #[test]
    fn finished_crop_releases_desktop_and_reuses_full_frame() {
        let state = Shot::default();
        let img = RgbaImage::from_fn(8, 6, |x, y| image::Rgba([x as u8, y as u8, 7, 255]));
        *state.frame.lock().unwrap() = Some(img.clone());
        let (crop, at) = state.crop(r(1., 1., 2., 1.), 2.).unwrap();
        assert_eq!(at, (2, 2));
        assert_eq!(crop, image::imageops::crop_imm(&img, 2, 2, 4, 2).to_image());
        assert!(
            state.frame.lock().unwrap().is_none(),
            "finished capture retains the desktop"
        );
        let allocation = img.as_ptr();
        *state.frame.lock().unwrap() = Some(img);
        let (full, _) = state.crop(r(0., 0., 8., 6.), 1.).unwrap();
        assert_eq!(
            full.as_ptr(),
            allocation,
            "full-screen crop copied the desktop"
        );
        assert!(state.frame.lock().unwrap().is_none());
        *state.frame.lock().unwrap() = Some(full);
        assert!(state.crop(r(0., 0., 0., 0.), 1.).is_err());
        assert!(
            state.frame.lock().unwrap().is_none(),
            "failed crop retains the desktop"
        );
    }

    #[test]
    #[ignore = "capture/encoding timings; reads the primary display without saving it"]
    fn capture_performance() {
        use image::codecs::png::{CompressionType, FilterType, PngEncoder};
        use std::time::Instant;

        assert!(!cfg!(debug_assertions), "run with cargo test --release");
        let monitor = xcap::Monitor::all()
            .unwrap()
            .into_iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .unwrap();
        let t = Instant::now();
        let desktop = monitor.capture_image().unwrap();
        eprintln!(
            "desktop capture {:?}, {}x{}",
            t.elapsed(),
            desktop.width(),
            desktop.height()
        );
        let gradient = RgbaImage::from_fn(3840, 2160, |x, y| {
            image::Rgba([(x / 16) as u8, (y / 9) as u8, ((x + y) / 24) as u8, 255])
        });
        let mut seed = 7u32;
        let noise = RgbaImage::from_fn(1920, 1080, |_, _| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let [r, g, b, _] = seed.to_le_bytes();
            image::Rgba([r, g, b, 255])
        });
        for (name, img) in [("desktop", &desktop), ("4k gradient", &gradient), ("noise", &noise)] {
            let t = Instant::now();
            std::hint::black_box(bmp_bytes(img));
            eprintln!("{name} BMP {:?}", t.elapsed());
            for adaptive in [true, false] {
                let mut times = Vec::new();
                let mut bytes = Vec::new();
                for _ in 0..7 {
                    let t = Instant::now();
                    if adaptive {
                        bytes = Vec::new();
                        img.write_with_encoder(PngEncoder::new_with_quality(
                            &mut bytes, CompressionType::Fast, FilterType::Adaptive,
                        )).unwrap();
                    } else {
                        bytes = png_bytes(img).unwrap();
                    }
                    times.push(t.elapsed());
                }
                times.sort();
                assert_eq!(image::load_from_memory(&bytes).unwrap().to_rgba8(), *img);
                eprintln!(
                    "{name} adaptive={adaptive}: median {:?}, {} bytes",
                    times[3],
                    bytes.len()
                );
            }
        }
    }

    #[test]
    fn bmp_frame_is_topdown_bgra_and_readable() {
        let mut img = RgbaImage::new(2, 1);
        img.put_pixel(0, 0, image::Rgba([1, 2, 3, 0]));
        img.put_pixel(1, 0, image::Rgba([250, 251, 252, 128]));
        let bmp = bmp_bytes(&img);
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(bmp.len(), 54 + 8);
        assert_eq!(
            u32::from_le_bytes(bmp[2..6].try_into().unwrap()) as usize,
            bmp.len()
        );
        assert_eq!(i32::from_le_bytes(bmp[18..22].try_into().unwrap()), 2);
        // Negative height marks the rows as top-down, the order the frame is in.
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -1);
        // BGRA order, alpha forced opaque even where the capture said clear.
        assert_eq!(&bmp[54..62], &[3, 2, 1, 255, 252, 251, 250, 255]);
        // A real decoder agrees end to end.
        let back = image::load_from_memory(&bmp).unwrap().to_rgba8();
        assert_eq!(back.dimensions(), (2, 1));
        assert_eq!(back.get_pixel(0, 0).0, [1, 2, 3, 255]);
        assert_eq!(back.get_pixel(1, 0).0, [250, 251, 252, 255]);
    }

    #[test]
    fn spans_every_monitor() {
        // One screen: the desktop is that screen.
        assert_eq!(virtual_bounds(&[(0, 0, 1920, 1080)]), (0, 0, 1920, 1080));
        // Second screen to the right.
        assert_eq!(
            virtual_bounds(&[(0, 0, 1920, 1080), (1920, 0, 2560, 1440)]),
            (0, 0, 4480, 1440)
        );
        // Second screen to the LEFT, which is where the origin goes negative and
        // a naive (0, 0) origin silently crops the wrong half of the desktop.
        assert_eq!(
            virtual_bounds(&[(0, 0, 1920, 1080), (-2560, -200, 2560, 1440)]),
            (-2560, -200, 4480, 1440)
        );
        // Stacked vertically, primary on the bottom.
        assert_eq!(
            virtual_bounds(&[(0, 0, 1920, 1080), (0, -1080, 1920, 1080)]),
            (0, -1080, 1920, 2160)
        );
    }

    #[test]
    fn css_scales_to_physical() {
        // Same drag, three Windows scaling settings, three different crops.
        assert_eq!(
            css_rect_to_physical(r(100., 100., 400., 300.), 1.0, 1920, 1080),
            Some((100, 100, 400, 300))
        );
        assert_eq!(
            css_rect_to_physical(r(100., 100., 400., 300.), 1.25, 2400, 1350),
            Some((125, 125, 500, 375))
        );
        assert_eq!(
            css_rect_to_physical(r(100., 100., 400., 300.), 1.5, 2880, 1620),
            Some((150, 150, 600, 450))
        );
    }

    #[test]
    fn clamps_to_the_frame_and_rejects_empty() {
        // A drag off the right edge still crops, just shorter.
        assert_eq!(
            css_rect_to_physical(r(1900., 1000., 100., 100.), 1.0, 1920, 1080),
            Some((1900, 1000, 20, 80))
        );
        // Rounding at 1.5 must not push the crop past the last row of pixels.
        assert_eq!(
            css_rect_to_physical(r(0., 1000., 1280., 80.), 1.5, 2880, 1620),
            Some((0, 1500, 1920, 120))
        );
        // A click with no drag is a dismissal, not a 0x0 screenshot.
        assert_eq!(
            css_rect_to_physical(r(10., 10., 0., 0.), 1.0, 1920, 1080),
            None
        );
        // Entirely off the frame.
        assert_eq!(
            css_rect_to_physical(r(5000., 10., 50., 50.), 1.0, 1920, 1080),
            None
        );
    }
}
