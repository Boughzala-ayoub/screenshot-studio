import { invoke } from "@tauri-apps/api/core";

const frozen = document.getElementById("frozen") as HTMLImageElement;
const dim = document.getElementById("dim") as HTMLDivElement;
const sel = document.getElementById("sel") as HTMLDivElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const hint = document.getElementById("hint") as HTMLDivElement;
const vline = document.getElementById("vline") as HTMLDivElement;
const hline = document.getElementById("hline") as HTMLDivElement;
const loupe = document.getElementById("loupe") as HTMLDivElement;
const pixdot = document.getElementById("pixdot") as HTMLElement;
const pixtxt = document.getElementById("pixtxt") as HTMLElement;
const frame = document.getElementById("frame") as HTMLDivElement;
const recordControls = document.getElementById("record-controls")!;
const recordButton = document.getElementById("start-record") as HTMLButtonElement;
const recordError = document.getElementById("record-error")!;

const ZOOM = 8;
const LOUPE = 132; // keep in step with #loupe in overlay.css

type Rect = { x: number; y: number; w: number; h: number };
let start: { x: number; y: number } | null = null;
let last = { x: 0, y: 0 }; // where the pointer last was
let nudge = { x: 0, y: 0 }; // keyboard offset applied to the moving corner
let moving = false; // Space held mid-drag: carry the whole box, size intact
let selection: Rect | null = null;
let adjustment: { rect: Rect; mode: string; x: number; y: number } | null = null;
let starting = false;
const isVideo = () => document.body.classList.contains("video");

// One CPU-readable copy of the frame, so the loupe can name the color under
// the cursor. Redrawn once per capture, sampled one pixel at a time.
const sampler = document.createElement("canvas");
let sctx: CanvasRenderingContext2D | null = null;

// The page outlives the capture now (no reload between shots), so everything a
// drag touched goes back to the first-load state by hand.
function reset() {
  start = null;
  nudge.x = nudge.y = 0;
  moving = false;
  selection = adjustment = null;
  starting = false;
  recordButton.disabled = false;
  recordControls.hidden = recordError.hidden = true;
  sel.tabIndex = -1;
  dim.hidden = false;
  hint.hidden = false;
  sel.hidden = hud.hidden = frame.hidden = true;
  vline.hidden = hline.hidden = loupe.hidden = true;
  document.body.classList.remove("live", "framed");
}

function recordingFrame(x: number, y: number, w: number, h: number) {
  sel.hidden = hud.hidden = hint.hidden = recordControls.hidden = true;
  vline.hidden = hline.hidden = loupe.hidden = true;
  frame.hidden = false;
  frame.style.left = `${x}px`;
  frame.style.top = `${y}px`;
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  document.body.classList.remove("framed");
  document.body.classList.add("live");
}

// While a recording runs the overlay stays up, see-through and click-through,
// as nothing but a frame drawn just outside the region so it never lands in
// the video. Rust calls these two around the recording.
Object.assign(window, {
  recFrame: recordingFrame,
  recPaused(on: boolean) {
    document.body.classList.toggle("paused", on);
  },
  recDone() {
    document.body.classList.remove("paused");
    reset();
  },
});

// The capture loop. The backend completes await_frame once per hotkey press,
// however long after the press this page finally woke up; nothing is pushed at
// a webview mid-load, so nothing can be lost. The window stays hidden until the
// still is actually painted: showing earlier gives a window that looks ready
// and drops the first drag on the floor.
let url = "";
async function captures() {
  for (let gen = 0; ; ) {
    const info = await invoke<{ gen: number; video: boolean }>("await_frame", { seen: gen });
    gen = info.gen;
    try {
      if (url) URL.revokeObjectURL(url);
      url = "";
      frozen.removeAttribute("src");
      loupe.style.backgroundImage = "";
      sampler.width = sampler.height = 0;
      sctx = null;
      reset();
      // The badge and the hint say which of the two the drag will do.
      document.body.classList.toggle("video", info.video);
      if (!info.video) {
        const bmp = await invoke<ArrayBuffer>("frozen_frame");
        url = URL.createObjectURL(new Blob([bmp], { type: "image/bmp" }));
        frozen.src = url;
        loupe.style.backgroundImage = `url(${url})`;
        await frozen.decode().catch(() => {}); // a broken frame beats a dead hotkey
        sampler.width = frozen.naturalWidth;
        sampler.height = frozen.naturalHeight;
        sctx = sampler.getContext("2d", { willReadFrequently: true });
        sctx?.drawImage(frozen, 0, 0);
      }
      invoke("overlay_ready");
    } catch {
      // this frame is lost, but the loop survives to answer the next press
    }
  }
}
captures();

