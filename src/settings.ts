import { invoke } from "@tauri-apps/api/core";

const rec = document.getElementById("recorder") as HTMLDivElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const auto = document.getElementById("autostart") as HTMLInputElement;

let current = "";

// The chord drawn as keycaps, one per key in the combination.
function showChord(chord: string) {
  rec.replaceChildren(
    ...chord.split("+").map((k) => {
      const cap = document.createElement("kbd");
      cap.textContent = k;
      return cap;
    }),
  );
}

invoke<{ hotkey: string; autostart: boolean }>("get_settings").then((s) => {
  current = s.hotkey;
  showChord(current);
  auto.checked = s.autostart;
});

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

rec.addEventListener("focus", () => {
  rec.textContent = "press keys…";
});
rec.addEventListener("blur", () => {
  showChord(current);
});

// Applied the moment a valid chord lands: registered, persisted, tray updated.
// No save button to forget.
rec.addEventListener("keydown", (e) => {
  e.preventDefault();
  if (e.key === "Escape") {
    rec.blur();
    return;
  }
  const combo = fromEvent(e);
  if (!combo) return;
  showChord(combo);
  invoke("set_hotkey", { hotkey: combo })
    .then(() => {
      current = combo;
      flash("saved");
      rec.blur();
    })
    .catch((err) => {
      showChord(current);
      flash(String(err), true);
    });
});

auto.addEventListener("change", () => {
  invoke("set_autostart", { on: auto.checked }).catch((err) => {
    auto.checked = !auto.checked;
    flash(String(err), true);
  });
});
