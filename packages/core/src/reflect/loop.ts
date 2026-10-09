/**
 * The probe loop (TDD "The notarization loop", steps 2–7):
 *
 *   1. one batched reflector call proposes 2–3 rival hypotheses per open anomaly (the model only
 *      PROPOSES; everything after this is deterministic code),
 *   2. hypotheses are grouped per anomaly; anomalies are worked in id order, each against its
 *      claim's belief (BeliefStore; one belief per claim),
 *   3. every applicable template designs its first not-yet-used design VARIANT (ctx.variant), whose
 *      design fingerprint (src/beliefs/params.ts) has never been applied to the belief; the next
 *      probe is the last confirmed template's next variant when it has one, else the best design by
 *      the greedy cost-aware score. A fingerprint is never repeated (also across runs),
 *   4. the runner commits the prediction, runs the probe and records the verdict,
 *   5. the verdict updates the belief at once (BeliefStore.applyProbe: only "confirmed" moves α/β),
 *   6. the claim is probed again while its belief is between the thresholds and the claim has had
 *      fewer than NOTARY_MAX_PROBES_PER_CLAIM probes this run (default 5):
 *        candidate (either side)        -> stop probing the claim (its other anomalies are skipped),
 *        confirmed                      -> next independent design, same rivals,
 *        inconclusive                   -> keep only the rivals that matched,
 *        uninformative / invalid        -> next design, same rivals,
 *        refuted (all rivals)           -> re-propose ONCE via reproposeAfterRefutation with the
 *                                          probe as evidence; refuted again -> abstain,
 *   7. abstain (TDD step 7): a belief still between the thresholds when the per-claim cap, the
 *      budget / run cap, or the supply of independent designs ends is moved to `abstained`.
 *
 * Caps kept: credit budget (BudgetExceededError stops cleanly, stoppedReason), header_burst per-run
 * cap, step repeat ≤ 3 (templates), MAX_PROBES_PER_RUN. BLOCKED errors propagate.
 */
import { BeliefStore } from "../beliefs/store.js";
import type { BeliefPrior } from "../beliefs/store.js";
import { designFingerprint } from "../beliefs/params.js";
import { contractEntryById } from "../contracts/index.js";
import type { ContractEntry } from "../contracts/types.js";
import type { LlmLike } from "../llm/client.js";
import type { Anomaly, Claim, Hypothesis, Probe, RoleUsage, Tool } from "../schema/index.js";
import type { NotaryDb } from "../store/db.js";
import { BudgetExceededError } from "../tools/index.js";
import type { CreditLedger } from "../tools/index.js";
import { proposeHypotheses, reproposeAfterRefutation } from "./hypotheses.js";
import type { Rejection } from "./hypotheses.js";
import { runProbe } from "./runner.js";
import { lambdaFromEnv, rankDesigns } from "./score.js";
import { TEMPLATES } from "./templates/index.js";
import { buildCostModel } from "./templates/common.js";
import { BurstCounter, SimplePaymentPool, isSkip } from "./templates/types.js";
import type { PaymentPool, ProbeContext, ProbeDesign, ProbeIo, ProbeTemplateModule } from "./templates/types.js";

/** Default per-claim probe cap per run (env NOTARY_MAX_PROBES_PER_CLAIM). */
export const DEFAULT_MAX_PROBES_PER_CLAIM = 5;
/** Hard cap on probes per run, whatever the budget. */
export const MAX_PROBES_PER_RUN = 30;

/** NOTARY_MAX_PROBES_PER_CLAIM: a positive integer, else the default (5). */
export function maxProbesPerClaimFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NOTARY_MAX_PROBES_PER_CLAIM?.trim();
  if (!raw) return DEFAULT_MAX_PROBES_PER_CLAIM;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_PROBES_PER_CLAIM;
}

