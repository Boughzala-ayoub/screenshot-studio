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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
// PORT=... when something else already sits on 4173.
const PORT = process.env.PORT || "4173";
const ORIGIN = `http://localhost:${PORT}`;
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
      if (m.method === "Runtime.exceptionThrown") {
        const text = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text;
        // The video pin's stub recording; see the kind=video wait below.
        if (!text.includes("video failed to load")) fail(text);
      }
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
  convertFileSrc() { return window.__videoUrl; },
  invoke(cmd, args) {
    (window.__calls ||= []).push({ cmd, args });
    if (cmd === "finish_capture") {
      window.__setupHiddenAtStart = document.getElementById('record-controls').hidden &&
        getComputedStyle(document.getElementById('frozen')).display === 'none';
      if (window.__failRecord) return Promise.reject(new Error('Recorder unavailable'));
    }
    if (cmd === "get_settings")
      return Promise.resolve({ hotkey: "Ctrl+Shift+4", record_hotkey: "Ctrl+Shift+5", autostart: true });
    if (cmd === "recent_shots") {
      if (!location.search.includes("video")) return Promise.resolve(["a.png"]);
      return new Promise((resolve) => {
        const canvas = document.createElement("canvas");
        canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#253455"; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#eef0f6"; ctx.font = "24px sans-serif";
        ctx.fillText("Recording preview", 40, 80);
        const stream = canvas.captureStream(0);
        const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
        recorder.ondataavailable = (e) => {
          window.__videoUrl = URL.createObjectURL(e.data);
          stream.getTracks().forEach((t) => t.stop());
          resolve(["recording.mp4"]);
        };
        recorder.start();
        stream.getVideoTracks()[0].requestFrame();
        setTimeout(() => recorder.stop(), 250);
      });
    }
    if (cmd === "edit_target") return Promise.resolve("a.png");
    if (cmd === "recording_ms") return Promise.resolve(65000);
    if (cmd === "pause_recording") return Promise.resolve(args.on);
    // Like the real backend: one generation per "press", then park for ever.
    // Resolving every call spins the overlay's capture loop, and its reset()
    // lands mid-drag and nulls the selection under the test's cursor.
    // ?video on the URL arms a recording instead of a still.
    if (cmd === "await_frame") {
      window.__gen = (window.__gen || 0) + 1;
      const info = { gen: 1, video: location.search.includes("video") };
      return window.__gen > 1 ? new Promise(() => {}) : Promise.resolve(info);
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
  if (process.env.SHOT_DIR) mkdirSync(process.env.SHOT_DIR, { recursive: true });
  kids.push(
    spawn("npx", ["vite", "preview", "--port", PORT, "--strictPort"], {
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
  if (!await read("window.__calls.some(c => c.cmd === 'frozen_frame') && document.getElementById('frozen').naturalWidth > 0"))
    fail("screenshot selection must still load the frozen desktop");
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

  // --- record mode: badge, then the frame around the region ---------------
  // Selecting only prepares a region. Moving and resizing remain local until
  // Record is explicitly pressed, and setup UI leaves before capture starts.
  const loadedV = cdp.event("Page.loadEventFired");
  await s("Emulation.setDeviceMetricsOverride", {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  await s("Page.navigate", { url: `${URL_}?video` });
  await loadedV;
  await overlayReady();
  const badge = await read("document.body.classList.contains('video') && getComputedStyle(document.querySelector('#mode .rec')).display !== 'none'");
  if (!badge) fail("record mode does not show the Record badge");
  else pass("record mode shows the Record badge");
  const liveSetup = () => read("getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(document.getElementById('frozen')).display === 'none' && !window.__calls.some(c => c.cmd === 'frozen_frame')");
  if (!await liveSetup()) fail("recording setup must show the live desktop without requesting a snapshot");
  else pass("recording setup shows the live desktop without requesting a snapshot");
  await drag([[100, 100], [500, 400]]);
  await sleep(50);
  if (!await liveSetup() || !await read("document.getElementById('loupe').hidden"))
    fail("prepared video region must stay live without a frozen magnifier");
  if (!await read("!window.__calls.some(c => c.cmd === 'finish_capture') && !document.getElementById('record-controls').hidden"))
    fail("selecting a video region must wait for Record");
  else pass("selecting a video region does not start recording");
  await drag([[200, 200], [240, 230]]);
  const handle = await read("document.querySelector('[data-handle=se]').getBoundingClientRect().toJSON()");
  await drag([[handle.x + handle.width / 2, handle.y + handle.height / 2], [handle.x + handle.width / 2 + 40, handle.y + handle.height / 2 + 40]]);
  await read("document.getElementById('sel').focus()");
  await s("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight" });
  await s("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", modifiers: 8 });
  const adjusted = await read("(({x,y,width,height}) => [x,y,width,height])(document.getElementById('sel').getBoundingClientRect())");
  if (JSON.stringify(adjusted) !== JSON.stringify([141, 130, 440, 341]))
    fail(`moving/resizing the prepared region gave ${JSON.stringify(adjusted)}`);
  else pass("prepared region supports dragging, resize handles, and keyboard adjustment");
  if (await read("window.__calls.some(c => c.cmd === 'finish_capture')")) fail("adjusting a region started recording");
  await read("document.getElementById('start-record').click(); document.getElementById('start-record').click()");
  await waitFor("explicit record start", () => read("window.__calls.some(c => c.cmd === 'finish_capture')"));
  const vcalls = await read("window.__calls.filter(c => c.cmd === 'finish_capture')");
  if (vcalls.length !== 1 || JSON.stringify(vcalls[0].args.rect) !== JSON.stringify({ x: 141, y: 130, w: 440, h: 341 }))
    fail(`Record must start once with the adjusted region: ${JSON.stringify(vcalls)}`);
  else pass("Record starts once with the adjusted region");
  if (!await read("window.__setupHiddenAtStart")) fail("setup controls and frozen image must disappear before recording starts");
  await read("recFrame(100, 100, 400, 300); true");
  const frame = await read(
    "JSON.stringify([document.body.classList.contains('live'), getComputedStyle(document.body).backgroundColor," +
      "(({left,top,width,height}) => [left,top,width,height])(document.getElementById('frame').getBoundingClientRect())," +
      "getComputedStyle(document.getElementById('frozen')).display, document.documentElement.scrollWidth <= document.documentElement.clientWidth])",
  ).then(JSON.parse);
  const [liveOn, bg, fbox, frozenDisplay, noScroll] = frame;
  if (!liveOn || bg !== "rgba(0, 0, 0, 0)" || frozenDisplay !== "none")
    fail(`live frame: body live=${liveOn}, background ${bg}, frozen ${frozenDisplay}`);
  else if (JSON.stringify(fbox) !== JSON.stringify([100, 100, 400, 300]))
    fail(`live frame box ${JSON.stringify(fbox)}, want [100,100,400,300]`);
  else if (!noScroll) fail("live frame overflows horizontally");
  else pass("recFrame() turns the page into a see-through frame on the region");
  await read("recDone(); true");
  const back = await read("!document.body.classList.contains('live') && document.getElementById('frame').hidden");
  if (!back) fail("recDone() did not restore the overlay");
  else pass("recDone() restores the overlay");
  await drag([[100, 100], [500, 400]]);
  await read("document.getElementById('reselect').click()");
  if (!await read("document.getElementById('sel').hidden && document.getElementById('record-controls').hidden")) fail("Reselect must clear the prepared region");
  await drag([[500, 400], [100, 100]]);
  await drag([[110, 110], [0, 0]]); // Top-left handle clamps to the viewport.
  await drag([[250, 200], [1900, 1000]]); // Moving cannot carry the box off-screen.
  const bounded = await read("(({x,y,width,height}) => [x,y,width,height])(document.getElementById('sel').getBoundingClientRect())");
  if (JSON.stringify(bounded) !== JSON.stringify([1420, 680, 500, 400])) fail(`prepared region escaped viewport: ${JSON.stringify(bounded)}`);
  else pass("reverse selection, resizing, and moving stay within the viewport");
  await read("window.__failRecord = true; document.getElementById('start-record').click()");
  await waitFor("record error", () => read("!document.getElementById('record-error').hidden"));
  if (!await read("!document.getElementById('record-controls').hidden && !document.getElementById('start-record').disabled && !document.body.classList.contains('live')"))
    fail("a failed start must restore the adjustable region and controls");
  else pass("a failed start restores the adjustable region with an error");
  await read("document.getElementById('cancel-record').click()");
  if (!await read("window.__calls.some(c => c.cmd === 'cancel_capture')")) fail("Cancel must dismiss recording setup");
  else pass("recording setup can be reselected or cancelled");

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
  // The settings window is 400 logical px, the pin bottoms out at 272. Checked
  // at those widths and one narrower, because a crushed row overflows silently.
  for (const [page, width, height] of [
    ["settings.html", 400, 440],
    ["settings.html", 320, 440],
    ["preview.html", 272, 100],
    ["preview.html", 420, 320],
    // ?rec so it is a real navigation, not a hash change that fires no load event.
    ["preview.html?rec#rec", 196, 36],
    ["preview.html?kind=video", 272, 100],
    ["editor.html", 640, 420],
    ["editor.html", 900, 620],
    ["editor.html", 1280, 800],
    ...WIDTHS.filter((w) => w <= 1280).flatMap((width) =>
      ["settings.html", "preview.html", "preview.html?kind=video", "preview.html?rec#rec", "editor.html", "overlay.html", "overlay.html?video"]
        .map((page) => [page, width, 700])),
    ["editor.html", 681, 700],
    ["editor.html", 381, 700],
    ["overlay.html", 681, 700],
    ["overlay.html?video", 681, 700],
  ]) {
    await s("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    const loadedP = cdp.event("Page.loadEventFired");
    await s("Page.navigate", { url: `${ORIGIN}/${page}` });
    await loadedP;
    if (page.startsWith("overlay")) await overlayReady();
    else if (page.startsWith("editor")) await waitFor("editor ready", () => read("document.body.classList.contains('in')"));
    else if (page.includes("kind=video")) {
      // Headless Chrome cannot always encode the stub's canvas recording (an
      // empty webm, DEMUXER_ERROR). The layout audit still runs on the pin's
      // chrome; only the decoded picture is missing, and that is said out loud.
      await waitFor("video pin ready", () => read("document.body.classList.contains('in')"));
      if (!(await read("!document.getElementById('clip').hidden && document.getElementById('clip').videoWidth > 0")))
        console.log(`skip  ${page} at ${width}px: stub recording did not decode here, auditing chrome only`);
    }
    else if (page.startsWith("settings")) await waitFor("shortcuts ready", () => read("!!document.querySelector('#recorder kbd')"));
    else await waitFor("preview ready", () => read("document.body.classList.contains('in')"));
    await sleep(200);
    const [dsw, dcw, bsw, bcw] = await read(
      "JSON.stringify([document.documentElement.scrollWidth, document.documentElement.clientWidth," +
        "document.body.scrollWidth, document.body.clientWidth])",
    ).then(JSON.parse);
    if (dsw > dcw || bsw > bcw)
      fail(`${page} at ${width}px overflows: doc ${dsw}/${dcw}, body ${bsw}/${bcw}`);
    else pass(`${page} at ${width}px: no horizontal overflow`);
    // SHOT_DIR=dir to eyeball each of them, once the page has faded in.
    if (process.env.SHOT_DIR) {
      await sleep(400);
      const { data } = await s("Page.captureScreenshot", { format: "png" });
      const name = `${page.replace(/[^a-z]+/g, "-")}${width}.png`;
      writeFileSync(join(process.env.SHOT_DIR, name), Buffer.from(data, "base64"));
    }

    const auditState = async (state) => {
      const issues = await read(`(() => {
        const root = document.documentElement;
        const issues = root.scrollWidth > root.clientWidth ? ['document overflow'] : [];
        for (const el of document.querySelectorAll('button, summary, .recorder, #textbox, #hint')) {
          if (!el.checkVisibility()) continue;
          const r = el.getBoundingClientRect();
          if (r.left < 0 || r.right > innerWidth + 1 || r.width < 1) issues.push(el.id || el.tagName);
          if (el.matches('.handle') && !el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)))
            issues.push(el.dataset.handle + ' resize handle is covered');
          if (!location.pathname.includes('settings') && r.bottom > innerHeight + 1) issues.push((el.id || el.tagName) + ' below viewport');
        }
        return issues;
      })()`);
      if (issues.length) fail(`${page} ${state} at ${width}px: ${issues.join(', ')}`);
      else pass(`${page} ${state} at ${width}px: controls fit`);
      if (process.env.SHOT_DIR) {
        const { data } = await s("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(process.env.SHOT_DIR, `${page.replace(/[^a-z]+/g, "-")}${width}-${state}.png`), Buffer.from(data, "base64"));
      }
    };
    await auditState("default");
    if (page.startsWith("preview") && !page.includes("#rec")) {
      await read("document.querySelector('summary').click()");
      await auditState("menu");
      await read("document.getElementById('path').click()");
      if (!await read("!document.querySelector('.more').open && window.__calls.some(c => c.cmd === 'copy_path')"))
        fail("menu action must copy the path and close");
      await read("document.querySelector('summary').click()");
      await s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
      if (!await read("!document.querySelector('.more').open && !window.__calls.some(c => c.cmd === 'close_preview')"))
        fail("Escape must dismiss the menu without closing the pin");
    }
    if (page.startsWith("settings")) {
      await read("document.getElementById('recorder').focus()");
      await auditState("shortcut-focus");
      await s("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
      if (!await read("document.activeElement.id === 'recorder-video'")) fail("Tab must leave the shortcut field");
      await s("Input.dispatchKeyEvent", { type: "keyDown", key: "6", code: "Digit6", modifiers: 10 });
      await sleep(30);
      if (!await read("window.__calls.some(c => c.cmd === 'set_hotkey' && c.args.hotkey === 'Ctrl+Shift+6' && c.args.record)")) fail("shortcut change was not saved");
      await read("document.getElementById('autostart').click()");
      if (!await read("window.__calls.some(c => c.cmd === 'set_autostart' && c.args.on === false)")) fail("autostart toggle was not saved");
    }
    if (page.startsWith("editor")) {
      await read("document.querySelector('[data-tool=text]').click()");
      const r = await read("document.getElementById('canvas').getBoundingClientRect().toJSON()");
      await drag([[r.right - 20, r.top + 20]]);
      await auditState("text-open");
      if (!await read("document.querySelector('[data-tool=text]').getAttribute('aria-pressed') === 'true' && !document.getElementById('textbox').hidden")) fail("text tool must show its selected state and input");
    }
    if (page.startsWith("overlay")) {
      await drag([[10, 80], [width - 8, height - 80]]);
      await auditState("selection");
      if (page.includes("video")) {
        await auditState("record-setup");
        if (await read("window.__calls.some(c => c.cmd === 'finish_capture')")) fail("responsive setup started recording before confirmation");
        await read("window.__failRecord = true; document.getElementById('start-record').click()");
        await waitFor("responsive record error", () => read("!document.getElementById('record-error').hidden"));
        await auditState("record-error");
        await read("window.__failRecord = false");
        await read("document.getElementById('sel').focus()");
        await s("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
        await waitFor("keyboard record start", () => read("window.__calls.filter(c => c.cmd === 'finish_capture').length === 2"));
        await auditState("recording-frame");
      }
    }
  }

  // --- the stop bar --------------------------------------------------------
  await s("Emulation.setDeviceMetricsOverride", {
    width: 196, height: 36, deviceScaleFactor: 1, mobile: false,
  });
  const loadedRec = cdp.event("Page.loadEventFired");
  await s("Page.navigate", { url: `${ORIGIN}/preview.html?rec#rec` });
  await loadedRec;
  await sleep(120);
  const bar = await read(
    "JSON.stringify([document.body.classList.contains('rec'), getComputedStyle(document.querySelector('header')).display," +
      "document.getElementById('clock').textContent, (window.__calls||[]).some(c => c.cmd === 'preview_ready')])",
  ).then(JSON.parse);
  if (!bar[0] || bar[1] !== "none" || bar[2] !== "1:05" || !bar[3])
    fail(`stop bar: ${JSON.stringify(bar)}`);
  else pass("#rec turns the pin into the stop bar with the backend's clock");
  const stopBox = await read("JSON.stringify(document.getElementById('stop').getBoundingClientRect())").then(JSON.parse);
  await drag([[stopBox.x + stopBox.width / 2, stopBox.y + stopBox.height / 2]]);
  await sleep(30);
  const stopped = await read("(window.__calls||[]).some(c => c.cmd === 'stop_recording')");
  if (!stopped) fail("the stop button did not send stop_recording");
  else pass("the stop button sends stop_recording");
  // Pause: the button asks the backend, then shows play and freezes the clock.
  await read("document.getElementById('pause').click()");
  await sleep(30);
  const pausedOn = await read(
    "(window.__calls||[]).some(c => c.cmd === 'pause_recording' && c.args.on === true) && document.body.classList.contains('paused')" +
      " && getComputedStyle(document.querySelector('#pause .ic-play')).display !== 'none'",
  );
  if (!pausedOn) fail("the pause button did not pause");
  else pass("the pause button sends pause_recording and shows play");
  await s("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  await sleep(30);
  const resumed = await read(
    "(window.__calls||[]).some(c => c.cmd === 'pause_recording' && c.args.on === false) && !document.body.classList.contains('paused')",
  );
  if (!resumed) fail("Space did not resume");
  else pass("Space resumes the recording");

  // --- the editor: a drag draws, save sends PNG bytes ----------------------
  await s("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  const loadedEd = cdp.event("Page.loadEventFired");
  await s("Page.navigate", { url: `${ORIGIN}/editor.html` });
  await loadedEd;
  await waitFor("editor_ready", () => read("(window.__calls||[]).some(c => c.cmd === 'editor_ready')"));
  const cbox = await read("JSON.stringify(document.getElementById('canvas').getBoundingClientRect())").then(JSON.parse);
  if (cbox.width < 100 || cbox.right > 1280 || cbox.bottom > 800)
    fail(`canvas box ${JSON.stringify(cbox)} does not fit the window`);
  else pass(`editor canvas fits the window (${Math.round(cbox.width)}x${Math.round(cbox.height)})`);
  await drag([[cbox.x + 50, cbox.y + 50], [cbox.x + 200, cbox.y + 150]]);
  await sleep(30);
  const undoOn = await read("!document.getElementById('undo').disabled");
  if (!undoOn) fail("a drag on the canvas did not add a shape");
  else pass("a drag on the canvas adds a shape (undo enabled)");
  // A pixel on the drawn rectangle's left edge is amber, the default colour.
  const px = await read(
    "(() => { const c = document.getElementById('canvas'); const r = c.getBoundingClientRect();" +
      "const sx = c.width / r.width; const d = c.getContext('2d').getImageData(Math.round(50 * sx), Math.round(100 * sx), 1, 1).data;" +
      "return Array.from(d).join(','); })()",
  );
  if (px !== "255,69,58,255") fail(`rectangle edge pixel is ${px}, want 255,69,58,255`);
  else pass("the rectangle is painted in the chosen colour");
  await s("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 2 });
  await s("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: 2 });
  await sleep(30);
  const undone = await read("document.getElementById('undo').disabled && !document.getElementById('redo').disabled");
  if (!undone) fail("Ctrl+Z did not undo the shape");
  else pass("Ctrl+Z undoes, redo becomes available");
  // The text tool: T, click, type, Enter leaves a shape behind.
  await s("Input.dispatchKeyEvent", { type: "keyDown", key: "t", code: "KeyT" });
  await s("Input.dispatchKeyEvent", { type: "keyUp", key: "t", code: "KeyT" });
  await drag([[cbox.x + 300, cbox.y + 300]]);
  await sleep(50);
  const boxOpen = await read("!document.getElementById('textbox').hidden && document.activeElement === document.getElementById('textbox')");
  if (!boxOpen) fail("clicking with the text tool did not open a focused text box");
  else pass("the text tool opens a focused text box");
  await s("Input.insertText", { text: "hello" });
  await s("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
  await s("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  await sleep(50);
  const textShape = await read("document.getElementById('textbox').hidden && !document.getElementById('undo').disabled");
  if (!textShape) fail("Enter did not commit the text as a shape");
  else pass("Enter commits the text as a shape");
  await s("Input.dispatchKeyEvent", { type: "keyDown", key: "s", code: "KeyS", modifiers: 2 });
  await s("Input.dispatchKeyEvent", { type: "keyUp", key: "s", code: "KeyS", modifiers: 2 });
  await waitFor("save_edited", () => read("(window.__calls||[]).some(c => c.cmd === 'save_edited')"));
  const saved = await read(
    "(() => { const c = (window.__calls||[]).find(c => c.cmd === 'save_edited'); const a = c.args;" +
      "return a instanceof Uint8Array && a.length > 8 && a[1] === 0x50 && a[2] === 0x4e && a[3] === 0x47; })()",
  );
  if (!saved) fail("save_edited did not carry PNG bytes as its body");
  else pass("Ctrl+S sends the PNG bytes to save_edited");
  if (process.env.SHOT_EDITOR) {
    await drag([[cbox.x + 50, cbox.y + 50], [cbox.x + 200, cbox.y + 150]]);
    const { data } = await s("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.SHOT_EDITOR, Buffer.from(data, "base64"));
    pass(`editor screenshot written to ${process.env.SHOT_EDITOR}`);
  }

  // A burst of pointer samples must paint once per frame, without replaying
  // committed annotations. Count real canvas calls; timings are informational.
  await read("document.querySelector('[data-tool=rect]').click()");
  for (let i = 0; i < 30; i++) {
    await drag([[cbox.x + 20 + i, cbox.y + 20], [cbox.x + 140 + i, cbox.y + 100]]);
  }
  await s("Input.dispatchMouseEvent", {
    type: "mousePressed", x: cbox.x + 40, y: cbox.y + 40,
    button: "left", buttons: 1, clickCount: 1,
  });
  const perf = await read(`(async () => {
    const c = document.getElementById('canvas'), ctx = c.getContext('2d');
    const r = c.getBoundingClientRect();
    const original = ctx.strokeRect;
    let strokes = 0;
    ctx.strokeRect = function(...args) { strokes++; return original.apply(this, args); };
    const t = performance.now();
    for (let i = 0; i < 120; i++) c.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: r.x + 100 + i, clientY: r.y + 140, buttons: 1,
    }));
    const ms = performance.now() - t;
    await new Promise(requestAnimationFrame);
    ctx.strokeRect = original;
    return { samples: 120, strokes, ms };
  })()`);
  console.log(`editor drag: ${JSON.stringify(perf)}`);
  if (perf.strokes !== 1) fail(`120 pointer samples painted ${perf.strokes} rectangles, want one live rectangle`);
  else pass("pointer samples share one paint and do not replay committed shapes");
  await s("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: cbox.x + 219, y: cbox.y + 140,
    button: "left", buttons: 0, clickCount: 1,
  });
  const history = await read(`(() => {
    const c = document.getElementById('canvas');
    const before = c.toDataURL();
    document.getElementById('undo').click();
    const undone = c.toDataURL();
    document.getElementById('redo').click();
    return before !== undone && before === c.toDataURL();
  })()`);
  if (!history) fail("undo/redo must restore the exact annotated pixels");
  else pass("undo/redo restores the exact annotated pixels");

  for (const kind of ["ellipse", "arrow", "highlight", "pixelate", "number"]) {
    await read(`document.querySelector('[data-tool=${kind}]').click()`);
    await drag([[cbox.x + 60, cbox.y + 60], [cbox.x + 260, cbox.y + 180]]);
    await read("window.__painted = document.getElementById('canvas').toDataURL(); document.querySelector('[data-tool=rect]').click()");
    await drag([[cbox.x + 20, cbox.y + 20]]); // An empty click restores the snapshot.
    if (!await read("window.__painted === document.getElementById('canvas').toDataURL()"))
      fail(`${kind}: cached pixels differ from a full repaint`);
    else pass(`${kind}: cached pixels match a full repaint`);
  }

  await read("document.querySelector('[data-tool=pen]').click()");
  await s("Input.dispatchMouseEvent", {
    type: "mousePressed", x: cbox.x + 40, y: cbox.y + 240,
    button: "left", buttons: 1, clickCount: 1,
  });
  const pen = await read(`(() => {
    const c = document.getElementById('canvas'), ctx = c.getContext('2d');
    const r = c.getBoundingClientRect(), original = ctx.lineTo;
    let points = 0;
    ctx.lineTo = function(...args) { points++; return original.apply(this, args); };
    for (let i = 0; i < 120; i++) c.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, clientX: r.x + 50 + i, clientY: r.y + 240 + i % 20, buttons: 1,
    }));
    document.getElementById('copy').click(); // Before the scheduled animation frame.
    ctx.lineTo = original;
    window.__painted = c.toDataURL();
    return points;
  })()`);
  if (pen !== 120) fail(`copy before paint drew ${pen} pen segments, want all 120`);
  else pass("copy before the next paint includes every sampled pen point");
  await waitFor("copy_edited", () => read("window.__calls.some(c => c.cmd === 'copy_edited')"));
  const exported = await read(`(async () => {
    const bytes = window.__calls.find(c => c.cmd === 'copy_edited').args;
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = image.width; c.height = image.height;
    c.getContext('2d').drawImage(image, 0, 0); image.close();
    return c.toDataURL() === window.__painted;
  })()`);
  if (!exported) fail("exported PNG differs from the latest pen stroke");
  else pass("exported PNG matches the latest pen stroke exactly");
  await s("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: cbox.x + 169, y: cbox.y + 259,
    button: "left", buttons: 0, clickCount: 1,
  });

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
