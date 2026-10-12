/**
 * `notary notarize --tool <t> [--replay]`: recon -> deterministic checker -> probe loop, then a
 * notarize bundle in packages/core/runs/<runId>/.
 *
 * live   — recon records into cassette `<runId>-recon`, probes into `<runId>-probes` (copied to the
 *          `recon-<tool>` / `probes-<tool>` "latest" aliases afterwards); P8 also writes the model
 *          cassette `<runId>-llm` and the replay record `<runId>-inputs` (store snapshot, parameters),
 *          and pins all four in bundle.cassettes as `<name>@<sha256>`.
 * replay — the cassettes are served (no tool network, no tool keys). `notary replay` also serves the
 *          model answers (src/replay/llm-cassette.ts) and restores the store snapshot; probe ids and
 *          request tags use `identityRunId` (the recorded run's id), never the replay's own runId.
 * BLOCKED (exit 3) before any network call when a tool key (live), the reflector model id or the
 * provider's connection settings (LITELLM_BASE_URL + LITELLM_API_KEY, or AWS_REGION; see
 * src/llm/config.ts) are missing; also when a credential error surfaces mid-run.
 *
 * P5 beliefs phase (src/beliefs/phase.ts) runs after runProbeLoop: ensure a belief per claim,
 * apply every probe (only "confirmed" moves α/β), abstain what ended between thresholds, check
 * every cited span (FR-10, from runs/<runId>/spans.jsonl written by the local span sink), then
 * the adversary (`--adversary bedrock|session`, default bedrock) reviews each candidate. A missing
 * adversary model prints BLOCKED and leaves the candidates as candidates (exit 3).
 *
 * Re-examination (DECISIONS #85): a candidate the adversary DOWNGRADES gets one bounded extra round in
 * the same run — never-applied designs only (the template the adversary's reason names first), the
 * same ledger / burst counter / payment pools / per-run probe cap, then the evidence check and ONE more
 * adversary review of those claims. Still not candidate -> abstained ("re-examined after downgrade").
 *
 * P7 transfer priors (`--priors-from <tool>` [`--priors-bundle <path>`]): the source tool's latest
 * notarize bundle (runs/<runId>/<runId>.json, hash-verified) gives per-defect-class base rates and
 * each NEW belief of this run starts from its claim's transfer prior (src/beliefs/priors.ts).
 * Beliefs that already exist in the store keep their state. No source bundle -> BLOCKED (exit 3).
 * Every notarize bundle records probes_to_candidate_<claimId> (null if never reached) and
 * probes_to_candidate_mean; with priors also priors_strength / priors_applied / priors_informative
 * and bundle.priorsFrom.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeBundle, verifyBundle, writeBundle } from "../bundle/index.js";
import type { UnhashedBundle } from "../bundle/index.js";
import { recordRunTimeline } from "../timeline/write.js";
import { incidentsLine, recordRunIncidents } from "../incidents/record.js";
import { enterIncidentRun, withIncidentRun } from "../incidents/live.js";
import { consolidateMetrics, withMetricDisclosures } from "../eval/metrics.js";
import { cassetteNames, pinIfPresent } from "../replay/pins.js";
import { INPUTS_VERSION, saveInputs, snapshotStore } from "../replay/inputs.js";
import { RecordingLlm } from "../replay/llm-cassette.js";
import { RUNS_DIR } from "../checker/notarize.js";
import { bundleTraceLinks } from "../trace/links.js";
import { observedClaimIds } from "../checker/check.js";
import { runRecon } from "../checker/recon.js";
import type { ReconResult } from "../checker/recon.js";
import { LlmClient, ModelConfigError, llmConfigIssues } from "../llm/index.js";
import type { LlmLike, UsageMeter } from "../llm/index.js";
import { reviewBelief } from "../adversary/index.js";
import type { AdversaryBackend, ReviewBeliefArgs, ReviewOutcome } from "../adversary/index.js";
import { runBeliefsPhase } from "../beliefs/phase.js";
import { loadPriorsSource, priorStrengthFromEnv, probesToCandidateMetrics, transferPriors } from "../beliefs/priors.js";
import type { PriorsSource } from "../beliefs/priors.js";
import { BeliefStore, beliefIdFor } from "../beliefs/store.js";
import { claimById } from "../contracts/index.js";
import { GuardRegistry, compileGuards, wireRetirement } from "../guards/index.js";
import type { BeliefsPhaseResult } from "../beliefs/phase.js";
import { DEFAULT_MANIFEST_PATH, loadManifest } from "../queue/manifest.js";
import type { SeedManifest } from "../queue/manifest.js";
import { SEED_PLAN, probeHandles, refundedPaymentHandles } from "../queue/seed-plan.js";
import type { SeedPlan } from "../queue/seed-plan.js";
import type { Belief, Guard, Probe, RoleUsage, RunBundle, Tool, UsageByRole } from "../schema/index.js";
import { DEFAULT_DB_PATH, openDb } from "../store/db.js";
import type { NotaryDb } from "../store/db.js";
import { setSpanSink, spanSinkPath } from "../trace/index.js";
import {
  CreditLedger,
  DEFAULT_CASSETTE_DIR,
  TestModeLockError,
  budgetFromEnv,
  computeContentHash,
  createTools,
  isBlocked,
  listCassettes,
  loadCassette,
  saveCassette,
} from "../tools/index.js";
import type { Cassette, Tools } from "../tools/index.js";
import { MAX_PROBES_PER_RUN, REEXAMINED_AFTER_DOWNGRADE, maxProbesPerClaimFromEnv, runProbeLoop, templateNamedIn } from "./loop.js";
import { lambdaFromEnv } from "./score.js";
import type { ProbeLoopResult } from "./loop.js";
import { BurstCounter, SimplePaymentPool, probeIoFromTools } from "./templates/index.js";
import type { ProbeIo } from "./templates/index.js";

export const SEEDED_QUEUE_PATH = fileURLToPath(new URL("../../fixtures/queue/seeded.json", import.meta.url));

const TOOL_KEY: Record<Tool, string> = { crustdata: "CRUSTDATA_API_KEY", dodo: "DODO_PAYMENTS_API_KEY" };

const ZERO: RoleUsage = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };

export interface NotarizeOptions {
  tool: Tool;
  replay?: boolean;
  env?: NodeJS.ProcessEnv;
  runsDir?: string;
  cassetteDir?: string;
  dbPath?: string;
  /** Injected model client (tests); default LlmClient from env. */
  llm?: LlmLike & { meter?: UsageMeter };
  manifestPath?: string;
  queuePath?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Adversary backend for candidate beliefs (default bedrock). */
  adversary?: AdversaryBackend;
  /** Injected adversary reviewer (tests); default reviewBelief. */
  review?: (args: ReviewBeliefArgs) => Promise<ReviewOutcome>;
  /** P7: start new beliefs from transfer priors learned on this tool (its latest notarize bundle). */
  priorsFrom?: Tool;
  /** P7: use this notarize bundle as the priors source instead of the latest in runsDir. */
  priorsBundle?: string;
  /** P7: prior strength in pseudo-counts; default NOTARY_PRIOR_STRENGTH, else 2. */
  priorStrength?: number;
  // ---- P8 replay -----------------------------------------------------------------------------
  /** Live: write per-run cassettes, the model cassette and the replay record (default true). */
  recordReplay?: boolean;
  /** Replay: the recorded run whose probe ids / request tags the cassettes hold (default: this runId). */
  identityRunId?: string;
  /** Replay: cassettes to serve (default recon-<tool> / probes-<tool>, the latest recording). */
  reconCassette?: string;
  probesCassette?: string;
  /** Bundle runId override (replay: `<original>-replay`), and the run this one reproduces. */
  runId?: string;
  replayOf?: string;
  /** Use this store (not closed here) instead of opening dbPath; replay passes a restored scratch store. */
  db?: NotaryDb;
  /** Where span records are written and read back for the evidence check (default runsDir). */
  spansDir?: string;
  /** Run parameters; replay passes the recorded ones so nothing is read from the environment. */
  params?: Partial<NotarizeParams>;
  /** Replay: the recorded transfer-priors source instead of looking for its bundle. */
  priorsSourceRecord?: { from: Tool; runId: string; beliefsAfter: Belief[] };
  /** Replay: the recorded probe payment pool instead of the seed manifest. */
  paymentPool?: string[];
  /** Replay: the recorded probe subscription pool (change-plan probes) instead of the seed manifest. */
  subscriptionPool?: string[];
  /** Replay: more pinned cassette refs to list in the bundle (model cassette, replay record). */
  extraCassettes?: string[];
  /** unguarded_call_sites for bundle.metrics (the CLI runs the coverage check); default null. */
  unguardedCallSites?: () => Promise<number | null>;
}