export interface ProbeLoopOptions {
  tool: Tool;
  anomalies: readonly Anomaly[];
  claims: readonly Claim[];
  tools: ProbeIo;
  llm: LlmLike;
  db: NotaryDb;
  runId: string;
  ledger: CreditLedger;
  /** Belief store the verdicts update; default a BeliefStore over `db`. */
  beliefs?: BeliefStore;
  /** Transfer priors by claim id (P7), used when a belief is first created. */
  priors?: Readonly<Record<string, BeliefPrior>>;
  /** Default NOTARY_PROBE_LAMBDA (see score.ts). */
  lambda?: number;
  /** Per-run header_burst counter; default a fresh one (cap 10). */
  burst?: BurstCounter;
  /** Probe-reserved Dodo payments; default none (refund probes are skipped with a reason). */
  payments?: PaymentPool;
  /** Contract entries by claim id (recon recipes); default src/contracts. */
  entries?: readonly ContractEntry[];
  templates?: readonly ProbeTemplateModule[];
  /** Default NOTARY_MAX_PROBES_PER_CLAIM, else 5. */
  maxProbesPerClaim?: number;
  maxProbesPerRun?: number;
  /**
   * Replay alignment (compare-priors): the probe sequence number for the n-th probe (1-based) of a
   * claim, so probe ids and request tags match a recording made by another run of the same loop.
   * undefined (or no hook) -> the run's running count, as before.
   */
  probeSeq?: (claimId: string, nthForClaim: number) => number | undefined;
  now?: () => Date;
}

export interface SkippedAnomaly {
  anomalyId: string;
  reason: string;
}

/** How probing ended for a claim this run. */
export interface ClaimOutcome {
  claimId: string;
  outcome: "candidate" | "abstained" | "open";
  probes: number;
  reason: string;
}

export interface ProbeLoopResult {
  hypotheses: Hypothesis[];
  probes: Probe[];
  rejected: Rejection[];
  /** Reflector usage of the propose + re-propose calls. */
  usage: RoleUsage;
  stoppedReason?: string;
  /** Anomalies whose re-proposed rivals were refuted too (abstain). */
  abstained: string[];
  /** Anomalies no probe could be designed or run for, with the reason. */
  skipped: SkippedAnomaly[];
  /** Per probed claim: candidate reached, abstained (cap / budget / designs exhausted), or open. */
  claimOutcomes: ClaimOutcome[];
}

function addUsage(a: RoleUsage, b: RoleUsage): RoleUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    usd: Math.round((a.usd + b.usd) * 1e9) / 1e9,
    calls: a.calls + b.calls,
  };
}

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type Candidate = ProbeDesign & { module: ProbeTemplateModule; variant: number };

