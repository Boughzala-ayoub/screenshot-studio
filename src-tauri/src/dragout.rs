//! Dragging a shot out of the pin into another application.
//!
//! Windows offers a drop target a menu of formats and lets it take whichever it
//! understands. This offers two: CF_HDROP, so anything that accepts files gets
//! the picture, and CF_UNICODETEXT, so a terminal or a text box gets the path
//! instead. The ready-made crates for this offer only the file, which is why
//! dropping onto a prompt that wanted characters did nothing at all.

use std::ffi::c_void;
use std::iter::once;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::Once;

use windows::core::{implement, Error, Result, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{
    BOOL, COLORREF, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
    DV_E_FORMATETC, E_NOTIMPL, HGLOBAL, OLE_E_ADVISENOTSUPPORTED, POINT, S_OK, SIZE,
};
use windows::Win32::Graphics::Gdi::CreateBitmap;
use windows::Win32::System::Com::{
    CoCreateInstance, IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA,
    CLSCTX_ALL, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_FIXED};
use windows::Win32::System::Ole::{
    DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, DROPEFFECT, DROPEFFECT_COPY,
};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Shell::{
    Common::ITEMIDLIST, ILCreateFromPathW, IDragSourceHelper, IShellItemArray, BHID_DataObject,
    CLSID_DragDropHelper, DROPFILES, SHDRAGIMAGE, SHCreateShellItemArrayFromIDLists,
    SHCreateStdEnumFmtEtc,
};

/// Standard clipboard format ids, spelled out rather than imported: they move
/// between modules across windows-rs releases and the numbers never do.
const CF_UNICODETEXT: u16 = 13;
const CF_HDROP: u16 = 15;

/// Longest edge of the picture that follows the cursor during the drag.
const THUMB_MAX: u32 = 180;

static OLE: Once = Once::new();

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(once(0)).collect()
}

fn err(code: HRESULT) -> Error {
    Error::new(code, HSTRING::new())
}

unsafe fn hglobal(bytes: &[u8]) -> Result<HGLOBAL> {
    let handle = GlobalAlloc(GMEM_FIXED, bytes.len())?;
    let ptr = GlobalLock(handle) as *mut u8;
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
    let _ = GlobalUnlock(handle);
    Ok(handle)
}

/// DROPFILES header followed by a double-null-terminated wide path: the shape
/// CF_HDROP has had since Windows 95.
fn hdrop_blob(path: &Path) -> Vec<u8> {
    let mut chars = wide(path);
    chars.push(0); // the list itself ends with a second NUL

    let mut header = DROPFILES {
        pFiles: size_of::<DROPFILES>() as u32,
        fWide: BOOL(1),
        ..Default::default()
    };
    header.pt = POINT { x: 0, y: 0 };

    let mut blob = Vec::with_capacity(size_of::<DROPFILES>() + chars.len() * 2);
    unsafe {
        blob.extend_from_slice(std::slice::from_raw_parts(
            &header as *const DROPFILES as *const u8,
            size_of::<DROPFILES>(),
        ));
        blob.extend_from_slice(std::slice::from_raw_parts(
            chars.as_ptr() as *const u8,
            chars.len() * 2,
        ));
    }
    blob
}

/// The path as CF_UNICODETEXT, quoted when it contains a space. A terminal that
/// takes the text pastes it verbatim, and the shots folder is called "Screenshot
/// Studio", so a bare path would break every command it landed in. Explorer
/// quotes the same way when it drops a file on a console.
fn text_blob(path: &Path) -> Vec<u8> {
    let shown = path.to_string_lossy();
    let text = if shown.contains(char::is_whitespace) {
        format!("\"{shown}\"")
    } else {
        shown.into_owned()
    };
    let chars: Vec<u16> = text.encode_utf16().chain(once(0)).collect();
    unsafe { std::slice::from_raw_parts(chars.as_ptr() as *const u8, chars.len() * 2).to_vec() }
}

