/**
 * `notary notarize --tool <t> --compare-priors [--priors-from <s>]` (P7, PRD FR-15): the probe loop
 * run TWICE over the same replay cassette, once from Beta(1, 1) and once from transfer priors, and
 * probes-to-candidate recorded for both. Replay only: no tool network, no new tool spending.
 *
 * Fairness rules (each arm is otherwise the plain runProbeLoop):
 *   - each arm gets a fresh in-memory belief store, so neither sees the other's evidence or spent
 *     design fingerprints, and a fresh replay recorder + credit ledger;
 *   - reflector responses are shared: the first arm's model answers are memoised by request and
 *     served to the second arm, so both arms probe the same rival hypotheses (an unseen request,
 *     e.g. a re-proposal only one arm needs, goes to the model);
 *   - both arms use the runId of the live run that recorded the cassette (its notarize bundle), so
 *     probe tags in request bodies match the recording; the with-priors arm reuses the probe
 *     sequence number of the same claim's n-th probe in the without-priors arm (runProbeLoop
 *     `probeSeq`), because a claim that settles sooner would otherwise shift every later tag.
 * Known limit: identical UNTAGGED requests are served in recorded order, so when one arm skips a
 * probe, later identical requests can receive a different recorded copy than in the other arm.
 * A cassette miss stops that arm; what it measured so far is kept and the miss is reported.
 *
 * Metrics (bundle.metrics):
 *   probes_to_candidate_without_priors / _with_priors   mean over claims that reached candidate in
 *                                                       BOTH arms (paired); null if none did
 *   probes_to_candidate_{without,with}_priors_<claimId> per claim; null if never reached
 *   candidates_{without,with}_priors, probes_{without,with}_priors, priors_strength
 */
import { join } from "node:path";
import { canonicalJson } from "../bundle/hash.js";
import { finalizeBundle, writeBundle } from "../bundle/index.js";
import type { UnhashedBundle } from "../bundle/index.js";
import { recordRunTimeline } from "../timeline/write.js";
import { consolidateMetrics, withMetricDisclosures } from "../eval/metrics.js";
import { pinIfPresent } from "../replay/pins.js";
import { BeliefStore } from "../beliefs/store.js";
import type { BeliefPrior } from "../beliefs/store.js";
import {
  COMPARE_PRIORS_RUN_PREFIX,
  loadPriorsSource,
  meanOf,
  priorStrengthFromEnv,
  probesToCandidateMetrics,
  transferPriors,
} from "../beliefs/priors.js";
import { RUNS_DIR } from "../checker/notarize.js";
import { bundleTraceLinks } from "../trace/links.js";
import { observedClaimIds } from "../checker/check.js";
import { runRecon } from "../checker/recon.js";
import type { ContractEntry } from "../contracts/types.js";
import type { CompleteRequest, CompleteResult, LlmLike, UsageMeter } from "../llm/index.js";
import { DEFAULT_MANIFEST_PATH } from "../queue/manifest.js";
import type { Anomaly, Belief, BeliefEvent, Claim, Hypothesis, Probe, RoleUsage, RunBundle, Tool } from "../schema/index.js";
import { NotaryDb } from "../store/db.js";
import {
  CassetteMissError,
  CreditLedger,
  DEFAULT_CASSETTE_DIR,
  isBlocked,
  listCassettes,
  loadCassette,
} from "../tools/index.js";
import { maxProbesPerClaimFromEnv, runProbeLoop } from "./loop.js";
import type { ClaimOutcome } from "./loop.js";
import { SEEDED_QUEUE_PATH, preflight, probePaymentPool, rawReplayProbeIo, recordedRunId } from "./notarize.js";
import { BurstCounter, SimplePaymentPool } from "./templates/index.js";
import type { PaymentPool, ProbeIo, ProbeTemplateModule } from "./templates/index.js";

export type ArmLabel = "without_priors" | "with_priors";

export interface PriorsArm {
  label: ArmLabel;
  probes: Probe[];
  hypotheses: Hypothesis[];
  before: Belief[];
  after: Belief[];
  events: BeliefEvent[];
  perClaim: Record<string, number | null>;
  claimOutcomes: ClaimOutcome[];
  ledger: CreditLedger;
  stoppedReason?: string;
  /** Set when the arm ended on a cassette miss (what it measured until then is kept). */
  error?: string;
}

