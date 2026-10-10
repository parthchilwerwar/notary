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
 *   - each publish replaces the directory's contents: stale `demo-*.json` files and index.json in
 *     the fixture dir are removed first; nothing else anywhere is touched.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { FIXTURE_BUNDLES_SUBDIR, verifyBundle, writeBundle } from "../bundle/index.js";
import type { RunBundle } from "../schema/index.js";
import { FIXTURE_DISCLOSURE } from "./index.js";

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

  const removed: string[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (name === "index.json" || (name.startsWith("demo-") && name.endsWith(".json"))) {
        rmSync(join(dir, name), { force: true });
        removed.push(name);
      }
    }
  }

  const written: string[] = [];
  let indexPath = join(dir, "index.json");
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
  ];
  return { dir, indexPath, written, removed, lines };
}
