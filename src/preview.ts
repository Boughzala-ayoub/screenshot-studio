import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const shot = document.getElementById("shot") as HTMLImageElement;
const clip = document.getElementById("clip") as HTMLVideoElement;
const editBtn = document.getElementById("edit") as HTMLButtonElement;
const recbar = document.getElementById("recbar") as HTMLDivElement;
const clock = document.getElementById("clock") as HTMLSpanElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const dims = document.getElementById("dims") as HTMLSpanElement;
const count = document.getElementById("count") as HTMLSpanElement;
const older = document.getElementById("older") as HTMLButtonElement;
const newer = document.getElementById("newer") as HTMLButtonElement;
const newBtn = document.getElementById("new") as HTMLButtonElement;
const copyBtn = document.getElementById("copy") as HTMLButtonElement;
const pathBtn = document.getElementById("path") as HTMLButtonElement;
const openBtn = document.getElementById("open") as HTMLButtonElement;
const closeBtn = document.getElementById("close") as HTMLButtonElement;

// Newest first, so index 0 is the shot that was just taken and higher indices
// walk back through the kept history.
let shots: string[] = [];
let index = 0;
let url = ""; // the object URL on screen, revoked when the next one replaces it

const current = () => shots[index];
const isVideo = (p: string) => p.toLowerCase().endsWith(".mp4");
// Which pin this window is: Rust opens the video pin as preview.html?kind=video
// and answers recent_shots with recordings only for it.
const videoPin = new URLSearchParams(location.search).get("kind") === "video";
newBtn.title = videoPin ? "New recording (N)" : "New shot (N)";

// The dims slot doubles as the status line: flash a message, then put the
// dimensions back once the eye has had a moment to catch it.
let dimsText = "";
let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flashDims(msg: string) {
  clearTimeout(flashTimer);
  dims.textContent = msg;
  dims.classList.add("flash");
  flashTimer = setTimeout(() => {
    dims.classList.remove("flash");
    dims.textContent = dimsText;
  }, 1400);
}

async function show() {
  const video = isVideo(current());
  let w: number, h: number;
  if (video) {
    // Straight from disk over the asset protocol: a recording can be a few
    // hundred megabytes, and <video> wants to seek in it.
    clip.src = convertFileSrc(current());
    await new Promise<void>((ok, bad) => {
      clip.onloadedmetadata = () => ok();
      clip.onerror = () => bad(new Error("video failed to load"));
    });
    ({ videoWidth: w, videoHeight: h } = clip);
    if (url) URL.revokeObjectURL(url);
    url = "";
    shot.removeAttribute("src");
  } else {
    const bytes = await invoke<ArrayBuffer>("shot_png", { path: current() });
    const old = url;
    url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    shot.src = url;
    await shot.decode();
    // Revoked only after the replacement is painted, and never left behind:
    // each kept URL pins a decoded PNG in memory for the life of the pin.
    if (old) URL.revokeObjectURL(old);
    ({ naturalWidth: w, naturalHeight: h } = shot);
    clip.removeAttribute("src");
  }
  shot.hidden = video;
  clip.hidden = !video;
  // Annotation is for stills; a recording's copy is its path.
  editBtn.hidden = video;
  copyBtn.title = video ? "Copy the file path (C)" : "Copy image to clipboard (C)";

  dimsText = `${w} x ${h}`;
  dims.classList.remove("flash");
  dims.textContent = dimsText;
  count.textContent = `${index + 1}/${shots.length}`;
  older.disabled = index >= shots.length - 1;
  newer.disabled = index === 0;
  // Shots are not all the same shape, so the window follows the picture rather
  // than letterboxing whatever it started at.
  await invoke("fit_pin", { w, h });
}

async function step(by: number) {
  const next = index + by;
  if (next < 0 || next >= shots.length) return;
  index = next;
  await show();
}

// While a recording runs this same window is its stop bar: Rust sizes it,
// reloads it with #rec, and the page is a clock and a stop button.
const recording = location.hash === "#rec";

function stopRecording() {
  stopBtn.disabled = true;
  clock.textContent = "saving";
  invoke("stop_recording");
}

