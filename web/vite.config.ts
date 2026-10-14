import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the engine runs separately (python -m retake --no-window).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8765", "/media": "http://127.0.0.1:8765" },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