/** Everything a notarize run would otherwise read from the environment (recorded for replay). */
export interface NotarizeParams {
  creditBudget: number;
  maxProbesPerClaim: number;
  /**
   * Per-run probe cap; omitted = MAX_PROBES_PER_RUN (30). Only the fixture demo raises it (in-process;
   * recorded in the run inputs so a replay reproduces it). Nothing reads it from the environment.
   */
  maxProbesPerRun?: number;
  lambda: number;
  priorStrength: number;
  adversary: AdversaryBackend;
}

/** What the bundle records about the transfer priors of a run. */
export interface PriorsContext {
  from: Tool;
  sourceRunId: string;
  strength: number;
  /** New beliefs created from a prior this run. */
  applied: number;
  /** Of those, priors other than Beta(1, 1). */
  informative: number;
  /** Beliefs that already existed (kept their state; no prior applied). */
  preexisting: number;
}

export interface NotarizeResult {
  exitCode: number;
  lines: string[];
  status: RunBundle["status"];
  runId?: string;
  bundlePath?: string;
  loop?: ProbeLoopResult;
  beliefs?: BeliefsPhaseResult;
}

function blocked(reasons: string[]): NotarizeResult {
  return { exitCode: 3, lines: reasons.map((r) => (r.startsWith("BLOCKED:") ? r : `BLOCKED: ${r}`)), status: "blocked" };
}

function compactStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * The raw (unguarded) REPLAY ProbeIo of every probing path: probes must see the raw recorded
 * response to confirm or refute a belief (DECISIONS #56), so this module is the one place outside
 * recon that builds unwrapped tools. Used by `--compare-priors` (src/reflect/compare-priors.ts)
 * and drift replay (src/beliefs/drift.ts). Replay only: no network, no keys.
 */
export function rawReplayProbeIo(opts: {
  cassette?: string;
  cassettes?: Cassette[];
  cassetteDir?: string;
  ledger: CreditLedger;
  env?: NodeJS.ProcessEnv;
}): ProbeIo {
  return probeIoFromTools(
    createTools({
      mode: "replay",
      ...(opts.cassette ? { cassette: opts.cassette } : {}),
      ...(opts.cassettes ? { cassettes: opts.cassettes } : {}),
      ...(opts.cassetteDir ? { cassetteDir: opts.cassetteDir } : {}),
      ledger: opts.ledger,
      env: opts.env ?? {},
    }),
  );
}

/**
 * The raw (unguarded) probe tools of the guarded run's re-verification sentinel (src/queue/sentinel.ts,
 * DECISIONS #105): a sentinel probe must see the raw response, never the guards it re-verifies (#56).
 * Live: records into `cassette`; replay: serves from it. Shares the run's credit ledger.
 */
export function sentinelProbeTools(o: {
  mode: "live" | "replay";
  cassette: string;
  cassetteDir?: string;
  ledger: CreditLedger;
  env: NodeJS.ProcessEnv;
}): Tools {
  return createTools({
    mode: o.mode,
    cassette: o.cassette,
    ledger: o.ledger,
    env: o.env,
    ...(o.cassetteDir === undefined ? {} : { cassetteDir: o.cassetteDir }),
  });
}

/**
 * Probe-reserved Dodo resources (DECISIONS #42, #81): never anything the seeded queue references.
 *
 * Payments: when the manifest holds the plan's PROBE-ONLY customer (seed-plan.ts `probe`; a customer
 * the queue never names), only its open (unrefunded) one-time payments, in handle order. Older
 * manifests without it fall back to every succeeded payment no queue item references, last handles
 * first. Payments the seed itself refunded are never offered (a refund probe on them proves nothing).
 * Subscriptions (change-plan probes): those of customers the queue never names (cust:/sub: refs), in
 * handle order.
 */
export function probePaymentPool(
  manifestPath: string,
  queuePath: string,
  plan: SeedPlan = SEED_PLAN,
): { ids: string[]; subscriptionIds: string[]; note?: string } {
  if (!existsSync(manifestPath)) return { ids: [], subscriptionIds: [], note: "no seed manifest: refund and change-plan probes are skipped" };
  const queueText = existsSync(queuePath) ? readFileSync(queuePath, "utf8") : "";
  return probePoolFromManifest(loadManifest(manifestPath), queueText, plan);
}

/** probePaymentPool over an already loaded manifest and the queue file's text (same rules). */
export function probePoolFromManifest(manifest: SeedManifest, queueText: string, plan: SeedPlan = SEED_PLAN): { ids: string[]; subscriptionIds: string[] } {
  const refs = (kind: string) => new Set([...queueText.matchAll(new RegExp(`"${kind}:([A-Za-z0-9._-]+)"`, "g"))].map((m) => m[1]!));
  const usedPay = refs("pay");
  const usedCust = refs("cust");
  const usedSub = refs("sub");
  const refunded = new Set(refundedPaymentHandles(plan));
  const usable = (handle: string): boolean => {
    const p = manifest.payments[handle];
    return p !== undefined && !usedPay.has(handle) && !usedCust.has(p.customerHandle) && p.status === "succeeded" && !refunded.has(handle);
  };
  const probe = probeHandles(plan);
  const reserved = !usedCust.has(probe.customer) && probe.openPayments.some((h) => manifest.payments[h]?.customerHandle === probe.customer);
  const ids = reserved
    ? probe.openPayments.filter(usable).map((h) => manifest.payments[h]!.paymentId)
    : Object.entries(manifest.payments)
        .filter(([handle, p]) => !usedPay.has(handle) && p.status === "succeeded" && !refunded.has(handle))
        .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
        .map(([, p]) => p.paymentId);
  const subscriptionIds = Object.entries(manifest.subscriptions)
    .filter(([handle, sub]) => !usedSub.has(handle) && !usedCust.has(sub.customerHandle))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, sub]) => sub.subscriptionId);
  return { ids, subscriptionIds };
}