fn format_of(id: u16) -> FORMATETC {
    FORMATETC {
        cfFormat: id,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

#[implement(IDataObject)]
struct ShotData {
    hdrop: Vec<u8>,
    text: Vec<u8>,
    /// The shell's own object for the same file, asked whenever a target wants a
    /// format neither of the two above covers.
    shell: Option<IDataObject>,
}

impl ShotData {
    fn new(path: &Path) -> Self {
        Self {
            hdrop: hdrop_blob(path),
            text: text_blob(path),
            shell: shell_object(path),
        }
    }

    /// The bytes for a requested format, or None if it is not one of ours.
    fn bytes_for(&self, request: *const FORMATETC) -> Option<&[u8]> {
        let want = unsafe { request.as_ref() }?;
        if want.tymed & TYMED_HGLOBAL.0 as u32 == 0 || want.dwAspect != DVASPECT_CONTENT.0 {
            return None;
        }
        match want.cfFormat {
            CF_HDROP => Some(&self.hdrop),
            CF_UNICODETEXT => Some(&self.text),
            _ => None,
        }
    }
}

#[allow(non_snake_case)]
impl IDataObject_Impl for ShotData {
    fn GetData(&self, request: *const FORMATETC) -> Result<STGMEDIUM> {
        match self.bytes_for(request) {
            Some(bytes) => Ok(STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 {
                    hGlobal: unsafe { hglobal(bytes)? },
                },
                pUnkForRelease: std::mem::ManuallyDrop::new(None),
            }),
            None => match &self.shell {
                Some(shell) => unsafe { shell.GetData(request) },
                None => Err(err(DV_E_FORMATETC)),
            },
        }
    }

    fn GetDataHere(&self, _request: *const FORMATETC, _medium: *mut STGMEDIUM) -> Result<()> {
        Err(err(DV_E_FORMATETC))
    }

    fn QueryGetData(&self, request: *const FORMATETC) -> HRESULT {
        if self.bytes_for(request).is_some() {
            S_OK
        } else {
            match &self.shell {
                Some(shell) => unsafe { shell.QueryGetData(request) },
                None => DV_E_FORMATETC,
            }
        }
    }

    fn GetCanonicalFormatEtc(&self, _in: *const FORMATETC, out: *mut FORMATETC) -> HRESULT {
        unsafe { (*out).ptd = std::ptr::null_mut() };
        E_NOTIMPL
    }

    fn SetData(
        &self,
        _request: *const FORMATETC,
        _medium: *const STGMEDIUM,
        _release: BOOL,
    ) -> Result<()> {
        Err(err(E_NOTIMPL))
    }

    /// Targets that browse rather than ask by name only find a format if it is
    /// listed here, so both of ours are.
    fn EnumFormatEtc(&self, _direction: u32) -> Result<IEnumFORMATETC> {
        let formats = [format_of(CF_HDROP), format_of(CF_UNICODETEXT)];
        unsafe { SHCreateStdEnumFmtEtc(&formats) }
    }

    fn DAdvise(
        &self,
        _request: *const FORMATETC,
        _flags: u32,
        _sink: Option<&IAdviseSink>,
    ) -> Result<u32> {
        Err(err(OLE_E_ADVISENOTSUPPORTED))
    }

    fn DUnadvise(&self, _connection: u32) -> Result<()> {
        Err(err(OLE_E_ADVISENOTSUPPORTED))
    }

    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        Err(err(OLE_E_ADVISENOTSUPPORTED))
    }
}

#[implement(IDropSource)]
struct DropSource;

