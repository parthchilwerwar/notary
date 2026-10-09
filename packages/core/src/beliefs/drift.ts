/**
 * Drift replay: the un-learning path (TDD "Drift fixture" and step 7; PRD FR-16). `notary replay
 * --drift` (P8) will drive it; P7 provides the mechanism and its test.
 *
 * Given a drift fixture (a real cassette with exactly one response changed, src/tools/drift-fixture.ts)
 * and the probes recorded into that cassette (from the notarize bundle, or from the db by runId):
 *
 *   0. discovery: replay every recorded probe in commit order against the fixture on ONE replay
 *      recorder (so repeated identical requests get the same recorded copy as in the original
 *      run). The AFFECTED probes are those that were served the altered exchange
 *      (requestHash + occurrence). Only their claims' beliefs are touched: the other recordings
 *      are unchanged observations the beliefs already counted, so re-applying them would double
 *      count old evidence.
 *   1..N passes: each pass replays the same sequence on a fresh recorder; every affected probe is
 *      re-run through runProbe (its ORIGINAL pre-registered prediction is committed under a new id
 *      `<probeId>~drift-<fixture>-<pass>` before the replayed call, then judged by the same
 *      deterministic verdict rules) and its verdict is applied to the EXISTING belief with
 *      BeliefStore.applyProbe. Each pass stands for one fresh observation of the new behavior.
 *   Un-learning is not special-cased: BeliefStore moves a notarized belief to `unlearned` when
 *   P(holds) crosses back over 0.5 against its side, and wireRetirement retires its guards.
 *
 * Passes stop when no affected belief is notarized any more (unlearned), when a pass produced no
 * observation against an affected belief's notarized side, or at maxPasses (default 10, env
 * NOTARY_DRIFT_MAX_PASSES). Returns each belief's trajectory (α, β, P(holds), and confidence in
 * the notarized side, step by step), the retired guards and the replayed probes.
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
import { loadDriftFixture } from "../tools/drift-fixture.js";
import type { DriftFixture, DriftMeta } from "../tools/drift-fixture.js";
import { BeliefStore } from "./store.js";

/** Default cap on drift passes (env NOTARY_DRIFT_MAX_PASSES). */
export const DEFAULT_DRIFT_MAX_PASSES = 10;

export function driftMaxPassesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NOTARY_DRIFT_MAX_PASSES?.trim();
  if (!raw) return DEFAULT_DRIFT_MAX_PASSES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DRIFT_MAX_PASSES;
}

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
  /** Only touch this claim's belief (default: every claim whose probe consumed the altered exchange). */
  claimId?: string;
  /** ProbeIo serving the fixture; called once per pass (fresh recorder). Default: createTools replay. */
  io?: (fixture: DriftFixture) => ProbeIo;
  maxPasses?: number;
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
  pass: number;
  probeId: string;
  sourceProbeId: string;
  verdict: ProbeVerdict;
}

export interface DriftTrajectory {
  beliefId: string;
  claimId: string;
  side: "honored" | "violated";
  start: DriftPoint;
  steps: DriftStep[];
  final: Belief;
}