export interface CompareArmsOptions {
  tool: Tool;
  claims: readonly Claim[];
  anomalies: readonly Anomaly[];
  entries?: readonly ContractEntry[];
  llm: LlmLike;
  priors: Readonly<Record<string, BeliefPrior>>;
  runId: string;
  /** A fresh ProbeIo for one arm (replay recorder), charging that arm's ledger. */
  io: (ledger: CreditLedger) => ProbeIo;
  /** A fresh ledger per arm; default from env. */
  ledger?: () => CreditLedger;
  /** A fresh payment pool per arm; default empty. */
  payments?: () => PaymentPool;
  /** A fresh probe subscription pool per arm (change-plan probes); default empty. */
  subscriptions?: () => PaymentPool;
  maxProbesPerClaim?: number;
  lambda?: number;
  templates?: readonly ProbeTemplateModule[];
  now?: () => Date;
}

export interface CompareArmsResult {
  without: PriorsArm;
  with: PriorsArm;
  metrics: Record<string, number | null>;
  lines: string[];
}

/** Serves each distinct request's first answer again (keyed by canonical request JSON). */
export class MemoLlm implements LlmLike {
  private readonly memo = new Map<string, CompleteResult>();
  calls = 0;
  hits = 0;
  constructor(private readonly inner: LlmLike) {}
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const key = canonicalJson(req);
    const hit = this.memo.get(key);
    if (hit) {
      this.hits += 1;
      return hit;
    }
    this.calls += 1;
    const res = await this.inner.complete(req);
    this.memo.set(key, res);
    return res;
  }
}

const SEQ_OF_ID = /-p(\d+)$/;

/** claimId -> [seq of its 1st probe, 2nd, ...] from an arm's probes (commit order). */
function seqsByClaim(probes: readonly Probe[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const p of probes) {
    const m = SEQ_OF_ID.exec(p.id);
    if (!m) continue;
    out.set(p.claimId, [...(out.get(p.claimId) ?? []), Number(m[1])]);
  }
  return out;
}

async function runArm(
  opts: CompareArmsOptions,
  label: ArmLabel,
  llm: LlmLike,
  priors: Readonly<Record<string, BeliefPrior>> | undefined,
  probeSeq?: (claimId: string, n: number) => number | undefined,
): Promise<PriorsArm> {
  const db = new NotaryDb(":memory:");
  try {
    const store = new BeliefStore(db, opts.now ? { now: opts.now } : {});
    for (const c of opts.claims) store.ensure(c, priors?.[c.id]);
    const before = store.list(opts.tool);
    const ledger = opts.ledger?.() ?? new CreditLedger();
    let stoppedReason: string | undefined;
    let error: string | undefined;
    let claimOutcomes: ClaimOutcome[] = [];
    try {
      const loop = await runProbeLoop({
        tool: opts.tool,
        anomalies: opts.anomalies,
        claims: opts.claims,
        ...(opts.entries ? { entries: opts.entries } : {}),
        tools: opts.io(ledger),
        llm,
        db,
        runId: opts.runId,
        ledger,
        beliefs: store,
        ...(priors ? { priors } : {}),
        ...(probeSeq ? { probeSeq } : {}),
        ...(opts.maxProbesPerClaim !== undefined ? { maxProbesPerClaim: opts.maxProbesPerClaim } : {}),
        ...(opts.lambda !== undefined ? { lambda: opts.lambda } : {}),
        ...(opts.templates ? { templates: opts.templates } : {}),
        burst: new BurstCounter(),
        payments: opts.payments?.() ?? new SimplePaymentPool(),
        subscriptions: opts.subscriptions?.() ?? new SimplePaymentPool(),
        ...(opts.now ? { now: opts.now } : {}),
      });
      stoppedReason = loop.stoppedReason;
      claimOutcomes = loop.claimOutcomes;
    } catch (err) {
      if (!(err instanceof CassetteMissError)) throw err;
      error = err.message;
    }
    const after = store.list(opts.tool);
    const ptc = probesToCandidateMetrics(after, opts.claims.map((c) => c.id));
    return {
      label,
      probes: db.loadProbes(opts.runId),
      hypotheses: db.loadHypotheses(opts.runId),
      before,
      after,
      events: store.events().filter((e) => after.some((b) => b.id === e.beliefId)),
      perClaim: ptc.perClaim,
      claimOutcomes,
      ledger,
      ...(stoppedReason ? { stoppedReason } : {}),
      ...(error ? { error } : {}),
    };
  } finally {
    db.close();
  }
}

