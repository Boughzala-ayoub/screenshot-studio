import { invoke } from "@tauri-apps/api/core";

const status = document.getElementById("status") as HTMLParagraphElement;
const auto = document.getElementById("autostart") as HTMLInputElement;

// The chord drawn as keycaps, one per key in the combination.
function showChord(rec: HTMLElement, chord: string) {
  rec.replaceChildren(
    ...chord.split("+").map((k) => {
      const cap = document.createElement("kbd");
      cap.textContent = k;
      return cap;
    }),
  );
}

let statusTimer: ReturnType<typeof setTimeout> | undefined;
function flash(msg: string, err = false) {
  clearTimeout(statusTimer);
  status.textContent = msg;
  status.className = err ? "err" : "ok";
  statusTimer = setTimeout(() => (status.textContent = ""), err ? 4000 : 1600);
}

// A keydown into the Tauri shortcut grammar, or null for anything that cannot
// be a global hotkey. Modifier-only presses (the Ctrl on the way to Ctrl+P)
// fall out as null too, so the box just waits for the full chord.
function fromEvent(e: KeyboardEvent): string | null {
  const mods = [
    e.ctrlKey && "Ctrl",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    e.metaKey && "Super",
  ].filter(Boolean) as string[];
  let key = "";
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else return null;
  // A bare letter cannot be global: it would eat that key in every app.
  if (!mods.length && !key.startsWith("F")) return null;
  return [...mods, key].join("+");
}

// One recorder box per shortcut. Applied the moment a valid chord lands:
// registered, persisted, tray updated. No save button to forget.
function recorder(id: string, record: boolean, initial: string) {
  const rec = document.getElementById(id) as HTMLDivElement;
  let current = initial;
  showChord(rec, current);
  rec.addEventListener("focus", () => {
    rec.textContent = "press keys…";
  });
  rec.addEventListener("blur", () => {
    showChord(rec, current);
  });
  rec.addEventListener("keydown", (e) => {
    if (e.key === "Tab") return;
    e.preventDefault();
    if (e.key === "Escape") {
      rec.blur();
      return;
    }
    const combo = fromEvent(e);
    if (!combo) return;
    showChord(rec, combo);
    invoke("set_hotkey", { hotkey: combo, record })
      .then(() => {
        current = combo;
        flash("saved");
        rec.blur();
      })
      .catch((err) => {
        showChord(rec, current);
        flash(String(err), true);
      });
  });
}

invoke<{ hotkey: string; record_hotkey: string; autostart: boolean }>("get_settings").then((s) => {
  recorder("recorder", false, s.hotkey);
  recorder("recorder-video", true, s.record_hotkey);
  auto.checked = s.autostart;
});

auto.addEventListener("change", () => {
  invoke("set_autostart", { on: auto.checked }).catch((err) => {
    auto.checked = !auto.checked;
    flash(String(err), true);
  });
});
