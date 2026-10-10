// Verified bundles from bundle directories (each with its own index.json), for the ask and
// approval endpoints. Same rules as the GET /api/bundles loader in server.ts: only a directory's own
// index.json is read, run ids must be safe file names, the first directory wins on a duplicate runId,
// and every bundle is re-verified with verifyBundle. A bundle whose hash does not match (tampered) or
// that fails the schema is skipped: nothing downstream answers from, or acts on, unverified evidence.
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyBundle } from "../bundle/hash.js";
import { BundleIndexSchema } from "../schema/bundle.js";
import type { RunBundle } from "../schema/index.js";

export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface LoadedBundle {
  bundle: RunBundle;
  /** The directory the bundle was read from. */
  dir: string;
}

/** Immediate subdirectories of `runsDir` (runs/<runId>/), sorted; [] when absent. */
export function runSubdirectories(runsDir: string | null): string[] {
  if (runsDir === null || !existsSync(runsDir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(runsDir).sort()) {
    const sub = join(runsDir, name);
    try {
      if (statSync(sub).isDirectory()) out.push(sub);
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

/** Every verified bundle listed by the directories' index.json files. */
export async function loadVerifiedBundles(dirs: readonly string[]): Promise<LoadedBundle[]> {
  const seen = new Set<string>();
  const out: LoadedBundle[] = [];
  for (const dir of dirs) {
    const indexPath = join(dir, "index.json");
    if (!existsSync(indexPath)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(indexPath, "utf8"));
    } catch {
      continue;
    }
    const parsed = BundleIndexSchema.safeParse(raw);
    if (!parsed.success) continue;
    for (const entry of parsed.data) {
      if (!SAFE_RUN_ID.test(entry.runId) || seen.has(entry.runId)) continue;
      const file = join(dir, `${entry.runId}.json`);
      if (!existsSync(file)) continue;
      let body: unknown;
      try {
        body = JSON.parse(await readFile(file, "utf8"));
      } catch {
        continue;
      }
      const checked = verifyBundle(body);
      if (!checked.ok) continue;
      seen.add(entry.runId);
      out.push({ bundle: checked.bundle, dir });
    }
  }
  return out;
}
