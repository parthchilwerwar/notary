/**
 * Drift replay: the un-learning path (TDD "Drift fixture" and step 7; PRD FR-16; audit A-16).
 * `notary replay --drift` drives it.
 *
 * Given a drift fixture (a real cassette whose responses were rewritten consistently for one op, or
 * one exchange; src/tools/drift-fixture.ts) and the probes recorded into that cassette (from the
 * notarize bundle, or from the db by runId):
 *
 *   0. discovery: replay every recorded probe in commit order against the fixture on ONE replay
 *      recorder (so repeated identical requests get the same recorded copy as in the original
 *      run). The AFFECTED probes are those served at least one changed exchange (requestHash +
 *      occurrence in the fixture's `drift.changed`). Only their claims' beliefs are touched: the
 *      other recordings are unchanged observations the beliefs already counted.
 *   1. one replay, counted by DISTINCT DESIGN: the affected probes of a claim are grouped by
 *      BeliefStore's independence notion, the design fingerprint (params.ts designFingerprint:
 *      template + treatment value at claim.param + variant). The first probe of each design (commit
 *      order) is re-run through runProbe — its ORIGINAL pre-registered prediction committed under
 *      `<probeId>~drift-<fixture>` before the replayed call, then judged by the same deterministic
 *      verdict rules — and its verdict is applied to the EXISTING belief with
 *      BeliefStore.applyProbe. Replicates of a design are replayed raw (to keep the recorder's
 *      occurrence counters aligned) but never re-counted: each distinct design contributes at most
 *      ONE observation to α/β. The same recorded response is never counted twice (A-16).
 *   Un-learning is not special-cased: BeliefStore moves a notarized belief to `unlearned` when
 *   P(holds) crosses back over 0.5 against its side, and wireRetirement retires its guards. When the
 *   recorded designs are too few to cross 0.5, the result says so ("not un-learned: only N distinct
 *   designs observed the change", plus how many it would take) and nothing is faked; `replay --drift`
 *   then exits 1 (A-05).
 *
 * Returns each belief's trajectory (α, β, P(holds) and confidence in the notarized side, one step
 * per distinct design), the retired guards and the replayed probes.
 */
import { beliefSide } from "../guards/compiler.js";
import { GuardRegistry, wireRetirement } from "../guards/registry.js";
import { runProbe } from "../reflect/runner.js";
import { rawReplayProbeIo } from "../reflect/notarize.js";
import { BurstCounter, SimplePaymentPool, TEMPLATES, buildCostModel } from "../reflect/templates/index.js";
import type { PredictedObservation, ProbeContext, ProbeDesign, ProbeIo, ProbeTemplateModule, VariantParams } from "../reflect/templates/index.js";
import type { Belief, BeliefEvent, BeliefStatus, Claim, Guard, Hypothesis, Probe, ProbeVerdict } from "../schema/index.js";
import type { NotaryDb } from "../store/db.js";
import { CreditLedger } from "../tools/index.js";
import type { Exchange } from "../tools/index.js";
import { driftedExchangeKeys, loadDriftFixture } from "../tools/drift-fixture.js";
import type { DriftFixture, DriftMeta } from "../tools/drift-fixture.js";
import { designFingerprint } from "./params.js";
import { BeliefStore } from "./store.js";

