/**
 * `notary replay [--bundle <runId>] [--drift <fixture>]` (P8; PRD FR-11, TDD "Replay").
 *
 * For every recorded LIVE run/notarize bundle (or the one named): verify the bundle's content hash,
 * load every cassette it pins and verify both the file's own hash and the pin, then re-run the same
 * pipeline in replay mode — `run --naive|--guarded` from the run's tool cassette, or the full
 * notarize loop from its recon/probe cassettes and recorded model answers — starting from the store
 * snapshot in the run's replay record, with the recorded parameters and NO environment: no keys,
 * no .env, no model ids. A cassette miss (tool or model) fails loudly and names the exchange. The
 * replay bundle is written with `replayOf` = the original runId and mode "replay", and every key
 * of the original's `bundle.metrics` is compared exactly with the replay's, and so are the records
 * themselves (probes, hypotheses, anomalies, beliefs, decisions; see records.ts, AUDIT-19). Exit 0
 * only when every bundle replayed and every metric and record matched; 1 on any miss, tamper, missing record or mismatch;
 * 3 (BLOCKED) when there is nothing recorded to replay.
 *
 * Bundles come from each run directory's `<runId>.json` and from the web bundle directory's
 * index.json (never its `*.timeline.json` files). The same runId in both places must have the same
 * content hash (CONFLICT otherwise) - except earlier REPLAY outputs (mode "replay" with replayOf),
 * which carry wall-clock fields (startedAt, commit times, trace ids) and so a different hash on every
 * run: two copies of one replay output are compared on metrics and records, like a replay itself.
 * Recorded runs listed in fixtures/replay/known-unreplayable.json (each with a reason and the
 * DECISIONS entry) are still attempted; one that fails with its listed error is reported
 * "SKIPPED (known unreplayable: ...)" and does not fail the sweep (an explicit --bundle of it exits 1).
 * Any other failure fails; nothing else is skipped.
 *
 * `--drift <fixture>` instead replays the notarize bundle whose probe cassette the drift fixture was
 * copied from (matched by content hash), then runs replayDrift on the resulting store and prints
 * each affected belief's trajectory (one step per DISTINCT design; replicates count once, A-16) and
 * the guards it retired. Exit 1 when no belief un-learned, with "not un-learned: only N distinct
 * designs observed the change" (A-05): too few designs is reported, never faked.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { verifyBundle } from "../bundle/index.js";
import { replayDrift } from "../beliefs/drift.js";
import { compareExact, formatComparison } from "../eval/metrics.js";
import type { MetricRow } from "../eval/metrics.js";
import { loadManifest } from "../queue/manifest.js";
import { RUNS_DIR, WEB_BUNDLES_DIR, runQueue } from "../queue/run.js";
import { reconOnly } from "../checker/notarize.js";
import { notarize } from "../reflect/notarize.js";
import type { RunBundle } from "../schema/index.js";
import type { NotaryDb } from "../store/db.js";
import { CassetteMissError, CreditLedger, DEFAULT_CASSETTE_DIR, listCassettes } from "../tools/index.js";
import type { Cassette } from "../tools/index.js";
import { loadDriftFixture } from "../tools/drift-fixture.js";
import { pinnedPath, readInputs, restoreStore, sha256File } from "./inputs.js";
import type { FilePin, ReplayInputs } from "./inputs.js";
import { ReplayLlm } from "./llm-cassette.js";
import { compareRecords, formatRecords } from "./records.js";
import type { RecordRow } from "./records.js";
import { PinMismatchError, loadPinned, parseRef } from "./pins.js";

/** The committed list of recorded runs that cannot replay (reason + DECISIONS entry each). */
export const KNOWN_UNREPLAYABLE_FILE = fileURLToPath(new URL("../../fixtures/replay/known-unreplayable.json", import.meta.url));

