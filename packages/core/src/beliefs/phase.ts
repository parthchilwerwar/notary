/**
 * The beliefs phase of `notary notarize` (TDD "The notarization loop", steps 7–8), run after the
 * probe loop (which already updates beliefs probe by probe and abstains at its caps):
 *
 *   1. ensure one belief per claim (Beta(1,1) or a transfer prior),
 *   2. apply every probe of this run in commit order (only "confirmed" moves α/β; idempotent),
 *   3. abstain: beliefs probed this run that are still between the thresholds when the run's
 *      probe allowance / budget ends,
 *   4. evidence-validity check (FR-10) on every belief with unchecked cited evidence; invalid
 *      evidence reverts the belief to hypothesis,
 *   5. adversary review of every candidate (FR-7) through `reviewBelief`; a missing adversary
 *      model (BLOCKED) leaves the candidates as candidates.
 * Returns beliefs before/after and the belief events appended during the phase, for the bundle.
 */
import { reviewBelief } from "../adversary/index.js";
import type { AdversaryBackend, ReviewBeliefArgs, ReviewOutcome } from "../adversary/index.js";
import type { LlmLike } from "../llm/index.js";
import type { Belief, BeliefEvent, BeliefStatus, Claim, Hypothesis, Probe, Tool } from "../schema/index.js";
import type { NotaryDb } from "../store/db.js";
import { isBlocked } from "../tools/index.js";
import { checkEvidence, loadSpanRecords } from "./evidence.js";
import { BeliefStore } from "./store.js";
import type { BeliefPrior } from "./store.js";

export interface BeliefsPhaseOptions {
  db: NotaryDb;
  tool: Tool;
  runsDir: string;
  claims: readonly Claim[];
  probes: readonly Probe[];
  hypotheses: readonly Hypothesis[];
  /** Why the probe loop stopped early (budget / cap), if it did. */
  stoppedReason?: string | undefined;
  /** Claims whose anomaly abstained in the loop (re-proposed rivals refuted too). */
  abstainedClaimIds?: readonly string[];
  backend: AdversaryBackend;
  llm?: LlmLike;
  /** Injected reviewer (tests); default reviewBelief. */
  review?: (args: ReviewBeliefArgs) => Promise<ReviewOutcome>;
  priors?: Readonly<Record<string, BeliefPrior>>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  store?: BeliefStore;
  /** Beliefs as they were before this run's probe loop (when the loop already updated them). */
  before?: Belief[];
  /** Report belief events appended after this seq (default: from the start of this phase). */
  eventsSince?: number;
}

