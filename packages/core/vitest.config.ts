import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests stub fetch, so live-mode traffic in them is never real network: run the process-wide
    // Crustdata throttle on virtual time (waits counted, not slept). See test/setup-virtual-time.ts.
    setupFiles: ["./test/setup-virtual-time.ts"],
  },
});
