/**
 * `notary demo --fixture --publish`: copy the fixture demo's bundles into
 * packages/web/public/bundles/fixture/ with their OWN index.json (same BundleIndexSchema shape),
 * so the dashboard can show the walkthrough without it ever looking like a result.
 *
 * Separation rules (DECISIONS #20: only JSON data goes into packages/web/public):
 *   - writes only inside <webBundlesDir>/fixture/; never the real bundles/index.json or any other file;
 *   - every bundle must verify (schema + content hash), be `sample: true`, carry the FIXTURE
 *     disclosure and have a `demo-` runId, or nothing is written at all;
 *   - bundles are written unchanged (writeBundle re-verifies the hash before writing);
 *   - each publish replaces ITS SCENARIO's files only (scenario = runId prefix, `demoScenarioOf`:
 *     `demo-change-api-*` vs every other `demo-*`): that scenario's stale `demo-*.json` files and
 *     index.json are removed, the other scenario's bundles are kept (re-verified and re-indexed
 *     unchanged; one that no longer verifies is removed), so `--scenario change-api --publish` and the
 *     default `--publish` never delete each other's bundles. Nothing else anywhere is touched.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { FIXTURE_BUNDLES_SUBDIR, verifyBundle, writeBundle } from "../bundle/index.js";
import type { RunBundle } from "../schema/index.js";
import { FIXTURE_DISCLOSURE, demoScenarioOf } from "./index.js";

export interface PublishFixtureOptions {
  /** The dashboard's real bundles directory; fixture bundles go to its `fixture/` subdirectory. */
  webBundlesDir: string;
}

export interface PublishFixtureResult {
  dir: string;
  indexPath: string;
  written: string[];
  removed: string[];
  lines: string[];
}

/** Why a bundle may not be published as fixture data, or null when it may. */
export function fixturePublishRefusal(bundle: unknown): string | null {
  const v = verifyBundle(bundle);
  if (!v.ok) return `fails verification (${v.error})`;
  const b = v.bundle;
  if (b.sample !== true) return `${b.runId} is not sample: true`;
  if (!b.disclosure.includes(FIXTURE_DISCLOSURE)) return `${b.runId} lacks the FIXTURE disclosure`;
  if (!b.runId.startsWith("demo-")) return `${b.runId} is not a demo-* bundle`;
  return null;
}

export async function publishFixtureBundles(bundles: readonly RunBundle[], opts: PublishFixtureOptions): Promise<PublishFixtureResult> {
  const parent = resolve(opts.webBundlesDir);
  const dir = join(parent, FIXTURE_BUNDLES_SUBDIR);
  if (bundles.length === 0) throw new Error("notary demo --publish: no fixture bundles to publish");
  // Validate everything before touching the disk: one bad bundle means nothing is written.
  const refusals = bundles.map(fixturePublishRefusal).filter((r): r is string => r !== null);
  if (refusals.length) throw new Error(`notary demo --publish: refusing to publish: ${refusals.join("; ")}`);
  const ids = bundles.map((b) => b.runId);
  if (new Set(ids).size !== ids.length) throw new Error(`notary demo --publish: duplicate runIds (${ids.join(", ")})`);

  const scenarios = new Set(ids.map(demoScenarioOf));
  const removed: string[] = [];
  const kept: RunBundle[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const isBundle = name.startsWith("demo-") && name.endsWith(".json");
      if (name !== "index.json" && !isBundle) continue;
      if (isBundle && !scenarios.has(demoScenarioOf(name.slice(0, -".json".length)))) {
        // Another scenario's bundle: keep it (re-indexed below) if it still verifies as fixture data.
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
        } catch {
          parsed = undefined;
        }
        const v = parsed === undefined ? undefined : verifyBundle(parsed);
        if (v?.ok && fixturePublishRefusal(parsed) === null && `${v.bundle.runId}.json` === name) {
          kept.push(v.bundle);
          continue;
        }
      }
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    }
  }

  const written: string[] = [];
  let indexPath = join(dir, "index.json");
  // Re-index the other scenario's bundles first (bytes unchanged: writeBundle writes the verified bundle).
  for (const b of kept) {
    const w = await writeBundle(b, dir);
    indexPath = w.indexPath;
  }
  for (const b of bundles) {
    const w = await writeBundle(b, dir);
    if (resolve(w.indexPath) !== resolve(indexPath)) throw new Error(`notary demo --publish: unexpected index path ${w.indexPath}`);
    indexPath = w.indexPath;
    written.push(w.bundlePath);
  }

  const shown = (p: string): string => relative(parent, p).split(sep).join("/");
  const lines = [
    `published ${written.length} FIXTURE bundle(s) to ${dir} (own index.json; the real bundles/index.json is untouched)`,
    ...written.map((p) => `  ${shown(p)}`),
    `  ${shown(indexPath)}`,
    ...(removed.length ? [`  replaced previous contents: ${removed.join(", ")}`] : []),
    ...(kept.length ? [`  kept the other scenario's bundles (re-indexed unchanged): ${kept.map((b) => `${b.runId}.json`).join(", ")}`] : []),
  ];
  return { dir, indexPath, written, removed, lines };
}