export async function runProbeLoop(opts: ProbeLoopOptions): Promise<ProbeLoopResult> {
  const templates = opts.templates ?? TEMPLATES;
  const lambda = opts.lambda ?? lambdaFromEnv();
  const burst = opts.burst ?? new BurstCounter();
  const payments = opts.payments ?? new SimplePaymentPool();
  const maxPerClaim = opts.maxProbesPerClaim ?? maxProbesPerClaimFromEnv();
  const maxPerRun = opts.maxProbesPerRun ?? MAX_PROBES_PER_RUN;
  const store = opts.beliefs ?? new BeliefStore(opts.db, opts.now ? { now: opts.now } : {});
  const claims = new Map(opts.claims.map((c) => [c.id, c]));
  const entries = new Map((opts.entries ?? []).map((e) => [e.claim.id, e]));
  const anomalies = opts.anomalies.filter((a) => a.tool === opts.tool).sort(byId);

  opts.db.saveAnomalies(opts.runId, anomalies);

  // 1. One batched reflector call for every open anomaly.
  const proposed = await proposeHypotheses({ anomalies, claims: opts.claims, llm: opts.llm });
  const hypotheses: Hypothesis[] = [...proposed.hypotheses];
  const hypothesesById = new Map(hypotheses.map((h) => [h.id, h]));
  const rejected: Rejection[] = [...proposed.rejected];
  let usage = proposed.usage;
  opts.db.saveHypotheses(opts.runId, proposed.hypotheses, 0);

  const probes: Probe[] = [];
  const abstained: string[] = [];
  const skipped: SkippedAnomaly[] = [];
  const probesForClaim = new Map<string, number>();
  const outcomes = new Map<string, ClaimOutcome>();
  let stoppedReason: string | undefined;
  let seq = 0;

  const setOutcome = (claimId: string, outcome: ClaimOutcome["outcome"], reason: string): void => {
    outcomes.set(claimId, { claimId, outcome, probes: probesForClaim.get(claimId) ?? 0, reason });
  };
  const abstainIfOpen = (claimId: string, why: string): void => {
    const b = store.byClaim(claimId);
    if (!b || b.status !== "hypothesis") return;
    store.abstain(b.id, `${why}; P(holds)=${b.confidence.toFixed(4)}`);
    setOutcome(claimId, "abstained", why);
  };

  // 2. Group per anomaly.
  const groups = new Map<string, Hypothesis[]>();
  for (const h of proposed.hypotheses) groups.set(h.anomalyId, [...(groups.get(h.anomalyId) ?? []), h]);

  outer: for (const anomaly of anomalies) {
    const claim = claims.get(anomaly.claimId);
    if (!claim) {
      skipped.push({ anomalyId: anomaly.id, reason: `claim ${anomaly.claimId} not found` });
      continue;
    }
    const belief = store.ensure(claim, opts.priors?.[claim.id]);
    if (belief.status === "candidate" || belief.status === "notarized") {
      skipped.push({ anomalyId: anomaly.id, reason: `belief ${belief.id} is already ${belief.status}` });
      continue;
    }
    let live = [...(groups.get(anomaly.id) ?? [])].sort(byId);
    if (live.length === 0) {
      skipped.push({ anomalyId: anomaly.id, reason: "no valid hypotheses" });
      continue;
    }
    let reproposed = false;
    let anomalyProbes = 0;
    let preferTemplate: string | undefined;

    while (live.length > 0) {
      if (probes.length >= maxPerRun) {
        stoppedReason = `probe cap reached (${maxPerRun} per run)`;
        break outer;
      }
      const used = probesForClaim.get(claim.id) ?? 0;
      if (used >= maxPerClaim) {
        abstainIfOpen(claim.id, `per-claim probe cap reached (${used}/${maxPerClaim}) between thresholds`);
        break;
      }
      seq += 1;
      const pseq = opts.probeSeq?.(claim.id, used + 1) ?? seq;
      const baseCtx: ProbeContext = {
        runId: opts.runId,
        tag: `${opts.runId}-p${pseq}`.replace(/[^A-Za-z0-9._-]/g, "-"),
        anomaly,
        ...(() => {
          const entry = entries.get(claim.id) ?? contractEntryById(claim.id);
          return entry ? { entry } : {};
        })(),
        costs: buildCostModel({ claims: opts.claims, ledger: opts.ledger.snapshot() }),
        burst,
        payments,
      };

      // 3. Each applicable template's first variant with a never-applied fingerprint.
      const applied = store.appliedFingerprints(belief.id);
      const designs: Candidate[] = [];
      const skips: string[] = [];
      for (const t of templates) {
        if (!t.appliesTo(claim)) continue;
        for (let k = 0; k < Math.max(1, t.variants ?? 1); k++) {
          const d = t.design(claim, live, { ...baseCtx, variant: k });
          if (isSkip(d)) {
            if (k === 0) skips.push(d.skip);
            break;
          }
          if (applied.has(designFingerprint(claim, d))) continue;
          designs.push({ ...d, module: t, variant: k });
          break;
        }
      }
      const ranked = rankDesigns(designs, lambda);
      if (ranked.length === 0) {
        seq -= 1;
        if (anomalyProbes === 0) {
          skipped.push({
            anomalyId: anomaly.id,
            reason: skips.length ? skips.join("; ") : "no applicable template separates these hypotheses",
          });
        }
        break;
      }
      const preferred = preferTemplate ? ranked.find((r) => r.design.module.name === preferTemplate) : undefined;
      const best = (preferred ?? ranked[0]!).design;
      const { module, variant, ...design } = best;
      const ctx: ProbeContext = { ...baseCtx, variant };

      // 4. Commit, run, verdict.
      let result;
      try {
        result = await runProbe({
          io: opts.tools,
          db: opts.db,
          runId: opts.runId,
          probeId: `${opts.runId}-p${String(pseq).padStart(3, "0")}`,
          claim,
          template: module,
          design,
          ctx,
          ledger: opts.ledger,
          ...(opts.now ? { now: opts.now } : {}),
        });
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          stoppedReason = `${err.message} (before probe ${module.name} for ${anomaly.id})`;
          break outer;
        }
        throw err;
      }
      probes.push(result.probe);
      payments.consume(design.paymentIds ?? []);
      anomalyProbes += 1;
      probesForClaim.set(claim.id, (probesForClaim.get(claim.id) ?? 0) + 1);

      // 5. Update the belief now.
      const v = result.verdict;
      const after = store.applyProbe(belief.id, result.probe, v, hypothesesById).belief;
      if (result.stoppedReason) {
        stoppedReason = result.stoppedReason;
        break outer;
      }
      if (after.status === "candidate") {
        setOutcome(claim.id, "candidate", `candidate after ${probesForClaim.get(claim.id)} probe(s) this run`);
        break;
      }

      // 6. Act on the verdict.
      if (v.verdict === "confirmed") {
        preferTemplate = module.name;
        continue;
      }
      if (v.verdict === "inconclusive" && result.observation) {
        const obs = result.observation;
        live = live.filter((h) => module.matches(design.predictions[h.id]!, obs));
        continue;
      }
      if (v.verdict === "refuted" && v.needsRepropose) {
        if (reproposed) {
          abstained.push(anomaly.id);
          abstainIfOpen(claim.id, "every proposed rival was refuted twice");
          break;
        }
        reproposed = true;
        preferTemplate = undefined;
        const again = await reproposeAfterRefutation({ anomaly, claim, refuted: live, evidence: result.probe, llm: opts.llm });
        usage = addUsage(usage, again.usage);
        rejected.push(...again.rejected);
        hypotheses.push(...again.hypotheses);
        for (const h of again.hypotheses) hypothesesById.set(h.id, h);
        opts.db.saveHypotheses(opts.runId, again.hypotheses, 1);
        live = [...again.hypotheses].sort(byId);
        if (live.length === 0) {
          abstained.push(anomaly.id);
          abstainIfOpen(claim.id, "re-proposal returned no valid hypotheses");
          break;
        }
        continue;
      }
      // uninformative / invalid: try the next design with the same rivals.
    }
  }

  // 7. Abstain whatever is still between the thresholds once probing has ended.
  for (const claimId of [...probesForClaim.keys()].sort()) {
    if (outcomes.has(claimId)) continue;
    const why = stoppedReason ? `budget ended between thresholds (${stoppedReason})` : "no further independent probe design between thresholds";
    abstainIfOpen(claimId, why);
    if (!outcomes.has(claimId)) {
      const b = store.byClaim(claimId);
      setOutcome(claimId, b?.status === "candidate" ? "candidate" : "open", `belief is ${b?.status ?? "missing"}`);
    }
  }

  return {
    hypotheses,
    probes,
    rejected,
    usage,
    ...(stoppedReason ? { stoppedReason } : {}),
    abstained,
    skipped,
    claimOutcomes: [...outcomes.values()].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0)),
  };
}