/** Both arms over the same inputs; see the header for the fairness rules. */
export async function comparePriorArms(opts: CompareArmsOptions): Promise<CompareArmsResult> {
  const llm = new MemoLlm(opts.llm);
  const without = await runArm(opts, "without_priors", llm, undefined);

  // Align the with-priors arm's probe ids/tags with the recording (= the without-priors arm).
  const seqs = seqsByClaim(without.probes);
  let fresh = Math.max(0, ...[...seqs.values()].flat());
  const probeSeq = (claimId: string, n: number): number => seqs.get(claimId)?.[n - 1] ?? ++fresh;
  const withPriors = await runArm(opts, "with_priors", llm, opts.priors, probeSeq);

  const ids = opts.claims.map((c) => c.id).sort();
  const paired = ids.filter((id) => without.perClaim[id] != null && withPriors.perClaim[id] != null);
  const metrics: Record<string, number | null> = {
    probes_to_candidate_without_priors: meanOf(paired.map((id) => without.perClaim[id]!)),
    probes_to_candidate_with_priors: meanOf(paired.map((id) => withPriors.perClaim[id]!)),
    candidates_without_priors: ids.filter((id) => without.perClaim[id] != null).length,
    candidates_with_priors: ids.filter((id) => withPriors.perClaim[id] != null).length,
    probes_without_priors: without.probes.length,
    probes_with_priors: withPriors.probes.length,
    paired_claims: paired.length,
  };
  for (const id of ids) {
    metrics[`probes_to_candidate_without_priors_${id}`] = without.perClaim[id] ?? null;
    metrics[`probes_to_candidate_with_priors_${id}`] = withPriors.perClaim[id] ?? null;
  }
  const lines = [
    `compare priors: ${opts.tool}, runId ${opts.runId}; reflector calls ${llm.calls} (served again from memo: ${llm.hits})`,
    `without priors: ${without.probes.length} probes, ${metrics.candidates_without_priors} candidate(s)${without.error ? `; STOPPED: ${without.error}` : ""}`,
    `with priors:    ${withPriors.probes.length} probes, ${metrics.candidates_with_priors} candidate(s)${withPriors.error ? `; STOPPED: ${withPriors.error}` : ""}`,
    `probes to candidate (paired over ${paired.length} claim(s)): without ${metrics.probes_to_candidate_without_priors ?? "n/a"}, with ${metrics.probes_to_candidate_with_priors ?? "n/a"}`,
  ];
  for (const id of ids) {
    const a = without.perClaim[id];
    const b = withPriors.perClaim[id];
    if (a != null || b != null) lines.push(`  ${id}: without ${a ?? "-"}, with ${b ?? "-"}`);
  }
  return { without, with: withPriors, metrics, lines };
}

// ---------------------------------------------------------------------------------------------
// CLI flow

export interface ComparePriorsOptions {
  tool: Tool;
  /** Source tool for the priors; default the other tool. */
  priorsFrom?: Tool;
  priorsBundle?: string;
  priorStrength?: number;
  env?: NodeJS.ProcessEnv;
  runsDir?: string;
  cassetteDir?: string;
  llm?: LlmLike & { meter?: UsageMeter };
  manifestPath?: string;
  queuePath?: string;
  now?: () => Date;
}

export interface ComparePriorsResult {
  exitCode: number;
  lines: string[];
  status: RunBundle["status"];
  runId?: string;
  bundlePath?: string;
  compare?: CompareArmsResult;
}

const ZERO: RoleUsage = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };

function otherTool(t: Tool): Tool {
  return t === "dodo" ? "crustdata" : "dodo";
}

export { recordedRunId } from "./notarize.js";

