// Drives the built overlay in headless Chrome over raw CDP. No test framework and
// no puppeteer: Node's global WebSocket and fetch are enough, and the point is to
// exercise the served bundle, not the source.
//
//   npm run verify:overlay
//
// Fails loudly on: a drag that reports the wrong rect, a click that reports a
// capture instead of a cancel, or a horizontal scrollbar at any width. That last
// one matters more than it looks: a scrollbar offsets every clientX the overlay
// reads, so the crop would silently land on the wrong pixels.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ORIGIN = "http://localhost:4173";
const URL_ = `${ORIGIN}/overlay.html`;
const CDP_PORT = 9333;
const WIDTHS = [320, 375, 768, 1024, 1280, 1920];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
let profile;

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exitCode = 1;
}
function pass(msg) {
  console.log(`ok    ${msg}`);
}

async function waitFor(label, fn, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.once = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method && this.once.has(m.method)) {
        this.once.get(m.method)();
        this.once.delete(m.method);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  event(method) {
    return new Promise((r) => this.once.set(method, r));
  }
}

// Everything the overlay touches of the Tauri bridge, recorded instead of sent.
const STUB = `window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    (window.__calls ||= []).push({ cmd, args });
    if (cmd === "get_settings")
      return Promise.resolve({ hotkey: "Ctrl+Shift+4", autostart: true });
    if (cmd === "recent_shots") return Promise.resolve(["a.png"]);
    // Like the real backend: one generation per "press", then park for ever.
    // Resolving every call spins the overlay's capture loop, and its reset()
    // lands mid-drag and nulls the selection under the test's cursor.
    if (cmd === "await_frame") {
      window.__gen = (window.__gen || 0) + 1;
      return window.__gen > 1 ? new Promise(() => {}) : Promise.resolve(1);
    }
    if (cmd !== "frozen_frame" && cmd !== "shot_png")
      return Promise.resolve(new ArrayBuffer(0));
    // The real backend hands over a BMP these days, but a PNG stand-in still
    // decodes fine: <img> sniffs the bytes, not the blob's declared type.
    // A stand-in desktop, so SHOT screenshots show the dimming against real
    // pixels. It is position:fixed and never affects layout either way.
    const c = new OffscreenCanvas(1920, 1080);
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 1920, 1080);
    grad.addColorStop(0, "#1e3a8a");
    grad.addColorStop(1, "#0b1020");
    g.fillStyle = grad;
    g.fillRect(0, 0, 1920, 1080);
    g.fillStyle = "rgba(255,255,255,0.72)";
    g.font = "500 40px system-ui, sans-serif";
    for (let y = 90; y < 1080; y += 130) g.fillText("stand-in desktop  y=" + y, 70, y);
    return c.convertToBlob({ type: "image/png" }).then((b) => b.arrayBuffer());
  },
};`;

