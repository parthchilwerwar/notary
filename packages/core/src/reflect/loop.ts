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
 * Uninformative designs: a template whose probe saw nothing (e.g. a boundary sweep on a data set
 * that can't fill a page) is demoted for that subject: the next probe prefers any other template
 * whose design still separates the rivals, and comes back to the demoted one only when nothing
 * else is left (its other variants would read the same too-small data set).
 *
 * VERIFICATION PROBES (TDD "verify the exact tool behaviors an action depends on"; PRD "Risks":
 * honored results are first-class findings). A claim that behaves as documented yields no anomaly,
 * so the steps above would never probe it, while the gate (src/queue/gate.ts) needs it notarized.
 * After the anomalies, every claim in `verifyClaims` (default: the required-beliefs map,
 * src/queue/required.ts) of this tool that had no anomaly this run and is not already
 * candidate/notarized gets a DETERMINISTIC rival set, built without any model call:
 *   { honored, the claim's suspected defect class from src/contracts/priors-map.ts }
 * Models only ever PROPOSE hypotheses; a fixed, code-built rival pair proposes nothing new and every
 * verdict stays deterministic, so this keeps that rule. The pair then goes through exactly the same
 * probe-until-settled loop (template designs + score, commit-then-run, fingerprint independence,
 * per-claim / per-run caps, credit budget, abstain). One difference: when both rivals are refuted
 * there is no model re-proposal; the claim abstains.
 *
 * RE-EXAMINATION AFTER A DOWNGRADE (DECISIONS #85). notarize() calls the loop a second time, at most
 * once per run, with `reexamine`: the claims the adversary downgraded, each with the rivals it was
 * probed against and, when the adversary's reason names a template deterministically, that template
 * first. Only designs whose fingerprint was never applied run (as always); templates already used on
 * the claim go after unused ones. No anomalies, no verification, no model call (refuted -> abstain).
 * Abstentions in this round carry "re-examined after downgrade".
 *
 * Caps kept: credit budget (BudgetExceededError stops cleanly, stoppedReason), header_burst per-run
 * cap, step repeat ≤ 3 (templates), MAX_PROBES_PER_RUN. BLOCKED errors propagate.
 */
import { BeliefStore } from "../beliefs/store.js";
import type { BeliefPrior } from "../beliefs/store.js";
import { designFingerprint } from "../beliefs/params.js";
import { contractEntryById } from "../contracts/index.js";
import type { ContractEntry } from "../contracts/types.js";
import { suspectedClassOf } from "../contracts/priors-map.js";
import type { LlmLike } from "../llm/client.js";
import { REQUIRED_CLAIMS } from "../queue/required.js";
import type { Anomaly, Claim, Hypothesis, Probe, ProbeTemplate, RoleUsage, Tool } from "../schema/index.js";
import type { NotaryDb } from "../store/db.js";
import { BudgetExceededError } from "../tools/index.js";
import type { CreditLedger } from "../tools/index.js";
import { DEFECT_CLASS_NOTES, hypothesisId, proposeHypotheses, reproposeAfterRefutation } from "./hypotheses.js";
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
  /** Probe-reserved Dodo subscriptions; default none (change-plan probes are skipped with a reason). */
  subscriptions?: PaymentPool;
  /**
   * Claims to VERIFY even without an anomaly (see the header). Default: every claim of the
   * required-beliefs map (defaultVerifyClaims()). [] disables verification probes.
   */
  verifyClaims?: readonly string[];
  /**
   * Re-examination round (see the header): claims to probe again with their rivals and an optional
   * preferred template. When set, anomalies and verification are not processed.
   */
  reexamine?: ReadonlyArray<{ claimId: string; rivals: readonly Hypothesis[]; prefer?: ProbeTemplate }>;
  /** Probe sequence offset, so a second loop call in the same run continues the run's probe ids. */
  seqStart?: number;
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

/** Verification probes this run (claims probed without an anomaly), and claims that could not be. */
export interface VerificationSummary {
  /** Claims a deterministic rival set was built for (in probe order). */
  claims: string[];
  skipped: Array<{ claimId: string; reason: string }>;
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
  verification: VerificationSummary;
  /** Re-examination round only: claims probed again after a downgrade, and those that could not be. */
  reexamined?: VerificationSummary;
}

/** Reason prefix of every abstention in a re-examination round. */
export const REEXAMINED_AFTER_DOWNGRADE = "re-examined after downgrade";

/**
 * The template an adversary reason names, deterministically: the earliest template name mentioned
 * in its "Untested alternative:" part, else anywhere in the reason; undefined when none is named.
 */
export function templateNamedIn(reason: string | undefined, templates: readonly ProbeTemplateModule[] = TEMPLATES): ProbeTemplate | undefined {
  if (!reason) return undefined;
  const at = reason.indexOf("Untested alternative:");
  for (const text of at >= 0 ? [reason.slice(at), reason] : [reason]) {
    let best: { name: ProbeTemplate; pos: number } | undefined;
    for (const t of templates) {
      const pos = text.indexOf(t.name);
      if (pos >= 0 && (!best || pos < best.pos)) best = { name: t.name, pos };
    }
    if (best) return best.name;
  }
  return undefined;
}

/** The required-beliefs map's claims (src/queue/required.ts), deduplicated and sorted. */
export function defaultVerifyClaims(): string[] {
  return [...new Set(Object.values(REQUIRED_CLAIMS).flat())].sort();
}

/** Pseudo subject id of a verification probe's rivals (Hypothesis.anomalyId); never a checker anomaly id. */
export function verificationSubjectId(claimId: string): string {
  return `verify:${claimId}`;
}

/**
 * The deterministic verification rival set of a claim: {honored, suspected class}. No model is
 * involved (see the header). The distinguishingTest recorded is the first applicable template in
 * registry order; the probe actually run is still chosen by the cost-aware score (DECISIONS #39).
 */
export function verificationRivals(claim: Claim, templates: readonly ProbeTemplateModule[] = TEMPLATES): { hypotheses: Hypothesis[] } | { skip: string } {
  const suspected = suspectedClassOf(claim.id);
  if (!suspected || suspected === "honored") {
    return { skip: `no suspected defect class for ${claim.id} in src/contracts/priors-map.ts (control claim): nothing to rival "honored"` };
  }
  // A template that can tell the pair apart: applies to the claim and predicts different outcomes for both classes.
  const separatesPair = (t: ProbeTemplateModule): boolean => {
    const h = t.classTable?.honored;
    const d = t.classTable?.[suspected];
    return h !== undefined && d !== undefined && JSON.stringify([...h].sort()) !== JSON.stringify([...d].sort());
  };
  const template = templates.find((t) => t.appliesTo(claim) && separatesPair(t));
  if (!template) return { skip: `no probe template applies to ${claim.id} (${claim.expect.kind} on ${claim.operation}) and separates honored from ${suspected}` };
  const subject = verificationSubjectId(claim.id);
  const hypotheses = (["honored", suspected] as const).map(
    (cls): Hypothesis => ({
      id: hypothesisId(subject, cls, template.name),
      anomalyId: subject,
      class: cls,
      statement:
        cls === "honored"
          ? `Verification rival (deterministic, not model-proposed; no anomaly observed): the documented claim holds for ${claim.operation}${claim.param ? ` [${claim.param}]` : ""}.`
          : `Verification rival (deterministic, not model-proposed; suspected class from src/contracts/priors-map.ts): ${cls}: ${DEFECT_CLASS_NOTES[cls]}.`,
      distinguishingTest: template.name,
    }),
  );
  return { hypotheses: hypotheses.sort(byId) };
}

function addUsage(a: RoleUsage, b: RoleUsage): RoleUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    usd: Math.round((a.usd + b.usd) * 1e9) / 1e9,
    calls: a.calls + b.calls,
  };
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type Candidate = ProbeDesign & { module: ProbeTemplateModule; variant: number };

export async function runProbeLoop(opts: ProbeLoopOptions): Promise<ProbeLoopResult> {
  const templates = opts.templates ?? TEMPLATES;
  const lambda = opts.lambda ?? lambdaFromEnv();
  const burst = opts.burst ?? new BurstCounter();
  const payments = opts.payments ?? new SimplePaymentPool();
  const subscriptions = opts.subscriptions ?? new SimplePaymentPool();
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
  let seq = opts.seqStart ?? 0;
  const reasonPrefix = opts.reexamine ? `${REEXAMINED_AFTER_DOWNGRADE}: ` : "";

  const setOutcome = (claimId: string, outcome: ClaimOutcome["outcome"], reason: string): void => {
    outcomes.set(claimId, { claimId, outcome, probes: probesForClaim.get(claimId) ?? 0, reason });
  };
  const abstainIfOpen = (claimId: string, why: string): void => {
    const b = store.byClaim(claimId);
    if (!b || b.status !== "hypothesis") return;
    store.abstain(b.id, `${reasonPrefix}${why}; P(holds)=${b.confidence.toFixed(4)}`);
    setOutcome(claimId, "abstained", `${reasonPrefix}${why}`);
  };

  // 2. Group per anomaly.
  const groups = new Map<string, Hypothesis[]>();
  for (const h of proposed.hypotheses) groups.set(h.anomalyId, [...(groups.get(h.anomalyId) ?? []), h]);

  /** One subject: a checker anomaly with its proposed rivals, or a verification claim with its deterministic pair. */
  interface Subject {
    /** Anomaly id, or verificationSubjectId(claim.id). */
    id: string;
    claim: Claim;
    anomaly?: Anomaly;
    rivals: Hypothesis[];
    verification: boolean;
    /** Re-examination subject: a template to try first (named by the adversary). */
    reexamine?: { prefer?: ProbeTemplate };
  }
  const reexamineSkipped: VerificationSummary["skipped"] = [];
  const verifySkipped: VerificationSummary["skipped"] = [];

  /** Probe one subject until its claim settles or a cap ends it. Returns true when the whole run must stop. */
  const probeSubject = async (subject: Subject): Promise<boolean> => {
    const { claim, anomaly } = subject;
    const belief = store.ensure(claim, opts.priors?.[claim.id]);
    const skip = (reason: string): void => {
      if (subject.reexamine) reexamineSkipped.push({ claimId: claim.id, reason });
      else if (subject.verification) verifySkipped.push({ claimId: claim.id, reason });
      else skipped.push({ anomalyId: subject.id, reason });
    };
    let live = [...subject.rivals].sort(byId);
    let reproposed = false;
    let subjectProbes = 0;
    let preferTemplate: string | undefined;
    const demoted = new Set<string>();
    // Re-examination: templates already used on this claim go after unused ones.
    if (subject.reexamine) for (const fp of store.appliedFingerprints(belief.id)) demoted.add(fp.split(/[|#]/)[0]!);

    while (live.length > 0) {
      if (probes.length >= maxPerRun) {
        stoppedReason = `probe cap reached (${maxPerRun} per run)`;
        return true;
      }
      const used = probesForClaim.get(claim.id) ?? 0;
      if (used >= maxPerClaim) {
        abstainIfOpen(claim.id, `per-claim probe cap reached (${used}/${maxPerClaim}) between thresholds`);
        return false;
      }
      seq += 1;
      const pseq = opts.probeSeq?.(claim.id, used + 1) ?? seq;
      const baseCtx: ProbeContext = {
        runId: opts.runId,
        tag: `${opts.runId}-p${pseq}`.replace(/[^A-Za-z0-9._-]/g, "-"),
        ...(anomaly ? { anomaly } : {}),
        ...(() => {
          const entry = entries.get(claim.id) ?? contractEntryById(claim.id);
          return entry ? { entry } : {};
        })(),
        costs: buildCostModel({ claims: opts.claims, ledger: opts.ledger.snapshot() }),
        burst,
        payments,
        subscriptions,
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
        if (subjectProbes === 0) skip(skips.length ? skips.join("; ") : "no applicable template separates these hypotheses");
        return false;
      }
      // A template that just saw nothing goes to the back (see the header).
      const fresh = ranked.filter((r) => !demoted.has(r.design.module.name));
      const pool = fresh.length ? fresh : ranked;
      const named = subject.reexamine?.prefer && subjectProbes === 0 ? ranked.find((r) => r.design.module.name === subject.reexamine!.prefer) : undefined;
      const preferred = named ?? (preferTemplate ? pool.find((r) => r.design.module.name === preferTemplate) : undefined);
      const best = (preferred ?? pool[0]!).design;
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
          stoppedReason = `${err.message} (before probe ${module.name} for ${subject.id})`;
          return true;
        }
        throw err;
      }
      probes.push(result.probe);
      payments.consume(design.paymentIds ?? []);
      subscriptions.consume(design.subscriptionIds ?? []);
      subjectProbes += 1;
      probesForClaim.set(claim.id, (probesForClaim.get(claim.id) ?? 0) + 1);

      // 5. Update the belief now.
      const v = result.verdict;
      const after = store.applyProbe(belief.id, result.probe, v, hypothesesById).belief;
      if (result.stoppedReason) {
        stoppedReason = result.stoppedReason;
        return true;
      }
      if (after.status === "candidate") {
        setOutcome(claim.id, "candidate", `candidate after ${probesForClaim.get(claim.id)} probe(s) this run${subject.reexamine ? " (re-examination after downgrade)" : subject.verification ? " (verification probes)" : ""}`);
        return false;
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
        if (subject.verification || !anomaly) {
          // Deterministic rivals: no model re-proposal for a verification or re-examination subject.
          abstainIfOpen(claim.id, "every rival was refuted (no model re-proposal for verification / re-examination probes)");
          return false;
        }
        if (reproposed) {
          abstained.push(subject.id);
          abstainIfOpen(claim.id, "every proposed rival was refuted twice");
          return false;
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
          abstained.push(subject.id);
          abstainIfOpen(claim.id, "re-proposal returned no valid hypotheses");
          return false;
        }
        continue;
      }
      // uninformative: demote the template; uninformative / invalid: next design, same rivals.
      if (v.verdict === "uninformative") demoted.add(module.name);
    }
    return false;
  };

  let stop = false;
  const reexamined: string[] = [];
  if (opts.reexamine) {
    for (const r of opts.reexamine) {
      const claim = claims.get(r.claimId);
      if (!claim) {
        reexamineSkipped.push({ claimId: r.claimId, reason: "claim not found" });
        continue;
      }
      if (r.rivals.length < 2) {
        reexamineSkipped.push({ claimId: r.claimId, reason: "fewer than 2 rivals to re-examine" });
        continue;
      }
      reexamined.push(r.claimId);
      // The rivals were proposed (or built) earlier in this run: known for verdicts, not re-reported.
      for (const h of r.rivals) hypothesesById.set(h.id, h);
      const prefer = r.prefer ? { prefer: r.prefer } : {};
      if (await probeSubject({ id: `reexamine:${r.claimId}`, claim, rivals: [...r.rivals], verification: false, reexamine: prefer })) {
        stop = true;
        break;
      }
    }
  }
  for (const anomaly of opts.reexamine ? [] : anomalies) {
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
    const rivals = groups.get(anomaly.id) ?? [];
    if (rivals.length === 0) {
      skipped.push({ anomalyId: anomaly.id, reason: "no valid hypotheses" });
      continue;
    }
    if (await probeSubject({ id: anomaly.id, claim, anomaly, rivals, verification: false })) {
      stop = true;
      break;
    }
  }

  // Verification probes: claims to verify that had no anomaly this run (see the header).
  const verifyIds = [...new Set(opts.verifyClaims ?? defaultVerifyClaims())].sort();
  const anomalyClaims = new Set(anomalies.map((a) => a.claimId));
  const verified: string[] = [];
  for (const claimId of stop || opts.reexamine ? [] : verifyIds) {
    const claim = claims.get(claimId);
    if (!claim || claim.tool !== opts.tool || anomalyClaims.has(claimId)) continue;
    const belief = store.ensure(claim, opts.priors?.[claim.id]);
    if (belief.status === "candidate" || belief.status === "notarized") {
      verifySkipped.push({ claimId, reason: `belief ${belief.id} is already ${belief.status}` });
      continue;
    }
    const built = verificationRivals(claim, templates);
    if ("skip" in built) {
      verifySkipped.push({ claimId, reason: built.skip });
      continue;
    }
    hypotheses.push(...built.hypotheses);
    for (const h of built.hypotheses) hypothesesById.set(h.id, h);
    opts.db.saveHypotheses(opts.runId, built.hypotheses, 0);
    verified.push(claimId);
    if (await probeSubject({ id: verificationSubjectId(claimId), claim, rivals: built.hypotheses, verification: true })) break;
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
    verification: { claims: verified, skipped: verifySkipped },
    ...(opts.reexamine ? { reexamined: { claims: reexamined, skipped: reexamineSkipped } } : {}),
  };
}