/** runId of the newest LIVE notarize bundle of `tool` that recorded `probes-<tool>` (for tag alignment). */
export function recordedRunId(runsDir: string, tool: Tool): string | undefined {
  if (!existsSync(runsDir)) return undefined;
  let best: { runId: string; at: string } | undefined;
  for (const dir of readdirSync(runsDir).sort()) {
    const file = join(runsDir, dir, `${dir}.json`);
    if (!existsSync(file)) continue;
    let v;
    try {
      v = verifyBundle(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      continue;
    }
    if (!v.ok) continue;
    const b = v.bundle;
    if (b.sample || b.kind !== "notarize" || b.tool !== tool || b.mode !== "live" || !cassetteNames(b.cassettes).some((n) => n === `probes-${tool}` || n === `${b.runId}-probes`)) continue;
    const at = b.finishedAt ?? b.startedAt;
    if (!best || at > best.at) best = { runId: b.runId, at };
  }
  return best?.runId;
}

export function preflight(opts: Pick<NotarizeOptions, "tool" | "replay" | "llm">, env: NodeJS.ProcessEnv): { llm?: LlmLike & { meter?: UsageMeter }; result?: NotarizeResult } {
  const reasons: string[] = [];
  if (!opts.replay && !(env[TOOL_KEY[opts.tool]] ?? "").trim()) reasons.push(`${TOOL_KEY[opts.tool]} not set`);
  let llm = opts.llm;
  if (!llm) {
    let client: LlmClient;
    try {
      client = new LlmClient({ env });
    } catch (err) {
      if (err instanceof ModelConfigError) return { result: { exitCode: 1, lines: [err.message], status: "failed" } };
      throw err;
    }
    // Provider-aware (src/llm/config.ts): the reflector model id, then LiteLLM URL + key or AWS_REGION.
    for (const issue of llmConfigIssues(env, "reflector")) reasons.push(issue.message);
    llm = client;
  }
  if (reasons.length) return { result: blocked(reasons) };
  return { llm };
}

/** The verification-probe disclosure, with the number of probes that actually ran on those claims. */
export function verificationDisclosure(claims: readonly string[], probes: readonly Pick<Probe, "claimId">[]): string {
  const set = new Set(claims);
  const ran = probes.filter((p) => set.has(p.claimId));
  const probed = new Set(ran.map((p) => p.claimId)).size;
  const rivals = "a deterministic rival pair {honored, suspected class from src/contracts/priors-map.ts} built by code, not proposed by a model";
  const head = `Verification probes: ${claims.length} required claim(s) with no anomaly this run (${claims.join(", ")})`;
  return ran.length === 0
    ? `${head} had ${rivals}, but no verification probe ran on them in this run (0 probes).`
    : `${head}: ${ran.length} probe(s) ran on ${probed} of them against ${rivals}; same commit-then-run loop, caps and budget.`;
}

function countVerdicts(probes: readonly Probe[]): Record<string, number> {
  const out: Record<string, number> = { confirmed: 0, refuted: 0, inconclusive: 0, uninformative: 0, invalid: 0 };
  for (const p of probes) if (p.verdict) out[p.verdict] = (out[p.verdict] ?? 0) + 1;
  return out;
}

export async function notarize(opts: NotarizeOptions): Promise<NotarizeResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const mode = opts.replay ? "replay" : "live";
  const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;

  const runsDir = opts.runsDir ?? RUNS_DIR;

  // P7: the priors source is checked first, so a missing one is reported with any other BLOCKED reason.
  // P8 replay passes the recorded source beliefs instead of looking for a bundle.
  let source: PriorsSource | undefined;
  let priorsRecord = opts.priorsSourceRecord;
  if (opts.priorsFrom && !priorsRecord) {
    if (opts.priorsFrom === opts.tool) {
      return { exitCode: 1, lines: [`--priors-from must name the other tool (got ${opts.priorsFrom} for --tool ${opts.tool})`], status: "failed" };
    }
    source = loadPriorsSource({ tool: opts.priorsFrom, runsDir, ...(opts.priorsBundle ? { bundlePath: opts.priorsBundle } : {}) });
    if (source.bundle) priorsRecord = { from: opts.priorsFrom, runId: source.bundle.runId, beliefsAfter: source.bundle.beliefs.after };
  }
  const pre = preflight(opts, env);
  if (source?.blocked) return blocked([source.blocked, ...(pre.result?.status === "blocked" ? pre.result.lines : [])]);
  if (pre.result) return pre.result;
  const baseLlm = pre.llm!;

  const reconName = opts.reconCassette ?? `recon-${opts.tool}`;
  const probesName = opts.probesCassette ?? `probes-${opts.tool}`;
  if (opts.replay) {
    const have = listCassettes(cassetteDir);
    const missing = [reconName, probesName].filter((c) => !have.includes(c));
    if (missing.length) {
      return {
        exitCode: 1,
        lines: [`No cassette ${missing.join(", ")} in ${cassetteDir}; record with a live notarize run first.`],
        status: "failed",
      };
    }
  }

  // P8: every parameter that would otherwise come from the environment is fixed here and recorded.
  const params: NotarizeParams = {
    creditBudget: opts.params?.creditBudget ?? budgetFromEnv(env),
    maxProbesPerClaim: opts.params?.maxProbesPerClaim ?? maxProbesPerClaimFromEnv(env),
    ...(opts.params?.maxProbesPerRun !== undefined ? { maxProbesPerRun: opts.params.maxProbesPerRun } : {}),
    lambda: opts.params?.lambda ?? lambdaFromEnv(env),
    priorStrength: opts.params?.priorStrength ?? opts.priorStrength ?? priorStrengthFromEnv(env),
    adversary: opts.params?.adversary ?? opts.adversary ?? "bedrock",
  };

  const started = now();
  // P8 live: record per-run cassettes (+ model calls and the replay record) so this exact run replays.
  const record = mode === "live" && opts.recordReplay !== false;
  const liveRunId = mode === "live" ? (opts.runId ?? `notarize-${opts.tool}-${compactStamp(started)}`) : undefined;
  const reconCassette = record ? `${liveRunId}-recon` : reconName;
  const probesCassette = record ? `${liveRunId}-probes` : probesName;
  const ledger = new CreditLedger({ budget: params.creditBudget });
  const db = opts.db ?? openDb(opts.dbPath ?? DEFAULT_DB_PATH);
  const snapshot = record ? snapshotStore(db) : null;
  const recorder = record ? new RecordingLlm(baseLlm, { env }) : undefined;
  const llm: LlmLike & { meter?: UsageMeter } = recorder ?? baseLlm;
  const review = recorder ? recorder.recordReviews(opts.review ?? reviewBelief) : opts.review;
  const previousSink = spanSinkPath();
  try {
    let recon: ReconResult;
    let loop: ProbeLoopResult;
    try {
      // Live incidents (recon anomalies, probe and model incidents) are attributed to this run.
      recon = await withIncidentRun(liveRunId ?? opts.runId, () =>
        runRecon({
          tool: opts.tool,
          mode,
          cassetteName: reconCassette,
          cassetteDir,
          ledger,
          env,
          ...(opts.sleep ? { sleep: opts.sleep } : {}),
        }),
      );
      const runId = opts.runId ?? liveRunId ?? `notarize-${opts.tool}-replay-${recon.cassetteHash.slice(0, 12)}`;
      enterIncidentRun(runId);
      // P8 replay identity: probe ids, request tags and store rows use the RECORDED run's id, so a
      // replay sends byte-identical requests; the bundle itself is written under `runId`.
      const identity = opts.identityRunId ?? runId;
      const spansDir = opts.spansDir ?? runsDir;
      // Local span sink: every span of this run (probes included) lands in <spansDir>/<identity>/spans.jsonl.
      setSpanSink(join(spansDir, identity, "spans.jsonl"));
      const tools = createTools({ mode, cassette: probesCassette, cassetteDir, ledger, env });
      // Beliefs before this run; the probe loop updates them verdict by verdict.
      const claims = recon.entries.map((e) => e.claim);
      const beliefStore = new BeliefStore(db, opts.now ? { now: opts.now } : {});
      // A belief that leaves notarized (unlearned, invalid evidence) retires its guards at once (FR-8).
      const registry = new GuardRegistry(db, { now });
      const unwire = wireRetirement(beliefStore, registry);
      const eventsSince = beliefStore.lastEventSeq();
      // P7: transfer priors for the beliefs this run creates (existing beliefs keep their state).
      const strength = params.priorStrength;
      const transfer = priorsRecord
        ? transferPriors({ sourceBeliefs: priorsRecord.beliefsAfter, targetClaims: claims, strength, from: priorsRecord.from })
        : undefined;
      const priors = transfer?.priors;
      const preexisting = new Set(claims.filter((c) => beliefStore.byClaim(c.id)).map((c) => c.id));
      for (const c of claims) beliefStore.ensure(c, priors?.[c.id]);
      const priorsContext: PriorsContext | undefined = transfer
        ? {
            from: transfer.from,
            sourceRunId: priorsRecord!.runId,
            strength,
            applied: claims.filter((c) => !preexisting.has(c.id)).length,
            informative: transfer.perClaim.filter((p) => p.informative && !preexisting.has(p.claimId)).length,
            preexisting: preexisting.size,
          }
        : undefined;
      const beliefsBefore = beliefStore.list(opts.tool);
      const pool: { ids: string[]; subscriptionIds: string[]; note?: string } = opts.paymentPool
        ? { ids: [...opts.paymentPool], subscriptionIds: [...(opts.subscriptionPool ?? [])] }
        : opts.tool === "dodo"
          ? probePaymentPool(opts.manifestPath ?? DEFAULT_MANIFEST_PATH, opts.queuePath ?? SEEDED_QUEUE_PATH)
          : { ids: [], subscriptionIds: [] };
      // One run-wide set of probe resources: the re-examination round shares them with the main loop.
      const loopShared = {
        tool: opts.tool,
        claims: recon.entries.map((e) => e.claim),
        entries: recon.entries,
        tools: probeIoFromTools(tools, opts.sleep ? { sleep: opts.sleep } : {}),
        llm,
        db,
        runId: identity,
        ledger,
        beliefs: beliefStore,
        maxProbesPerClaim: params.maxProbesPerClaim,
        maxProbesPerRun: params.maxProbesPerRun ?? MAX_PROBES_PER_RUN,
        lambda: params.lambda,
        burst: new BurstCounter(),
        payments: new SimplePaymentPool(pool.ids),
        subscriptions: new SimplePaymentPool(pool.subscriptionIds),
        ...(priors ? { priors } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      };
      loop = await runProbeLoop({ ...loopShared, anomalies: recon.anomalies });
      const abstainedClaimIds = recon.anomalies.filter((an) => loop.abstained.includes(an.id)).map((an) => an.claimId);
      let beliefs = await runBeliefsPhase({
        db,
        store: beliefStore,
        before: beliefsBefore,
        eventsSince,
        tool: opts.tool,
        runsDir: spansDir,
        claims,
        probes: loop.probes,
        hypotheses: loop.hypotheses,
        stoppedReason: recon.stoppedReason ?? loop.stoppedReason,
        abstainedClaimIds,
        backend: params.adversary,
        llm,
        env,
        ...(priors ? { priors } : {}),
        ...(review ? { review } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      // Re-examination after an adversary downgrade: at most ONE extra round per run (see the header).
      const downgraded = [...new Set(beliefs.events.filter((e) => e.from === "candidate" && e.to === "hypothesis" && e.reason.startsWith("adversary downgrade")).map((e) => e.beliefId))].sort();
      const subjects = downgraded.flatMap((beliefId) => {
        const b = beliefStore.get(beliefId);
        if (!b || b.status !== "hypothesis") return [];
        const last = [...loop.probes].reverse().find((pr) => pr.claimId === b.claimId);
        const rivals = (last?.hypothesisIds ?? []).flatMap((id) => loop.hypotheses.filter((h) => h.id === id));
        const prefer = templateNamedIn(b.adversary?.reason);
        return [{ claimId: b.claimId, rivals, ...(prefer ? { prefer } : {}) }];
      });
      if (subjects.length && !(recon.stoppedReason ?? loop.stoppedReason ?? beliefs.usdCapStopped)) {
        const first = loop;
        const round = await runProbeLoop({
          ...loopShared,
          anomalies: [],
          verifyClaims: [],
          reexamine: subjects,
          seqStart: first.probes.length,
          maxProbesPerRun: Math.max(0, (params.maxProbesPerRun ?? MAX_PROBES_PER_RUN) - first.probes.length),
        });
        const ids = subjects.map((x) => x.claimId);
        const second = await runBeliefsPhase({
          db,
          store: beliefStore,
          before: beliefs.before,
          eventsSince,
          tool: opts.tool,
          runsDir: spansDir,
          claims,
          probes: round.probes,
          hypotheses: first.hypotheses,
          stoppedReason: round.stoppedReason,
          abstainReason: `${REEXAMINED_AFTER_DOWNGRADE}; the run's one extra round ended between thresholds`,
          reviewOnly: ids,
          backend: params.adversary,
          llm,
          env,
          ...(priors ? { priors } : {}),
          ...(review ? { review } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        });
        // A re-examined claim still open (unprobed, or downgraded again by its one extra review): abstain it.
        for (const id of ids) {
          const b = beliefStore.byClaim(id);
          if (b?.status === "hypothesis") beliefStore.abstain(b.id, `${REEXAMINED_AFTER_DOWNGRADE}; still not notarized after the one extra round (${round.probes.filter((pr) => pr.claimId === id).length} probe(s)${round.stoppedReason ? `, ${round.stoppedReason}` : ""}); P(holds)=${b.confidence.toFixed(4)}`);
        }
        const outcomes = new Map(first.claimOutcomes.map((o) => [o.claimId, o]));
        for (const o of round.claimOutcomes) outcomes.set(o.claimId, o);
        const stopped = first.stoppedReason ?? round.stoppedReason;
        loop = {
          ...first,
          probes: [...first.probes, ...round.probes],
          claimOutcomes: [...outcomes.values()].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0)),
          ...(stopped ? { stoppedReason: stopped } : {}),
          ...(round.reexamined ? { reexamined: round.reexamined } : {}),
        };
        const after = beliefStore.list(opts.tool);
        const afterIds = new Set(after.map((b) => b.id));
        beliefs = {
          before: beliefs.before,
          after,
          events: beliefStore.events(undefined, eventsSince).filter((e) => afterIds.has(e.beliefId)),
          lines: [
            second.lines[0]!, // final belief counts
            ...beliefs.lines.slice(1),
            `re-examination after downgrade (one round): ${ids.join(", ")}: ${round.probes.length} probe(s); ${ids.map((id) => `${id}=${beliefStore.byClaim(id)?.status}`).join(", ")}`,
            ...second.lines.slice(3),
          ],
          ...((beliefs.adversaryBlocked ?? second.adversaryBlocked) ? { adversaryBlocked: (beliefs.adversaryBlocked ?? second.adversaryBlocked)! } : {}),
          ...((beliefs.usdCapStopped ?? second.usdCapStopped) ? { usdCapStopped: (beliefs.usdCapStopped ?? second.usdCapStopped)! } : {}),
          reviews: {
            uphold: beliefs.reviews.uphold + second.reviews.uphold,
            narrow: beliefs.reviews.narrow + second.reviews.narrow,
            downgrade: beliefs.reviews.downgrade + second.reviews.downgrade,
            failed: beliefs.reviews.failed + second.reviews.failed,
          },
          evidence: { checked: beliefs.evidence.checked + second.evidence.checked, invalid: beliefs.evidence.invalid + second.evidence.invalid, source: beliefs.evidence.source },
        };
      }
      // Compile the notarized beliefs (all tools) into the registry; this tool's guards go in the bundle.
      const allBeliefs = beliefStore.list();
      const cited = [...new Set(allBeliefs.filter((b) => b.status === "notarized").flatMap((b) => b.evidence.map((e) => e.probeId)))];
      registry.sync(
        compileGuards({
          beliefs: allBeliefs,
          claimFor: (claimId) => claimById(claimId) ?? (beliefStore.byClaim(claimId) ? beliefStore.claimFor(beliefIdFor(claimId)) : undefined),
          probes: db.loadProbesByIds(cited),
          now,
        }),
      );
      unwire();
      const guards = registry.all().filter((g) => g.operation.startsWith(`${opts.tool}.`));

      // P8: cassette refs pinned to their content hashes (+ the replay record when recording live).
      let cassettes: string[];
      if (record) {
        if (!existsSync(join(cassetteDir, `${reconCassette}.json`))) {
          saveCassette({ name: reconCassette, tool: opts.tool, createdAt: started.toISOString(), exchanges: [], contentHash: computeContentHash([]) }, cassetteDir);
        }
        tools.recorder.save();
        // The fixed names stay the "latest recording" aliases the P2–P7 commands replay.
        for (const [name, alias] of [
          [reconCassette, `recon-${opts.tool}`],
          [probesCassette, `probes-${opts.tool}`],
        ] as const) {
          saveCassette({ ...loadCassette(name, { dir: cassetteDir }), name: alias }, cassetteDir);
        }
        saveCassette(recorder!.toCassette(`${runId}-llm`), cassetteDir);
        saveInputs(
          `${runId}-inputs`,
          {
            version: INPUTS_VERSION,
            runId,
            kind: "notarize",
            variant: "notarize",
            tool: opts.tool,
            seed: 0,
            identityRunId: identity,
            params,
            files: {},
            ...(priorsRecord ? { priorsSource: priorsRecord } : {}),
            paymentPool: pool.ids,
            subscriptionPool: pool.subscriptionIds,
            store: snapshot,
          },
          cassetteDir,
        );
        cassettes = [reconCassette, probesCassette, `${runId}-llm`, `${runId}-inputs`].map((n) => pinIfPresent(n, cassetteDir));
      } else {
        cassettes = [pinIfPresent(reconCassette, cassetteDir), pinIfPresent(probesCassette, cassetteDir), ...(opts.extraCassettes ?? [])];
      }
      const unguarded = opts.unguardedCallSites ? await opts.unguardedCallSites() : null;
      return await writeNotarizeBundle({
        opts,
        mode,
        runId,
        identity,
        started,
        now,
        recon,
        loop,
        beliefs,
        ledger,
        llm,
        poolNote: pool.note,
        guards,
        cassettes,
        unguardedCallSites: unguarded,
        ...(priorsContext ? { priors: priorsContext } : {}),
      });
    } catch (err) {
      if (isBlocked(err) || err instanceof TestModeLockError) return blocked([err.message]);
      throw err;
    }
  } finally {
    setSpanSink(previousSink);
    if (!opts.db) db.close();
  }
}

async function writeNotarizeBundle(a: {
  opts: NotarizeOptions;
  mode: "live" | "replay";
  runId: string;
  identity: string;
  started: Date;
  now: () => Date;
  recon: ReconResult;
  loop: ProbeLoopResult;
  beliefs: BeliefsPhaseResult;
  ledger: CreditLedger;
  llm: LlmLike & { meter?: UsageMeter };
  poolNote?: string | undefined;
  guards: Guard[];
  cassettes: string[];
  unguardedCallSites: number | null;
  priors?: PriorsContext;
}): Promise<NotarizeResult> {
  const { recon, loop, ledger, runId, beliefs } = a;
  const tool = a.opts.tool;
  // Credit budget, probe cap or NOTARY_MAX_USD (reflector in the loop, or the adversary phase).
  const stopReason = recon.stoppedReason ?? loop.stoppedReason ?? beliefs.usdCapStopped;
  const status: RunBundle["status"] = stopReason ? "stopped_budget" : "completed";
  const usageByRole: UsageByRole = a.llm.meter?.snapshot() ?? { executor: ZERO, reflector: loop.usage, adversary: ZERO };
  const verdicts = countVerdicts(loop.probes);
  const disclosure = [
    "Notarize run: anomalies from the deterministic checker, rival hypotheses proposed by the reflector model, probes with predictions committed before each call, verdicts by deterministic rules. Beliefs are Beta(α, β) over the doc claim holding (only confirmed probes update), every cited span is checked against runs/<runId>/spans.jsonl, and candidates are reviewed by the adversary.",
  ];
  if (beliefs.adversaryBlocked) disclosure.push(`Adversary review did not run (${beliefs.adversaryBlocked}); candidate beliefs stay candidates.`);
  if (a.mode === "replay") {
    disclosure.push(
      a.opts.replayOf
        ? `Replay of ${a.opts.replayOf} from its pinned cassettes (tool traffic, model answers, store snapshot); no network calls, no keys.`
        : "Replayed from cassettes; no tool network calls.",
    );
  }
  if (a.identity !== runId) disclosure.push(`Probe ids and request tags use the recorded run id ${a.identity}.`);
  if (tool === "dodo") disclosure.push("Dodo Payments test mode only; refund and change-plan probes use seeded probe-only payments and subscriptions the seeded queue does not reference.");
  if (loop.verification.claims.length) disclosure.push(verificationDisclosure(loop.verification.claims, loop.probes));
  if (a.priors) {
    disclosure.push(
      `Transfer priors from ${a.priors.from} notarize bundle ${a.priors.sourceRunId}: each new belief started from Beta(1 + s(1 - r), 1 + s*r), r = the ${a.priors.from} base rate of its claim's suspected defect class, s = ${a.priors.strength} pseudo-counts (Beta(1, 1) when ${a.priors.from} settled nothing relevant).`,
    );
  }
  const claimIds = recon.entries.map((e) => e.claim.id);
  const ptc = probesToCandidateMetrics(beliefs.after, claimIds);

  const draft: UnhashedBundle = {
    runId,
    kind: "notarize",
    variant: "notarize",
    mode: a.mode,
    sample: false,
    disclosure,
    startedAt: a.started.toISOString(),
    finishedAt: a.now().toISOString(),
    status,
    ...(stopReason ? { stopReason } : {}),
    seed: 0,
    tool,
    ...(a.priors ? { priorsFrom: a.priors.from } : {}),
    ...(a.opts.replayOf ? { replayOf: a.opts.replayOf } : {}),
    queue: [],
    decisions: [],
    claims: recon.entries.map((e) => e.claim),
    anomalies: recon.anomalies,
    hypotheses: loop.hypotheses,
    probes: loop.probes,
    beliefs: { before: beliefs.before, after: beliefs.after },
    beliefEvents: beliefs.events,
    guards: a.guards,
    usageByRole,
    credits: { byEndpoint: ledger.byEndpoint, total: ledger.total, budget: ledger.budget },
    metrics: {
      claims: recon.entries.length,
      anomalies: recon.anomalies.length,
      hypotheses: loop.hypotheses.length,
      hypothesesRejected: loop.rejected.length,
      probes: loop.probes.length,
      ...Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [`probes.${k}`, v])),
      abstained: loop.abstained.length,
      anomaliesSkipped: loop.skipped.length,
      ...Object.fromEntries(
        (["hypothesis", "candidate", "notarized", "refuted", "abstained", "unlearned"] as const).map((st) => [
          `beliefs.${st}`,
          beliefs.after.filter((b) => b.status === st).length,
        ]),
      ),
      "evidence.checked": beliefs.evidence.checked,
      "evidence.invalid": beliefs.evidence.invalid,
      "adversary.uphold": beliefs.reviews.uphold,
      "adversary.narrow": beliefs.reviews.narrow,
      "adversary.downgrade": beliefs.reviews.downgrade,
      "adversary.failed": beliefs.reviews.failed,
      // Model calls whose price was unknown (usd recorded as 0, which is not their cost); only when > 0,
      // so bundles without unknown prices keep their metric keys (replay compares keys exactly).
      ...(a.llm.meter?.unknownCalls() ? { usd_unknown_calls: a.llm.meter.unknownCalls() } : {}),
      probes_to_candidate_mean: ptc.mean,
      ...Object.fromEntries(Object.entries(ptc.perClaim).map(([id, n]) => [`probes_to_candidate_${id}`, n])),
      ...(a.priors
        ? {
            priors_strength: a.priors.strength,
            priors_applied: a.priors.applied,
            priors_informative: a.priors.informative,
            priors_preexisting: a.priors.preexisting,
          }
        : {}),
    },
    // Empty unless a neatlogs trace link template exists (src/trace/links.ts); then exported traces only.
    traceLinks: bundleTraceLinks({
      traceIds: [...loop.probes.map((p) => p.traceId), ...recon.anomalies.map((x) => x.traceId)],
      runsDir: a.opts.runsDir ?? RUNS_DIR,
      ...(a.opts.env ? { env: a.opts.env } : {}),
    }),
    cassettes: a.cassettes,
  };
  // P8: every TDD metric (src/eval/metrics.ts); belief precision's ground truth = the checker's verdicts on this run's recon.
  const bundle = finalizeBundle(
    withMetricDisclosures({
      ...draft,
      metrics: consolidateMetrics(draft, { checkedClaimIds: observedClaimIds(recon.entries, recon.observations), unguardedCallSites: a.unguardedCallSites }),
    }),
  );
  const dir = join(a.opts.runsDir ?? RUNS_DIR, runId);
  const { bundlePath } = await writeBundle(bundle, dir);
  recordRunTimeline(bundle, dir, { runsDir: a.opts.runsDir ?? RUNS_DIR });
  // Incidents (derived from the records) -> runs/<runId>/incidents.json + neatlogs warn/error logs.
  const incidentReport = await recordRunIncidents(bundle, dir);

  const lines = [
    `notarize: tool=${tool} mode=${a.mode} runId=${runId}`,
    `claims: ${recon.entries.length}  anomalies: ${recon.anomalies.length}  hypotheses: ${loop.hypotheses.length} (rejected ${loop.rejected.length})`,
    `probes: ${loop.probes.length}  ${Object.entries(verdicts).map(([k, v]) => `${k}=${v}`).join(" ")}  abstained: ${loop.abstained.length}`,
    `claims probed: ${loop.claimOutcomes.length}  ${(["candidate", "abstained", "open"] as const).map((o) => `${o}=${loop.claimOutcomes.filter((c) => c.outcome === o).length}`).join(" ")}`,
    `credits: ${ledger.total}/${ledger.budget}  reflector: ${usageByRole.reflector.calls} calls, $${usageByRole.reflector.usd}`,
  ];
  lines.push(...beliefs.lines);
  lines.push(`probes to candidate: mean ${ptc.mean ?? "n/a"} over ${ptc.reached}/${claimIds.length} claims that reached candidate`);
  if (a.priors) {
    lines.push(
      `priors: from ${a.priors.from} (${a.priors.sourceRunId}), strength ${a.priors.strength}: applied to ${a.priors.applied} new belief(s), ${a.priors.informative} informative; ${a.priors.preexisting} existing belief(s) kept their state`,
    );
  }
  if (a.poolNote) lines.push(`note: ${a.poolNote}`);
  for (const s of loop.skipped) lines.push(`skipped ${s.anomalyId}: ${s.reason}`);
  if (loop.verification.claims.length) lines.push(`verification probes (no anomaly; deterministic rivals): ${loop.verification.claims.join(", ")}`);
  for (const v of loop.verification.skipped) lines.push(`verification skipped ${v.claimId}: ${v.reason}`);
  if (stopReason) lines.push(`STOPPED: ${stopReason}`);
  // Unknown prices are recorded as $0: say so next to the run, naming the env vars to set.
  for (const w of a.llm.meter?.warnings ?? []) lines.push(`pricing: ${w}`);
  lines.push(`bundle: ${bundlePath}`);
  lines.push(incidentsLine(incidentReport));
  const blockedCandidates = beliefs.adversaryBlocked !== undefined && beliefs.after.some((b) => b.status === "candidate");
  return { exitCode: blockedCandidates ? 3 : 0, lines, status, runId, bundlePath, loop, beliefs };
}
