/**
 * Publish incidents for the bundles already in the dashboard (real: packages/web/public/bundles,
 * fixture: .../bundles/fixture) into packages/web/public/incidents[/fixture], derived from
 * packages/core/runs/** — no new runs; nothing under public/bundles is written.
 *   pnpm --filter @notary/core publish:incidents
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishDashboardIncidents } from "../src/incidents/record.js";

const runs = fileURLToPath(new URL("../runs/", import.meta.url));
const web = fileURLToPath(new URL("../../web/public/bundles/", import.meta.url));
const incidents = fileURLToPath(new URL("../../web/public/incidents/", import.meta.url));

const real = await publishDashboardIncidents(web, incidents, { sample: false, runsDirs: [runs] });
const fixture = await publishDashboardIncidents(join(web, "fixture"), join(incidents, "fixture"), { sample: true, runsDirs: [join(runs, "demo"), join(runs, "demo-change-api")] });
for (const [label, r] of [["real", real], ["fixture", fixture]] as const) {
  console.log(`${label}: ${r.index.incidents} incident(s) from ${r.index.runs} run(s) -> ${r.index.path}`);
  for (const s of r.skipped) console.log(`  skipped ${s.runId}: ${s.reason}`);
}