export async function comparePriors(opts: ComparePriorsOptions): Promise<ComparePriorsResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const tool = opts.tool;
  const from = opts.priorsFrom ?? otherTool(tool);
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;
  if (from === tool) return { exitCode: 1, lines: [`--priors-from must name the other tool (got ${from} for --tool ${tool})`], status: "failed" };

  // BLOCKED checks, all reported together: replay cassettes, priors source, reflector model.
  const reasons: string[] = [];
  const have = listCassettes(cassetteDir);
  const missing = [`recon-${tool}`, `probes-${tool}`].filter((c) => !have.includes(c));
  if (missing.length) {
    reasons.push(`BLOCKED: no replay cassette ${missing.join(", ")} in ${cassetteDir} — record one with a live notarize --tool ${tool} run first`);
  }
  const source = loadPriorsSource({ tool: from, runsDir, ...(opts.priorsBundle ? { bundlePath: opts.priorsBundle } : {}) });
  if (source.blocked) reasons.push(source.blocked);
  const pre = preflight({ tool, replay: true, ...(opts.llm ? { llm: opts.llm } : {}) }, env);
  if (pre.result) {
    if (pre.result.status !== "blocked") return { ...pre.result, status: pre.result.status };
    reasons.push(...pre.result.lines);
  }
  if (reasons.length) return { exitCode: 3, lines: reasons.map((r) => (r.startsWith("BLOCKED:") ? r : `BLOCKED: ${r}`)), status: "blocked" };
  const llm = pre.llm!;

  const started = now();
  try {
    const recon = await runRecon({ tool, mode: "replay", cassetteDir, ledger: new CreditLedger({ env }), env });
    const claims = recon.entries.map((e) => e.claim);
    const strength = opts.priorStrength ?? priorStrengthFromEnv(env);
    const transfer = transferPriors({ sourceBeliefs: source.bundle!.beliefs.after, targetClaims: claims, strength, from });
    const probesHash = loadCassette(`probes-${tool}`, { dir: cassetteDir }).contentHash;
    const recorded = recordedRunId(runsDir, tool);
    const loopRunId = recorded ?? `notarize-${tool}-replay-${recon.cassetteHash.slice(0, 12)}`;
    const pool = tool === "dodo" ? probePaymentPool(opts.manifestPath ?? DEFAULT_MANIFEST_PATH, opts.queuePath ?? SEEDED_QUEUE_PATH) : { ids: [], subscriptionIds: [] };

    const compare = await comparePriorArms({
      tool,
      claims,
      anomalies: recon.anomalies,
      entries: recon.entries,
      llm,
      priors: transfer.priors,
      runId: loopRunId,
      io: (ledger) => rawReplayProbeIo({ cassette: `probes-${tool}`, cassetteDir, ledger, env }),
      ledger: () => new CreditLedger({ env }),
      payments: () => new SimplePaymentPool(pool.ids),
      subscriptions: () => new SimplePaymentPool(pool.subscriptionIds),
      maxProbesPerClaim: maxProbesPerClaimFromEnv(env),
      now,
    });

    const runId = `${COMPARE_PRIORS_RUN_PREFIX}${tool}-${probesHash.slice(0, 12)}`;
    const failed = compare.without.error ?? compare.with.error;
    const status: RunBundle["status"] = failed ? "failed" : "completed";
    const arm = compare.with;
    const disclosure = [
      `Priors comparison (FR-15): the probe loop replayed twice over cassette probes-${tool} (sha ${probesHash.slice(0, 12)}), once from Beta(1, 1) and once from transfer priors learned on ${from} (bundle ${source.bundle!.runId}, strength ${strength}). No tool network calls; reflector answers were shared between the arms. Probes, hypotheses and beliefs shown are the with-priors arm.`,
      "probes_to_candidate_with_priors / _without_priors are means over the claims that reached candidate in both arms.",
    ];
    if (!recorded) disclosure.push(`No live ${tool} notarize bundle found: probe tags use ${loopRunId}, which may not match the recording.`);
    if (failed) disclosure.push(`An arm stopped early: ${failed}`);
    const ma = llm as LlmLike & { meter?: UsageMeter };
    const draft: UnhashedBundle = {
      runId,
      kind: "notarize",
      variant: "notarize",
      mode: "replay",
      sample: false,
      disclosure,
      startedAt: started.toISOString(),
      finishedAt: now().toISOString(),
      status,
      ...(failed ? { stopReason: failed } : {}),
      seed: 0,
      tool,
      priorsFrom: from,
      replayOf: loopRunId,
      queue: [],
      decisions: [],
      claims,
      anomalies: recon.anomalies,
      hypotheses: arm.hypotheses,
      probes: arm.probes,
      beliefs: { before: arm.before, after: arm.after },
      beliefEvents: arm.events,
      guards: [],
      usageByRole: ma.meter?.snapshot() ?? { executor: ZERO, reflector: ZERO, adversary: ZERO },
      credits: { byEndpoint: arm.ledger.byEndpoint, total: arm.ledger.total, budget: arm.ledger.budget },
      metrics: { ...compare.metrics, priors_strength: strength },
      // Empty unless a neatlogs trace link template exists (src/trace/links.ts); then exported traces only.
      traceLinks: bundleTraceLinks({ traceIds: [...arm.probes.map((p) => p.traceId), ...recon.anomalies.map((x) => x.traceId)], runsDir, env }),
      cassettes: [pinIfPresent(`recon-${tool}`, cassetteDir), pinIfPresent(`probes-${tool}`, cassetteDir)],
    };
    // P8: every TDD metric (src/eval/metrics.ts); probes_to_candidate_with/_without_priors are kept.
    const bundle = finalizeBundle(withMetricDisclosures({ ...draft, metrics: consolidateMetrics(draft, { checkedClaimIds: observedClaimIds(recon.entries, recon.observations) }) }));
    const { bundlePath } = await writeBundle(bundle, join(runsDir, runId));
    recordRunTimeline(bundle, join(runsDir, runId), { runsDir });
    const lines = [...compare.lines, `bundle: ${bundlePath}`];
    return { exitCode: failed ? 1 : 0, lines, status, runId, bundlePath, compare };
  } catch (err) {
    if (isBlocked(err)) return { exitCode: 3, lines: [err.message], status: "blocked" };
    throw err;
  }
}
