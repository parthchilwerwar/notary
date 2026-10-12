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

/**
 * The bundle of each run directory one level below `runsDir`: only `<dir>/<dir>.json`, sorted. Files a
 * run directory holds next to its bundle (incidents.json, approvals.json, index.json, cassettes, ...)
 * are never read as bundles.
 */
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
    const bundle = join(full, `${dir}.json`);
    if (existsSync(bundle)) out.push(bundle);
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

/** One newest bundle per (class, tool, mode). */
export function latestPerCategory(bundles: readonly RunBundle[]): RunBundle[] {
  const byKey = new Map<string, RunBundle>();
  for (const b of [...bundles].sort(order)) byKey.set(`${classify(b)}/${b.tool ?? "-"}/${b.mode}`, b);
  return [...byKey.values()].sort(order);
}

/** A real bundle certificates are built from: full notarize bundles, and queue runs / drift replays that carry belief events (never sample, never compare-priors arms). */
export function isCertificateSource(b: RunBundle): boolean {
  return !b.sample && (classify(b) === "notarize-full" || (b.beliefEvents.length > 0 && (b.kind === "run" || isDriftReplay(b))));
}

/**
 * What `notary export` copies to the dashboard: the newest bundle per category, plus every certificate
 * source, so each source bundle a certificate file cites is published with the same contentHash
 * (a later notarize run of the same tool must not hide the earlier run whose probes a certificate cites).
 */
export function dashboardBundles(bundles: readonly RunBundle[]): RunBundle[] {
  const byId = new Map(latestPerCategory(bundles).map((b) => [b.runId, b] as const));
  for (const b of bundles) if (isCertificateSource(b)) byId.set(b.runId, b);
  return [...byId.values()].sort(order);
}

/** Newest full notarize bundle (the one carrying beliefs and guards) for a tool. */
export function latestNotarize(bundles: readonly RunBundle[], tool: Tool): RunBundle | undefined {
  return latest(bundles, (b) => classify(b) === "notarize-full" && b.tool === tool);
}