async function main() {
  kids.push(
    spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], {
      stdio: "ignore",
      shell: true,
    }),
  );
  const status = await waitFor("vite preview", async () => (await fetch(URL_)).status);
  if (status !== 200) throw new Error(`${URL_} served ${status}`);
  pass(`${URL_} serves 200`);

  profile = mkdtempSync(join(tmpdir(), "ss-verify-"));
  kids.push(
    spawn(CHROME, [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1920,1080",
      "about:blank",
    ]),
  );
  const version = await waitFor("chrome", async () =>
    (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(),
  );

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const cdp = new Cdp(ws);

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);

  await s("Page.enable");
  await s("Runtime.enable");
  await s("Page.addScriptToEvaluateOnNewDocument", { source: STUB });

  // --- the drag ---------------------------------------------------------
  await s("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const loaded = cdp.event("Page.loadEventFired");
  await s("Page.navigate", { url: URL_ });
  await loaded;

  const drag = async (path) => {
    const [a, ...rest] = path;
    await s("Input.dispatchMouseEvent", {
      type: "mousePressed", x: a[0], y: a[1], button: "left", buttons: 1, clickCount: 1,
    });
    for (const p of rest) {
      await s("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: p[0], y: p[1], button: "left", buttons: 1,
      });
    }
    const z = rest.at(-1) ?? a;
    await s("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: z[0], y: z[1], button: "left", buttons: 0, clickCount: 1,
    });
  };

  const read = async (expr) => {
    const { result } = await s("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.value;
  };

  // The page resets its drag state when the first frame finishes painting, so a
  // drag started before overlay_ready races that reset and loses. The real
  // window is only shown after overlay_ready for exactly this reason.
  const overlayReady = () =>
    waitFor("overlay_ready", () =>
      read("(window.__calls||[]).some(c => c.cmd === 'overlay_ready')"));

  await overlayReady();
  await drag([[100, 100], [300, 250], [500, 400]]);
  await sleep(50);

  const calls = await read("JSON.stringify(window.__calls || [])").then(JSON.parse);
  const finish = calls.find((c) => c.cmd === "finish_capture");
  const want = { x: 100, y: 100, w: 400, h: 300 };
  if (!finish) fail(`no finish_capture; got ${JSON.stringify(calls.map((c) => c.cmd))}`);
  else if (JSON.stringify(finish.args.rect) !== JSON.stringify(want))
    fail(`rect ${JSON.stringify(finish.args.rect)}, want ${JSON.stringify(want)}`);
  else pass(`drag (100,100)->(500,400) reports ${JSON.stringify(want)}`);

  // The painted selection has to agree with the rect that was sent, or the user
  // is framing one region and getting another.
  const box = await read(
    "JSON.stringify((({left,top,width,height}) => ({x:left,y:top,w:width,h:height}))" +
      "(document.getElementById('sel').getBoundingClientRect()))",
  ).then(JSON.parse);
  if (JSON.stringify(box) !== JSON.stringify(want))
    fail(`painted box ${JSON.stringify(box)}, want ${JSON.stringify(want)}`);
  else pass("painted selection matches the reported rect");

  const hud = await read("document.getElementById('hud').textContent");
  if (hud !== "400 x 300") fail(`hud reads ${JSON.stringify(hud)}, want "400 x 300"`);
  else pass('hud reads "400 x 300"');

  // SHOT=path.png to eyeball it. No-overflow is not the same as looks right.
  if (process.env.SHOT) {
    const { data } = await s("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.SHOT, Buffer.from(data, "base64"));
    pass(`screenshot written to ${process.env.SHOT}`);
  }

  // --- a click is a dismissal, not a 0x0 capture ------------------------
  const loaded2 = cdp.event("Page.loadEventFired");
  await s("Page.navigate", { url: URL_ });
  await loaded2;
  await overlayReady();
  await drag([[640, 400]]);
  await sleep(50);
  const cmds = await read("JSON.stringify((window.__calls||[]).map(c=>c.cmd))").then(JSON.parse);
  if (cmds.includes("finish_capture")) fail(`a bare click sent ${JSON.stringify(cmds)}`);
  else if (!cmds.includes("cancel_capture")) fail(`a bare click sent ${JSON.stringify(cmds)}`);
  else pass("a bare click cancels instead of capturing");

  // --- no horizontal overflow at any width ------------------------------
  for (const width of WIDTHS) {
    await s("Emulation.setDeviceMetricsOverride", {
      width,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const loadedN = cdp.event("Page.loadEventFired");
    await s("Page.navigate", { url: URL_ });
    await loadedN;
    await overlayReady();
    await drag([[10, 10], [width - 4, 600]]); // hug the right edge, worst case for the hud
    await sleep(30);
    const over = await read(
      "JSON.stringify([document.documentElement.scrollWidth, document.documentElement.clientWidth," +
        "document.body.scrollWidth, document.body.clientWidth])",
    ).then(JSON.parse);
    const [dsw, dcw, bsw, bcw] = over;
    if (dsw > dcw || bsw > bcw) fail(`${width}px overflows: doc ${dsw}/${dcw}, body ${bsw}/${bcw}`);
    else pass(`${width}px: no horizontal overflow`);
  }

  // --- the fixed-size windows hold their layout too ---------------------
  // The settings window is 400 logical px, the pin bottoms out at 240. Checked
  // at those widths and one narrower, because a crushed row overflows silently.
  for (const [page, width, height] of [
    ["settings.html", 400, 330],
    ["settings.html", 320, 330],
    ["preview.html", 240, 100],
    ["preview.html", 420, 320],
  ]) {
    await s("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    const loadedP = cdp.event("Page.loadEventFired");
    await s("Page.navigate", { url: `${ORIGIN}/${page}` });
    await loadedP;
    await sleep(60);
    const [dsw, dcw, bsw, bcw] = await read(
      "JSON.stringify([document.documentElement.scrollWidth, document.documentElement.clientWidth," +
        "document.body.scrollWidth, document.body.clientWidth])",
    ).then(JSON.parse);
    if (dsw > dcw || bsw > bcw)
      fail(`${page} at ${width}px overflows: doc ${dsw}/${dcw}, body ${bsw}/${bcw}`);
    else pass(`${page} at ${width}px: no horizontal overflow`);
  }

  // --- on the pin, a double right-click closes and a drag drags out -----
  // A left click stays inert, a drag past the 6px threshold hands the file
  // to drag_shot, and two right-clicks inside 400ms dismiss the pin.
  const pinShown = async () => {
    await waitFor("pin image", () =>
      read("(window.__calls||[]).some(c => c.cmd === 'fit_pin')"));
  };
  const rightClick = async (x, y) => {
    await s("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1,
    });
    await s("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1,
    });
  };
  await s("Emulation.setDeviceMetricsOverride", {
    width: 420, height: 320, deviceScaleFactor: 1, mobile: false,
  });
  const loadedClick = cdp.event("Page.loadEventFired");
  await s("Page.navigate", { url: `${ORIGIN}/preview.html` });
  await loadedClick;
  await pinShown();
  await drag([[210, 180]]);
  await rightClick(210, 180);
  await sleep(50);
  let pinCmds = await read("JSON.stringify((window.__calls||[]).map(c=>c.cmd))").then(JSON.parse);
  if (pinCmds.includes("close_preview") || pinCmds.includes("drag_shot"))
    fail(`a left or single right click on the pin sent ${JSON.stringify(pinCmds)}`);
  else pass("a single click on the pin, either button, stays inert");
  // A fresh back-to-back pair, so the check never depends on how long the
  // reads above took relative to the 400ms double-click window.
  await rightClick(210, 180);
  await rightClick(210, 180);
  await sleep(50);
  pinCmds = await read("JSON.stringify((window.__calls||[]).map(c=>c.cmd))").then(JSON.parse);
  if (!pinCmds.includes("close_preview"))
    fail(`a double right-click on the pin sent ${JSON.stringify(pinCmds)}`);
  else pass("a double right-click on the pin closes it");

  const loadedDrag = cdp.event("Page.loadEventFired");
  await s("Page.navigate", { url: `${ORIGIN}/preview.html` });
  await loadedDrag;
  await pinShown();
  await drag([[100, 150], [160, 200], [220, 250]]);
  await sleep(50);
  pinCmds = await read("JSON.stringify((window.__calls||[]).map(c=>c.cmd))").then(JSON.parse);
  if (!pinCmds.includes("drag_shot") || pinCmds.includes("close_preview"))
    fail(`a drag on the pin sent ${JSON.stringify(pinCmds)}`);
  else pass("a drag on the pin drags the file out, not a close");

  ws.close();
}

try {
  await main();
} catch (e) {
  fail(e.message);
} finally {
  for (const k of kids) k.kill();
  if (profile) {
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* chrome still letting go */
    }
  }
  console.log(process.exitCode ? "\nverify-overlay: FAILED" : "\nverify-overlay: all checks passed");
  process.exit(process.exitCode ?? 0);
}
