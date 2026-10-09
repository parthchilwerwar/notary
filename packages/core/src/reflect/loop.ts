/**
 * The probe loop (TDD "The notarization loop", steps 2–6):
 *
 *   1. one batched reflector call proposes 2–3 rival hypotheses per open anomaly (the model only
 *      PROPOSES; everything after this is deterministic code),
 *   2. hypotheses are grouped per anomaly; anomalies are worked in id order,
 *   3. every applicable template designs a probe (predictions derived from defect classes by code)
 *      and the greedy cost-aware score picks the best unused one,
 *   4. the runner commits the prediction, runs the probe and records the verdict,
 *   5. confirmed -> done; inconclusive -> keep only the rivals that matched and try the next best
 *      template; uninformative / invalid -> try the next best template; refuted (all rivals) ->
 *      re-propose ONCE via reproposeAfterRefutation with the probe as evidence, then abstain.
 *
 * Stops cleanly on BudgetExceededError (stoppedReason). BLOCKED errors propagate.
 * P5 hook: beliefs (Beta updates from confirmed/refuted probes) and the adversary consume
 * `probes` + `hypotheses` from this result; nothing here touches beliefs.
 */
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

/** Probes per anomaly per hypothesis round (a re-proposal gets its own allowance). */
export const MAX_PROBES_PER_ANOMALY = 2;
/** Hard cap on probes per run, whatever the budget. */
export const MAX_PROBES_PER_RUN = 30;

export interface ProbeLoopOptions {
  tool: Tool;
  anomalies: readonly Anomaly[];
  claims: readonly Claim[];
  tools: ProbeIo;
  llm: LlmLike;
  db: NotaryDb;
  runId: string;
  ledger: CreditLedger;
  /** Default NOTARY_PROBE_LAMBDA (see score.ts). */
  lambda?: number;
  /** Per-run header_burst counter; default a fresh one (cap 10). */
  burst?: BurstCounter;
  /** Probe-reserved Dodo payments; default none (refund probes are skipped with a reason). */
  payments?: PaymentPool;
  /** Contract entries by claim id (recon recipes); default src/contracts. */
  entries?: readonly ContractEntry[];
  templates?: readonly ProbeTemplateModule[];
  maxProbesPerAnomaly?: number;
  maxProbesPerRun?: number;
  now?: () => Date;
}

export interface SkippedAnomaly {
  anomalyId: string;
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

export async function runProbeLoop(opts: ProbeLoopOptions): Promise<ProbeLoopResult> {
  const templates = opts.templates ?? TEMPLATES;
  const lambda = opts.lambda ?? lambdaFromEnv();
  const burst = opts.burst ?? new BurstCounter();
  const payments = opts.payments ?? new SimplePaymentPool();
  const maxPerAnomaly = opts.maxProbesPerAnomaly ?? MAX_PROBES_PER_ANOMALY;
  const maxPerRun = opts.maxProbesPerRun ?? MAX_PROBES_PER_RUN;
  const claims = new Map(opts.claims.map((c) => [c.id, c]));
  const entries = new Map((opts.entries ?? []).map((e) => [e.claim.id, e]));
  const anomalies = opts.anomalies.filter((a) => a.tool === opts.tool).sort(byId);

  opts.db.saveAnomalies(opts.runId, anomalies);

  // 1. One batched reflector call for every open anomaly.
  const proposed = await proposeHypotheses({ anomalies, claims: opts.claims, llm: opts.llm });
  const hypotheses: Hypothesis[] = [...proposed.hypotheses];
  const rejected: Rejection[] = [...proposed.rejected];
  let usage = proposed.usage;
  opts.db.saveHypotheses(opts.runId, proposed.hypotheses, 0);

  const probes: Probe[] = [];
  const abstained: string[] = [];
  const skipped: SkippedAnomaly[] = [];
  let stoppedReason: string | undefined;
  let seq = 0;

  // 2. Group per anomaly.
  const groups = new Map<string, Hypothesis[]>();
  for (const h of proposed.hypotheses) groups.set(h.anomalyId, [...(groups.get(h.anomalyId) ?? []), h]);

  outer: for (const anomaly of anomalies) {
    const claim = claims.get(anomaly.claimId);
    if (!claim) {
      skipped.push({ anomalyId: anomaly.id, reason: `claim ${anomaly.claimId} not found` });
      continue;
    }
    let live = [...(groups.get(anomaly.id) ?? [])].sort(byId);
    if (live.length === 0) {
      skipped.push({ anomalyId: anomaly.id, reason: "no valid hypotheses" });
      continue;
    }
    let reproposed = false;
    let used = new Set<string>();
    let roundProbes = 0;

    while (live.length > 0) {
      if (probes.length >= maxPerRun) {
        stoppedReason = `probe cap reached (${maxPerRun} per run)`;
        break outer;
      }
      if (roundProbes >= maxPerAnomaly) break;
      seq += 1;
      const ctx: ProbeContext = {
        runId: opts.runId,
        tag: `${opts.runId}-p${seq}`.replace(/[^A-Za-z0-9._-]/g, "-"),
        anomaly,
        ...(() => {
          const entry = entries.get(claim.id) ?? contractEntryById(claim.id);
          return entry ? { entry } : {};
        })(),
        costs: buildCostModel({ claims: opts.claims, ledger: opts.ledger.snapshot() }),
        burst,
        payments,
      };

      // 3. Design with every applicable unused template; rank by score.
      const designs: Array<ProbeDesign & { module: ProbeTemplateModule }> = [];
      const skips: string[] = [];
      for (const t of templates) {
        if (used.has(t.name) || !t.appliesTo(claim)) continue;
        const d = t.design(claim, live, ctx);
        if (isSkip(d)) skips.push(d.skip);
        else designs.push({ ...d, module: t });
      }
      const ranked = rankDesigns(designs, lambda);
      if (ranked.length === 0) {
        seq -= 1;
        if (roundProbes === 0) {
          skipped.push({
            anomalyId: anomaly.id,
            reason: skips.length ? skips.join("; ") : "no applicable template separates these hypotheses",
          });
        }
        break;
      }
      const best = ranked[0]!.design;
      const { module, ...design } = best;

      // 4. Commit, run, verdict.
      let result;
      try {
        result = await runProbe({
          io: opts.tools,
          db: opts.db,
          runId: opts.runId,
          probeId: `${opts.runId}-p${String(seq).padStart(3, "0")}`,
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
      used.add(module.name);
      roundProbes += 1;
      if (result.stoppedReason) {
        stoppedReason = result.stoppedReason;
        break outer;
      }

      // 5. Act on the verdict.
      const v = result.verdict;
      if (v.verdict === "confirmed") break;
      if (v.verdict === "inconclusive" && result.observation) {
        const obs = result.observation;
        live = live.filter((h) => module.matches(design.predictions[h.id]!, obs));
        continue;
      }
      if (v.verdict === "refuted" && v.needsRepropose) {
        if (reproposed) {
          abstained.push(anomaly.id);
          break;
        }
        reproposed = true;
        const again = await reproposeAfterRefutation({ anomaly, claim, refuted: live, evidence: result.probe, llm: opts.llm });
        usage = addUsage(usage, again.usage);
        rejected.push(...again.rejected);
        hypotheses.push(...again.hypotheses);
        opts.db.saveHypotheses(opts.runId, again.hypotheses, 1);
        live = [...again.hypotheses].sort(byId);
        used = new Set();
        roundProbes = 0;
        if (live.length === 0) {
          abstained.push(anomaly.id);
          break;
        }
        continue;
      }
      // uninformative / invalid: try the next best template with the same rivals.
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
  };
}
