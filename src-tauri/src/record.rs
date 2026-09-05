//! Region video. Windows Graphics Capture on the monitor under the selection,
//! cropped on the GPU to the region, encoded to an H.264 MP4 by Media
//! Foundation. No audio: the request was "video of part of my screen".

use std::path::PathBuf;
use std::time::Instant;

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

const FPS: u32 = 30;

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

struct Rec {
    encoder: Option<VideoEncoder>,
    crop: Crop,
    scratch: Vec<u8>,
    /// The last frame handed to the encoder, rows already flipped, and when
    /// it arrived. WGC only delivers a frame when something changed, so a
    /// recording of a still region would end at its first frame; the stop
    /// sends this once more, stamped at the moment the user stopped.
    last: Vec<u8>,
    last_ts: i64,
    last_at: Instant,
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
            scratch: Vec::new(),
            last: Vec::new(),
            last_ts: 0,
            last_at: Instant::now(),
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
        let ts = frame.timestamp()?.Duration;
        let c = self.crop;
        let buf = frame.buffer_crop(c.x, c.y, c.x + c.w, c.y + c.h)?;
        let pixels = buf.as_nopadding_buffer(&mut self.scratch);
        // Media Foundation reads an uncompressed RGB sample bottom-up.
        let row = (c.w * 4) as usize;
        self.last.clear();
        for r in pixels.chunks_exact(row).rev() {
            self.last.extend_from_slice(r);
        }
        self.last_ts = ts;
        self.last_at = Instant::now();
        enc.send_frame_buffer(&self.last, ts)?;
        Ok(())
    }
}

impl Rec {
    fn finish(&mut self) -> Result<(), Err> {
        let Some(mut enc) = self.encoder.take() else {
            return Ok(());
        };
        if !self.last.is_empty() {
            let held = self.last_at.elapsed().as_nanos() as i64 / 100;
            enc.send_frame_buffer(&self.last, self.last_ts + held)?;
        }
        enc.finish()?;
        Ok(())
    }
}

pub struct Recording {
    control: CaptureControl<Rec, Err>,
    pub path: PathBuf,
    pub started: Instant,
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
    fn bitrate_scales_with_area_within_bounds() {
        assert_eq!(bitrate(1920, 1080), 7_776_000);
        assert_eq!(bitrate(100, 100), 1_000_000);
        assert_eq!(bitrate(3840, 2160), 12_000_000);
    }
}