const KnownUnreplayableSchema = z.object({
  schema: z.literal("notary-known-unreplayable/1"),
  note: z.string().optional(),
  runs: z.array(
    z.object({
      runId: z.string().min(1),
      reason: z.string().min(1),
      /** The replay must fail with an error containing this text; any other outcome is reported as such. */
      expectedError: z.string().min(1),
      decision: z.string().min(1),
    }),
  ),
});
export type KnownUnreplayable = z.infer<typeof KnownUnreplayableSchema>["runs"][number];

/** Read the known-unreplayable list (a missing file is an empty list; an invalid one throws). */
export function loadKnownUnreplayable(file: string = KNOWN_UNREPLAYABLE_FILE): KnownUnreplayable[] {
  if (!existsSync(file)) return [];
  return KnownUnreplayableSchema.parse(JSON.parse(readFileSync(file, "utf8"))).runs;
}

export const BLOCKED_NOTHING_RECORDED =
  "BLOCKED: no recorded live runs to replay (fixtures/cassettes is empty) — record runs with API keys first";

export interface ReplayOptions {
  /** Replay only this runId. */
  bundle?: string;
  /** Drift fixture (name in fixtures/drift, or a path): replay its source notarize run, then drift. */
  drift?: string;
  /** Where bundles are found and replay bundles written (default packages/core/runs). */
  runsDir?: string;
  /** Also searched for bundles (default packages/web/public/bundles); null to skip. */
  webBundlesDir?: string | null;
  cassetteDir?: string;
  driftDir?: string;
  now?: () => Date;
  /** unguarded_call_sites for the replay bundles (the CLI runs the coverage check); default null. */
  unguardedCallSites?: () => Promise<number | null>;
  /** Known-unreplayable runs (default: fixtures/replay/known-unreplayable.json). */
  knownUnreplayable?: readonly KnownUnreplayable[];
}

export interface BundleReplay {
  runId: string;
  ok: boolean;
  replayRunId?: string;
  replayBundlePath?: string;
  rows?: MetricRow[];
  /** Record-level comparison (probes, hypotheses, anomalies, beliefs, decisions); AUDIT-19. */
  records?: RecordRow[];
  error?: string;
  replay?: RunBundle;
  /** Set when the run is on the known-unreplayable list and failed with its listed error. */
  skipped?: KnownUnreplayable;
}

export interface ReplayResult {
  exitCode: number;
  lines: string[];
  replays: BundleReplay[];
}

interface Found {
  file: string;
  bundle?: RunBundle;
  error?: string;
}

function bundleFilesIn(runsDir: string, webDir: string | null): string[] {
  const out: string[] = [];
  if (existsSync(runsDir)) {
    for (const d of readdirSync(runsDir).sort()) {
      const full = join(runsDir, d);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      const f = join(full, `${d}.json`);
      if (existsSync(f)) out.push(f);
    }
  }
  if (webDir && existsSync(webDir)) out.push(...webBundleFiles(webDir));
  return out;
}

/**
 * The web bundle directory's bundles: the files its index.json lists (like the server). Without an
 * index, every `*.json` except index.json and the `*.timeline.json` timelines published next to them.
 */
function webBundleFiles(webDir: string): string[] {
  const indexPath = join(webDir, "index.json");
  if (!existsSync(indexPath)) {
    return readdirSync(webDir)
      .sort()
      .filter((f) => f.endsWith(".json") && f !== "index.json" && !f.endsWith(".timeline.json"))
      .map((f) => join(webDir, f));
  }
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    // An unreadable index is reported as an invalid bundle file below, not silently skipped.
    return [indexPath];
  }
  if (!Array.isArray(entries)) return [indexPath];
  return entries.map((e) => join(webDir, `${String((e as { runId?: unknown } | null)?.runId ?? "")}.json`));
}

