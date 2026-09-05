//! Region video. Windows Graphics Capture on the monitor under the selection,
//! cropped on the GPU to the region, encoded to an H.264 MP4 by Media
//! Foundation. No audio: the request was "video of part of my screen".

use std::path::PathBuf;
use std::time::{Duration, Instant};

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::{Frame, FrameBuffer};
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

const FPS: u32 = 30;

// A 30 fps budget with room for one early frame. Strict timestamp buckets
// discard useful frames when a 30 fps source jitters across bucket boundaries.
fn frame_due(next: &mut Option<i64>, timestamp: i64) -> bool {
    const TICKS: i64 = 10_000_000 / FPS as i64;
    let scheduled = next.unwrap_or(timestamp);
    if timestamp < scheduled - TICKS {
        return false;
    }
    *next = Some(scheduled.max(timestamp) + TICKS);
    true
}

/// Remove row padding and flip for the encoder in one copy into reused storage.
fn bottom_up(buf: &mut FrameBuffer<'_>, output: &mut Vec<u8>) {
    let row = buf.width() as usize * 4;
    let pitch = buf.row_pitch() as usize;
    output.resize(row * buf.height() as usize, 0);
    for (src, dst) in buf
        .as_raw_buffer()
        .chunks_exact(pitch)
        .rev()
        .zip(output.chunks_exact_mut(row))
    {
        dst.copy_from_slice(&src[..row]);
    }
}

/// The recorded rectangle, physical pixels, relative to its monitor's top-left.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// A selection clamped to its monitor and rounded down to even dimensions,
/// which H.264 insists on. None when nothing usable is left.
pub fn even_crop(x: i32, y: i32, w: u32, h: u32, mw: u32, mh: u32) -> Option<Crop> {
    let x0 = x.clamp(0, mw as i32) as u32;
    let y0 = y.clamp(0, mh as i32) as u32;
    let x1 = (x + w as i32).clamp(0, mw as i32) as u32;
    let y1 = (y + h as i32).clamp(0, mh as i32) as u32;
    let (w, h) = ((x1 - x0) & !1, (y1 - y0) & !1);
    (w >= 2 && h >= 2).then_some(Crop { x: x0, y: y0, w, h })
}

/// Roughly 0.1 bit per pixel per frame: 8 Mbps for 1080p, 2 Mbps for a
/// 720x480 corner. Screen content compresses far better than camera footage.
fn bitrate(w: u32, h: u32) -> u32 {
    (w * h * FPS / 8).clamp(1_000_000, 12_000_000)
}

type Err = Box<dyn std::error::Error + Send + Sync>;

/// The pause bookkeeping, kept apart from the capture so it can be checked
/// without a screen. Frames that arrive while paused are dropped, and the
/// time spent paused is subtracted from every later timestamp so the file
/// plays as one continuous take.
#[derive(Default)]
struct Pauses {
    paused_at: Option<Instant>,
    /// Total paused time in 100 ns ticks, the encoder's unit.
    skipped: i64,
}

impl Pauses {
    fn paused(&self) -> bool {
        self.paused_at.is_some()
    }
    fn pause(&mut self, now: Instant) {
        self.paused_at.get_or_insert(now);
    }
    /// The pause just ended, or None when there was none to end.
    fn resume(&mut self, now: Instant) -> Option<Duration> {
        let d = now.duration_since(self.paused_at.take()?);
        self.skipped += d.as_nanos() as i64 / 100;
        Some(d)
    }
    /// A capture timestamp with the pauses so far taken out.
    fn adjust(&self, ts: i64) -> i64 {
        ts - self.skipped
    }
    /// Recording time since `started`, pauses excluded, including one in progress.
    fn elapsed(&self, started: Instant, now: Instant) -> Duration {
        let end = self.paused_at.unwrap_or(now);
        end.duration_since(started)
            .saturating_sub(Duration::from_nanos(self.skipped as u64 * 100))
    }
}

