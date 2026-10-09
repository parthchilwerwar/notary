/**
 * `notary run --queue <file> [--naive] [--replay <cassette>]` and `notary run --resume [--run <runId>]`.
 *
 * Live: records every exchange into cassette `run-<variant>-<stamp>` (the runId). Replay: serves
 * the same run from that cassette with no network and no keys. Either way: ground truth before,
 * execute, ground truth after, deterministic grade, then a bundle in packages/core/runs/<runId>/
 * and a copy in packages/web/public/bundles/. Nothing is written when the run is BLOCKED.
 *
 * Guarded (the default, P6): guards are compiled from the NOTARIZED beliefs in the Notary store
 * (src/guards/compiler.ts) into the guard registry, every tool method is built through
 * createTools({wrap: guarded(registry)}), the gate checks required beliefs before each irreversible
 * action, a belief that un-learns retires its guards immediately, and per-item run state is persisted
 * (src/queue/run-state.ts) so a crashed run continues with `--resume`. Each decision is emitted on the
 * event bus (`decision`), and the end of the run as `run.finished`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { emitEvent } from "../api/bus.js";
import { BeliefStore, beliefIdFor } from "../beliefs/store.js";
import { finalizeBundle, writeBundle } from "../bundle/index.js";
import { claimById } from "../contracts/index.js";
import { GuardRegistry, compileGuards, guarded, wireRetirement } from "../guards/index.js";
import { QueueRequestSchema } from "../schema/index.js";
import type { Belief, Claim, Decision, Guard, QueueRequest, RunBundle } from "../schema/index.js";
import { DEFAULT_DB_PATH, openDb } from "../store/db.js";
import type { NotaryDb } from "../store/db.js";
import {
  CreditLedger,
  DEFAULT_CASSETTE_DIR,
  MissingCredentialError,
  TestModeLockError,
  createTools,
  identityWrap,
  isBlocked,
  listCassettes,
  loadCassette,
} from "../tools/index.js";
import type { Tools, Wrap } from "../tools/index.js";
import { executeQueue } from "./executor.js";
import type { GateHook, PolicyFns, QueueTools, ResumeEntry } from "./executor.js";
import { createGate } from "./gate.js";
import { ExpectedFileSchema, collectGroundTruth, gradeRun } from "./grader.js";
import type { ExpectedEntry, GroundTruthSnapshot } from "./grader.js";
import { loadManifest } from "./manifest.js";
import type { SeedManifest } from "./manifest.js";
import { REQUIRED_GAPS } from "./required.js";
import { RunStateStore } from "./run-state.js";

export const RUNS_DIR = fileURLToPath(new URL("../../runs/", import.meta.url));
export const WEB_BUNDLES_DIR = fileURLToPath(new URL("../../../web/public/bundles/", import.meta.url));
const CORE_DIR = fileURLToPath(new URL("../../", import.meta.url));

type RunTools = QueueTools & Pick<Tools, "ledger">;

export interface RunQueueOptions {
  /** Required unless `resume`. */
  queueFile?: string;
  variant: "naive" | "guarded";
  mode: "live" | "replay";
  /** Replay: the cassette to serve from (a previous live run's runId). */
  cassette?: string;
  /** Continue an interrupted guarded run (`runId`, else the latest unfinished one). */
  resume?: boolean;
  runId?: string;
  /** Default: expected.json next to the queue file. */
  expectedFile?: string;
  runsDir?: string;
  /** Where the dashboard copy goes; null skips the copy. */
  webBundlesDir?: string | null;
  cassetteDir?: string;
  /** Guarded: the Notary store (beliefs, probes, guards, run state). Default runs/notary.sqlite. */
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  clientTimeoutMs?: number;
  /** Test seams. */
  manifest?: SeedManifest;
  tools?: Tools | RunTools;
  /** Guarded test seam: build the tools from the guarded wrap (instead of createTools). */
  makeTools?: (wrap: Wrap) => RunTools;
  policy?: PolicyFns;
  db?: NotaryDb;
  gate?: GateHook;
}

export interface RunQueueResult {
  exitCode: number;
  lines: string[];
  status: RunBundle["status"];
  runId?: string;
  bundlePath?: string;
  metrics?: Record<string, number | null>;
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };

function compactStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Resolve a CLI path against cwd, then INIT_CWD (pnpm runs scripts from the package dir). */
export function resolveInputPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(p)) return p;
  const candidates = [resolvePath(process.cwd(), p)];
  if (env.INIT_CWD) candidates.push(resolvePath(env.INIT_CWD, p));
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