/** Every bundle file, hash-verified on load (a tampered or invalid one comes back with `error`). */
export function discoverBundles(runsDir: string, webDir: string | null): Found[] {
  return bundleFilesIn(runsDir, webDir).map((file): Found => {
    let raw: unknown;
    try {
      if (!existsSync(file)) return { file, error: "listed in index.json but the file is missing" };
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      return { file, error: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
    const v = verifyBundle(raw);
    if (!v.ok) return { file, error: v.error.split("\n")[0]! };
    return { file, bundle: v.bundle };
  });
}

const isReplayOutput = (b: RunBundle): boolean => b.mode === "replay" && typeof b.replayOf === "string" && b.replayOf.length > 0;

/**
 * Two hash-verified copies of one replay output (same runId, different content hash): the same
 * replay when they replay the same original and every metric and record a replay must reproduce is
 * identical - the difference is then only wall-clock fields (startedAt/finishedAt, commit times,
 * trace ids) and the hash derived from them.
 */
export function sameReplayOutput(a: RunBundle, b: RunBundle): { same: boolean; detail?: string } {
  if (!isReplayOutput(a) || !isReplayOutput(b)) return { same: false, detail: "not both replay outputs" };
  if (a.replayOf !== b.replayOf) return { same: false, detail: `replayOf ${a.replayOf} vs ${b.replayOf}` };
  const m = compareExact(a.metrics, b.metrics);
  if (!m.allMatch) return { same: false, detail: `metric(s) differ: ${m.rows.filter((r) => !r.match).map((r) => r.key).join(", ")}` };
  const r = compareRecords(a, b);
  if (!r.allMatch) return { same: false, detail: r.rows.filter((x) => !x.match).map((x) => x.detail ?? x.section).join("; ") };
  return { same: true };
}

const isRecordedLive = (b: RunBundle): boolean => !b.sample && b.mode === "live" && (b.kind === "run" || b.kind === "notarize");

function checkFile(what: string, pin: FilePin | undefined): string {
  if (!pin) throw new Error(`the replay record pins no ${what} file`);
  const path = pinnedPath(pin);
  if (!existsSync(path)) throw new Error(`${what} file ${pin.path} is missing`);
  const actual = sha256File(path);
  if (actual !== pin.sha256) throw new Error(`${what} file ${pin.path} changed since the run (sha256 ${actual.slice(0, 12)}, recorded ${pin.sha256.slice(0, 12)})`);
  return path;
}

function describeMiss(err: CassetteMissError): string {
  return `CASSETTE MISS: ${err.op} ${err.method} ${err.url} (request hash ${err.requestHash}, occurrence ${err.occurrence}) — ${err.message}`;
}

interface Loaded {
  cassettes: Map<string, { ref: string; cassette: Cassette }>;
  inputs: ReplayInputs;
  inputsRef: string;
}

function loadRecord(b: RunBundle, cassetteDir: string): Loaded {
  const cassettes = new Map<string, { ref: string; cassette: Cassette }>();
  // Every pinned cassette is loaded and verified (file hash + pin). An unpinned ref (e.g. the seed
  // run's cassette when it was never written here) is not served by replay; the cassettes replay
  // serves are looked up below and must be pinned.
  for (const ref of b.cassettes) {
    const { name, hash } = parseRef(ref);
    if (hash !== undefined) cassettes.set(name, { ref, cassette: loadPinned(ref, cassetteDir) });
  }
  const unpinned = b.cassettes.filter((r) => parseRef(r).hash === undefined).map((r) => parseRef(r).name);
  const needed = b.kind === "run" ? [b.runId] : [];
  for (const n of needed) if (unpinned.includes(n)) throw new PinMismatchError(n, "not pinned to a content hash (recorded before P8?)");
  const rec = cassettes.get(`${b.runId}-inputs`);
  if (!rec) throw new Error(`bundle ${b.runId} pins no replay record (${b.runId}-inputs); it predates P8 replay recording`);
  return { cassettes, inputs: readInputs(rec.cassette), inputsRef: rec.ref };
}

/** Replay one recorded bundle; with `keepDb` (notarize) the scratch store is returned open. */
export async function replayBundle(
  original: RunBundle,
  opts: ReplayOptions & { keepDb?: boolean },
): Promise<BundleReplay & { db?: NotaryDb }> {
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;
  const base: BundleReplay = { runId: original.runId, ok: false };
  let db: NotaryDb | undefined;
  try {
    const { cassettes, inputs, inputsRef } = loadRecord(original, cassetteDir);
    if (inputs.runId !== original.runId) throw new Error(`replay record is for ${inputs.runId}, not ${original.runId}`);
    let replayRunId: string;
    let bundlePath: string | undefined;

    if (original.kind === "run") {
      const toolNames = [...cassettes.keys()].filter((n) => n === original.runId || n.startsWith(`${original.runId}-resume-`));
      if (toolNames.some((n) => n.includes("-resume-"))) {
        throw new Error("resumed runs (crash + --resume) are not replayable: the replay would not crash at the same point");
      }
      if (!cassettes.has(original.runId)) throw new Error(`bundle pins no tool cassette named ${original.runId}`);
      const queueFile = checkFile("queue", inputs.files.queue);
      const expectedFile = checkFile("expected outcomes", inputs.files.expected);
      const manifestFile = inputs.files.manifest ? checkFile("seed manifest", inputs.files.manifest) : undefined;
      if (!manifestFile) throw new Error("the replay record pins no seed manifest");
      if (inputs.variant === "guarded") db = restoreStore(inputs.store);
      const result = await runQueue({
        queueFile,
        expectedFile,
        variant: inputs.variant === "naive" ? "naive" : "guarded",
        mode: "replay",
        cassette: original.runId,
        cassetteDir,
        runsDir,
        webBundlesDir: null,
        manifest: loadManifest(manifestFile),
        env: {},
        creditBudget: inputs.params.creditBudget,
        ...(inputs.params.clientTimeoutMs !== undefined ? { clientTimeoutMs: inputs.params.clientTimeoutMs } : {}),
        extraCassettes: [inputsRef],
        ...(db ? { db } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.unguardedCallSites ? { unguardedCallSites: opts.unguardedCallSites } : {}),
      });
      if (!result.bundlePath || !result.runId) throw new Error(`replay run did not write a bundle: ${result.lines.join(" | ")}`);
      replayRunId = result.runId;
      bundlePath = result.bundlePath;
    } else if (inputs.reconOnly) {
      const tool = original.tool;
      if (!tool) throw new Error("notarize bundle names no tool");
      const recon = [...cassettes.keys()].find((n) => n.endsWith("-recon"));
      if (!recon) throw new Error("bundle pins no recon cassette");
      replayRunId = `${original.runId}-replay`;
      const result = await reconOnly({
        tool,
        replay: true,
        env: {},
        cassetteDir,
        runsDir,
        ledger: new CreditLedger({ budget: inputs.params.creditBudget }),
        runId: replayRunId,
        replayOf: original.runId,
        reconCassette: recon,
        extraCassettes: [inputsRef],
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.unguardedCallSites ? { unguardedCallSites: opts.unguardedCallSites } : {}),
      });
      if (!result.bundlePath) throw new Error(`replay recon did not write a bundle: ${result.lines.join(" | ")}`);
      bundlePath = result.bundlePath;
    } else {
      const tool = original.tool;
      if (!tool) throw new Error("notarize bundle names no tool");
      const recon = [...cassettes.keys()].find((n) => n.endsWith("-recon"));
      const probes = [...cassettes.keys()].find((n) => n.endsWith("-probes"));
      const llmRec = cassettes.get(`${original.runId}-llm`);
      if (!recon || !probes) throw new Error("bundle pins no recon/probe cassettes");
      if (!llmRec) throw new Error(`bundle pins no model cassette (${original.runId}-llm)`);
      const llm = new ReplayLlm(llmRec.cassette);
      db = restoreStore(inputs.store);
      replayRunId = `${original.runId}-replay`;
      const spansDir = join(runsDir, replayRunId, "spans");
      rmSync(spansDir, { recursive: true, force: true });
      const backend = inputs.params.adversary ?? "bedrock";
      const result = await notarize({
        tool,
        replay: true,
        env: {},
        llm,
        db,
        runId: replayRunId,
        replayOf: original.runId,
        identityRunId: inputs.identityRunId,
        reconCassette: recon,
        probesCassette: probes,
        cassetteDir,
        runsDir,
        spansDir,
        params: inputs.params,
        ...(inputs.priorsSource ? { priorsSourceRecord: inputs.priorsSource } : {}),
        paymentPool: inputs.paymentPool ?? [],
        subscriptionPool: inputs.subscriptionPool ?? [],
        extraCassettes: [llmRec.ref, inputsRef],
        ...(backend === "session" ? { review: llm.review } : {}),
        sleep: async () => {},
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.unguardedCallSites ? { unguardedCallSites: opts.unguardedCallSites } : {}),
      });
      if (!result.bundlePath) throw new Error(`replay notarize did not write a bundle: ${result.lines.join(" | ")}`);
      bundlePath = result.bundlePath;
    }

    const v = verifyBundle(JSON.parse(readFileSync(bundlePath, "utf8")));
    if (!v.ok) throw new Error(`replay bundle failed verification: ${v.error}`);
    const { rows, allMatch } = compareExact(original.metrics, v.bundle.metrics);
    const records = compareRecords(original, v.bundle);
    const out = { ...base, ok: allMatch && records.allMatch, replayRunId, replayBundlePath: bundlePath, rows, records: records.rows, replay: v.bundle };
    if (opts.keepDb && db) return { ...out, db };
    db?.close();
    return out;
  } catch (err) {
    db?.close();
    if (err instanceof CassetteMissError) return { ...base, error: describeMiss(err) };
    if (err instanceof PinMismatchError) return { ...base, error: `TAMPERED OR MISSING: ${err.message}` };
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runReplay(opts: ReplayOptions = {}): Promise<ReplayResult> {
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const webDir = opts.webBundlesDir === undefined ? WEB_BUNDLES_DIR : opts.webBundlesDir;
  const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;
  const found = discoverBundles(runsDir, webDir);
  const lines: string[] = [];
  const failures: string[] = [];

  // Every loaded bundle's content hash is recomputed; a tampered one is a visible failure.
  for (const f of found) if (f.error) failures.push(`TAMPERED OR INVALID BUNDLE ${f.file}: ${f.error}`);
  const byId = new Map<string, Found & { bundle: RunBundle }>();
  const replayCopies: string[] = [];
  for (const f of found) {
    if (!f.bundle) continue;
    const prev = byId.get(f.bundle.runId);
    if (prev && prev.bundle.contentHash !== f.bundle.contentHash) {
      const same = sameReplayOutput(prev.bundle, f.bundle);
      if (same.same) replayCopies.push(f.bundle.runId);
      else failures.push(`CONFLICT: bundle ${f.bundle.runId} differs between ${prev.file} and ${f.file}${isReplayOutput(f.bundle) && same.detail ? ` (${same.detail})` : ""}`);
      continue;
    }
    if (!prev) byId.set(f.bundle.runId, f as Found & { bundle: RunBundle });
  }
  lines.push(`verified ${byId.size} bundle(s) (content hash recomputed)${failures.length ? `; ${failures.length} failed verification` : ""}`);
  if (replayCopies.length) {
    lines.push(`${replayCopies.length} earlier replay output(s) have two copies that differ only in wall-clock fields (same metrics and records): ${replayCopies.join(", ")}`);
  }
  let known: readonly KnownUnreplayable[];
  try {
    known = opts.knownUnreplayable ?? loadKnownUnreplayable();
  } catch (err) {
    return { exitCode: 1, lines: [...lines, ...failures, `invalid ${KNOWN_UNREPLAYABLE_FILE}: ${err instanceof Error ? err.message : String(err)}`], replays: [] };
  }
  const knownById = new Map(known.map((k) => [k.runId, k]));

  if (opts.drift) return driftReplay(opts, [...byId.values()].map((f) => f.bundle), lines, failures);

  let targets = [...byId.values()].map((f) => f.bundle).filter(isRecordedLive);
  if (opts.bundle) {
    const b = byId.get(opts.bundle)?.bundle;
    if (!b) return { exitCode: 1, lines: [...lines, ...failures, `no bundle ${opts.bundle} in ${runsDir}${webDir ? ` or ${webDir}` : ""}`], replays: [] };
    if (!isRecordedLive(b)) {
      return { exitCode: 1, lines: [...lines, ...failures, `bundle ${opts.bundle} is not a recorded live run (mode ${b.mode}, kind ${b.kind}${b.sample ? ", sample" : ""}); replay its original`], replays: [] };
    }
    targets = [b];
  }
  if (targets.length === 0) {
    if (failures.length) return { exitCode: 1, lines: [...lines, ...failures, "FAIL: nothing replayable, and some bundles failed verification"], replays: [] };
    const empty = listCassettes(cassetteDir).length === 0;
    const blockedLine = empty
      ? BLOCKED_NOTHING_RECORDED
      : `BLOCKED: no recorded live runs to replay (no live run/notarize bundle in ${runsDir}${webDir ? ` or ${webDir}` : ""}; ${listCassettes(cassetteDir).length} cassette(s) present) — record runs with API keys first`;
    return { exitCode: 3, lines: [...lines, blockedLine], replays: [] };
  }

  const replays: BundleReplay[] = [];
  targets.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.runId < b.runId ? -1 : 1));
  for (const b of targets) {
    const r: BundleReplay = await replayBundle(b, opts);
    const k = knownById.get(b.runId);
    lines.push("", `replay ${b.runId} (${b.kind}${b.kind === "run" ? ` --${b.variant}` : ` ${b.tool ?? ""}`})${r.replayRunId ? ` -> ${r.replayRunId}` : ""}`);
    if (k && r.error?.includes(k.expectedError)) {
      // Attempted, and failed exactly as recorded: disclosed, neither a pass nor a failure.
      r.skipped = k;
      replays.push(r);
      lines.push(`  SKIPPED (known unreplayable: ${k.reason}; ${k.decision})`);
      lines.push(`  observed: ${r.error.length > 240 ? `${r.error.slice(0, 239)}…` : r.error}`);
      continue;
    }
    replays.push(r);
    if (r.error) {
      lines.push(`  FAIL: ${r.error}`);
      if (k) lines.push(`  (listed as known unreplayable, but this is not the listed failure "${k.expectedError}")`);
      continue;
    }
    if (k && r.ok) lines.push(`  NOTE: listed as known unreplayable (${k.decision}) but it reproduced; remove it from ${KNOWN_UNREPLAYABLE_FILE}`);
    lines.push(...formatComparison(r.rows ?? []));
    lines.push(...formatRecords(r.records ?? []));
    const bad = (r.rows ?? []).filter((x) => !x.match).length;
    const badRecords = (r.records ?? []).filter((x) => !x.match);
    if (r.ok) lines.push(`  OK: all ${r.rows?.length ?? 0} metrics and all ${r.records?.length ?? 0} record sections match exactly`);
    else {
      if (bad) lines.push(`  FAIL: ${bad} metric(s) differ`);
      if (badRecords.length) lines.push(`  FAIL: record(s) differ in ${badRecords.map((x) => x.section).join(", ")}`);
    }
    if (r.replayBundlePath) lines.push(`  replay bundle: ${r.replayBundlePath}`);
  }
  const skipped = replays.filter((r) => r.skipped);
  const attempted = replays.filter((r) => !r.skipped);
  const allOk = failures.length === 0 && attempted.every((r) => r.ok);
  const skippedNote = skipped.length
    ? `; ${skipped.length} skipped as known unreplayable (${skipped.map((r) => r.runId).join(", ")}; see fixtures/replay/known-unreplayable.json)`
    : "";
  lines.push(
    "",
    ...failures,
    allOk
      ? `REPLAY OK: ${attempted.length} bundle(s) reproduced exactly${skippedNote}`
      : `REPLAY FAILED: ${attempted.filter((r) => !r.ok).length}/${attempted.length} bundle(s) did not reproduce${failures.length ? `, ${failures.length} verification failure(s)` : ""}${skippedNote}`,
  );
  // An explicit --bundle of a known-unreplayable run did not reproduce: never a pass.
  const explicitSkip = opts.bundle !== undefined && skipped.length > 0;
  return { exitCode: allOk && !explicitSkip ? 0 : 1, lines, replays };
}

