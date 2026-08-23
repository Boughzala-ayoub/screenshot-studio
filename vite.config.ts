import { defineConfig } from "vite";

// Two pages, no index: this app has no main window, only the capture overlay
// and the pinned preview. Both are opened from Rust by filename.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    rollupOptions: {
      input: { overlay: "overlay.html", preview: "preview.html", settings: "settings.html" },
    },
  },
});