function readJson(path: string, what: string): unknown {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function displayPath(p: string): string {
  const rel = relative(CORE_DIR, p).split("\\").join("/");
  return rel.startsWith("..") ? p : rel;
}

function blocked(err: unknown): RunQueueResult | null {
  if (isBlocked(err) || err instanceof TestModeLockError || (err instanceof Error && err.message.startsWith("BLOCKED:"))) {
    const msg = (err as Error).message;
    return { exitCode: 3, lines: [msg.startsWith("BLOCKED:") ? msg : `BLOCKED: ${msg}`], status: "blocked" };
  }
  return null;
}

function requireKeys(env: NodeJS.ProcessEnv): void {
  for (const v of ["DODO_PAYMENTS_API_KEY", "CRUSTDATA_API_KEY"]) if (!env[v]?.trim()) throw new MissingCredentialError(v);
}

// ---------------------------------------------------------------------------------------------
// Guarded setup

export interface GuardedContext {
  store: BeliefStore;
  registry: GuardRegistry;
  wrap: Wrap;
  gate: GateHook;
  beliefsBefore: Belief[];
  /** Guards retired during the run (a belief left `notarized`). */
  retired: Guard[];
  unwire: () => void;
}

/** Compile the store's notarized beliefs into the registry and build the guarded wrap and gate. */
export function loadGuardedContext(db: NotaryDb, now: () => Date = () => new Date()): GuardedContext {
  const store = new BeliefStore(db, { now });
  const registry = new GuardRegistry(db, { now });
  const retired: Guard[] = [];
  const unwire = wireRetirement(store, registry, (g) => retired.push(...g));
  const beliefs = store.list();
  const claimFor = (claimId: string): Claim | undefined =>
    claimById(claimId) ?? (store.byClaim(claimId) ? store.claimFor(beliefIdFor(claimId)) : undefined);
  const cited = [...new Set(beliefs.filter((b) => b.status === "notarized").flatMap((b) => b.evidence.map((e) => e.probeId)))];
  registry.sync(compileGuards({ beliefs, claimFor, probes: db.loadProbesByIds(cited), now }));
  const gate = createGate({ beliefs: () => store.list(), probesForClaims: (ids) => db.loadProbesByClaims(ids) });
  return { store, registry, wrap: guarded(registry), gate, beliefsBefore: beliefs, retired, unwire };
}

// ---------------------------------------------------------------------------------------------

export async function runQueue(opts: RunQueueOptions): Promise<RunQueueResult> {
  if (opts.resume) return resumeQueue(opts);
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const started = now();
  const guardedRun = opts.variant === "guarded";

  // Inputs.
  if (!opts.queueFile) throw new Error("run needs --queue <file>");
  const queuePath = resolveInputPath(opts.queueFile, env);
  const queue: QueueRequest[] = z.array(QueueRequestSchema).parse(readJson(queuePath, "queue file"));
  const expectedPath = opts.expectedFile ? resolveInputPath(opts.expectedFile, env) : join(dirname(queuePath), "expected.json");
  const expected: ExpectedEntry[] = ExpectedFileSchema.parse(readJson(expectedPath, "expected outcomes file"));

  let runId: string;
  let cassetteName: string;
  let manifest: SeedManifest;
  let tools: RunTools;
  let db: NotaryDb | undefined;
  let gctx: GuardedContext | undefined;
  const ownDb = guardedRun && !opts.db;
  try {
    if (opts.mode === "replay") {
      if (!opts.cassette) throw new Error("replay needs a cassette name (--replay <cassette>)");
      cassetteName = opts.cassette;
      const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;
      if (!opts.tools && !opts.makeTools && !listCassettes(cassetteDir).includes(cassetteName)) {
        return {
          exitCode: 1,
          lines: [`No cassette ${cassetteName} in ${cassetteDir}; record one first with a live \`notary run\`.`],
          status: "failed",
        };
      }
    } else if (!opts.tools && !opts.makeTools) {
      // Fail fast, before any request, file or store, when a key is missing.
      requireKeys(env);
    }
    if (guardedRun) {
      db = opts.db ?? openDb(opts.dbPath ?? DEFAULT_DB_PATH);
      gctx = loadGuardedContext(db, now);
    }
    const wrap = gctx?.wrap ?? identityWrap;
    if (opts.mode === "replay") {
      cassetteName = opts.cassette!;
      if (opts.tools) {
        runId = `${cassetteName}-replay`;
        tools = opts.tools;
      } else if (opts.makeTools) {
        runId = `${cassetteName}-replay`;
        tools = opts.makeTools(wrap);
      } else {
        const cassette = loadCassette(cassetteName, opts.cassetteDir === undefined ? {} : { dir: opts.cassetteDir });
        runId = `${cassetteName}-replay-${cassette.contentHash.slice(0, 12)}`;
        tools = createTools({ mode: "replay", cassettes: [cassette], wrap, ...(opts.cassetteDir === undefined ? {} : { cassetteDir: opts.cassetteDir }) });
      }
    } else {
      runId = `run-${opts.variant}-${compactStamp(started)}`;
      cassetteName = runId;
      tools =
        opts.tools ??
        opts.makeTools?.(wrap) ??
        createTools({
          mode: "live",
          cassette: cassetteName,
          ledger: new CreditLedger({ env }),
          env,
          wrap,
          ...(opts.cassetteDir === undefined ? {} : { cassetteDir: opts.cassetteDir }),
        });
    }
    manifest = opts.manifest ?? loadManifest();
  } catch (err) {
    gctx?.unwire();
    if (ownDb) db?.close();
    const b = blocked(err);
    if (b) return b;
    throw err;
  }

  const runState = guardedRun && db ? new RunStateStore(db, { now }) : undefined;
  try {
    let before: GroundTruthSnapshot;
    let after: GroundTruthSnapshot;
    let exec: Awaited<ReturnType<typeof executeQueue>>;
    try {
      before = await collectGroundTruth(tools, manifest, now);
      runState?.startRun(
        {
          runId,
          queueFile: queuePath,
          expectedFile: expectedPath,
          variant: opts.variant,
          mode: opts.mode,
          startedAt: started.toISOString(),
          cassettes: [cassetteName],
          before,
        },
        queue.map((r) => r.id),
      );
      exec = await executeQueue({
        queue,
        manifest,
        tools,
        variant: opts.variant,
        runId,
        ...(gctx ? { gate: opts.gate ?? gctx.gate } : {}),
        ...(runState ? { runState: runState.hooks(runId) } : {}),
        onDecision: (d) => emitEvent("decision", { runId, variant: opts.variant, decision: d }),
        ...(opts.policy ? { policy: opts.policy } : {}),
        ...(opts.clientTimeoutMs === undefined ? {} : { clientTimeoutMs: opts.clientTimeoutMs }),
        now,
      });
      after = await collectGroundTruth(tools, manifest, now);
    } catch (err) {
      const b = blocked(err);
      if (b) return b;
      if (runState) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${msg}\nRun ${runId} interrupted; its state is saved. Continue with: notary run --resume --run ${runId}`, { cause: err });
      }
      throw err;
    }

    return await writeRunBundle({
      opts,
      runId,
      started,
      now,
      queue,
      queuePath,
      expectedPath,
      expected,
      before,
      after,
      exec,
      tools,
      manifest,
      cassettes: [cassetteName],
      ...(opts.mode === "replay" ? { replayOf: cassetteName } : {}),
      ...(gctx ? { gctx } : {}),
      ...(runState ? { runState } : {}),
    });
  } finally {
    gctx?.unwire();
    if (ownDb) db?.close();
  }
}

/** `notary run --resume [--run <runId>]`: continue an interrupted guarded run. */
async function resumeQueue(opts: RunQueueOptions): Promise<RunQueueResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const ownDb = !opts.db;
  const db = opts.db ?? openDb(opts.dbPath ?? DEFAULT_DB_PATH);
  let gctx: GuardedContext | undefined;
  try {
    const runState = new RunStateStore(db, { now });
    const meta = opts.runId ? runState.meta(opts.runId) : runState.latestIncomplete();
    if (!meta) {
      return { exitCode: 1, lines: [opts.runId ? `No run ${opts.runId} in ${db.path}.` : `No interrupted run to resume in ${db.path}.`], status: "failed" };
    }
    const items = runState.items(meta.runId);
    if (meta.finishedAt) {
      return { exitCode: 1, lines: [`Run ${meta.runId} already finished at ${meta.finishedAt}; nothing to resume.`], status: "failed" };
    }
    if (meta.variant !== "guarded") return { exitCode: 1, lines: [`Run ${meta.runId} is ${meta.variant}; only guarded runs persist state.`], status: "failed" };
    if (meta.mode !== "live") return { exitCode: 1, lines: [`Run ${meta.runId} was a replay; replay it again instead of resuming.`], status: "failed" };

    const queue: QueueRequest[] = z.array(QueueRequestSchema).parse(readJson(meta.queueFile, "queue file"));
    const expected: ExpectedEntry[] = ExpectedFileSchema.parse(readJson(meta.expectedFile, "expected outcomes file"));

    let tools: RunTools;
    let manifest: SeedManifest;
    const cassetteName = `${meta.runId}-resume-${compactStamp(now())}`;
    try {
      if (!opts.tools && !opts.makeTools) requireKeys(env);
      gctx = loadGuardedContext(db, now);
      tools =
        opts.tools ??
        opts.makeTools?.(gctx.wrap) ??
        createTools({
          mode: "live",
          cassette: cassetteName,
          ledger: new CreditLedger({ env }),
          env,
          wrap: gctx.wrap,
          ...(opts.cassetteDir === undefined ? {} : { cassetteDir: opts.cassetteDir }),
        });
      manifest = opts.manifest ?? loadManifest();
    } catch (err) {
      const b = blocked(err);
      if (b) return b;
      throw err;
    }
    runState.addCassette(meta.runId, cassetteName);

    const resume = new Map<string, ResumeEntry>(
      items.map((i) => [
        i.requestId,
        { state: i.state, ...(i.decision ? { decision: i.decision } : {}), ...(i.lastWrite ? { lastWrite: i.lastWrite } : {}) },
      ]),
    );
    const inFlight = items.filter((i) => i.state === "in_flight").map((i) => i.requestId);
    let after: GroundTruthSnapshot;
    let exec: Awaited<ReturnType<typeof executeQueue>>;
    try {
      exec = await executeQueue({
        queue,
        manifest,
        tools,
        variant: "guarded",
        runId: meta.runId,
        gate: opts.gate ?? gctx.gate,
        runState: runState.hooks(meta.runId),
        resume,
        onDecision: (d) => emitEvent("decision", { runId: meta.runId, variant: "guarded", decision: d }),
        ...(opts.policy ? { policy: opts.policy } : {}),
        ...(opts.clientTimeoutMs === undefined ? {} : { clientTimeoutMs: opts.clientTimeoutMs }),
        now,
      });
      after = await collectGroundTruth(tools, manifest, now);
    } catch (err) {
      const b = blocked(err);
      if (b) return b;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg}\nRun ${meta.runId} interrupted again; continue with: notary run --resume --run ${meta.runId}`, { cause: err });
    }

    const resumeNotes = [
      `Resumed run: interrupted, then continued with --resume at ${now().toISOString()}; ${exec.resumedDone?.length ?? 0} item(s) carried over as done${
        inFlight.length ? `; in flight at the crash: ${inFlight.join(", ")} (read back before any retry)` : ""
      }.`,
    ];
    return await writeRunBundle({
      opts: { ...opts, variant: "guarded", mode: "live" },
      runId: meta.runId,
      started: new Date(meta.startedAt),
      now,
      queue,
      queuePath: meta.queueFile,
      expectedPath: meta.expectedFile,
      expected,
      before: meta.before,
      after,
      exec,
      tools,
      manifest,
      cassettes: [...meta.cassettes, cassetteName],
      extraDisclosure: resumeNotes,
      gctx,
      runState,
    });
  } finally {
    gctx?.unwire();
    if (ownDb) db.close();
  }
}

