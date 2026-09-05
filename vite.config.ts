import { defineConfig } from "vite";

// No index: this app has no main window, only the capture overlay, the pinned
// preview, the editor and the settings page. Each is opened from Rust by filename.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    rollupOptions: {
      input: {
        overlay: "overlay.html",
        preview: "preview.html",
        editor: "editor.html",
        settings: "settings.html",
      },
    },
  },
});
