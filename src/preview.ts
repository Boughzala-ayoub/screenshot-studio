import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const shot = document.getElementById("shot") as HTMLImageElement;
const clip = document.getElementById("clip") as HTMLVideoElement;
const editBtn = document.getElementById("edit") as HTMLButtonElement;
const recbar = document.getElementById("recbar") as HTMLDivElement;
const clock = document.getElementById("clock") as HTMLSpanElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
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
// The shot on screen. Every action works on this one, so it only moves once
// the next picture is actually up; until then the arrows' target is `want`.
let index = 0;
let want = 0;
let loads = 0; // bumped per show(), so a load that finishes after a newer one is dropped
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

async function show(i: number) {
  const load = ++loads;
  const path = shots[i];
  const video = isVideo(path);
  let w: number, h: number;
  if (video) {
    // Straight from disk over the asset protocol: a recording can be a few
    // hundred megabytes, and <video> wants to seek in it. Probed off screen
    // first, like a still: <video> drops its old clip the moment its src
    // changes, so the pin's own element only switches to a clip that loads.
    const src = convertFileSrc(path);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    const ok = await new Promise<boolean>((done) => {
      probe.onloadedmetadata = () => done(true);
      probe.onerror = () => done(false);
      probe.src = src;
    });
    ({ videoWidth: w, videoHeight: h } = probe);
    probe.removeAttribute("src");
    probe.load(); // lets go of the file
    if (load !== loads) return;
    if (!ok) throw new Error("video failed to load");
    clip.src = src;
    index = i;
    if (url) URL.revokeObjectURL(url);
    url = "";
    shot.removeAttribute("src");
  } else {
    const bytes = await invoke<ArrayBuffer>("shot_png", { path });
    const next = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    // Decoded off screen, so the old picture and its actions stay put until
    // the new one can replace both at once.
    const img = new Image();
    img.src = next;
    const painted = await img.decode().then(() => load === loads, () => false);
    if (!painted) {
      URL.revokeObjectURL(next);
      if (load === loads) throw new Error("image failed to decode");
      return;
    }
    const old = url;
    url = next;
    shot.src = next;
    index = i;
    // Revoked only after the replacement is painted, and never left behind:
    // each kept URL pins a decoded PNG in memory for the life of the pin.
    if (old) URL.revokeObjectURL(old);
    ({ naturalWidth: w, naturalHeight: h } = img);
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
  count.textContent = `${index + 1} of ${shots.length}`;
  older.disabled = index >= shots.length - 1;
  newer.disabled = index === 0;
  // Shots are not all the same shape, so the window follows the picture rather
  // than letterboxing whatever it started at.
  await invoke("fit_pin", { w, h });
}

async function step(by: number) {
  const next = want + by;
  if (next < 0 || next >= shots.length) return;
  want = next;
  const shown = show(next);
  const load = loads; // show() numbered itself before its first await
  await shown.catch(() => {
    // The shot stays where it was, so the arrows go back there and the same
    // press retries. Only if this was the latest move: an older failure must
    // not pull them back from a newer one that worked.
    if (load !== loads) return;
    want = index;
    flashDims("could not load that shot");
  });
}

// While a recording runs this same window is its stop bar: Rust sizes it,
// reloads it with #rec, and the page is a clock and a stop button.
const recording = location.hash === "#rec";

function stopRecording() {
  stopBtn.disabled = true;
  clock.textContent = "saving";
  invoke("stop_recording");
}

let paused = false;
function togglePause() {
  invoke<boolean>("pause_recording", { on: !paused }).then((on) => {
    paused = on;
    document.body.classList.toggle("paused", on);
    pauseBtn.title = on ? "Resume (Space)" : "Pause (Space)";
    syncClock();
  });
}

// The clock is the backend's, so a reload mid-recording stays honest, and it
// is re-read after every pause so the frozen time and the resumed time agree.
let t0 = 0;
function syncClock() {
  invoke<number>("recording_ms").then((ms) => {
    t0 = performance.now() - ms;
    tickClock();
  });
}
function tickClock() {
  if (paused) return;
  const s = Math.floor((performance.now() - t0) / 1000);
  clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

if (recording) {
  document.body.classList.add("rec");
  recbar.hidden = false;
  stopBtn.addEventListener("click", stopRecording);
  pauseBtn.addEventListener("click", togglePause);
  syncClock();
  setInterval(tickClock, 250);
  document.body.classList.add("in");
  invoke("preview_ready");
} else {
  // A still's clipboard copy runs in the background and can take seconds, or
  // fail, so the pin says Copied only once Rust says so. Rust also calls this
  // when the copy finishes, in case that is after the pin loaded.
  const autoCopied = async () => {
    const path = current();
    if (!url) return; // no still painted yet; the load asks for itself
    const ok = await invoke<boolean | null>("auto_copied", { path });
    if (ok !== null && path === current()) flashDims(ok ? "Copied" : "not copied, press C");
  };
  Object.assign(window, { autoCopied });
  // Hidden until the crop is on screen, so the pin never flashes an empty
  // frame. The pin only ever loads right after a capture or an edit.
  invoke<string[]>("recent_shots")
    .then(async (list) => {
      shots = list;
      if (shots.length) {
        await show(0);
        flashDims("Saved");
        autoCopied();
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
  // False means a newer copy took this one's place and reports for itself.
  invoke<boolean>("copy_path", { path: current() })
    .then((wrote) => wrote && flashDims("path copied"))
    .catch(() => flashDims("copy failed"));
}

// A still goes on the clipboard as a picture. A recording cannot (there is
// no clipboard image of a video), so its copy is the path, which pastes into
// a file dialog or a terminal just as well.
function copyShot() {
  if (!current()) return;
  if (isVideo(current())) return copyPath();
  invoke<boolean>("copy_shot", { path: current() })
    .then((wrote) => wrote && flashDims("copied to clipboard"))
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
    else if (e.key === " ") togglePause();
    return;
  }
  if (e.key === "Escape") invoke("close_preview");
  else if (e.key === "ArrowLeft") step(1);
  else if (e.key === "ArrowRight") step(-1);
  else if (e.key === "c" || e.key === "C") copyShot();
  else if (e.key === "n" || e.key === "N") invoke("new_capture");
  else if (e.key === "e" || e.key === "E") edit();
});