// ---------------------------------------------------------------------------------------------

async function writeRunBundle(a: {
  opts: RunQueueOptions;
  runId: string;
  started: Date;
  now: () => Date;
  queue: QueueRequest[];
  queuePath: string;
  expectedPath: string;
  expected: ExpectedEntry[];
  before: GroundTruthSnapshot | null;
  after: GroundTruthSnapshot;
  exec: Awaited<ReturnType<typeof executeQueue>>;
  tools: RunTools;
  manifest: SeedManifest;
  cassettes: string[];
  replayOf?: string;
  extraDisclosure?: string[];
  gctx?: GuardedContext;
  runState?: RunStateStore;
}): Promise<RunQueueResult> {
  const { opts, exec, before, after, runId } = a;
  const graded = gradeRun({
    decisions: exec.decisions,
    expected: a.expected,
    groundTruth: { before, after },
    queue: a.queue,
    itemsTotal: a.queue.length,
  });

  const queueRel = displayPath(a.queuePath);
  const disclosure = [
    `Seeded queue: ${queueRel} (SEEDED FIXTURE)`,
    `Expected outcomes: ${displayPath(a.expectedPath)}, hand-written from the policy table before any run.`,
    "Dodo Payments test mode only.",
    opts.variant === "naive"
      ? "Naive variant (run-1 baseline): no gating, no guards; trusts the docs (one page of refunds/payments, retries a write once after timeout/5xx)."
      : "Guarded variant: every tool call goes through guards compiled from notarized beliefs; irreversible actions run only when all their required beliefs are notarized, else held with an evidence pack; writes are never retried blindly (read back first).",
    "Graded deterministically from Dodo state read back by full pagination before and after the run; no LLM grades anything.",
  ];
  if (a.gctx) {
    const active = a.gctx.registry.all().filter((g) => g.active).length;
    const notarized = a.gctx.beliefsBefore.filter((b) => b.status === "notarized").length;
    disclosure.push(`Guards: ${active} active, compiled from ${notarized} notarized belief(s) in the Notary store.`);
    for (const [action, gap] of Object.entries(REQUIRED_GAPS)) disclosure.push(`Required-beliefs gap (${action}): ${gap}`);
    if (a.gctx.retired.length) disclosure.push(`Guards retired during the run (belief left notarized): ${a.gctx.retired.map((g) => g.id).join(", ")}`);
  }
  if (!before || !after.complete || !before.complete) {
    const problems = [...(before?.problems ?? ["no ground truth from before the run"]), ...after.problems];
    disclosure.push(`Ground truth incomplete (${problems.join("; ")}); unsafe-action metrics are null.`);
  }
  if (opts.mode === "replay") disclosure.push(`Replayed from cassette ${a.cassettes[0]}; no network calls.`);
  disclosure.push(...(a.extraDisclosure ?? []));
  for (const n of exec.notes) disclosure.push(`${opts.variant === "naive" ? "Client timeout" : "Note"}: ${n}`);
  if (exec.notProcessed.length) disclosure.push(`Not processed (budget stop): ${exec.notProcessed.join(", ")}`);

  const traceLinks: Record<string, string> = {};
  for (const d of graded.decisions as Decision[]) Object.assign(traceLinks, d.evidencePack?.traceLinks ?? {});

  const snap = a.tools.ledger.snapshot();
  const manifestCassette = (a.manifest as unknown as { cassette?: unknown }).cassette;
  const status: RunBundle["status"] = exec.stopReason ? "stopped_budget" : "completed";
  const beliefsAfter = a.gctx ? a.gctx.store.list() : [];
  const bundle = finalizeBundle({
    runId,
    kind: "run",
    variant: opts.variant,
    mode: opts.mode,
    sample: false,
    disclosure,
    startedAt: a.started.toISOString(),
    finishedAt: a.now().toISOString(),
    status,
    ...(exec.stopReason ? { stopReason: exec.stopReason } : {}),
    seed: 0,
    ...(a.replayOf ? { replayOf: a.replayOf } : {}),
    queue: a.queue,
    decisions: graded.decisions,
    claims: [],
    anomalies: [],
    hypotheses: [],
    probes: [],
    beliefs: { before: a.gctx?.beliefsBefore ?? [], after: beliefsAfter },
    beliefEvents: [],
    guards: a.gctx ? a.gctx.registry.all() : [],
    usageByRole: { executor: ZERO_USAGE, reflector: ZERO_USAGE, adversary: ZERO_USAGE },
    credits: { byEndpoint: snap.byEndpoint, total: snap.total, budget: snap.budget },
    metrics: graded.metrics,
    traceLinks,
    cassettes: [...a.cassettes, ...(typeof manifestCassette === "string" && manifestCassette ? [manifestCassette] : [])],
  });

  const { bundlePath } = await writeBundle(bundle, join(opts.runsDir ?? RUNS_DIR, runId));
  a.runState?.finishRun(runId);
  emitEvent("run.finished", { runId, variant: opts.variant, status, metrics: graded.metrics, bundlePath });
  const webDir = opts.webBundlesDir === undefined ? WEB_BUNDLES_DIR : opts.webBundlesDir;
  const lines = [
    `run --${opts.variant}: mode=${opts.mode} queue=${queueRel} items=${a.queue.length} status=${status}`,
    `runId: ${runId}  cassette: ${a.cassettes[a.cassettes.length - 1]}`,
    ...(exec.stopReason ? [`STOPPED: ${exec.stopReason}`] : []),
    ...(a.gctx ? [`guards: ${a.gctx.registry.all().filter((g) => g.active).length} active`] : []),
    ...Object.entries(graded.metrics).map(([k, v]) => `  ${k}: ${v === null ? "null" : v}`),
    `credits: ${snap.total}/${snap.budget}`,
    `bundle: ${bundlePath}`,
  ];
  if (webDir !== null) {
    const web = await writeBundle(bundle, webDir);
    lines.push(`dashboard copy: ${web.bundlePath}`);
  }
  return { exitCode: 0, lines, status, runId, bundlePath, metrics: graded.metrics };
}
