import { invoke } from "@tauri-apps/api/core";

const shot = document.getElementById("shot") as HTMLImageElement;
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
  const bytes = await invoke<ArrayBuffer>("shot_png", { path: current() });
  const old = url;
  url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  shot.src = url;
  await shot.decode();
  // Revoked only after the replacement is painted, and never left behind:
  // each kept URL pins a decoded PNG in memory for the life of the pin.
  if (old) URL.revokeObjectURL(old);

  dimsText = `${shot.naturalWidth} x ${shot.naturalHeight}`;
  dims.classList.remove("flash");
  dims.textContent = dimsText;
  count.textContent = `${index + 1}/${shots.length}`;
  older.disabled = index >= shots.length - 1;
  newer.disabled = index === 0;
  // Shots are not all the same shape, so the window follows the picture rather
  // than letterboxing whatever it started at.
  await invoke("fit_pin", { w: shot.naturalWidth, h: shot.naturalHeight });
}

async function step(by: number) {
  const next = index + by;
  if (next < 0 || next >= shots.length) return;
  index = next;
  await show();
}

// Hidden until the crop is on screen, so the pin never flashes an empty frame.
// The pin only ever loads right after a capture, and that capture is already
// on the clipboard, so say so once the picture is up.
invoke<string[]>("recent_shots")
  .then(async (list) => {
    shots = list;
    if (shots.length) {
      await show();
      flashDims("copied to clipboard");
    }
  })
  .finally(() => {
    document.body.classList.add("in"); // start the settle as the window shows
    invoke("preview_ready");
  });

// Drag whichever shot is on screen into any app. The payload carries the file
// and the path at once, so an image editor takes the picture and a terminal
// takes the path. Started from the first real movement rather than from the
// press itself, so a click on the pin stays a click.
let armed: { x: number; y: number } | null = null;

shot.addEventListener("pointerdown", (e) => {
  if (e.button === 0) armed = { x: e.clientX, y: e.clientY };
});

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

older.addEventListener("click", () => step(1));
newer.addEventListener("click", () => step(-1));

// Scrolling on the pin walks the history, the same direction the arrows read.
addEventListener("wheel", (e) => step(e.deltaY > 0 ? 1 : -1));

function copyShot() {
  if (!current()) return;
  invoke("copy_shot", { path: current() })
    .then(() => flashDims("copied to clipboard"))
    .catch(() => flashDims("copy failed"));
}

copyBtn.addEventListener("click", copyShot);

pathBtn.addEventListener("click", () => {
  if (!current()) return;
  invoke("copy_path", { path: current() })
    .then(() => flashDims("path copied"))
    .catch(() => flashDims("copy failed"));
});

// Retake without reaching for the hotkey. Rust hides the pin first so it stays
// out of the new frame, and puts it back if the capture is cancelled.
newBtn.addEventListener("click", () => invoke("new_capture"));

openBtn.addEventListener("click", () => invoke("open_folder"));

closeBtn.addEventListener("click", () => invoke("close_preview"));

addEventListener("keydown", (e) => {
  if (e.key === "Escape") invoke("close_preview");
  else if (e.key === "ArrowLeft") step(1);
  else if (e.key === "ArrowRight") step(-1);
  else if (e.key === "c" || e.key === "C") copyShot();
  else if (e.key === "n" || e.key === "N") invoke("new_capture");
});
