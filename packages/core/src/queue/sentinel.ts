/**
 * Re-verification sentinel (DECISIONS #105): the guarded run's way of NOTICING an API change.
 *
 * Notary can only learn that an API changed by observing it. A transform guard is the riskiest
 * thing the guarded run does: it silently rewrites a money amount (e.g. items[].amount x 1/100) on
 * the strength of probes run earlier. If the API changes after notarization, the same transform
 * turns a correct write into a wrong one with no error. So, before an irreversible write that an
 * ACTIVE transform guard would rewrite, the sentinel re-runs the guard's belief's own experiment:
 *
 *   1. which beliefs: every active `transform` guard on the write's op whose rewrite would apply to
 *      this call (a numeric value at rule.param that scales to an integer when requireInteger) and
 *      whose belief is still `notarized`. Nothing runs when a block guard on the op refuses the write
 *      anyway, or when the transform would refuse it (no write = nothing to protect).
 *   2. which experiment: the template of the belief's cited probes (e.g. unit_roundtrip), with the
 *      rival hypotheses those probes were judged against. Designs never applied to the belief come
 *      first (they add independence, DECISIONS #45), then replicates of the cited designs (a replicate
 *      is a fresh observation: it moves α/β but adds no independence), least used by this sentinel
 *      first. Probes run on PROBE-ONLY resources (seed-plan `probe`; never a queue payment, #42),
 *      through the normal commit-then-run path (runProbe: prediction committed to SQLite before any
 *      call) and the RAW tools (reflect/notarize.ts `sentinelProbeTools`, cassette `<runId>-sentinel`;
 *      a probe must see what guards would hide, #56).
 *   3. what it does with the verdict: BeliefStore.applyProbe, the real rules, nothing else. One probe
 *      that confirms the notarized side ends the check (the belief still holds). A probe that
 *      contradicts it (or says nothing) leads to the next design, until the belief leaves
 *      `notarized` (un-learning = P(holds) crossing 0.5 against its side; wireRetirement then retires
 *      its guards at once), or the per-check / per-run cap or the probe pool ends.
 *   4. verdict for the write: HOLD when a belief left notarized during the check (its transform is
 *      gone; the executor re-asks the gate, which names the revoked belief), when contrary evidence
 *      was seen but the belief has not crossed yet, or when the re-verification could not run at all.
 *      Otherwise proceed.
 *
 * Cost (live): only Dodo test-mode calls on probe-only payments; for dodo.refund.amount-minor-units a
 * probe is 2 getPayment + 2 partial refunds of 100–160 minor units; 0 Crustdata credits. One probe per
 * check while nothing changed; at most `maxProbesPerCheck` / `maxProbesPerRun` otherwise.
 *
 * Config: `NOTARY_SENTINEL` = `transform` (default for guarded runs) | `off`.
 */
import { designFingerprint, valuesAtPath } from "../beliefs/params.js";
import type { BeliefStore } from "../beliefs/store.js";
import { beliefSide } from "../guards/compiler.js";
import type { GuardRegistry } from "../guards/registry.js";
import { runProbe } from "../reflect/runner.js";
import { BurstCounter, buildCostModel, isSkip, templateByName } from "../reflect/templates/index.js";
import type { PaymentPool, ProbeContext, ProbeDesign, ProbeIo, ProbeTemplateModule } from "../reflect/templates/index.js";
import type { BeliefStatus, Claim, Guard, Hypothesis, Probe, ProbeTemplate } from "../schema/index.js";
import type { NotaryDb } from "../store/db.js";
import { BudgetExceededError } from "../tools/index.js";
import type { CreditLedger } from "../tools/index.js";
import { setSpanSink, spanSinkPath } from "../trace/index.js";

export type SentinelMode = "transform" | "off";
export const SENTINEL_ENV = "NOTARY_SENTINEL";
export const DEFAULT_SENTINEL_MODE: SentinelMode = "transform";
/** Enough for a fresh notarized Beta(1,4) plus a few earlier confirmations to cross 0.5 on contrary evidence. */
export const DEFAULT_SENTINEL_MAX_PROBES_PER_CHECK = 6;
export const DEFAULT_SENTINEL_MAX_PROBES_PER_RUN = 12;

