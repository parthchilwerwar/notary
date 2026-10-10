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
 *
 * Re-verification sentinel (guarded, DECISIONS #105; `NOTARY_SENTINEL=transform|off`, default
 * transform): before a write an active transform guard would rewrite, the belief's own experiment is
 * re-run on probe-only resources with RAW tools recording into cassette `<runId>-sentinel`; its
 * probes, rivals and the belief events of the run land in the bundle like any other probes.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { emitEvent } from "../api/bus.js";
import { BeliefStore, beliefIdFor } from "../beliefs/store.js";
import { finalizeBundle, writeBundle } from "../bundle/index.js";
import type { UnhashedBundle } from "../bundle/index.js";
import { consolidateMetrics, withMetricDisclosures } from "../eval/metrics.js";
import { INPUTS_VERSION, pinFile, saveInputs, snapshotStore } from "../replay/inputs.js";
import type { StoreSnapshot } from "../replay/inputs.js";
import { pinIfPresent } from "../replay/pins.js";
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
import { DEFAULT_CLIENT_TIMEOUT_MS, executeQueue } from "./executor.js";
import type { GateHook, PolicyFns, QueueTools, ResumeEntry } from "./executor.js";
import { createGate } from "./gate.js";
import { bundleTraceLinks } from "../trace/links.js";
import { ExpectedFileSchema, collectGroundTruth, gradeRun } from "./grader.js";
import type { ExpectedEntry, GroundTruthSnapshot } from "./grader.js";
import { DEFAULT_MANIFEST_PATH, loadManifest } from "./manifest.js";
import type { SeedManifest } from "./manifest.js";
import { REQUIRED_GAPS } from "./required.js";
import { RunStateStore } from "./run-state.js";
import { createSentinel, sentinelModeFromEnv } from "./sentinel.js";
import { liveDecisionEmitter, publishTimeline, recordRunTimeline } from "../timeline/write.js";
import type { Sentinel, SentinelMode } from "./sentinel.js";
import { SimplePaymentPool, probeIoFromTools } from "../reflect/templates/index.js";
import { probePoolFromManifest, sentinelProbeTools } from "../reflect/notarize.js";

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
  /** Resume: the run to continue. Live (not resume): override the default `run-<variant>-<stamp>` runId (demo). */
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
  // ---- P8 replay -----------------------------------------------------------------------------
  /** Seed manifest file (default fixtures/seed/manifest.json); its sha256 goes in the replay record. */
  manifestPath?: string;
  /** Live: write the replay record cassette `<runId>-inputs` (default true for real live runs). */
  recordReplay?: boolean;
  /** Credit budget; replay passes the recorded one (default: env, or the default budget in replay). */
  creditBudget?: number;
  /** Replay: more pinned cassette refs to list in the bundle (the replay record). */
  extraCassettes?: string[];
  /** unguarded_call_sites for bundle.metrics (the CLI runs the coverage check); default null. */
  unguardedCallSites?: () => Promise<number | null>;
  /** Guarded: re-verification sentinel mode (default: NOTARY_SENTINEL in env, else "transform"). */
  sentinel?: SentinelMode;
  /** Guarded test seam: RAW tools for sentinel probes when `tools`/`makeTools` are injected (else the sentinel is off). */
  sentinelProbeTools?: Tools;
  /** Guarded: sentinel caps (defaults in sentinel.ts). */
  sentinelMaxProbesPerCheck?: number;
  sentinelMaxProbesPerRun?: number;
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

/** The keys a live `notary run` needs, in the order a missing one is reported (also `POST /api/runs`). */
export const QUEUE_RUN_KEYS = ["DODO_PAYMENTS_API_KEY", "CRUSTDATA_API_KEY"] as const;