if (recording) {
  document.body.classList.add("rec");
  recbar.hidden = false;
  stopBtn.addEventListener("click", stopRecording);
  // The clock is the backend's, so a reload mid-recording stays honest.
  invoke<number>("recording_ms").then((ms) => {
    const t0 = performance.now() - ms;
    const tick = () => {
      const s = Math.floor((performance.now() - t0) / 1000);
      clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    setInterval(tick, 250);
  });
  document.body.classList.add("in");
  invoke("preview_ready");
} else {
  // Hidden until the crop is on screen, so the pin never flashes an empty
  // frame. The pin only ever loads right after a capture, and that capture is
  // already on the clipboard, so say so once the picture is up.
  invoke<string[]>("recent_shots")
    .then(async (list) => {
      shots = list;
      if (shots.length) {
        await show();
        flashDims(isVideo(current()) ? "saved" : "copied to clipboard");
      }
    })
    .finally(() => {
      document.body.classList.add("in"); // start the settle as the window shows
      invoke("preview_ready");
    });
}

// Drag whichever shot is on screen into any app. The payload carries the file
// and the path at once, so an image editor takes the picture and a terminal
// takes the path. Started from the first real movement rather than from the
// press itself, so a click on the pin stays a click.
let armed: { x: number; y: number } | null = null;

for (const media of [shot, clip] as HTMLElement[]) {
  media.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button === 0) armed = { x: e.clientX, y: e.clientY };
  });
}

// On window, not on the image. A quick flick puts the very first pointermove
// well outside the image, and a listener bound to the image would never see it,
// so the drag would only start for someone who dragged slowly.
addEventListener("pointermove", (e) => {
  if (!armed || !current()) return;
  if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) < 6) return;
  armed = null; // one drag per press
  invoke("drag_shot", { path: current() });
});

addEventListener("pointerup", () => (armed = null));

// Two right-clicks in quick succession dismiss the pin. A single one only
// swallows the webview's context menu, so a stray right-click costs nothing.
let lastRight = -Infinity; // 0 would pair with a right-click in the page's first 400ms
addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const now = performance.now();
  if (now - lastRight < 400) {
    if (recording) stopRecording();
    else invoke("close_preview");
  }
  lastRight = now;
});

older.addEventListener("click", () => step(1));
newer.addEventListener("click", () => step(-1));

// Scrolling on the pin walks the history, the same direction the arrows read.
addEventListener("wheel", (e) => step(e.deltaY > 0 ? 1 : -1));

function copyPath() {
  if (!current()) return;
  invoke("copy_path", { path: current() })
    .then(() => flashDims("path copied"))
    .catch(() => flashDims("copy failed"));
}

// A still goes on the clipboard as a picture. A recording cannot (there is
// no clipboard image of a video), so its copy is the path, which pastes into
// a file dialog or a terminal just as well.
function copyShot() {
  if (!current()) return;
  if (isVideo(current())) return copyPath();
  invoke("copy_shot", { path: current() })
    .then(() => flashDims("copied to clipboard"))
    .catch(() => flashDims("copy failed"));
}

copyBtn.addEventListener("click", copyShot);
pathBtn.addEventListener("click", copyPath);

function edit() {
  if (!current() || isVideo(current())) return;
  invoke("open_editor", { path: current() }).catch(() => flashDims("cannot edit"));
}
editBtn.addEventListener("click", edit);

// Retake without reaching for the hotkey. Rust hides the pin first so it stays
// out of the new frame, and puts it back if the capture is cancelled.
newBtn.addEventListener("click", () => invoke("new_capture"));

openBtn.addEventListener("click", () => invoke("open_folder"));

const more = document.querySelector<HTMLDetailsElement>(".more")!;
document.addEventListener("click", (e) => {
  if (!(e.target instanceof Node) || !more.contains(e.target) || (e.target as Element).closest("button")) more.open = false;
});

closeBtn.addEventListener("click", () => invoke("close_preview"));

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && more.open) {
    more.open = false;
    more.querySelector("summary")!.focus();
    return;
  }
  if (recording) {
    if (e.key === "Escape") stopRecording();
    return;
  }
  if (e.key === "Escape") invoke("close_preview");
  else if (e.key === "ArrowLeft") step(1);
  else if (e.key === "ArrowRight") step(-1);
  else if (e.key === "c" || e.key === "C") copyShot();
  else if (e.key === "n" || e.key === "N") invoke("new_capture");
  else if (e.key === "e" || e.key === "E") edit();
});