struct Rec {
    encoder: Option<VideoEncoder>,
    crop: Crop,
    /// The last frame handed to the encoder, rows already flipped, and when
    /// it arrived. WGC only delivers a frame when something changed, so a
    /// recording of a still region would end at its first frame; the stop
    /// sends this once more, stamped at the moment the user stopped.
    last: Vec<u8>,
    last_ts: Option<i64>,
    next_frame: Option<i64>,
    last_at: Instant,
    pauses: Pauses,
    #[cfg(test)]
    measured: (u64, Duration),
}

impl GraphicsCaptureApiHandler for Rec {
    type Flags = (Crop, PathBuf);
    type Error = Err;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Err> {
        let (crop, path) = ctx.flags;
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(crop.w, crop.h)
                .sub_type(VideoSettingsSubType::H264)
                .frame_rate(FPS)
                .bitrate(bitrate(crop.w, crop.h)),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            path,
        )?;
        Ok(Self {
            encoder: Some(encoder),
            crop,
            last: Vec::new(),
            last_ts: None,
            next_frame: None,
            last_at: Instant::now(),
            pauses: Pauses::default(),
            #[cfg(test)]
            measured: (0, Duration::ZERO),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _: InternalCaptureControl,
    ) -> Result<(), Err> {
        let Some(enc) = self.encoder.as_mut() else {
            return Ok(());
        };
        if self.pauses.paused() {
            return Ok(());
        }
        #[cfg(test)]
        let measuring = Instant::now();
        let ts = self.pauses.adjust(frame.timestamp()?.Duration);
        if self.last_ts.is_some_and(|last| ts <= last) || !frame_due(&mut self.next_frame, ts) {
            return Ok(());
        }
        let c = self.crop;
        let mut buf = frame.buffer_crop(c.x, c.y, c.x + c.w, c.y + c.h)?;
        bottom_up(&mut buf, &mut self.last);
        self.last_ts = Some(ts);
        self.last_at = Instant::now();
        enc.send_frame_buffer(&self.last, ts)?;
        #[cfg(test)]
        {
            self.measured.0 += 1;
            self.measured.1 += measuring.elapsed();
        }
        Ok(())
    }
}

impl Rec {
    fn finish(&mut self) -> Result<(), Err> {
        let Some(mut enc) = self.encoder.take() else {
            return Ok(());
        };
        if let Some(ts) = self.last_ts {
            let end = self.pauses.paused_at.unwrap_or_else(Instant::now);
            let held = end.saturating_duration_since(self.last_at).as_nanos() as i64 / 100;
            enc.send_frame_buffer(&self.last, ts + held)?;
        }
        enc.finish()?;
        Ok(())
    }
}

pub struct Recording {
    control: CaptureControl<Rec, Err>,
    pub path: PathBuf,
    started: Instant,
}

impl Recording {
    /// Pause or resume. Paused, the encoder gets nothing; resumed, the clock
    /// picks up where it left off and the held-frame timer skips the gap.
    pub fn set_paused(&self, on: bool) {
        let handler = self.control.callback();
        let mut r = handler.lock();
        let now = Instant::now();
        if on {
            r.pauses.pause(now);
        } else if let Some(gap) = r.pauses.resume(now) {
            r.last_at += gap;
        }
    }

    pub fn paused(&self) -> bool {
        self.control.callback().lock().pauses.paused()
    }