/** `NOTARY_SENTINEL`: unset/"transform"/"on" -> transform; "off"/"0"/"false" -> off; anything else is an error. */
export function sentinelModeFromEnv(env: NodeJS.ProcessEnv = process.env): SentinelMode {
  const raw = (env[SENTINEL_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "transform" || raw === "on") return "transform";
  if (raw === "off" || raw === "0" || raw === "false") return "off";
  throw new Error(`${SENTINEL_ENV} must be "transform" or "off" (got ${JSON.stringify(env[SENTINEL_ENV])})`);
}

export interface SentinelCheckInput {
  requestId: string;
  op: string;
  /** The write's params as the executor will send them (before guards). */
  params: Record<string, unknown>;
}

export interface BeliefState {
  status: BeliefStatus;
  alpha: number;
  beta: number;
  confidence: number;
}

export interface SentinelBeliefCheck {
  requestId: string;
  op: string;
  beliefId: string;
  claimId: string;
  guardId: string;
  /** The side the belief was notarized on when the check began. */
  side: "honored" | "violated";
  start: BeliefState;
  end: BeliefState;
  /** Sentinel probes run in this check, in order, with their verdicts. */
  probes: Array<{ probeId: string; design: string; replicate: boolean; verdict: string; winnerClass?: string; outcome: unknown; after: BeliefState }>;
  /** holds: a probe confirmed the notarized side. left_notarized: the belief un-learned (or otherwise left). contradicted: contrary evidence, not crossed. unverified: no informative probe. */
  outcome: "holds" | "left_notarized" | "contradicted" | "unverified";
  detail: string;
}

export interface SentinelVerdict {
  /** True when at least one belief was re-verified for this write. */
  ran: boolean;
  hold: boolean;
  reason?: string;
  checks: SentinelBeliefCheck[];
  /** Beliefs that left notarized during this check (their guards are already retired). */
  leftNotarized: string[];
  probeIds: string[];
}

export type SentinelHook = (input: SentinelCheckInput) => Promise<SentinelVerdict>;

export interface SentinelOptions {
  db: NotaryDb;
  /** The guarded run's BeliefStore (wired to its registry, so un-learning retires guards at once). */
  store: BeliefStore;
  registry: GuardRegistry;
  /** RAW (unguarded) probe IO. */
  io: ProbeIo;
  ledger: CreditLedger;
  /** Probe ids / request tags (`<identity>-sNNN`): the run id (live), the recorded run id (replay). */
  identity: string;
  /** Probe-only payments (and subscriptions) the probes may consume. */
  payments: PaymentPool;
  subscriptions?: PaymentPool;
  maxProbesPerCheck?: number;
  maxProbesPerRun?: number;
  /** Span sink for the sentinel probes (trace receipts runs/<identity>/spans.jsonl); null = leave as is. */
  spansPath?: string | null;
  now?: () => Date;
}

export interface Sentinel {
  check: SentinelHook;
  /** Every sentinel probe run, in order. */
  readonly probes: Probe[];
  /** The rival hypotheses those probes were judged against. */
  readonly hypotheses: Hypothesis[];
  readonly checks: SentinelBeliefCheck[];
}

/** True when the transform guard would rewrite (and not refuse) this call's params. */
export function transformRewrites(g: Guard, params: Record<string, unknown>): boolean {
  if (g.kind !== "transform") return false;
  const scale = g.rule.scale;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) return false;
  const values = valuesAtPath(params, String(g.rule.param ?? "")).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return false;
  if (g.rule.requireInteger === false) return true;
  return values.every((v) => Math.abs(v * scale - Math.round(v * scale)) < 1e-9);
}

const state = (b: { status: BeliefStatus; alpha: number; beta: number; confidence: number }): BeliefState => ({
  status: b.status,
  alpha: b.alpha,
  beta: b.beta,
  confidence: b.confidence,
});

export const fmtBelief = (s: BeliefState): string => `Beta(${s.alpha}, ${s.beta}) P(holds)=${s.confidence.toFixed(4)} ${s.status}`;

