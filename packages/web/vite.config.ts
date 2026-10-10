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
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (/recharts|d3-|victory|redux|reselect|immer/.test(id))
              return "charts";
            if (id.includes("zod")) return "schema";
            return "ui";
          }
        },
      },
    },
  },
});
