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
        // Two named chunks only. A hand-made "charts" chunk (recharts, d3-*) once became circular
        // with "ui" (TDZ crash at startup, DECISIONS #128), so nothing else is grouped by hand.
        // zod and the React core import nothing outside themselves, so neither can form a cycle.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (/[\\/]zod[\\/]/.test(id)) return "schema";
            // Only what every route needs shares "vendor". Dashboard-only libraries (recharts,
            // d3, cmdk, ...) are left to Rollup's splitting so they load with the lazy /app
            // chunk, never on the landing (R4 Lighthouse).
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) return "vendor";
          }
        },
      },
    },
  },
});