#[allow(non_snake_case)]
impl IDropSource_Impl for DropSource {
    fn QueryContinueDrag(&self, escaped: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escaped.as_bool() {
            DRAGDROP_S_CANCEL
        } else if (keys & MK_LBUTTON) == MODIFIERKEYS_FLAGS(0) {
            DRAGDROP_S_DROP // button released: this is the drop
        } else {
            S_OK
        }
    }

    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

fn shell_object(path: &Path) -> Option<IDataObject> {
    unsafe {
        let chars = wide(path);
        let id = ILCreateFromPathW(PCWSTR::from_raw(chars.as_ptr()));
        if id.is_null() {
            return None;
        }
        let list: [*const ITEMIDLIST; 1] = [id.cast_const()];
        let items: IShellItemArray = SHCreateShellItemArrayFromIDLists(&list).ok()?;
        items.BindToHandler(None, &BHID_DataObject).ok()
    }
}

/// RGBA in, a scaled premultiplied-BGRA bitmap out, for the picture that follows
/// the cursor. None if the shot cannot be read; the drag still works without it.
pub fn thumbnail(path: &Path) -> Option<(u32, u32, Vec<u8>)> {
    let img = image::open(path).ok()?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    let long = w.max(h).max(1);
    let img = if long > THUMB_MAX {
        image::imageops::resize(
            &img,
            (w * THUMB_MAX / long).max(1),
            (h * THUMB_MAX / long).max(1),
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };
    let (tw, th) = (img.width(), img.height());
    // CreateBitmap wants BGRA. The shots are opaque, so there is nothing to
    // premultiply; only the channel order changes.
    let mut bgra = img.into_raw();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    Some((tw, th, bgra))
}

/// Blocks until the drop completes or is cancelled, so it must run on the thread
/// that owns the window.
pub fn start(path: &Path, thumb: Option<(u32, u32, Vec<u8>)>) -> Result<()> {
    OLE.call_once(|| unsafe {
        let _ = OleInitialize(Some(std::ptr::null_mut()));
    });

    let data: IDataObject = ShotData::new(path).into();
    let source: IDropSource = DropSource.into();

    if let Some((w, h, bgra)) = thumb {
        unsafe {
            let bitmap = CreateBitmap(w as i32, h as i32, 1, 32, Some(bgra.as_ptr() as *const c_void));
            let image = SHDRAGIMAGE {
                sizeDragImage: SIZE {
                    cx: w as i32,
                    cy: h as i32,
                },
                ptOffset: POINT {
                    x: w as i32 / 2,
                    y: h as i32 / 2,
                },
                hbmpDragImage: bitmap,
                crColorKey: COLORREF(0xFFFFFFFF),
            };
            if let Ok(helper) =
                CoCreateInstance::<_, IDragSourceHelper>(&CLSID_DragDropHelper, None, CLSCTX_ALL)
            {
                let _ = helper.InitializeFromBitmap(&image, &data);
            }
        }
    }

    let mut effect = DROPEFFECT::default();
    // DRAGDROP_S_DROP means it landed somewhere, DRAGDROP_S_CANCEL that the user
    // let go over nothing. Neither is an error worth surfacing.
    let outcome = unsafe { DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect) };
    if outcome != DRAGDROP_S_DROP && outcome != DRAGDROP_S_CANCEL {
        return Err(err(outcome));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars_of(bytes: &[u8]) -> Vec<u16> {
        bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect()
    }

    /// Hand-built byte layouts are the kind of thing that silently half-works:
    /// a wrong offset or a missing terminator gives a drop that some apps accept
    /// and others ignore, which is exactly the bug this module exists to fix.
    #[test]
    fn hdrop_blob_is_shaped_the_way_windows_reads_it() {
        let blob = hdrop_blob(Path::new(r"C:\shots\a.png"));
        let header = size_of::<DROPFILES>();

        // pFiles: the file list starts right after the header.
        assert_eq!(
            u32::from_le_bytes(blob[0..4].try_into().unwrap()),
            header as u32
        );
        // fWide, the last field: non-zero, or Windows reads the path as ANSI.
        assert_eq!(u32::from_le_bytes(blob[16..20].try_into().unwrap()), 1);

        let chars = chars_of(&blob[header..]);
        assert_eq!(
            String::from_utf16(&chars[..chars.len() - 2]).unwrap(),
            r"C:\shots\a.png"
        );
        // Two terminators: one ends the path, one ends the list.
        assert_eq!(&chars[chars.len() - 2..], &[0, 0]);
    }

    fn text_of(path: &str) -> String {
        let chars = chars_of(&text_blob(Path::new(path)));
        assert_eq!(chars.last(), Some(&0)); // CF_UNICODETEXT is NUL terminated
        String::from_utf16(&chars[..chars.len() - 1]).unwrap()
    }

    #[test]
    fn text_blob_quotes_only_when_the_path_needs_it() {
        assert_eq!(text_of(r"C:\shots\a.png"), r"C:\shots\a.png");
        // The real folder has a space in it, and a terminal pastes this verbatim.
        assert_eq!(
            text_of(r"C:\Users\me\Pictures\Screenshot Studio\shot-1.png"),
            r#""C:\Users\me\Pictures\Screenshot Studio\shot-1.png""#
        );
    }
}
