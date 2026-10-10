/**
 * Noise floor (TDD "Replay, seeded queue and evaluation": "Three identical guarded runs establish
 * run-to-run variance for each metric before any improvement is claimed. A change smaller than the
 * floor is reported as no change.")
 *
 * `notary eval noise-floor --queue <file> [--runs 3] [--replay]`
 *   live (default): the guarded queue N times, live (needs the Dodo + Crustdata keys; BLOCKED
 *                   otherwise). NOTE: each live run moves real test-mode money state, so later runs
 *                   see the earlier runs' refunds unless the world is re-seeded between runs.
 *   --replay:       replays the newest recorded live guarded run of that queue N times (no keys).
 * Floor per metric = max − min over the N runs, for metrics that are numbers in every run (a metric
 * that is null in any run gets no floor and is listed as not comparable). The floor is written into
 * each run's bundle (`noiseFloor`, bundle re-hashed) and into runs/noise-floor.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { finalizeBundle, verifyBundle, writeBundle } from "../bundle/index.js";
import { publishTimeline, recordRunTimeline } from "../timeline/write.js";
import { RUNS_DIR, WEB_BUNDLES_DIR, runQueue } from "../queue/run.js";
import { discoverBundles, replayBundle } from "../replay/index.js";
import { pinnedPath, readInputs } from "../replay/inputs.js";
import { loadPinned, parseRef } from "../replay/pins.js";
import type { RunBundle } from "../schema/index.js";
import { DEFAULT_CASSETTE_DIR } from "../tools/index.js";
import type { Metrics } from "./metrics.js";

export type DeltaLabel = "no change" | "increase" | "decrease" | "not comparable";

export interface DeltaRow {
  key: string;
  a: number | null | undefined;
  b: number | null | undefined;
  /** b − a; null when either side is not a number. */
  delta: number | null;
  /** The metric's noise floor; null when none was measured. */
  floor: number | null;
  label: DeltaLabel;
}

const round9 = (x: number): number => Math.round(x * 1e9) / 1e9;

/** Per metric: max − min over the runs, only for metrics that are a number in every run. */
export function computeNoiseFloor(runs: readonly Metrics[]): { floor: Record<string, number>; notComparable: string[] } {
  const keys = [...new Set(runs.flatMap((m) => Object.keys(m)))].sort();
  const floor: Record<string, number> = {};
  const notComparable: string[] = [];
  for (const k of keys) {
    const vals = runs.map((m) => m[k]);
    if (runs.length === 0 || vals.some((v) => typeof v !== "number")) {
      notComparable.push(k);
      continue;
    }
    const nums = vals as number[];
    floor[k] = round9(Math.max(...nums) - Math.min(...nums));
  }
  return { floor, notComparable };
}

/**
 * Label each metric's change from run `a` to run `b`: "no change" when |Δ| ≤ the metric's floor
 * (with no floor measured, only Δ = 0 is no change); "increase"/"decrease" otherwise; "not
 * comparable" when either side is null or missing.
 */
export function compareRuns(a: Metrics, b: Metrics, noiseFloor: Readonly<Record<string, number>>): DeltaRow[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.map((key): DeltaRow => {
    const va = a[key];
    const vb = b[key];
    const floor = key in noiseFloor ? noiseFloor[key]! : null;
    if (typeof va !== "number" || typeof vb !== "number") return { key, a: va, b: vb, delta: null, floor, label: "not comparable" };
    const delta = round9(vb - va);
    const label: DeltaLabel = Math.abs(delta) <= (floor ?? 0) ? "no change" : delta > 0 ? "increase" : "decrease";
    return { key, a: va, b: vb, delta, floor, label };
  });
}

export interface NoiseFloorOptions {
  queueFile: string;
  runs?: number;
  replay?: boolean;
  env?: NodeJS.ProcessEnv;
  runsDir?: string;
  webBundlesDir?: string | null;
  cassetteDir?: string;
  now?: () => Date;
  unguardedCallSites?: () => Promise<number | null>;
}

export interface NoiseFloorResult {
  exitCode: number;
  lines: string[];
  floor?: Record<string, number>;
  runIds?: string[];
  summaryPath?: string;
}

/** The newest recorded live guarded run bundle whose replay record pins this queue file. */
function recordedGuardedRun(queuePath: string, runsDir: string, webDir: string | null, cassetteDir: string): RunBundle | undefined {
  let best: RunBundle | undefined;
  for (const f of discoverBundles(runsDir, webDir)) {
    const b = f.bundle;
    if (!b || b.sample || b.kind !== "run" || b.variant !== "guarded" || b.mode !== "live") continue;
    const ref = b.cassettes.find((r) => parseRef(r).name === `${b.runId}-inputs`);
    if (!ref) continue;
    try {
      const pin = readInputs(loadPinned(ref, cassetteDir)).files.queue;
      if (!pin || resolve(pinnedPath(pin)) !== resolve(queuePath)) continue;
    } catch {
      continue;
    }
    if (!best || b.startedAt > best.startedAt) best = b;
  }
  return best;
}

