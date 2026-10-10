/**
 * Bundle collection for `notary export` (P8). Only REAL bundles are ever used as a source of
 * results: `runs/<dir>/<runId>.json` files with `sample === false` and kind `run` | `notarize`
 * that pass verifyBundle (schema + recomputed content hash). Everything else is listed, never used:
 *   - skipped:  unreadable JSON, schema failures, hash mismatches (tampered), file name != runId
 *   - excluded: schema-valid sample bundles (kind/variant `sample` or `sample: true`)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { verifyBundle } from "../bundle/hash.js";
import { COMPARE_PRIORS_RUN_PREFIX } from "../beliefs/priors.js";
import type { RunBundle, Tool } from "../schema/index.js";

export interface CollectedBundle {
  bundle: RunBundle;
  /** Path relative to the runs dir, forward slashes. */
  file: string;
}

export interface SkippedBundle {
  file: string;
  reason: string;
}

export interface CollectResult {
  bundles: CollectedBundle[];
  skipped: SkippedBundle[];
  excluded: SkippedBundle[];
}

function rel(root: string, p: string): string {
  return relative(root, p).split("\\").join("/");
}

/** Every `*.json` (not index.json) one level below `runsDir`, sorted. */
function candidateFiles(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(runsDir).sort()) {
    const full = join(runsDir, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(full).sort()) if (f.endsWith(".json") && f !== "index.json") out.push(join(full, f));
  }
  return out;
}

export function collectBundles(runsDir: string): CollectResult {
  const result: CollectResult = { bundles: [], skipped: [], excluded: [] };
  for (const path of candidateFiles(runsDir)) {
    const file = rel(runsDir, path);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      result.skipped.push({ file, reason: `unreadable JSON (${(err as Error).message.split("\n")[0]})` });
      continue;
    }
    const checked = verifyBundle(raw);
    if (!checked.ok) {
      const reason = checked.reason === "hash" ? "content hash mismatch (tampered or edited after writing)" : "fails the bundle schema";
      result.skipped.push({ file, reason });
      continue;
    }
    const b = checked.bundle;
    if (b.sample || b.kind === "sample" || b.variant === "sample") {
      result.excluded.push({ file, reason: "SAMPLE bundle (synthetic) — never a source of results" });
      continue;
    }
    const stem = path.replace(/\\/g, "/").split("/").pop()!.replace(/\.json$/, "");
    if (stem !== b.runId) {
      result.skipped.push({ file, reason: `file name does not match its runId (${b.runId})` });
      continue;
    }
    result.bundles.push({ bundle: b, file });
  }
  result.bundles.sort((x, y) => order(x.bundle, y.bundle));
  return result;
}

const time = (b: RunBundle): number => Date.parse(b.startedAt);

/** Oldest first; ties broken by runId so output is stable. */
export function order(x: RunBundle, y: RunBundle): number {
  return time(x) - time(y) || (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0);
}

// --- classification ------------------------------------------------------------------------

export type BundleClass =
  | "run-naive"
  | "run-guarded"
  | "notarize-full"
  | "notarize-recon"
  | "notarize-compare-priors";

/** What produced a bundle, from its fields (and the runId prefixes the writers use). */
export function classify(b: RunBundle): BundleClass {
  if (b.kind === "run") return b.variant === "naive" ? "run-naive" : "run-guarded";
  if (b.runId.startsWith(COMPARE_PRIORS_RUN_PREFIX)) return "notarize-compare-priors";
  if (b.runId.startsWith("recon-") || b.disclosure.some((d) => d.startsWith("Recon-only notarize run"))) return "notarize-recon";
  return "notarize-full";
}

export function isDriftReplay(b: RunBundle): boolean {
  return b.disclosure.some((d) => d.includes("DRIFT FIXTURE"));
}

/** Newest bundle matching `pred`, or undefined. */
export function latest(bundles: readonly RunBundle[], pred: (b: RunBundle) => boolean): RunBundle | undefined {
  const hits = bundles.filter(pred).sort(order);
  return hits[hits.length - 1];
}

/** One newest bundle per (class, tool, mode): what the dashboard gets and what TOOLS.md reads. */
export function latestPerCategory(bundles: readonly RunBundle[]): RunBundle[] {
  const byKey = new Map<string, RunBundle>();
  for (const b of [...bundles].sort(order)) byKey.set(`${classify(b)}/${b.tool ?? "-"}/${b.mode}`, b);
  return [...byKey.values()].sort(order);
}

/** Newest full notarize bundle (the one carrying beliefs and guards) for a tool. */
export function latestNotarize(bundles: readonly RunBundle[], tool: Tool): RunBundle | undefined {
  return latest(bundles, (b) => classify(b) === "notarize-full" && b.tool === tool);
}
