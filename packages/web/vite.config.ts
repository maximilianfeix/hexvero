import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../cli/ui",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:7331" },
  },
});