export interface BeliefsPhaseResult {
  before: Belief[];
  after: Belief[];
  events: BeliefEvent[];
  lines: string[];
  /** Set when the adversary could not run (BLOCKED or config error); candidates stay candidates. */
  adversaryBlocked?: string;
  reviews: { uphold: number; narrow: number; downgrade: number; failed: number };
  evidence: { checked: number; invalid: number; source: string };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusCounts(beliefs: readonly Belief[]): Record<BeliefStatus, number> {
  const out: Record<BeliefStatus, number> = { hypothesis: 0, candidate: 0, notarized: 0, refuted: 0, abstained: 0, unlearned: 0 };
  for (const b of beliefs) out[b.status] += 1;
  return out;
}

/** Probe records by id for the given ids, from every run they belong to. */
function loadProbesById(db: NotaryDb, ids: readonly string[], current: readonly Probe[]): { probes: Map<string, Probe>; runIds: string[] } {
  const probes = new Map(current.map((p) => [p.id, p]));
  const runIds = new Set<string>();
  const stmt = db.db.prepare("SELECT run_id FROM probes WHERE id = ?");
  for (const id of ids) {
    const row = stmt.get(id) as { run_id?: unknown } | undefined;
    if (row?.run_id != null) runIds.add(String(row.run_id));
  }
  for (const runId of runIds) for (const p of db.loadProbes(runId)) if (ids.includes(p.id) && !probes.has(p.id)) probes.set(p.id, p);
  return { probes, runIds: [...runIds] };
}

export async function runBeliefsPhase(opts: BeliefsPhaseOptions): Promise<BeliefsPhaseResult> {
  const store = opts.store ?? new BeliefStore(opts.db, opts.now ? { now: opts.now } : {});
  const review = opts.review ?? reviewBelief;
  const lines: string[] = [];
  const claims = new Map(opts.claims.map((c) => [c.id, c]));
  const seq0 = opts.eventsSince ?? store.lastEventSeq();

  // 1. One belief per claim.
  for (const c of opts.claims) store.ensure(c, opts.priors?.[c.id]);
  const before = opts.before ?? store.list(opts.tool);

  // 2. Apply probes in commit order (a no-op for probes the loop already applied).
  const hyps = new Map(opts.hypotheses.map((h) => [h.id, h]));
  const probed = new Set<string>();
  for (const p of opts.probes) {
    const claim = claims.get(p.claimId);
    if (!claim) continue;
    const belief = store.ensure(claim, opts.priors?.[claim.id]);
    const observed = p.observed as { reason?: unknown } | undefined;
    store.applyProbe(
      belief.id,
      p,
      {
        verdict: p.verdict ?? "uninformative",
        ...(p.winningHypothesisId ? { winningHypothesisId: p.winningHypothesisId } : {}),
        reason: typeof observed?.reason === "string" ? observed.reason : "no verdict recorded",
      },
      hyps,
    );
    probed.add(claim.id);
  }

  // 3. Abstain: probed this run, still between the thresholds when the allowance/budget ended.
  const abstainedClaims = new Set(opts.abstainedClaimIds ?? []);
  for (const claimId of [...probed].sort()) {
    const b = store.byClaim(claimId)!;
    if (b.status !== "hypothesis") continue; // an unlearned belief keeps that status visible
    const why = opts.stoppedReason
      ? `budget ended between thresholds (${opts.stoppedReason})`
      : abstainedClaims.has(claimId)
        ? "every proposed rival was refuted twice; the run's probe allowance ended between thresholds"
        : "the run's probe allowance ended between thresholds";
    store.abstain(b.id, `${why}; P(holds)=${b.confidence.toFixed(4)}`);
  }

  // 4. Evidence-validity check on beliefs with unchecked cited evidence.
  const toCheck = store.list(opts.tool).filter((b) => b.evidence.some((e) => e.valid === undefined));
  const citedIds = [...new Set(toCheck.flatMap((b) => b.evidence.map((e) => e.probeId)))];
  const { probes: probeById, runIds } = loadProbesById(opts.db, citedIds, opts.probes);
  const spans = loadSpanRecords({ runsDir: opts.runsDir, runIds, ...(opts.env ? { env: opts.env } : {}) });
  let checked = 0;
  let invalid = 0;
  for (const b of toCheck) {
    const claim = claims.get(b.claimId) ?? store.claimFor(b.id);
    const results = checkEvidence({ belief: b, claim, probes: [...probeById.values()], spans: spans.records });
    checked += results.length;
    invalid += results.filter((r) => !r.valid).length;
    store.applyEvidenceCheck(b.id, results);
    for (const r of results) if (!r.valid) lines.push(`invalid evidence ${b.id} <- ${r.probeId}: ${r.reason}`);
  }
  for (const n of spans.notes) lines.push(`evidence note: ${n}`);

  // 5. Adversary on every candidate.
  const reviews = { uphold: 0, narrow: 0, downgrade: 0, failed: 0 };
  let adversaryBlocked: string | undefined;
  const candidates = store.list(opts.tool).filter((b) => b.status === "candidate");
  if (candidates.length && opts.backend === "bedrock") {
    const withModel = opts.llm as (LlmLike & { modelFor?: (role: "adversary") => string }) | undefined;
    if (!withModel) adversaryBlocked = "BLOCKED: no LLM client for the bedrock adversary";
    else if (typeof withModel.modelFor === "function") {
      try {
        withModel.modelFor("adversary");
      } catch (err) {
        if (isBlocked(err)) adversaryBlocked = err.message;
        else throw err;
      }
    }
  }
  for (const b of candidates) {
    const claim = claims.get(b.claimId) ?? store.claimFor(b.id);
    if (adversaryBlocked) {
      store.applyAdversary(b.id, null, adversaryBlocked);
      continue;
    }
    const cited = b.evidence.map((e) => e.probeId);
    const own = opts.probes.filter((p) => p.claimId === b.claimId).map((p) => p.id);
    const { probes } = loadProbesById(opts.db, [...new Set([...cited, ...own])], opts.probes);
    let outcome: ReviewOutcome;
    try {
      outcome = await review({
        belief: b,
        claim,
        probes: [...probes.values()].filter((p) => p.claimId === b.claimId),
        backend: opts.backend,
        ...(opts.llm ? { llm: opts.llm } : {}),
      });
    } catch (err) {
      if (isBlocked(err)) {
        adversaryBlocked = err.message;
        store.applyAdversary(b.id, null, adversaryBlocked);
        continue;
      }
      outcome = { review: null, failure: `adversary error: ${errText(err)}` };
    }
    const after = store.applyAdversary(b.id, outcome.review, outcome.failure);
    if (outcome.review) {
      reviews[outcome.review.verdict] += 1;
      lines.push(`adversary ${outcome.review.verdict} ${b.id} -> ${after.status}: ${outcome.review.reason}`);
    } else {
      reviews.failed += 1;
      lines.push(`adversary failed ${b.id} (stays candidate): ${outcome.failure ?? "no review"}`);
    }
  }

  const after = store.list(opts.tool);
  const ids = new Set(after.map((b) => b.id));
  const events = store.events(undefined, seq0).filter((e) => ids.has(e.beliefId));
  const counts = statusCounts(after);
  lines.unshift(
    `beliefs: ${after.length}  ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`,
    `evidence: checked ${checked}, invalid ${invalid} (source ${spans.source})`,
    `adversary: backend=${opts.backend} uphold=${reviews.uphold} narrow=${reviews.narrow} downgrade=${reviews.downgrade} failed=${reviews.failed}`,
  );
  if (adversaryBlocked) {
    const n = after.filter((b) => b.status === "candidate").length;
    lines.push(`${adversaryBlocked.startsWith("BLOCKED:") ? adversaryBlocked : `BLOCKED: ${adversaryBlocked}`} (adversary review skipped; ${n} belief(s) stay candidate)`);
  }
  return {
    before,
    after,
    events,
    lines,
    ...(adversaryBlocked ? { adversaryBlocked } : {}),
    reviews,
    evidence: { checked, invalid, source: spans.source },
  };
}
