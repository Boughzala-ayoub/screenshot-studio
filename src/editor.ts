import { invoke } from "@tauri-apps/api/core";

// The annotation editor. One canvas, the shot underneath, a list of shapes on
// top that is redrawn from scratch on every change: undo is a pop. Everything
// is kept in image pixels; the canvas is scaled to fit by CSS and pointer
// positions are mapped back through that scale.

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLElement;
const textbox = document.getElementById("textbox") as HTMLInputElement;
const status = document.getElementById("status") as HTMLSpanElement;
const dims = document.getElementById("dims") as HTMLSpanElement;
const undoBtn = document.getElementById("undo") as HTMLButtonElement;
const redoBtn = document.getElementById("redo") as HTMLButtonElement;
const ctx = canvas.getContext("2d")!;

type Kind = "rect" | "ellipse" | "arrow" | "pen" | "highlight" | "text" | "number" | "pixelate";
type Pt = { x: number; y: number };
type Shape = {
  kind: Kind;
  color: string;
  size: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  points?: Pt[];
  text?: string;
  n?: number;
};

const KEYS: Record<string, Kind> = {
  r: "rect",
  e: "ellipse",
  a: "arrow",
  p: "pen",
  h: "highlight",
  t: "text",
  n: "number",
  b: "pixelate",
};

let base: HTMLImageElement | null = null;
let shapes: Shape[] = [];
let redone: Shape[] = [];
let live: Shape | null = null;
let tool: Kind = "rect";
let color = "#e6a54c";
let size = 4;
// Where the text tool was clicked, image pixels, while the box is open.
let textAt: Pt | null = null;

const fontPx = (s: number) => 14 + s * 4; // 22 / 30 / 46 for the three sizes

// --- painting ---------------------------------------------------------------

function arrow(s: Shape) {
  const { x0, y0, x1, y1 } = s;
  const head = 10 + s.size * 3;
  const ang = Math.atan2(y1 - y0, x1 - x0);
  // The shaft stops short so the head's tip, not the shaft's end, is the point.
  const sx = x1 - Math.cos(ang) * head * 0.6;
  const sy = y1 - Math.sin(ang) * head * 0.6;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(sx, sy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(ang - 0.45) * head, y1 - Math.sin(ang - 0.45) * head);
  ctx.lineTo(x1 - Math.cos(ang + 0.45) * head, y1 - Math.sin(ang + 0.45) * head);
  ctx.closePath();
  ctx.fill();
}

function path(points: Pt[]) {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
}

function pixelate(s: Shape) {
  if (!base) return;
  const x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
  const w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0);
  if (w < 1 || h < 1) return;
  // Shrink the patch to one pixel per cell and blow it back up unsmoothed.
  const cell = 6 + s.size * 2;
  const tiny = document.createElement("canvas");
  tiny.width = Math.max(1, Math.ceil(w / cell));
  tiny.height = Math.max(1, Math.ceil(h / cell));
  tiny.getContext("2d")!.drawImage(base, x, y, w, h, 0, 0, tiny.width, tiny.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x, y, w, h);
  ctx.imageSmoothingEnabled = true;
}

function paint(s: Shape) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineWidth = s.size;
  ctx.lineCap = ctx.lineJoin = "round";
  const x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
  const w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0);
  switch (s.kind) {
    case "rect":
      ctx.strokeRect(x, y, w, h);
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "arrow":
      arrow(s);
      break;
    case "pen":
      path(s.points!);
      break;
    case "highlight":
      // A marker: wide, translucent, and it darkens rather than covers.
      ctx.globalAlpha = 0.45;
      ctx.globalCompositeOperation = "multiply";
      ctx.lineWidth = s.size * 5;
      ctx.lineCap = "butt";
      path(s.points!);
      break;
    case "text":
      ctx.font = `600 ${fontPx(s.size)}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
      ctx.shadowBlur = 4;
      ctx.fillText(s.text!, s.x0, s.y0);
      break;
    case "number": {
      const r = 11 + s.size * 1.5;
      ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.arc(s.x0, s.y0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = s.color === "#ffffff" ? "#141216" : "#ffffff";
      ctx.font = `700 ${Math.round(r * 1.15)}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(s.n), s.x0, s.y0 + 1);
      break;
    }
    case "pixelate":
      pixelate(s);
      break;
  }
  ctx.restore();
}

function draw() {
  if (!base) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(base, 0, 0);
  for (const s of shapes) paint(s);
  if (live) paint(live);
}

// --- history ----------------------------------------------------------------

function buttons() {
  undoBtn.disabled = !shapes.length;
  redoBtn.disabled = !redone.length;
}

function push(s: Shape) {
  shapes.push(s);
  redone = [];
  buttons();
  draw();
}

function undo() {
  const s = shapes.pop();
  if (s) redone.push(s);
  buttons();
  draw();
}

function redo() {
  const s = redone.pop();
  if (s) shapes.push(s);
  buttons();
  draw();
}

// --- pointer ----------------------------------------------------------------

// Client position to image pixels, through the CSS scale of the canvas.
function at(e: PointerEvent | MouseEvent): Pt {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * canvas.width) / r.width,
    y: ((e.clientY - r.top) * canvas.height) / r.height,
  };
}

