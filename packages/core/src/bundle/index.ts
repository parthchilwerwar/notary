import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BundleIndexSchema } from "../schema/bundle.js";
import type { BundleIndexEntry, RunBundle } from "../schema/index.js";
import { verifyBundle } from "./hash.js";

export {
  canonicalJson,
  computeContentHash,
  finalizeBundle,
  sha256Hex,
  verifyBundle,
  type UnhashedBundle,
  type VerifyResult,
} from "./hash.js";
export { buildSampleBundle } from "./sample.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/**
 * P9 (AUDIT-07): names of secret-looking env vars whose VALUE appears in `text`. Bundles are built
 * from redacted traffic, so this should never fire; it is the backstop before a bundle hits disk
 * (and, from packages/web/public, the public dashboard).
 */
export function leakedSecretNames(text: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (value && value.length >= 8 && SECRET_ENV_RE.test(name) && text.includes(value)) out.push(name);
  }
  return out.sort();
}

export interface WrittenBundle {
  bundlePath: string;
  indexPath: string;
}

/**
 * Write `<dir>/<runId>.json` (pretty JSON) and upsert its entry in `<dir>/index.json`, sorted by
 * startedAt. Refuses to write a bundle that fails schema validation or its own content hash, or
 * that contains a secret env value.
 */
export async function writeBundle(bundle: RunBundle, dir: string): Promise<WrittenBundle> {
  const checked = verifyBundle(bundle);
  if (!checked.ok) throw new Error(`refusing to write bundle: ${checked.error}`);
  const b = checked.bundle;
  if (!SAFE_RUN_ID.test(b.runId)) throw new Error(`unsafe runId for a file name: ${JSON.stringify(b.runId)}`);
  const text = `${JSON.stringify(b, null, 2)}\n`;
  const leaked = leakedSecretNames(text);
  if (leaked.length) throw new Error(`refusing to write bundle ${b.runId}: it contains the value of secret env var(s) ${leaked.join(", ")}`);

  await mkdir(dir, { recursive: true });
  const bundlePath = join(dir, `${b.runId}.json`);
  await writeFile(bundlePath, text, "utf8");

  const indexPath = join(dir, "index.json");
  let entries: BundleIndexEntry[] = [];
  if (existsSync(indexPath)) {
    const parsed = BundleIndexSchema.safeParse(JSON.parse(await readFile(indexPath, "utf8")));
    if (!parsed.success) throw new Error(`${indexPath} is not a valid bundle index; fix or delete it`);
    entries = parsed.data;
  }
  const entry: BundleIndexEntry = {
    runId: b.runId,
    kind: b.kind,
    variant: b.variant,
    mode: b.mode,
    sample: b.sample,
    startedAt: b.startedAt,
    status: b.status,
    contentHash: b.contentHash,
  };
  entries = entries.filter((e) => e.runId !== b.runId);
  entries.push(entry);
  entries.sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt) || (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0));
  await writeFile(indexPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");

  return { bundlePath, indexPath };
}
