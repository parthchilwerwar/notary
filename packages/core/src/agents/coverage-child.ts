// Child-process entry for Notary Chat's get_guard_coverage tool: runs the same static walk as
// `notary guards coverage` (tsc backend) and prints ONE JSON line (GuardCoverageSummary) to stdout.
// It runs in its own process because the TypeScript walk is synchronous and takes tens of seconds:
// in the server process it would block every request and stream (src/api/server.ts spawns this).
import { runCoverage } from "../guards/coverage.js";

const r = runCoverage({ backend: "tsc" });
process.stdout.write(
  `${JSON.stringify({
    backend: r.backend,
    backendNote: r.backendNote,
    totals: r.totals,
    unguarded_call_sites: r.unguarded_call_sites,
    sites: [...r.sites, ...r.createToolsCalls],
    computedAt: new Date().toISOString(),
  })}\n`,
);