export function createSentinel(opts: SentinelOptions): Sentinel {
  const maxPerCheck = opts.maxProbesPerCheck ?? DEFAULT_SENTINEL_MAX_PROBES_PER_CHECK;
  const maxPerRun = opts.maxProbesPerRun ?? DEFAULT_SENTINEL_MAX_PROBES_PER_RUN;
  const burst = new BurstCounter();
  const probes: Probe[] = [];
  const hypotheses = new Map<string, Hypothesis>();
  const checks: SentinelBeliefCheck[] = [];
  /** Fingerprint -> times this sentinel used the design (rotation across checks). */
  const usedHere = new Map<string, number>();
  let seq = 0;

  /** The template(s) and rivals of the belief's cited probes. */
  function experimentOf(beliefId: string, claim: Claim): { templates: ProbeTemplateModule[]; rivals: Hypothesis[] } | { skip: string } {
    const belief = opts.store.get(beliefId)!;
    const cited = new Set(belief.evidence.filter((e) => e.valid !== false).map((e) => e.probeId));
    const rows = opts.db.loadProbesByClaims([claim.id]).filter((r) => cited.has(r.probe.id));
    if (rows.length === 0) return { skip: "the belief cites no probe to re-run" };
    const byRun = new Map<string, Hypothesis[]>();
    const lookup = (runId: string, id: string): Hypothesis | undefined => {
      if (!byRun.has(runId)) byRun.set(runId, opts.db.loadHypotheses(runId));
      return byRun.get(runId)!.find((h) => h.id === id);
    };
    const last = rows[rows.length - 1]!;
    const rivals = last.probe.hypothesisIds.map((id) => lookup(last.runId, id)).filter((h): h is Hypothesis => h !== undefined);
    if (rivals.length < 2) return { skip: `the rival hypotheses of ${last.probe.id} are not in the store` };
    const names: ProbeTemplate[] = [];
    for (const r of [...rows].reverse()) if (!names.includes(r.probe.template)) names.push(r.probe.template);
    return { templates: names.map(templateByName).filter((t) => t.appliesTo(claim)), rivals };
  }

  async function reverify(input: SentinelCheckInput, g: Guard): Promise<SentinelBeliefCheck> {
    const startBelief = opts.store.get(g.beliefId)!;
    const claim = opts.store.claimFor(g.beliefId);
    const side = beliefSide(startBelief);
    const check: SentinelBeliefCheck = {
      requestId: input.requestId,
      op: input.op,
      beliefId: g.beliefId,
      claimId: claim.id,
      guardId: g.id,
      side,
      start: state(startBelief),
      end: state(startBelief),
      probes: [],
      outcome: "unverified",
      detail: "",
    };
    const exp = experimentOf(g.beliefId, claim);
    if ("skip" in exp) {
      check.detail = `could not re-verify: ${exp.skip}`;
      return check;
    }
    for (const h of exp.rivals) hypotheses.set(h.id, h);
    opts.db.saveHypotheses(opts.identity, exp.rivals, 0);
    const rivalsById = new Map(exp.rivals.map((h) => [h.id, h]));
    let contrary = 0;
    let stop = "";
    for (let n = 0; n < maxPerCheck; n++) {
      if (probes.length >= maxPerRun) {
        stop = `per-run sentinel cap reached (${maxPerRun})`;
        break;
      }
      const tag = `${opts.identity}-s${seq + 1}`.replace(/[^A-Za-z0-9._-]/g, "-");
      const baseCtx: ProbeContext = {
        runId: opts.identity,
        tag,
        costs: buildCostModel({ claims: [claim], ledger: opts.ledger.snapshot() }),
        burst,
        payments: opts.payments,
        ...(opts.subscriptions ? { subscriptions: opts.subscriptions } : {}),
      };
      const applied = opts.store.appliedFingerprints(g.beliefId);
      const candidates: Array<{ t: ProbeTemplateModule; k: number; d: ProbeDesign; fp: string; replicate: boolean }> = [];
      const skips: string[] = [];
      for (const t of exp.templates) {
        for (let k = 0; k < Math.max(1, t.variants ?? 1); k++) {
          const d = t.design(claim, exp.rivals, { ...baseCtx, variant: k });
          if (isSkip(d)) {
            skips.push(d.skip);
            break;
          }
          const fp = designFingerprint(claim, d);
          candidates.push({ t, k, d, fp, replicate: applied.has(fp) });
        }
      }
      candidates.sort((a, b) => (usedHere.get(a.fp) ?? 0) - (usedHere.get(b.fp) ?? 0) || Number(a.replicate) - Number(b.replicate) || exp.templates.indexOf(a.t) - exp.templates.indexOf(b.t) || a.k - b.k);
      const pick = candidates[0];
      if (!pick) {
        stop = `no design available (${[...new Set(skips)].join("; ") || "no applicable template"})`;
        break;
      }
      seq += 1;
      const probeId = `${opts.identity}-s${String(seq).padStart(3, "0")}`;
      const prevSink = spanSinkPath();
      if (opts.spansPath) setSpanSink(opts.spansPath);
      let result;
      try {
        result = await runProbe({
          io: opts.io,
          db: opts.db,
          runId: opts.identity,
          probeId,
          claim,
          template: pick.t,
          design: pick.d,
          ctx: { ...baseCtx, variant: pick.k },
          ledger: opts.ledger,
          ...(opts.now ? { now: opts.now } : {}),
        });
      } catch (err) {
        seq -= 1;
        if (err instanceof BudgetExceededError) {
          stop = `credit budget: ${err.message}`;
          break;
        }
        throw err;
      } finally {
        if (opts.spansPath) setSpanSink(prevSink);
      }
      probes.push(result.probe);
      opts.payments.consume(pick.d.paymentIds ?? []);
      opts.subscriptions?.consume(pick.d.subscriptionIds ?? []);
      usedHere.set(pick.fp, (usedHere.get(pick.fp) ?? 0) + 1);
      const after = opts.store.applyProbe(g.beliefId, result.probe, result.verdict, rivalsById).belief;
      const winner = result.verdict.winningHypothesisId ? rivalsById.get(result.verdict.winningHypothesisId) : undefined;
      check.probes.push({
        probeId,
        design: pick.fp,
        replicate: pick.replicate,
        verdict: result.verdict.verdict,
        ...(winner ? { winnerClass: winner.class } : {}),
        outcome: (result.probe.observed as { outcome?: unknown } | undefined)?.outcome ?? null,
        after: state(after),
      });
      check.end = state(after);
      if (after.status !== "notarized") {
        check.outcome = "left_notarized";
        check.detail = `${g.beliefId} left notarized (${after.status}) on sentinel probe ${probeId}`;
        return check;
      }
      if (result.verdict.verdict === "confirmed" && winner) {
        const s = winner.class === "honored" ? "honored" : "violated";
        if (s === side) {
          check.outcome = "holds";
          check.detail = `${probeId} confirmed the notarized ${side} side (${winner.class})`;
          return check;
        }
        contrary += 1;
      }
      if (result.stoppedReason) {
        stop = result.stoppedReason;
        break;
      }
    }
    if (contrary > 0) {
      check.outcome = "contradicted";
      check.detail = `${contrary} sentinel probe(s) went against the notarized ${side} side but P(holds) has not crossed 0.5 (${fmtBelief(check.end)})${stop ? `; ${stop}` : `; per-check cap ${maxPerCheck} reached`}`;
    } else {
      check.detail = `no sentinel probe confirmed either side${stop ? `; ${stop}` : `; per-check cap ${maxPerCheck} reached`}`;
    }
    return check;
  }

  const check: SentinelHook = async (input) => {
    const active = opts.registry.active(input.op);
    const none: SentinelVerdict = { ran: false, hold: false, checks: [], leftNotarized: [], probeIds: [] };
    // A block guard refuses the write anyway: nothing to protect.
    if (active.some((g) => g.kind === "block")) return none;
    const targets = active.filter((g) => transformRewrites(g, input.params) && opts.store.get(g.beliefId)?.status === "notarized");
    if (targets.length === 0) return none;
    const done: SentinelBeliefCheck[] = [];
    for (const g of targets) {
      // A belief retired by an earlier target in this same check is not re-run.
      if (opts.store.get(g.beliefId)?.status !== "notarized") continue;
      const c = await reverify(input, g);
      done.push(c);
      checks.push(c);
    }
    const left = [...new Set(done.filter((c) => c.outcome === "left_notarized").map((c) => c.beliefId))];
    const doubtful = done.filter((c) => c.outcome === "contradicted" || c.outcome === "unverified");
    const probeIds = done.flatMap((c) => c.probes.map((p) => p.probeId));
    const parts = done.map((c) => {
      const ran = c.probes.length ? `${c.probes.length} probe(s) ${c.probes.map((p) => p.probeId).join(", ")}` : "no probe";
      return `${c.beliefId} (${c.side}, guard ${c.guardId}): ${ran}; ${fmtBelief(c.start)} -> ${fmtBelief(c.end)}; ${c.outcome}: ${c.detail}`;
    });
    const hold = left.length > 0 || doubtful.length > 0;
    const reason = hold
      ? `re-verification sentinel before ${input.op}: ${left.length ? `belief ${left.join(", ")} un-learned and its guard was retired, so the transform this write relied on is revoked; ` : ""}${parts.join(" | ")}`
      : `re-verification sentinel before ${input.op}: ${parts.join(" | ")}`;
    return { ran: done.length > 0, hold, reason, checks: done, leftNotarized: left, probeIds };
  };

  return { check, probes, get hypotheses() { return [...hypotheses.values()]; }, checks };
}