const nextNumber = () => shapes.reduce((m, s) => Math.max(m, s.n ?? 0), 0) + 1;

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !base) return;
  if (!textbox.hidden) {
    commitText();
    return;
  }
  const p = at(e);
  if (tool === "text") {
    e.preventDefault(); // or the press's own focus change blurs the box at once
    openText(p, e);
    return;
  }
  if (tool === "number") {
    push({ kind: tool, color, size, x0: p.x, y0: p.y, x1: p.x, y1: p.y, n: nextNumber() });
    return;
  }
  live = { kind: tool, color, size, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  if (tool === "pen" || tool === "highlight") live.points = [p];
  canvas.setPointerCapture(e.pointerId);
  draw();
});

canvas.addEventListener("pointermove", (e) => {
  if (!live) return;
  const p = at(e);
  live.x1 = p.x;
  live.y1 = p.y;
  live.points?.push(p);
  draw();
});

canvas.addEventListener("pointerup", () => {
  if (!live) return;
  const s = live;
  live = null;
  // A click with no drag is a slip, not a shape.
  const moved = Math.abs(s.x1 - s.x0) > 2 || Math.abs(s.y1 - s.y0) > 2;
  if (moved || (s.points && s.points.length > 2)) push(s);
  else draw();
});

// --- text -------------------------------------------------------------------

function openText(p: Pt, e: MouseEvent) {
  textAt = p;
  const r = canvas.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const scale = r.width / canvas.width;
  textbox.hidden = false;
  textbox.value = "";
  textbox.style.left = `${e.clientX - sr.left}px`;
  textbox.style.maxWidth = `${Math.max(0, sr.right - e.clientX - 6)}px`;
  textbox.style.top = `${e.clientY - sr.top}px`;
  textbox.style.font = `600 ${fontPx(size) * scale}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
  textbox.style.color = color;
  textbox.focus();
}

function commitText() {
  const text = textbox.value.trim();
  textbox.hidden = true;
  if (text && textAt) push({ kind: "text", color, size, x0: textAt.x, y0: textAt.y, x1: textAt.x, y1: textAt.y, text });
  textAt = null;
}

textbox.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") commitText();
  else if (e.key === "Escape") {
    textbox.value = "";
    commitText();
  }
});
textbox.addEventListener("blur", commitText);

// --- toolbar ----------------------------------------------------------------

function pick<T extends string>(group: string, attr: string, value: T) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${group} button`)) {
    b.classList.toggle("on", b.dataset[attr] === value);
    b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
  }
}

function setTool(k: Kind) {
  tool = k;
  pick("tools", "tool", k);
  canvas.dataset.tool = k;
}
function setColor(c: string) {
  color = c;
  pick("colors", "color", c);
}
function setSize(s: number) {
  size = s;
  pick("sizes", "size", String(s));
}

document.getElementById("tools")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tool]");
  if (b) setTool(b.dataset.tool as Kind);
});
document.getElementById("colors")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-color]");
  if (b) setColor(b.dataset.color!);
});
document.getElementById("sizes")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-size]");
  if (b) setSize(Number(b.dataset.size));
});
undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

let statusTimer: ReturnType<typeof setTimeout> | undefined;
const hint = status.innerHTML;
function flash(msg: string) {
  clearTimeout(statusTimer);
  status.textContent = msg;
  status.classList.add("flash");
  statusTimer = setTimeout(() => {
    status.classList.remove("flash");
    status.innerHTML = hint;
  }, 1400);
}

async function png(): Promise<Uint8Array> {
  if (!textbox.hidden) commitText();
  const blob = await new Promise<Blob>((ok, bad) =>
    canvas.toBlob((b) => (b ? ok(b) : bad(new Error("encode failed"))), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

// The bytes go as the raw request body, straight into the Rust side.
async function save() {
  try {
    await invoke("save_edited", await png());
  } catch (err) {
    flash(String(err));
  }
}
async function copy() {
  try {
    await invoke("copy_edited", await png());
    flash("copied to clipboard");
  } catch (err) {
    flash(String(err));
  }
}
const cancel = () => invoke("close_editor");

document.getElementById("save")!.addEventListener("click", save);
document.getElementById("copy")!.addEventListener("click", copy);
document.getElementById("cancel")!.addEventListener("click", cancel);

addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === "z" && e.shiftKey) redo();
    else if (k === "z") undo();
    else if (k === "y") redo();
    else if (k === "s") save();
    else if (k === "c") copy();
    else return;
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") cancel();
  else if (e.key === "Enter") save();
  else if (k in KEYS) setTool(KEYS[k]);
  else if (k === "1") setSize(2);
  else if (k === "2") setSize(4);
  else if (k === "3") setSize(8);
});

// --- load -------------------------------------------------------------------

// The window stands hidden from startup and reloads for each shot. With no
// target (the warm-up load) there is nothing to show and nothing is shown.
async function load() {
  setTool("rect");
  setColor(color);
  setSize(size);
  buttons();
  const path = await invoke<string | null>("edit_target");
  if (!path) return;
  const bytes = await invoke<ArrayBuffer>("shot_png", { path });
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  await img.decode();
  base = img;
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  dims.textContent = `${canvas.width} x ${canvas.height}`;
  draw();
  document.body.classList.add("in");
  invoke("editor_ready");
}
load();