    /// Recorded time so far, pauses excluded: what the stop bar's clock shows.
    pub fn elapsed(&self) -> Duration {
        self.control
            .callback()
            .lock()
            .pauses
            .elapsed(self.started, Instant::now())
    }
}

/// Start recording `crop` of the monitor behind `hmonitor` into `path`.
pub fn start(hmonitor: isize, crop: Crop, path: PathBuf) -> Result<Recording, String> {
    // The yellow frame Windows draws around a captured monitor can be turned
    // off from 22H2 on; older builds keep it and the recording still works.
    let border = match GraphicsCaptureApi::is_border_settings_supported() {
        Ok(true) => DrawBorderSettings::WithoutBorder,
        _ => DrawBorderSettings::Default,
    };
    let settings = Settings::new(
        Monitor::from_raw_hmonitor(hmonitor as *mut std::ffi::c_void),
        CursorCaptureSettings::WithCursor,
        border,
        SecondaryWindowSettings::Default,
        // Native minimum intervals can undershoot 30 fps as display updates
        // arrive. Pace by timestamps before GPU readback instead.
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        (crop, path.clone()),
    );
    let control = Rec::start_free_threaded(settings).map_err(|e| e.to_string())?;
    Ok(Recording {
        control,
        path,
        started: Instant::now(),
    })
}

/// Stop the capture and flush the file. Returns where it landed.
pub fn stop(rec: Recording) -> Result<PathBuf, String> {
    let handler = rec.control.callback();
    rec.control.stop().map_err(|e| e.to_string())?;
    handler.lock().finish().map_err(|e| e.to_string())?;
    Ok(rec.path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_pacing_limits_work_with_one_frame_of_slack() {
        for hz in [30, 60, 120, 144, 240] {
            let mut next = None;
            let mut accepted = 0;
            for frame in 0..hz * 10 {
                let ts = frame * 10_000_000 / hz;
                if frame_due(&mut next, ts) {
                    accepted += 1;
                }
            }
            assert!((300..=301).contains(&accepted), "{hz} Hz input: {accepted}");
        }
        let mut next = None;
        assert!(frame_due(&mut next, 0));
        assert!(frame_due(&mut next, 1));
        assert!(!frame_due(&mut next, 2));
        assert!(frame_due(&mut next, 90_000_000));
        assert!(frame_due(&mut next, 90_000_001));
        assert!(!frame_due(&mut next, 90_000_002));
    }

    #[test]
    fn frame_pacing_retains_thirty_fps_with_arrival_jitter() {
        let mut next = None;
        let mut accepted = 0;
        for i in 0..300 {
            let ts = i * 10_000_000 / FPS as i64 + if i % 2 == 0 { 50_000 } else { -50_000 };
            if frame_due(&mut next, ts) {
                accepted += 1;
            }
        }
        assert_eq!(accepted, 300);
    }

    #[test]
    fn frame_copy_strips_padding_and_flips_without_reallocating() {
        for padding in [0, 8] {
            let pitch = 8 + padding;
            let mut raw = vec![0xff; pitch * 2];
            raw[..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
            raw[pitch..pitch + 8].copy_from_slice(&[9, 10, 11, 12, 13, 14, 15, 16]);
            let mut buf = FrameBuffer::new(&mut raw, 2, 2, pitch as u32, 0, ColorFormat::Bgra8);
            let mut output = vec![0; 16];
            let allocation = output.as_ptr();
            bottom_up(&mut buf, &mut output);
            assert_eq!(
                output,
                [9, 10, 11, 12, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8]
            );
            assert_eq!(output.as_ptr(), allocation);
        }
    }

    #[test]
    #[ignore = "timing comparison for a padded 1918x1080 capture buffer"]
    fn frame_copy_performance() {
        let (w, h, pitch) = (1918, 1080, 7680);
        let mut raw = vec![0x7f; pitch * h];
        let mut buf = FrameBuffer::new(
            &mut raw,
            w as u32,
            h as u32,
            pitch as u32,
            0,
            ColorFormat::Bgra8,
        );
        let mut scratch = Vec::new();
        let mut old = Vec::with_capacity(w * h * 4);
        let mut new = vec![0; w * h * 4];
        let mut before = Vec::new();
        let mut after = Vec::new();
        for _ in 0..21 {
            let t = Instant::now();
            let pixels = buf.as_nopadding_buffer(&mut scratch);
            old.clear();
            for row in pixels.chunks_exact(w * 4).rev() {
                old.extend_from_slice(row);
            }
            std::hint::black_box(&old);
            before.push(t.elapsed());
            let t = Instant::now();
            bottom_up(&mut buf, &mut new);
            std::hint::black_box(&new);
            after.push(t.elapsed());
            assert_eq!(old, new);
        }
        before.sort();
        after.sort();
        eprintln!(
            "frame copy median: before={:?}, after={:?}; removed {}-byte scratch buffer",
            before[10],
            after[10],
            scratch.len()
        );
    }

    #[test]
    #[ignore = "captures a 1918x1080 region of the primary display; show moving content"]
    fn live_recording_performance() {
        capture_recording(false);
    }

    #[test]
    #[ignore = "records the primary display, pauses, resumes, and stops while paused"]
    fn live_recording_pause() {
        capture_recording(true);
    }

    fn capture_recording(pause: bool) {
        let monitor = Monitor::primary().unwrap();
        let crop = even_crop(
            0,
            0,
            1918,
            1080,
            monitor.width().unwrap(),
            monitor.height().unwrap(),
        )
        .unwrap();
        let path =
            std::env::temp_dir().join(format!("ss-record-perf-{}-{pause}.mp4", std::process::id()));
        let t = Instant::now();
        let rec = start(monitor.as_raw_hmonitor() as isize, crop, path.clone()).unwrap();
        let startup = t.elapsed();
        std::thread::sleep(Duration::from_secs(2));
        if pause {
            rec.set_paused(true);
            let clock = rec.elapsed();
            let frames = rec.control.callback().lock().measured.0;
            std::thread::sleep(Duration::from_secs(1));
            assert_eq!(rec.elapsed(), clock);
            assert_eq!(rec.control.callback().lock().measured.0, frames);
            rec.set_paused(false);
        }
        std::thread::sleep(Duration::from_secs(2));
        if pause {
            rec.set_paused(true);
            std::thread::sleep(Duration::from_secs(1));
        }
        let active = rec.elapsed();
        let measured = rec.control.callback().lock().measured;
        let t = Instant::now();
        stop(rec).unwrap();
        eprintln!(
            "record benchmark: frames={}, processing={:?}, active={active:?}, startup={startup:?}, stop={:?}, file={}",
            measured.0,
            measured.1,
            t.elapsed(),
            path.display()
        );
        assert!(
            measured.0 > 1,
            "show moving content while running this test"
        );
        assert!(
            measured.0 <= (active.as_secs_f64() * FPS as f64).ceil() as u64 + 2,
            "30 fps recording processed excess frames"
        );
        assert!(std::fs::metadata(path).unwrap().len() > 1000);
    }

    #[test]
    fn crops_are_even_and_inside_the_monitor() {
        // A plain selection keeps its position, loses the odd pixel.
        assert_eq!(
            even_crop(100, 50, 401, 301, 1920, 1080),
            Some(Crop {
                x: 100,
                y: 50,
                w: 400,
                h: 300
            })
        );
        // Off the bottom-right: clamped, then evened.
        assert_eq!(
            even_crop(1800, 1000, 300, 300, 1920, 1080),
            Some(Crop {
                x: 1800,
                y: 1000,
                w: 120,
                h: 80
            })
        );
        // Starting off the top-left (a drag that began on the other monitor).
        assert_eq!(
            even_crop(-10, -10, 30, 30, 1920, 1080),
            Some(Crop {
                x: 0,
                y: 0,
                w: 20,
                h: 20
            })
        );
        // Too thin to encode.
        assert_eq!(even_crop(10, 10, 1, 100, 1920, 1080), None);
        assert_eq!(even_crop(3000, 10, 100, 100, 1920, 1080), None);
    }

    #[test]
    fn pauses_drop_out_of_timestamps_and_the_clock() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let mut p = Pauses::default();
        assert_eq!(p.adjust(10_000_000), 10_000_000);
        // Paused from 2 s to 5 s: the clock freezes at 2 s...
        p.pause(at(2));
        p.pause(at(3)); // a second press changes nothing
        assert!(p.paused());
        assert_eq!(p.elapsed(t0, at(4)), Duration::from_secs(2));
        // ...and afterwards every timestamp is 3 s earlier, the clock 3 s behind.
        assert_eq!(p.resume(at(5)), Some(Duration::from_secs(3)));
        assert_eq!(p.resume(at(6)), None);
        assert_eq!(p.adjust(70_000_000), 40_000_000);
        assert_eq!(p.elapsed(t0, at(9)), Duration::from_secs(6));
    }

    #[test]
    fn bitrate_scales_with_area_within_bounds() {
        assert_eq!(bitrate(1920, 1080), 7_776_000);
        assert_eq!(bitrate(100, 100), 1_000_000);
        assert_eq!(bitrate(3840, 2160), 12_000_000);
    }
}