export async function runNoiseFloor(opts: NoiseFloorOptions): Promise<NoiseFloorResult> {
  const n = opts.runs ?? 3;
  if (!Number.isInteger(n) || n < 2) return { exitCode: 1, lines: [`--runs must be an integer >= 2 (got ${n})`] };
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const webDir = opts.webBundlesDir === undefined ? WEB_BUNDLES_DIR : opts.webBundlesDir;
  const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;
  const queuePath = resolve(opts.queueFile);
  const lines: string[] = [`noise floor: ${n} guarded run(s) of ${opts.queueFile} (${opts.replay ? "replay" : "live"})`];
  const bundles: Array<{ bundle: RunBundle; path: string }> = [];

  if (opts.replay) {
    const original = recordedGuardedRun(queuePath, runsDir, webDir, cassetteDir);
    if (!original) {
      return { exitCode: 3, lines: [...lines, `BLOCKED: no recorded live guarded run of ${opts.queueFile} to replay — record one with API keys first`] };
    }
    for (let i = 0; i < n; i++) {
      const r = await replayBundle(original, {
        runsDir,
        cassetteDir,
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.unguardedCallSites ? { unguardedCallSites: opts.unguardedCallSites } : {}),
      });
      if (r.error || !r.replay || !r.replayBundlePath) return { exitCode: 1, lines: [...lines, `replay ${i + 1} of ${original.runId} failed: ${r.error ?? "no bundle"}`] };
      // Each replay overwrites the same deterministic replay runId; keep the copy we just read.
      bundles.push({ bundle: r.replay, path: r.replayBundlePath });
      lines.push(`run ${i + 1}: replay of ${original.runId} -> ${r.replayRunId}`);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const r = await runQueue({
        queueFile: opts.queueFile,
        variant: "guarded",
        mode: "live",
        runsDir,
        webBundlesDir: webDir,
        ...(opts.cassetteDir ? { cassetteDir: opts.cassetteDir } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.unguardedCallSites ? { unguardedCallSites: opts.unguardedCallSites } : {}),
      });
      if (r.exitCode !== 0 || !r.bundlePath) return { exitCode: r.exitCode || 1, lines: [...lines, ...r.lines] };
      const v = verifyBundle(JSON.parse(readFileSync(r.bundlePath, "utf8")));
      if (!v.ok) return { exitCode: 1, lines: [...lines, `run ${i + 1}: ${v.error}`] };
      bundles.push({ bundle: v.bundle, path: r.bundlePath });
      lines.push(`run ${i + 1}: ${v.bundle.runId}`);
    }
  }

  const { floor, notComparable } = computeNoiseFloor(bundles.map((b) => b.bundle.metrics));
  const runIds = [...new Set(bundles.map((b) => b.bundle.runId))];
  // Write the floor into every run's bundle (re-hashed), and its dashboard copy when there is one.
  for (const runId of runIds) {
    const entry = bundles.find((b) => b.bundle.runId === runId)!;
    const updated = finalizeBundle({ ...entry.bundle, noiseFloor: floor });
    await writeBundle(updated, join(runsDir, runId));
    recordRunTimeline(updated, join(runsDir, runId), { runsDir });
    if (webDir && existsSync(join(webDir, `${runId}.json`))) {
      await writeBundle(updated, webDir);
      await publishTimeline(updated, webDir, { expectSample: false, runDir: join(runsDir, runId), runsDir });
    }
  }
  const summary = {
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    queue: opts.queueFile,
    mode: opts.replay ? "replay" : "live",
    runs: bundles.map((b) => b.bundle.runId),
    floor,
    notComparable,
    values: Object.fromEntries(Object.keys(floor).map((k) => [k, bundles.map((b) => b.bundle.metrics[k] ?? null)])),
    rule: "floor = max - min per metric over the runs; a later change with |delta| <= floor is reported as no change",
  };
  await mkdir(runsDir, { recursive: true });
  const summaryPath = join(runsDir, "noise-floor.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const nonZero = Object.entries(floor).filter(([, v]) => v !== 0);
  lines.push(
    `floor computed for ${Object.keys(floor).length} metric(s); ${nonZero.length} non-zero${nonZero.length ? `: ${nonZero.map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}`,
    `not comparable (null in some run): ${notComparable.length ? notComparable.join(", ") : "none"}`,
    `summary: ${summaryPath}`,
  );
  return { exitCode: 0, lines, floor, runIds, summaryPath };
}
