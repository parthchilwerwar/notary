import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests stub fetch, so live-mode traffic in them is never real network: run the process-wide
    // Crustdata throttle on virtual time (waits counted, not slept). See test/setup-virtual-time.ts.
    setupFiles: ["./test/setup-virtual-time.ts"],
    // Realistic defaults for the integration tests (CLI subprocesses, export/publish over real files,
    // `serve`, the demo, LiteLLM doubles, chat safety): 5 s timed out under load (audit #8). Tests
    // that need more set their own timeout.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
