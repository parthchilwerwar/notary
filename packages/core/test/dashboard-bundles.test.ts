// `notary export` dashboard copy: newest bundle per category plus every certificate source, so a
// later notarize run of a tool never hides the earlier run whose probes a certificate cites.
// Bundles are constructed (TEST DATA) from one published fixture notarize bundle, re-hashed as real.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeBundle } from "../src/bundle/hash.js";
import { realCertificateSources } from "../src/certify/index.js";
import { dashboardBundles, latestPerCategory } from "../src/export/collect.js";
import { EXPLAIN_PATHS } from "../src/explain/export.js";
import type { RunBundle } from "../src/schema/index.js";

const FIXTURE_DIR = join(EXPLAIN_PATHS.webBundlesDir, "fixture");
const notarize = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json") && f !== "index.json" && !f.endsWith(".timeline.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as RunBundle)
  .find((b) => b.kind === "notarize" && b.probes.length > 0)!;

const real = (runId: string, startedAt: string, extra: Partial<RunBundle> = {}): RunBundle =>
  finalizeBundle({ ...notarize, runId, startedAt, sample: false, mode: "live", disclosure: [], ...extra });

describe("dashboardBundles", () => {
  const first = real(`notarize-${notarize.tool}-20260101T000000Z`, "2026-01-01T00:00:00.000Z");
  const second = real(`notarize-${notarize.tool}-20260102T000000Z`, "2026-01-02T00:00:00.000Z", { probes: [] });
  const reconOld = real(`recon-${notarize.tool}-20260101T000000Z`, "2026-01-01T00:00:00.000Z");
  const reconNew = real(`recon-${notarize.tool}-20260103T000000Z`, "2026-01-03T00:00:00.000Z");
  const all = [first, second, reconOld, reconNew];

  it("keeps every certificate source (both notarize runs) and only the newest recon-only run", () => {
    expect(latestPerCategory(all).map((b) => b.runId)).not.toContain(first.runId);
    const ids = dashboardBundles(all).map((b) => b.runId);
    expect(ids).toEqual([first.runId, second.runId, reconNew.runId]);
  });

  it("publishes exactly the bundles `export --certificates` can cite, plus the newest per category", () => {
    const ids = new Set(dashboardBundles(all).map((b) => b.runId));
    for (const s of realCertificateSources(all)) expect(ids.has(s.runId)).toBe(true);
    for (const b of latestPerCategory(all)) expect(ids.has(b.runId)).toBe(true);
  });
});