export interface ReplayDriftOptions {
  /** Drift fixture: loaded, a path, or a name in fixtures/drift. */
  fixture: string | DriftFixture;
  db: NotaryDb;
  /** Recorded probes of the run that made the cassette, in commit order (e.g. a notarize bundle's). */
  probes?: readonly Probe[];
  /** Their hypotheses (the bundle's); default loaded from the db by each probe's run. */
  hypotheses?: readonly Hypothesis[];
  /** Load the recorded probes from the db instead (the run that recorded the cassette). */
  runId?: string;
  /** Only touch this claim's belief (default: every claim whose probe consumed a changed exchange). */
  claimId?: string;
  /** ProbeIo serving the fixture; called once per replay (fresh recorder). Default: createTools replay. */
  io?: (fixture: DriftFixture) => ProbeIo;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface DriftPoint {
  alpha: number;
  beta: number;
  pHolds: number;
  /** Confidence in the side the belief was notarized on: P(holds) if honored, 1 − P(holds) if violated. */
  sideConfidence: number;
  status: BeliefStatus;
}

export interface DriftStep extends DriftPoint {
  /** Design fingerprint (BeliefStore's independence notion); one step per distinct design. */
  design: string;
  probeId: string;
  sourceProbeId: string;
  /** Other recorded probes of the same design: replayed for alignment, never re-counted. */
  replicateIds: string[];
  verdict: ProbeVerdict;
  /** True when this design's replay confirmed the side opposite the notarized one. */
  against: boolean;
}

export interface DriftTrajectory {
  beliefId: string;
  claimId: string;
  side: "honored" | "violated";
  start: DriftPoint;
  steps: DriftStep[];
  final: Belief;
  /** Distinct designs replayed (= steps.length). */
  distinctDesigns: number;
  /** Distinct designs whose replay confirmed against the notarized side. */
  designsAgainst: number;
  /** Distinct contrary designs it takes to cross 0.5 from the start state (existing rule). */
  designsNeeded: number;
  unlearned: boolean;
}

export interface ReplayDriftResult {
  drift: DriftMeta;
  fixture: string;
  affectedProbeIds: string[];
  trajectories: DriftTrajectory[];
  retiredGuards: Guard[];
  probes: Probe[];
  events: BeliefEvent[];
  /** True when at least one affected belief reached `unlearned`. */
  unlearned: boolean;
  stopReason: string;
  lines: string[];
}

const TEMPLATE_BY_NAME = new Map<string, ProbeTemplateModule>(TEMPLATES.map((t) => [t.name, t]));

function designOf(p: Probe): ProbeDesign {
  return {
    template: p.template,
    params: p.params as VariantParams,
    control: { params: (p.control?.params ?? { steps: [] }) as VariantParams },
    predictions: p.prediction as Record<string, PredictedObservation>,
    estCredits: 0,
    estCalls: p.calls,
  };
}

function ctxFor(runId: string, p: Probe, burst: BurstCounter): ProbeContext {
  return { runId, tag: p.id, costs: buildCostModel(), burst, payments: new SimplePaymentPool() };
}

/** An io that also reports every exchange it serves. */
function watching(io: ProbeIo, seen: (ex: Exchange) => void): ProbeIo {
  return {
    sleep: (ms) => io.sleep(ms),
    async call(op, args) {
      const out = await io.call(op, args);
      for (const ex of out) seen(ex);
      return out;
    },
  };
}

function pointOf(b: Belief, side: "honored" | "violated"): DriftPoint {
  return {
    alpha: b.alpha,
    beta: b.beta,
    pHolds: b.confidence,
    sideConfidence: side === "honored" ? b.confidence : 1 - b.confidence,
    status: b.status,
  };
}

/**
 * Contrary observations needed to cross 0.5 against `side` from Beta(α, β). P(holds) > 0.5 iff α > β
 * (Beta symmetry), so a violated belief needs α + k > β and an honored one β + k > α.
 */
export function designsToCross(alpha: number, beta: number, side: "honored" | "violated"): number {
  const gap = side === "violated" ? beta - alpha : alpha - beta;
  return Math.max(0, Math.floor(gap)) + 1;
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function replayDrift(opts: ReplayDriftOptions): Promise<ReplayDriftResult> {
  const fixture = typeof opts.fixture === "string" ? loadDriftFixture(opts.fixture) : opts.fixture;
  const env = opts.env ?? {};
  const now = opts.now ?? (() => new Date());
  const ioFor =
    opts.io ??
    ((f: DriftFixture) => rawReplayProbeIo({ cassettes: [f], ledger: new CreditLedger({ budget: Number.MAX_SAFE_INTEGER }), env }));
  const drifted = driftedExchangeKeys(fixture.drift);
  const isDrifted = (ex: Exchange): boolean => drifted.has(`${ex.requestHash}:${ex.occurrence}`);
  const driftRunId = `drift-${fixture.name}`;
  const d = fixture.drift;
  const what = d.op
    ? `op ${d.op}${d.match ? ` where ${d.match.path} = ${JSON.stringify(d.match.value)}` : ""}`
    : `exchange ${(d.exchange ?? "").slice(0, 12)}…`;
  const lines: string[] = [`drift fixture ${fixture.name}: ${d.source} ${what}, ${d.path} ${d.transform} (${plural(d.changed.length, "exchange")} changed)`];

  if (!opts.probes && !opts.runId) throw new Error("replayDrift needs the recorded probes (probes) or the run that recorded them (runId)");
  const recorded = [...(opts.probes ?? opts.db.loadProbes(opts.runId!))].filter((p) => !p.id.includes("~drift-"));
  const hyps = new Map<string, Hypothesis>();
  if (opts.hypotheses) for (const h of opts.hypotheses) hyps.set(h.id, h);
  else {
    const runIds = new Set<string>();
    const stmt = opts.db.db.prepare("SELECT run_id FROM probes WHERE id = ?");
    for (const p of recorded) {
      const row = stmt.get(p.id) as { run_id?: unknown } | undefined;
      if (row?.run_id != null) runIds.add(String(row.run_id));
    }
    if (opts.runId) runIds.add(opts.runId);
    for (const r of runIds) for (const h of opts.db.loadHypotheses(r)) hyps.set(h.id, h);
  }

  // 0. Discovery: which recorded probes were served a changed exchange?
  const affected = new Set<string>();
  {
    const io = ioFor(fixture);
    const burst = new BurstCounter();
    for (const p of recorded) {
      const t = TEMPLATE_BY_NAME.get(p.template);
      if (!t) continue;
      let hit = false;
      try {
        await t.execute(watching(io, (ex) => (hit ||= isDrifted(ex))), designOf(p), ctxFor(driftRunId, p, burst));
      } catch (err) {
        lines.push(`discovery: ${p.id} did not replay (${errText(err)})`);
      }
      if (hit && (!opts.claimId || p.claimId === opts.claimId)) affected.add(p.id);
    }
  }

  const store = new BeliefStore(opts.db, { now });
  const registry = new GuardRegistry(opts.db, { now });
  const retiredGuards: Guard[] = [];
  const unwire = wireRetirement(store, registry, (g) => retiredGuards.push(...g));
  const seq0 = store.lastEventSeq();
  const trajectories = new Map<string, DriftTrajectory>();
  /** Representative probe id -> its design and replicates. */
  const representative = new Map<string, { design: string; replicateIds: string[] }>();
  const replayed: Probe[] = [];
  let stopReason = "";

  try {
    const skippedClaims = new Set<string>();
    for (const p of recorded) {
      if (!affected.has(p.id) || trajectories.has(p.claimId) || skippedClaims.has(p.claimId)) continue;
      const b = store.byClaim(p.claimId);
      if (!b) {
        lines.push(`no belief for ${p.claimId} in the store: its probes are not replayed`);
        skippedClaims.add(p.claimId);
        continue;
      }
      if (b.status !== "notarized") {
        lines.push(`${b.id} is ${b.status}, not notarized: nothing to un-learn, its probes are not replayed`);
        skippedClaims.add(p.claimId);
        continue;
      }
      const side = beliefSide(b);
      trajectories.set(p.claimId, {
        beliefId: b.id,
        claimId: p.claimId,
        side,
        start: pointOf(b, side),
        steps: [],
        final: b,
        distinctDesigns: 0,
        designsAgainst: 0,
        designsNeeded: designsToCross(b.alpha, b.beta, side),
        unlearned: false,
      });
    }

    // Group each claim's affected probes by design fingerprint; the first (commit order) represents it.
    const byDesign = new Map<string, string>(); // `${claimId}\u0000${fingerprint}` -> representative id
    const active = recorded.filter((p) => affected.has(p.id) && trajectories.has(p.claimId));
    for (const p of active) {
      const claim = store.claimFor(trajectories.get(p.claimId)!.beliefId);
      const fp = designFingerprint(claim, p);
      const k = `${p.claimId}\u0000${fp}`;
      const rep = byDesign.get(k);
      if (rep === undefined) {
        byDesign.set(k, p.id);
        representative.set(p.id, { design: fp, replicateIds: [] });
      } else representative.get(rep)!.replicateIds.push(p.id);
    }
    lines.push(`affected probes: ${active.length ? active.map((p) => p.id).join(", ") : "none"}`);
    for (const [id, r] of representative) {
      lines.push(`design ${r.design}: ${id}${r.replicateIds.length ? ` (replicates not re-counted: ${r.replicateIds.join(", ")})` : ""}`);
    }

    if (active.length === 0) {
      stopReason = trajectories.size === 0 && affected.size > 0 ? "no affected belief is notarized" : "no recorded probe was served the altered exchange";
    } else {
      // 1. One replay of the whole recorded sequence on a fresh recorder; one observation per design.
      const io = ioFor(fixture);
      const burst = new BurstCounter();
      for (const p of recorded) {
        const t = TEMPLATE_BY_NAME.get(p.template);
        if (!t) continue;
        const ctx = ctxFor(driftRunId, p, burst);
        const rep = representative.get(p.id);
        if (!rep) {
          // Unaffected probes and replicates: replayed only to keep the occurrence counters aligned.
          try {
            await t.execute(io, designOf(p), ctx);
          } catch {
            /* reported during discovery */
          }
          continue;
        }
        const traj = trajectories.get(p.claimId)!;
        const claim: Claim = store.claimFor(traj.beliefId);
        const id = `${p.id}~drift-${fixture.name}`;
        const res = await runProbe({
          io,
          db: opts.db,
          runId: driftRunId,
          probeId: id,
          claim,
          template: t,
          design: designOf(p),
          ctx,
          ledger: new CreditLedger({ budget: Number.MAX_SAFE_INTEGER }),
          now,
        });
        replayed.push(res.probe);
        const after = store.applyProbe(traj.beliefId, res.probe, res.verdict, hyps).belief;
        const winner = res.verdict.winningHypothesisId ? hyps.get(res.verdict.winningHypothesisId) : undefined;
        const against = res.verdict.verdict === "confirmed" && winner !== undefined && (winner.class === "honored") !== (traj.side === "honored");
        if (against) traj.designsAgainst += 1;
        traj.distinctDesigns += 1;
        traj.steps.push({ design: rep.design, probeId: id, sourceProbeId: p.id, replicateIds: rep.replicateIds, verdict: res.verdict.verdict, against, ...pointOf(after, traj.side) });
        traj.final = after;
      }
    }
  } finally {
    unwire();
  }

  const notUnlearned: string[] = [];
  for (const t of trajectories.values()) {
    t.final = store.get(t.beliefId)!;
    t.unlearned = t.final.status === "unlearned";
    const path = [t.start, ...t.steps].map((s) => `${s.sideConfidence.toFixed(4)}`).join(" -> ");
    lines.push(`${t.beliefId} (${t.side}): confidence in the notarized side ${path}; status ${t.start.status} -> ${t.final.status}`);
    if (t.steps.length === 0) continue;
    if (t.unlearned) {
      lines.push(`${t.beliefId}: un-learned on ${plural(t.designsAgainst, "distinct design")} that observed the change (${plural(t.distinctDesigns, "design")} replayed, each counted once)`);
    } else {
      const msg = `not un-learned: only ${plural(t.designsAgainst, "distinct design")} observed the change`;
      notUnlearned.push(msg);
      lines.push(
        `${t.beliefId}: ${msg} (crossing 0.5 from Beta(${t.start.alpha}, ${t.start.beta}) needs at least ${t.designsNeeded}; replicates of a design count once)`,
      );
    }
  }
  for (const g of retiredGuards) lines.push(`guard retired: ${g.id} (${g.kind} on ${g.operation}) at ${g.retiredAt ?? "?"}`);
  const unlearned = [...trajectories.values()].some((t) => t.unlearned);
  if (!stopReason) {
    const n = [...trajectories.values()].filter((t) => t.unlearned);
    stopReason = notUnlearned.length ? notUnlearned.join("; ") : `unlearned on ${n.map((t) => plural(t.designsAgainst, "distinct design")).join(", ")}`;
  }
  lines.push(`stop: ${stopReason}`);
  const ids = new Set([...trajectories.values()].map((t) => t.beliefId));
  return {
    drift: fixture.drift,
    fixture: fixture.name,
    affectedProbeIds: [...affected].sort(),
    trajectories: [...trajectories.values()],
    retiredGuards,
    probes: replayed,
    events: store.events(undefined, seq0).filter((e) => ids.has(e.beliefId)),
    unlearned,
    stopReason,
    lines,
  };
}
