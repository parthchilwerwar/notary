import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Live mode in development: /api goes to a local `notary serve` (read-only, loopback).
  // When it is not running the probe fails and the app falls back to the static files.
  server: {
    proxy: {
      "/api": {
        target: process.env.NOTARY_API_PROXY ?? "http://127.0.0.1:8787",
        configure: (proxy) => {
          proxy.on("error", (_err, _req, res) => {
            if ("writeHead" in res && !res.headersSent) {
              res.writeHead(503, { "content-type": "text/plain" });
              res.end("notary serve is not running");
            }
          });
        },
      },
    },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["react", "react-dom", "zod"],
  },
  build: {
    rollupOptions: {
      output: {
        // Two vendor chunks only. A separate "charts" chunk (recharts, d3-*) became circular
        // with "ui" once @xyflow/react (which imports d3-zoom/d3-drag) landed in "ui", and the
        // production bundle failed at startup with a TDZ ReferenceError. zod imports nothing,
        // so its chunk cannot form a cycle.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (/[\\/]zod[\\/]/.test(id)) return "schema";
            return "vendor";
          }
        },
      },
    },
  },
});