// Two corners in, one CSS-pixel rect out. Rust scales it to physical pixels.
function rectOf(a: { x: number; y: number }, bx: number, by: number): Rect {
  return { x: Math.min(a.x, bx), y: Math.min(a.y, by), w: Math.abs(bx - a.x), h: Math.abs(by - a.y) };
}

// The corner a drag is steering: the pointer, plus whatever the arrow keys
// have added for the last pixel or two the hand is too coarse for.
const corner = () => ({ x: last.x + nudge.x, y: last.y + nudge.y });

// The cursor is hidden, so the guides and the loupe are the pointer.
function aim(x: number, y: number) {
  vline.hidden = hline.hidden = false;
  loupe.hidden = isVideo();
  vline.style.left = `${x}px`;
  hline.style.top = `${y}px`;
  if (isVideo()) return;

  // The frozen image is drawn at exactly one CSS pixel per viewport pixel, so
  // zooming it is a straight multiply. Offset by half the loupe to centre the
  // pixel under the cursor.
  loupe.style.backgroundSize = `${innerWidth * ZOOM}px ${innerHeight * ZOOM}px`;
  loupe.style.backgroundPosition = `${LOUPE / 2 - x * ZOOM}px ${LOUPE / 2 - y * ZOOM}px`;
  // Flip to the other side of the cursor near an edge rather than hang off it.
  const gap = 20;
  loupe.style.left = `${x + gap + LOUPE > innerWidth ? x - gap - LOUPE : x + gap}px`;
  loupe.style.top = `${y + gap + LOUPE > innerHeight ? y - gap - LOUPE : y + gap}px`;

  if (sctx) {
    // CSS pixel to frame pixel: the frame is the viewport times the scale.
    const sx = Math.min(sampler.width - 1, Math.max(0, Math.floor((x * sampler.width) / innerWidth)));
    const sy = Math.min(sampler.height - 1, Math.max(0, Math.floor((y * sampler.height) / innerHeight)));
    const [r, g, b] = sctx.getImageData(sx, sy, 1, 1).data;
    const hex = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
    pixdot.style.background = hex;
    pixtxt.textContent = hex;
  }
}

function readout(text: string, x: number, y: number) {
  hud.hidden = false;
  hud.textContent = text;
  const below = y + 8;
  hud.style.left = `${Math.max(0, Math.min(x, innerWidth - hud.offsetWidth - 8))}px`;
  hud.style.top = `${below + hud.offsetHeight > innerHeight ? y - hud.offsetHeight - 8 : below}px`;
}

function paint(r: Rect) {
  dim.hidden = true;
  sel.hidden = false;
  sel.style.left = `${r.x}px`;
  sel.style.top = `${r.y}px`;
  sel.style.width = `${r.w}px`;
  sel.style.height = `${r.h}px`;
  readout(`${Math.round(r.w)} x ${Math.round(r.h)}`, r.x, r.y + r.h);
}

function repaint() {
  if (!start) return;
  const c = corner();
  paint(rectOf(start, c.x, c.y));
}

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(n, high));

function adjustRect(r: Rect, mode: string, dx: number, dy: number): Rect {
  if (mode === "move") {
    return { ...r, x: clamp(r.x + dx, 0, innerWidth - r.w), y: clamp(r.y + dy, 0, innerHeight - r.h) };
  }
  let { x, y } = r;
  let right = x + r.w, bottom = y + r.h;
  if (mode.includes("w")) x = clamp(x + dx, 0, right - 2);
  if (mode.includes("e")) right = clamp(right + dx, x + 2, innerWidth);
  if (mode.includes("n")) y = clamp(y + dy, 0, bottom - 2);
  if (mode.includes("s")) bottom = clamp(bottom + dy, y + 2, innerHeight);
  return { x, y, w: right - x, h: bottom - y };
}

function select(r: Rect) {
  selection = r;
  document.body.classList.add("framed");
  hint.hidden = vline.hidden = hline.hidden = loupe.hidden = true;
  recordControls.hidden = false;
  sel.tabIndex = 0;
  paint(r);
  const height = recordControls.offsetHeight, width = recordControls.offsetWidth;
  const below = r.y + r.h + 40, above = r.y - height - 12;
  const top = below + height <= innerHeight - 12 ? below
    : above >= 12 ? above : clamp(r.y + r.h - height - 24, 12, innerHeight - height - 12);
  recordControls.style.top = `${top}px`;
  recordControls.style.left = `${clamp(r.x + r.w / 2, width / 2 + 12, innerWidth - width / 2 - 12)}px`;
}