async function driftReplay(opts: ReplayOptions, bundles: RunBundle[], lines: string[], failures: string[]): Promise<ReplayResult> {
  let fixture;
  try {
    fixture = loadDriftFixture(opts.drift!, opts.driftDir ? { driftDir: opts.driftDir } : {});
  } catch (err) {
    return { exitCode: 1, lines: [...lines, ...failures, `drift fixture ${opts.drift}: ${err instanceof Error ? err.message : String(err)}`], replays: [] };
  }
  const source = bundles
    .filter((b) => isRecordedLive(b) && b.kind === "notarize")
    .find((b) => b.cassettes.some((ref) => parseRef(ref).hash === fixture.drift.sourceContentHash));
  if (!source) {
    return {
      exitCode: 1,
      lines: [...lines, ...failures, `no recorded notarize bundle pins the drift fixture's source cassette ${fixture.drift.source} (sha ${fixture.drift.sourceContentHash.slice(0, 12)})`],
      replays: [],
    };
  }
  lines.push(`drift: source run ${source.runId} (replayed first to rebuild its store)`);
  const r = await replayBundle(source, { ...opts, keepDb: true });
  if (r.error || !r.db) return { exitCode: 1, lines: [...lines, ...failures, `  FAIL: ${r.error ?? "no store"}`], replays: [r] };
  try {
    const result = await replayDrift({
      fixture,
      db: r.db,
      probes: source.probes,
      hypotheses: source.hypotheses,
      env: {},
      ...(opts.now ? { now: opts.now } : {}),
    });
    lines.push(...result.lines);
    for (const t of result.trajectories) {
      lines.push(`trajectory ${t.beliefId} (${t.side}):`);
      lines.push(`  start  alpha=${t.start.alpha} beta=${t.start.beta} P(holds)=${t.start.pHolds.toFixed(4)} status=${t.start.status}`);
      t.steps.forEach((s, i) =>
        lines.push(
          `  design ${i + 1} ${s.verdict.padEnd(13)} alpha=${s.alpha} beta=${s.beta} P(holds)=${s.pHolds.toFixed(4)} status=${s.status}  [${s.design}${s.replicateIds.length ? `; ${s.replicateIds.length} replicate(s) not re-counted` : ""}]`,
        ),
      );
    }
    lines.push(`retired guards: ${result.retiredGuards.length ? result.retiredGuards.map((g) => `${g.id} (${g.kind} on ${g.operation})`).join(", ") : "none"}`);
    // P9 (AUDIT-05): a drift replay that un-learned nothing has not shown FR-16; never report it as a pass.
    if (!result.unlearned) {
      failures.push(
        `FAIL: the drift fixture un-learned no belief (${result.trajectories.length} affected belief(s), none reached unlearned): FR-16 not demonstrated`,
      );
    }
    return { exitCode: failures.length ? 1 : 0, lines: [...lines, ...failures], replays: [r] };
  } catch (err) {
    const msg = err instanceof CassetteMissError ? describeMiss(err) : err instanceof Error ? err.message : String(err);
    return { exitCode: 1, lines: [...lines, ...failures, `  FAIL: ${msg}`], replays: [r] };
  } finally {
    r.db.close();
  }
}