function requireKeys(env: NodeJS.ProcessEnv): void {
  for (const v of QUEUE_RUN_KEYS) if (!env[v]?.trim()) throw new MissingCredentialError(v);
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
  let snapshot: StoreSnapshot | null = null;
  const ownDb = guardedRun && !opts.db;
  // P8: a real live run writes a replay record (inputs, parameters, the store before the run).
  const record = opts.mode === "live" && opts.recordReplay !== false && !opts.tools && !opts.makeTools;
  const cassetteDirOrDefault = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;
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
      if (record) snapshot = snapshotStore(db);
      gctx = loadGuardedContext(db, now);
    }
    const wrap = gctx?.wrap ?? identityWrap;
    // P9 (AUDIT-10): the coverage check allow-lists this file's identity wrap for the naive baseline
    // only; this runtime invariant is what proves a guarded run never gets the identity wrap.
    if (guardedRun && (!gctx || wrap === identityWrap)) throw new Error("guarded run without the guarded wrap (refusing to run unguarded)");
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
        tools = createTools({
          mode: "replay",
          cassettes: [cassette],
          wrap,
          ledger: new CreditLedger(opts.creditBudget === undefined ? { env: {} } : { budget: opts.creditBudget }),
          ...(opts.cassetteDir === undefined ? {} : { cassetteDir: opts.cassetteDir }),
        });
      }
    } else {
      runId = opts.runId ?? `run-${opts.variant}-${compactStamp(started)}`;
      cassetteName = runId;
      tools =
        opts.tools ??
        opts.makeTools?.(wrap) ??
        createTools({
          mode: "live",
          cassette: cassetteName,
          ledger: new CreditLedger(opts.creditBudget === undefined ? { env } : { budget: opts.creditBudget }),
          env,
          wrap,
          ...(opts.cassetteDir === undefined ? {} : { cassetteDir: opts.cassetteDir }),
        });
    }
    manifest = opts.manifest ?? loadManifest(opts.manifestPath);
  } catch (err) {
    gctx?.unwire();
    if (ownDb) db?.close();
    const b = blocked(err);
    if (b) return b;
    throw err;
  }

  const runState = guardedRun && db ? new RunStateStore(db, { now }) : undefined;
  let sentinelSetup: SentinelSetup | undefined;
  try {
    sentinelSetup = gctx && db ? setupSentinel({ opts, env, now, db, gctx, tools, manifest, queuePath, identity: opts.mode === "replay" ? cassetteName : runId, cassetteDir: cassetteDirOrDefault }) : undefined;
  } catch (err) {
    gctx?.unwire();
    if (ownDb) db?.close();
    const b = blocked(err);
    if (b) return b;
    throw err;
  }
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
        ...(sentinelSetup?.sentinel ? { sentinel: sentinelSetup.sentinel.check } : {}),
        ...(runState ? { runState: runState.hooks(runId) } : {}),
        onDecision: ((live) => (d: Decision) => {
          emitEvent("decision", { runId, variant: opts.variant, decision: d });
          live(d);
        })(liveDecisionEmitter(runId, queue, now)),
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

    const extraCassettes = [...(opts.extraCassettes ?? [])];
    if (record) {
      const manifestFile = opts.manifest ? undefined : (opts.manifestPath ?? DEFAULT_MANIFEST_PATH);
      saveInputs(
        `${runId}-inputs`,
        {
          version: INPUTS_VERSION,
          runId,
          kind: "run",
          variant: opts.variant,
          seed: 0,
          identityRunId: runId,
          params: { creditBudget: tools.ledger.budget, clientTimeoutMs: opts.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS },
          files: {
            queue: pinFile(queuePath),
            expected: pinFile(expectedPath),
            ...(manifestFile && existsSync(manifestFile) ? { manifest: pinFile(manifestFile) } : {}),
          },
          store: snapshot,
        },
        cassetteDirOrDefault,
      );
      extraCassettes.push(pinIfPresent(`${runId}-inputs`, cassetteDirOrDefault));
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
      extraCassettes,
      cassettes: [cassetteName],
      ...(opts.mode === "replay" ? { replayOf: cassetteName } : {}),
      ...(gctx ? { gctx } : {}),
      ...(runState ? { runState } : {}),
      ...(sentinelSetup ? { sentinel: sentinelSetup } : {}),
    });
  } finally {
    gctx?.unwire();
    if (ownDb) db?.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Re-verification sentinel setup

interface SentinelSetup {
  mode: SentinelMode;
  sentinel?: Sentinel;
  /** The sentinel's cassette (pinned in the bundle when it recorded anything). */
  cassette?: string;
  /** Why the sentinel is not running, when it is not. */
  off?: string;
  /** Belief events before the run (the bundle carries the run's own events). */
  eventsSince: number;
}

function setupSentinel(a: {
  opts: RunQueueOptions;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  db: NotaryDb;
  gctx: GuardedContext;
  tools: RunTools;
  manifest: SeedManifest;
  queuePath: string;
  identity: string;
  cassetteDir: string;
}): SentinelSetup {
  const { opts } = a;
  const eventsSince = a.gctx.store.lastEventSeq();
  const mode = opts.sentinel ?? sentinelModeFromEnv(opts.mode === "replay" ? {} : a.env);
  if (mode === "off") return { mode, off: `off (${opts.sentinel ? "option" : "NOTARY_SENTINEL=off"})`, eventsSince };
  const cassette = `${a.identity}-sentinel`;
  let probeTools: Tools | undefined;
  if (opts.tools || opts.makeTools) {
    probeTools = opts.sentinelProbeTools;
    if (!probeTools) return { mode, off: "off (test seam: injected tools and no raw sentinel probe tools)", eventsSince };
  } else if (opts.mode === "replay") {
    if (!listCassettes(a.cassetteDir).includes(cassette)) return { mode, off: `off in replay (no recorded ${cassette} cassette: the recorded run ran no sentinel probe)`, eventsSince };
    probeTools = sentinelProbeTools({ mode: "replay", cassette, cassetteDir: a.cassetteDir, ledger: a.tools.ledger, env: {} });
  } else {
    probeTools = sentinelProbeTools({ mode: "live", cassette, cassetteDir: a.cassetteDir, ledger: a.tools.ledger, env: a.env });
  }
  const queueText = existsSync(a.queuePath) ? readFileSync(a.queuePath, "utf8") : "";
  const pool = probePoolFromManifest(a.manifest, queueText);
  const sentinel = createSentinel({
    db: a.db,
    store: a.gctx.store,
    registry: a.gctx.registry,
    io: probeIoFromTools(probeTools),
    ledger: a.tools.ledger,
    identity: a.identity,
    payments: new SimplePaymentPool(pool.ids),
    subscriptions: new SimplePaymentPool(pool.subscriptionIds),
    ...(opts.sentinelMaxProbesPerCheck === undefined ? {} : { maxProbesPerCheck: opts.sentinelMaxProbesPerCheck }),
    ...(opts.sentinelMaxProbesPerRun === undefined ? {} : { maxProbesPerRun: opts.sentinelMaxProbesPerRun }),
    // Replay never writes into the recorded run's directory.
    spansPath: opts.mode === "live" ? join(opts.runsDir ?? RUNS_DIR, a.identity, "spans.jsonl") : null,
    now: a.now,
  });
  return { mode, sentinel, cassette, eventsSince };
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
    // The resumed half gets its own sentinel identity (probe ids <runId>-resume-<stamp>-sNNN never collide).
    const sentinelSetup = setupSentinel({ opts: { ...opts, mode: "live" }, env, now, db, gctx, tools, manifest, queuePath: meta.queueFile, identity: cassetteName, cassetteDir: opts.cassetteDir ?? DEFAULT_CASSETTE_DIR });

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
        ...(sentinelSetup.sentinel ? { sentinel: sentinelSetup.sentinel.check } : {}),
        runState: runState.hooks(meta.runId),
        resume,
        onDecision: ((live) => (d: Decision) => {
          emitEvent("decision", { runId: meta.runId, variant: "guarded", decision: d });
          live(d);
        })(liveDecisionEmitter(meta.runId, queue, now)),
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
      sentinel: sentinelSetup,
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
  /** Already-pinned refs appended after the tool and manifest cassettes. */
  extraCassettes?: string[];
  replayOf?: string;
  extraDisclosure?: string[];
  gctx?: GuardedContext;
  runState?: RunStateStore;
  sentinel?: SentinelSetup;
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
  const sentinelProbes = a.sentinel?.sentinel?.probes ?? [];
  const sentinelChecks = a.sentinel?.sentinel?.checks ?? [];
  if (a.sentinel?.off && opts.sentinel === "off") disclosure.push(`Re-verification sentinel: ${a.sentinel.off}.`);
  if (sentinelChecks.length) {
    const left = [...new Set(sentinelChecks.filter((c) => c.outcome === "left_notarized").map((c) => c.beliefId))];
    disclosure.push(
      `Re-verification sentinel (DECISIONS #105, mode ${a.sentinel!.mode}): ${sentinelChecks.length} check(s) before transform-rewritten writes, ${sentinelProbes.length} probe(s) committed then run on probe-only resources with raw tools (cassette ${a.sentinel!.cassette}); belief updates by BeliefStore's rules only${left.length ? `; left notarized: ${left.join(", ")}` : ""}.`,
    );
  }
  if (!before || !after.complete || !before.complete) {
    const problems = [...(before?.problems ?? ["no ground truth from before the run"]), ...after.problems];
    disclosure.push(`Ground truth incomplete (${problems.join("; ")}); unsafe-action metrics are null.`);
  }
  if (opts.mode === "replay") disclosure.push(`Replayed from cassette ${a.cassettes[0]}; no network calls.`);
  disclosure.push(...(a.extraDisclosure ?? []));
  for (const n of exec.notes) disclosure.push(`${opts.variant === "naive" ? "Client timeout" : "Note"}: ${n}`);
  if (exec.notProcessed.length) disclosure.push(`Not processed (budget stop): ${exec.notProcessed.join(", ")}`);

  // Local spans.jsonl receipts from the gate's evidence packs; a receipt becomes a neatlogs URL only
  // when a trace link template exists and the trace was exported (src/trace/links.ts).
  const receipts: Record<string, string> = {};
  for (const d of graded.decisions as Decision[]) Object.assign(receipts, d.evidencePack?.traceLinks ?? {});
  const traceLinks = bundleTraceLinks({ fallback: receipts, runsDir: opts.runsDir ?? RUNS_DIR, ...(opts.env ? { env: opts.env } : {}) });

  const snap = a.tools.ledger.snapshot();
  const manifestCassette = (a.manifest as unknown as { cassette?: unknown }).cassette;
  const status: RunBundle["status"] = exec.stopReason ? "stopped_budget" : "completed";
  const beliefsAfter = a.gctx ? a.gctx.store.list() : [];
  const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;
  const draft: UnhashedBundle = {
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
    hypotheses: a.sentinel?.sentinel?.hypotheses ?? [],
    probes: sentinelProbes,
    beliefs: { before: a.gctx?.beliefsBefore ?? [], after: beliefsAfter },
    beliefEvents: a.gctx && a.sentinel ? a.gctx.store.events(undefined, a.sentinel.eventsSince) : [],
    guards: a.gctx ? a.gctx.registry.all() : [],
    usageByRole: { executor: ZERO_USAGE, reflector: ZERO_USAGE, adversary: ZERO_USAGE },
    credits: { byEndpoint: snap.byEndpoint, total: snap.total, budget: snap.budget },
    metrics: graded.metrics,
    traceLinks,
    // P8: every cassette pinned to its content hash, then the replay record.
    cassettes: [
      ...[...a.cassettes, ...(typeof manifestCassette === "string" && manifestCassette ? [manifestCassette] : [])].map((c) => pinIfPresent(c, cassetteDir)),
      ...(a.sentinel?.cassette && sentinelProbes.length && existsSync(join(cassetteDir, `${a.sentinel.cassette}.json`)) ? [pinIfPresent(a.sentinel.cassette, cassetteDir)] : []),
      ...(a.extraCassettes ?? []),
    ],
  };
  const unguarded = opts.unguardedCallSites ? await opts.unguardedCallSites() : null;
  const bundle = finalizeBundle(withMetricDisclosures({ ...draft, metrics: consolidateMetrics(draft, { unguardedCallSites: unguarded }) }));
  const metrics = bundle.metrics;

  const { bundlePath } = await writeBundle(bundle, join(opts.runsDir ?? RUNS_DIR, runId));
  recordRunTimeline(bundle, join(opts.runsDir ?? RUNS_DIR, runId), { runsDir: opts.runsDir ?? RUNS_DIR });
  a.runState?.finishRun(runId);
  emitEvent("run.finished", { runId, variant: opts.variant, status, metrics, bundlePath });
  const webDir = opts.webBundlesDir === undefined ? WEB_BUNDLES_DIR : opts.webBundlesDir;
  const lines = [
    `run --${opts.variant}: mode=${opts.mode} queue=${queueRel} items=${a.queue.length} status=${status}`,
    `runId: ${runId}  cassette: ${a.cassettes[a.cassettes.length - 1]}`,
    ...(exec.stopReason ? [`STOPPED: ${exec.stopReason}`] : []),
    ...(a.gctx ? [`guards: ${a.gctx.registry.all().filter((g) => g.active).length} active`] : []),
    ...Object.entries(metrics).map(([k, v]) => `  ${k}: ${v === null ? "null" : v}`),
    `credits: ${snap.total}/${snap.budget}`,
    `bundle: ${bundlePath}`,
  ];
  if (webDir !== null) {
    const web = await writeBundle(bundle, webDir);
    await publishTimeline(bundle, webDir, { expectSample: false, runDir: join(opts.runsDir ?? RUNS_DIR, runId), runsDir: opts.runsDir ?? RUNS_DIR });
    lines.push(`dashboard copy: ${web.bundlePath}`);
  }
  return { exitCode: 0, lines, status, runId, bundlePath, metrics };
}