async function startRecording() {
  if (!selection || adjustment || starting || !isVideo()) return;
  const r = { ...selection };
  starting = recordButton.disabled = true;
  recordError.hidden = true;
  // Paint away the dimming and setup controls before WGC takes its
  // first frame. Only the outline outside the recording region remains.
  recordingFrame(r.x, r.y, r.w, r.h);
  await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  try {
    await invoke("finish_capture", { rect: r });
  } catch (err) {
    starting = recordButton.disabled = false;
    document.body.classList.remove("live");
    frame.hidden = true;
    recordError.textContent = String(err);
    recordError.hidden = false;
    select(r);
    recordButton.focus();
  }
}

recordButton.addEventListener("click", startRecording);
document.getElementById("reselect")!.addEventListener("click", reset);
document.getElementById("cancel-record")!.addEventListener("click", () => invoke("cancel_capture"));

addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || starting || document.body.classList.contains("live")) return;
  const target = e.target as HTMLElement;
  if (target.closest("#record-controls")) return;
  if (selection) {
    if (!sel.contains(target)) return;
    adjustment = { rect: { ...selection }, mode: target.dataset.handle || "move", x: e.clientX, y: e.clientY };
    sel.setPointerCapture(e.pointerId);
    return;
  }
  hint.hidden = true;
  start = { x: e.clientX, y: e.clientY };
  last = { x: e.clientX, y: e.clientY };
  nudge.x = nudge.y = 0;
  repaint();
});

addEventListener("pointermove", (e) => {
  if (starting || document.body.classList.contains("live")) return;
  if (selection) {
    if (adjustment) select(adjustRect(adjustment.rect, adjustment.mode, e.clientX - adjustment.x, e.clientY - adjustment.y));
    return;
  }
  // Space held: the whole box rides along with the pointer, macOS-style,
  // instead of the corner stretching it.
  if (start && moving) {
    start.x += e.clientX - last.x;
    start.y += e.clientY - last.y;
  }
  last = { x: e.clientX, y: e.clientY };
  aim(e.clientX, e.clientY);
  if (start) repaint();
  else readout(`${Math.round(e.clientX)}, ${Math.round(e.clientY)}`, e.clientX, e.clientY);
});

addEventListener("pointerup", (e) => {
  if (adjustment) {
    select(adjustRect(adjustment.rect, adjustment.mode, e.clientX - adjustment.x, e.clientY - adjustment.y));
    adjustment = null;
    return;
  }
  if (!start) return;
  last = { x: e.clientX, y: e.clientY };
  const c = corner();
  const r = rectOf(start, c.x, c.y);
  start = null;
  if (isVideo()) {
    const x = clamp(r.x, 0, innerWidth), y = clamp(r.y, 0, innerHeight);
    const w = clamp(r.x + r.w, 0, innerWidth) - x, h = clamp(r.y + r.h, 0, innerHeight) - y;
    if (w >= 2 && h >= 2) {
      select({ x, y, w, h });
      sel.focus();
    } else reset();
    return;
  }
  // A stray click is someone dismissing the overlay, not a 1px screenshot.
  if (r.w < 2 || r.h < 2) invoke("cancel_capture");
  else invoke("finish_capture", { rect: r });
});

addEventListener("pointercancel", () => {
  if (adjustment) select(adjustment.rect);
  adjustment = null;
  if (start && isVideo()) reset();
});

addEventListener("keydown", (e) => {
  if (starting || document.body.classList.contains("live")) return;
  if (e.key === "Escape") {
    invoke("cancel_capture");
    return;
  }
  if (selection) {
    if (e.key === "Enter" && !(e.target as HTMLElement).closest("button")) {
      e.preventDefault();
      startRecording();
    }
    const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key in delta) {
      e.preventDefault();
      const [dx, dy] = delta[e.key];
      const mode = (e.target as HTMLElement).dataset.handle || (e.shiftKey ? "se" : "move");
      select(adjustRect(selection, mode, dx, dy));
    }
    return;
  }
  if (!start) return;
  // Mid-drag refinements: arrows place the corner a pixel at a time (Shift for
  // ten), Space picks the whole box up until it is released.
  const step = e.shiftKey ? 10 : 1;
  if (e.key === " ") moving = true;
  else if (e.key === "ArrowLeft") nudge.x -= step;
  else if (e.key === "ArrowRight") nudge.x += step;
  else if (e.key === "ArrowUp") nudge.y -= step;
  else if (e.key === "ArrowDown") nudge.y += step;
  else return;
  e.preventDefault();
  repaint();
});

addEventListener("keyup", (e) => {
  if (e.key === " ") moving = false;
});

// Right-click backs out, the way every other snipping tool on Windows does.
addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (starting || document.body.classList.contains("live")) return;
  invoke("cancel_capture");
});