export interface ReplayDriftResult {
  drift: DriftMeta;
  fixture: string;
  affectedProbeIds: string[];
  trajectories: DriftTrajectory[];
  retiredGuards: Guard[];
  probes: Probe[];
  events: BeliefEvent[];
  passes: number;
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

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export async function replayDrift(opts: ReplayDriftOptions): Promise<ReplayDriftResult> {
  const fixture = typeof opts.fixture === "string" ? loadDriftFixture(opts.fixture) : opts.fixture;
  const env = opts.env ?? {};
  const now = opts.now ?? (() => new Date());
  const maxPasses = opts.maxPasses ?? driftMaxPassesFromEnv(opts.env ?? process.env);
  const ioFor =
    opts.io ??
    ((f: DriftFixture) => rawReplayProbeIo({ cassettes: [f], ledger: new CreditLedger({ budget: Number.MAX_SAFE_INTEGER }), env }));
  const [driftHash, driftOcc] = fixture.drift.exchange.split(":");
  const isDrifted = (ex: Exchange): boolean => ex.requestHash === driftHash && ex.occurrence === Number(driftOcc ?? 0);
  const driftRunId = `drift-${fixture.name}`;
  const lines: string[] = [`drift fixture ${fixture.name}: ${fixture.drift.source} exchange ${fixture.drift.exchange.slice(0, 12)}…, ${fixture.drift.path}: ${JSON.stringify(fixture.drift.before)} -> ${JSON.stringify(fixture.drift.after)}`];

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

  // 0. Discovery: which recorded probes were served the altered exchange?
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
  const replayed: Probe[] = [];
  let passes = 0;
  let stopReason = "";

  try {
    for (const p of recorded) {
      if (!affected.has(p.id) || trajectories.has(p.claimId)) continue;
      const b = store.byClaim(p.claimId);
      if (!b) {
        lines.push(`no belief for ${p.claimId} in the store: its probes are not replayed`);
        continue;
      }
      const side = beliefSide(b);
      trajectories.set(p.claimId, { beliefId: b.id, claimId: p.claimId, side, start: pointOf(b, side), steps: [], final: b });
    }
    const active = recorded.filter((p) => affected.has(p.id) && trajectories.has(p.claimId));
    lines.push(`affected probes: ${active.length ? active.map((p) => p.id).join(", ") : "none"}`);
    if (active.length === 0) stopReason = "no recorded probe was served the altered exchange";

    for (let pass = 1; active.length > 0 && pass <= maxPasses; pass++) {
      const notarizedBefore = [...trajectories.values()].filter((t) => store.get(t.beliefId)?.status === "notarized");
      if (notarizedBefore.length === 0) {
        stopReason = "no affected belief is notarized";
        break;
      }
      passes = pass;
      const io = ioFor(fixture);
      const burst = new BurstCounter();
      let against = 0;
      for (const p of recorded) {
        const t = TEMPLATE_BY_NAME.get(p.template);
        if (!t) continue;
        const ctx = ctxFor(driftRunId, p, burst);
        if (!affected.has(p.id) || !trajectories.has(p.claimId)) {
          // Replayed only to keep the recorder's occurrence counters aligned with the recording.
          try {
            await t.execute(io, designOf(p), ctx);
          } catch {
            /* reported during discovery */
          }
          continue;
        }
        const traj = trajectories.get(p.claimId)!;
        const claim: Claim = store.claimFor(traj.beliefId);
        const id = `${p.id}~drift-${fixture.name}-${pass}`;
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
        const applied = store.applyProbe(traj.beliefId, res.probe, res.verdict, hyps);
        const after = applied.belief;
        const winner = res.verdict.winningHypothesisId ? hyps.get(res.verdict.winningHypothesisId) : undefined;
        if (res.verdict.verdict === "confirmed" && winner && (winner.class === "honored") !== (traj.side === "honored")) against += 1;
        traj.steps.push({ pass, probeId: id, sourceProbeId: p.id, verdict: res.verdict.verdict, ...pointOf(after, traj.side) });
        traj.final = after;
      }
      const stillNotarized = [...trajectories.values()].filter((t) => store.get(t.beliefId)?.status === "notarized");
      if (stillNotarized.length === 0) {
        stopReason = `unlearned after ${pass} pass(es)`;
        break;
      }
      if (against === 0) {
        stopReason = `pass ${pass} produced no observation against the notarized side`;
        break;
      }
      if (pass === maxPasses) stopReason = `maxPasses (${maxPasses}) reached`;
    }
  } finally {
    unwire();
  }

  for (const t of trajectories.values()) {
    t.final = store.get(t.beliefId)!;
    const path = [t.start, ...t.steps].map((s) => `${s.sideConfidence.toFixed(4)}`).join(" -> ");
    lines.push(`${t.beliefId} (${t.side}): confidence in the notarized side ${path}; status ${t.start.status} -> ${t.final.status}`);
  }
  for (const g of retiredGuards) lines.push(`guard retired: ${g.id} (${g.kind} on ${g.operation}) at ${g.retiredAt ?? "?"}`);
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
    passes,
    stopReason,
    lines,
  };
}
