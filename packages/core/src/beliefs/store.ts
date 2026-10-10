/**
 * Belief store (TDD "The notarization loop", steps 7–8; PRD FR-5, FR-6, FR-7, FR-10).
 *
 * One belief per claim, a Beta(α, β) over "the doc claim holds" (see math.ts for the exact
 * definition of `confidence` = P(holds)). Persisted in SQLite next to the probes:
 *   beliefs        current state (one row per claim)
 *   belief_probes  every probe applied to a belief (idempotent: a probe id applies once); the
 *                  ones that moved α/β are the belief's cited evidence
 *   belief_events  APPEND-ONLY log: triggers abort any UPDATE or DELETE
 *
 * Update rules
 *   - Only verdict "confirmed" moves α/β: winning hypothesis class "honored" → α+1; any other
 *     class → β+1 and belief.class := that class. The probe is cited as evidence
 *     {probeId, traceId, spanId}.
 *   - "inconclusive" / "uninformative" / "invalid" / "refuted" → no α/β change (FR-6); an event
 *     records the verdict and reason. These probes are NOT cited as evidence.
 *
 * Lifecycle
 *   hypothesis | abstained | unlearned | refuted
 *       → candidate   when P(holds) > 0.9 (honored side) or < 0.1 (violated side) AND at least 2
 *                     INDEPENDENT cited probes support that side (see below). The first time,
 *                     `probesToCandidate` := probes applied to the belief so far (all verdicts).
 *   candidate → hypothesis   when P(holds) falls back between the thresholds
 *   candidate → notarized    adversary uphold, or narrow (statement suffixed with the scope)
 *   candidate → hypothesis   adversary downgrade (FR-7: refuted beliefs revert to hypotheses)
 *   candidate → candidate    adversary review missing/malformed (fail safe), with an event
 *   notarized → unlearned    P(holds) crosses back over 0.5 against the side it was notarized on
 *                            (strictly: < 0.5 for honored, > 0.5 for violated); fires onUnlearn
 *   any (≠ hypothesis) → hypothesis   a cited span fails the evidence-validity check (FR-10); the
 *                            failed probe's +1 is taken back off α/β (P9), so it never moves P(holds)
 *   candidate → notarized    additionally needs ≥ 2 independent cited probes whose evidence PASSED the
 *                            FR-10 check (valid = 1); unchecked evidence cannot be notarized (P9)
 *   applyProbe refuses a verdict / winner that differs from the one recorded on the probe (P9)
 *   hypothesis | unlearned → abstained   `abstain()` when the budget ends between thresholds
 *
 * Independence rule: two cited probes are independent iff they have distinct probe ids AND
 * distinct design fingerprints, fingerprint = template + the treatment's values at claim.param
 * (template alone when the claim has no param). A replicate of the same experiment moves α/β but
 * does not add independence. Evidence marked valid:false never counts.
 *
 * Statements are generated deterministically from the claim and the side:
 *   "Doc claim holds: <op> [<param>] — <docText>"
 *   "Doc claim violated (<class>): <op> [<param>] — <docText>"
 * plus " [narrowed scope: <scope>]" after an adversary `narrow`. Side = the candidate/notarized
 * side when there is one, else P(holds) ≥ 0.5 → holds.
 *
 * Every status change (and every probe application, even without one) appends a BeliefEvent
 * {from, to, α, β, confidence, reason, probeId?}.
 */
import { DatabaseSync } from "node:sqlite";
import {
  AdversaryReviewSchema,
  BeliefEventSchema,
  BeliefPriorSchema,
  BeliefSchema,
  ClaimSchema,
} from "../schema/index.js";
import type {
  AdversaryReview,
  Belief,
  BeliefEvent,
  BeliefStatus,
  Claim,
  DefectClass,
  Hypothesis,
  Probe,
  ProbeVerdict,
} from "../schema/index.js";
import type { NotaryDb } from "../store/db.js";
import { MIN_INDEPENDENT_PROBES, UNLEARN_LINE, pHolds, sidePastThreshold } from "./math.js";
import type { Side } from "./math.js";
import { designFingerprint } from "./params.js";

export type BeliefPrior = NonNullable<Belief["prior"]>;

/** What applyProbe needs from a verdict (VerdictResult from reflect/verdict.ts fits). */
export interface VerdictLike {
  verdict: ProbeVerdict;
  winningHypothesisId?: string;
  reason: string;
}

export interface ApplyProbeResult {
  belief: Belief;
  /** True when α or β moved. */
  updated: boolean;
  /** False when this probe had already been applied to the belief (no-op). */
  applied: boolean;
  event?: BeliefEvent;
}

export interface EvidenceVerdict {
  probeId: string;
  valid: boolean;
  reason: string;
}

export type BeliefCallback = (belief: Belief, event: BeliefEvent) => void;

export interface BeliefStoreOptions {
  now?: () => Date;
  /** Fired when a notarized belief unlearns (P6/P7 retire its guard). */
  onUnlearn?: BeliefCallback;
  /** Fired whenever a notarized belief leaves `notarized` for any reason (unlearn or invalid evidence). */
  onLeaveNotarized?: BeliefCallback;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS beliefs (
  id                  TEXT PRIMARY KEY,
  claim_id            TEXT NOT NULL UNIQUE,
  tool                TEXT NOT NULL,
  claim_json          TEXT NOT NULL,
  class               TEXT,
  side                TEXT,
  scope               TEXT,
  alpha               REAL NOT NULL,
  beta                REAL NOT NULL,
  confidence          REAL NOT NULL,
  status              TEXT NOT NULL,
  adversary_json      TEXT,
  prior_json          TEXT,
  probes_applied      INTEGER NOT NULL DEFAULT 0,
  probes_to_candidate INTEGER,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS belief_probes (
  belief_id   TEXT NOT NULL,
  probe_id    TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  side        TEXT,
  fingerprint TEXT NOT NULL,
  cited       INTEGER NOT NULL DEFAULT 0,
  trace_id    TEXT NOT NULL,
  span_id     TEXT,
  valid       INTEGER,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (belief_id, probe_id)
);

CREATE TABLE IF NOT EXISTS belief_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  belief_id   TEXT NOT NULL,
  at          TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  alpha       REAL NOT NULL,
  beta        REAL NOT NULL,
  confidence  REAL NOT NULL,
  reason      TEXT NOT NULL,
  probe_id    TEXT
);
CREATE INDEX IF NOT EXISTS belief_events_belief ON belief_events (belief_id, seq);

CREATE TRIGGER IF NOT EXISTS belief_events_no_update
BEFORE UPDATE ON belief_events
BEGIN
  SELECT RAISE(ABORT, 'belief_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS belief_events_no_delete
BEFORE DELETE ON belief_events
BEGIN
  SELECT RAISE(ABORT, 'belief_events is append-only');
END;
`;

type Row = Record<string, unknown>;

const OPEN_STATUSES: ReadonlySet<BeliefStatus> = new Set<BeliefStatus>(["hypothesis", "abstained", "unlearned", "refuted"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

/** Deterministic belief id for a claim. */
export function beliefIdFor(claimId: string): string {
  return `belief-${claimId}`;
}

/** Deterministic statement text from claim + side (+ class for violations, + narrowed scope). */
export function statementFor(claim: Claim, side: Side, cls?: DefectClass | null, scope?: string | null): string {
  const subject = `${claim.operation}${claim.param ? ` [${claim.param}]` : ""} — ${claim.docText}`;
  const head = side === "honored" ? "Doc claim holds" : `Doc claim violated (${cls && cls !== "honored" ? cls : "unclassified"})`;
  return `${head}: ${subject}${scope ? ` [narrowed scope: ${scope}]` : ""}`;
}

export class BeliefStore {
  readonly db: DatabaseSync;
  private readonly now: () => Date;
  private onUnlearn: BeliefCallback | undefined;
  private onLeaveNotarized: BeliefCallback | undefined;
  private probeSeq = 0;

  constructor(db: NotaryDb | DatabaseSync, opts: BeliefStoreOptions = {}) {
    this.db = db instanceof DatabaseSync ? db : db.db;
    this.now = opts.now ?? (() => new Date());
    this.onUnlearn = opts.onUnlearn;
    this.onLeaveNotarized = opts.onLeaveNotarized;
    this.db.exec(SCHEMA_SQL);
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM belief_probes").get() as Row | undefined;
    this.probeSeq = Number(row?.s ?? 0);
  }

  setOnUnlearn(cb: BeliefCallback | undefined): void {
    this.onUnlearn = cb;
  }

  setOnLeaveNotarized(cb: BeliefCallback | undefined): void {
    this.onLeaveNotarized = cb;
  }

  // ------------------------------------------------------------------ reads

  private row(beliefId: string): Row {
    const r = this.db.prepare("SELECT * FROM beliefs WHERE id = ?").get(beliefId) as Row | undefined;
    if (!r) throw new Error(`belief ${beliefId} not found`);
    return r;
  }

  private claimOf(r: Row): Claim {
    return ClaimSchema.parse(JSON.parse(str(r.claim_json)));
  }

  private toBelief(r: Row): Belief {
    const claim = this.claimOf(r);
    const evidence = (
      this.db
        .prepare("SELECT probe_id, trace_id, span_id, valid FROM belief_probes WHERE belief_id = ? AND cited = 1 ORDER BY seq")
        .all(str(r.id)) as Row[]
    ).map((e) => ({
      probeId: str(e.probe_id),
      traceId: str(e.trace_id),
      ...(e.span_id == null ? {} : { spanId: str(e.span_id) }),
      ...(e.valid == null ? {} : { valid: Number(e.valid) === 1 }),
    }));
    const alpha = Number(r.alpha);
    const beta = Number(r.beta);
    const confidence = Number(r.confidence);
    const side: Side = r.side != null ? (str(r.side) as Side) : confidence >= UNLEARN_LINE ? "honored" : "violated";
    const cls = r.class == null ? undefined : (str(r.class) as DefectClass);
    return BeliefSchema.parse({
      id: r.id,
      claimId: r.claim_id,
      tool: r.tool,
      ...(cls ? { class: cls } : {}),
      statement: statementFor(claim, side, cls, r.scope == null ? null : str(r.scope)),
      alpha,
      beta,
      confidence,
      status: r.status,
      evidence,
      ...(r.adversary_json == null ? {} : { adversary: AdversaryReviewSchema.parse(JSON.parse(str(r.adversary_json))) }),
      ...(r.prior_json == null ? {} : { prior: BeliefPriorSchema.parse(JSON.parse(str(r.prior_json))) }),
      ...(r.probes_to_candidate == null ? {} : { probesToCandidate: Number(r.probes_to_candidate) }),
      updatedAt: r.updated_at,
    });
  }

  get(beliefId: string): Belief | undefined {
    const r = this.db.prepare("SELECT * FROM beliefs WHERE id = ?").get(beliefId) as Row | undefined;
    return r ? this.toBelief(r) : undefined;
  }

  byClaim(claimId: string): Belief | undefined {
    return this.get(beliefIdFor(claimId));
  }

  claimFor(beliefId: string): Claim {
    return this.claimOf(this.row(beliefId));
  }

  list(tool?: Claim["tool"]): Belief[] {
    const rows = (
      tool
        ? this.db.prepare("SELECT * FROM beliefs WHERE tool = ? ORDER BY id").all(tool)
        : this.db.prepare("SELECT * FROM beliefs ORDER BY id").all()
    ) as Row[];
    return rows.map((r) => this.toBelief(r));
  }

  /** Events in append order; all beliefs, or one. `sinceSeq` returns only events after that seq. */
  events(beliefId?: string, sinceSeq = 0): BeliefEvent[] {
    const rows = (
      beliefId
        ? this.db.prepare("SELECT * FROM belief_events WHERE belief_id = ? AND seq > ? ORDER BY seq").all(beliefId, sinceSeq)
        : this.db.prepare("SELECT * FROM belief_events WHERE seq > ? ORDER BY seq").all(sinceSeq)
    ) as Row[];
    return rows.map((r) =>
      BeliefEventSchema.parse({
        beliefId: r.belief_id,
        at: r.at,
        from: r.from_status ?? null,
        to: r.to_status,
        alpha: Number(r.alpha),
        beta: Number(r.beta),
        confidence: Number(r.confidence),
        reason: r.reason,
        ...(r.probe_id == null ? {} : { probeId: r.probe_id }),
      }),
    );
  }

  /** Highest event seq so far (for `events(undefined, since)`). */
  lastEventSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM belief_events").get() as Row | undefined;
    return Number(r?.s ?? 0);
  }

  /** Design fingerprints of every probe already applied to the belief (any verdict). */
  appliedFingerprints(beliefId: string): Set<string> {
    const rows = this.db.prepare("SELECT fingerprint FROM belief_probes WHERE belief_id = ?").all(beliefId) as Row[];
    return new Set(rows.map((r) => str(r.fingerprint)));
  }

  /** Independent cited probes supporting `side` (valid or not yet checked). */
  independentProbes(beliefId: string, side: Side): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(DISTINCT fingerprint) AS n FROM belief_probes
         WHERE belief_id = ? AND cited = 1 AND side = ? AND (valid IS NULL OR valid = 1)`,
      )
      .get(beliefId, side) as Row | undefined;
    return Number(r?.n ?? 0);
  }

  /** Independent cited probes supporting `side` whose evidence PASSED the FR-10 check (valid = 1). */
  verifiedIndependentProbes(beliefId: string, side: Side): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(DISTINCT fingerprint) AS n FROM belief_probes
         WHERE belief_id = ? AND cited = 1 AND side = ? AND valid = 1`,
      )
      .get(beliefId, side) as Row | undefined;
    return Number(r?.n ?? 0);
  }

  // ------------------------------------------------------------------ writes

  private appendEvent(e: Omit<BeliefEvent, "at">): BeliefEvent {
    const event = BeliefEventSchema.parse({ ...e, at: this.now().toISOString() });
    this.db
      .prepare(
        `INSERT INTO belief_events (belief_id, at, from_status, to_status, alpha, beta, confidence, reason, probe_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(event.beliefId, event.at, event.from, event.to, event.alpha, event.beta, event.confidence, event.reason, event.probeId ?? null);
    return event;
  }

  private save(id: string, patch: Record<string, string | number | null>): void {
    const keys = Object.keys(patch);
    const sql = `UPDATE beliefs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => patch[k]!), this.now().toISOString(), id);
  }

  /** Create the claim's belief at Beta(1,1) or `prior` (status hypothesis); existing beliefs are returned as is. */
  ensure(claim: Claim, prior?: BeliefPrior): Belief {
    const id = beliefIdFor(claim.id);
    const existing = this.get(id);
    if (existing) return existing;
    const p = prior ? BeliefPriorSchema.parse(prior) : undefined;
    const alpha = p?.alpha ?? 1;
    const beta = p?.beta ?? 1;
    const confidence = pHolds(alpha, beta);
    this.db
      .prepare(
        `INSERT INTO beliefs (id, claim_id, tool, claim_json, alpha, beta, confidence, status, prior_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'hypothesis', ?, ?)`,
      )
      .run(id, claim.id, claim.tool, JSON.stringify(ClaimSchema.parse(claim)), alpha, beta, confidence, p ? JSON.stringify(p) : null, this.now().toISOString());
    this.appendEvent({
      beliefId: id,
      from: null,
      to: "hypothesis",
      alpha,
      beta,
      confidence,
      reason: p ? `created from transfer prior Beta(${alpha}, ${beta}) (from ${p.from})` : "created at Beta(1, 1)",
    });
    return this.get(id)!;
  }

  /**
   * Apply one probe's verdict. Only "confirmed" moves α/β (see header). Applying the same probe
   * id twice is a no-op (`applied: false`).
   */
  applyProbe(
    beliefId: string,
    probe: Probe,
    verdict: VerdictLike,
    hypothesesById: ReadonlyMap<string, Hypothesis> | Readonly<Record<string, Hypothesis>>,
  ): ApplyProbeResult {
    const r = this.row(beliefId);
    if (str(r.claim_id) !== probe.claimId) throw new Error(`probe ${probe.id} is for claim ${probe.claimId}, belief ${beliefId} is for ${str(r.claim_id)}`);
    // P9 (AUDIT-03): the verdict applied must be the one recorded on the probe, never a caller's override.
    if (probe.verdict !== undefined && probe.verdict !== verdict.verdict) {
      throw new Error(`probe ${probe.id}: verdict ${verdict.verdict} differs from its recorded verdict ${probe.verdict}`);
    }
    if (verdict.verdict === "confirmed" && probe.winningHypothesisId !== undefined && probe.winningHypothesisId !== verdict.winningHypothesisId) {
      throw new Error(`probe ${probe.id}: winner ${verdict.winningHypothesisId ?? "(none)"} differs from its recorded winner ${probe.winningHypothesisId}`);
    }
    const seen = this.db.prepare("SELECT 1 AS x FROM belief_probes WHERE belief_id = ? AND probe_id = ?").get(beliefId, probe.id);
    if (seen) return { belief: this.toBelief(r), updated: false, applied: false };

    const claim = this.claimOf(r);
    const lookup = (id: string): Hypothesis | undefined =>
      hypothesesById instanceof Map ? hypothesesById.get(id) : (hypothesesById as Record<string, Hypothesis>)[id];
    const status = str(r.status) as BeliefStatus;
    let alpha = Number(r.alpha);
    let beta = Number(r.beta);
    let cls = r.class == null ? null : str(r.class);
    let side: Side | null = null;
    let reason: string;

    if (verdict.verdict === "confirmed") {
      const winner = verdict.winningHypothesisId ? lookup(verdict.winningHypothesisId) : undefined;
      if (!winner) {
        reason = `confirmed probe's winning hypothesis ${verdict.winningHypothesisId ?? "(none)"} is unknown: no update`;
      } else if (winner.class === "honored") {
        alpha += 1;
        side = "honored";
        reason = `confirmed honored (${winner.id}): α+1`;
      } else {
        beta += 1;
        side = "violated";
        cls = winner.class;
        reason = `confirmed ${winner.class} (${winner.id}): β+1`;
      }
    } else {
      reason = `${verdict.verdict}: no update (${verdict.reason})`;
    }

    this.probeSeq += 1;
    this.db
      .prepare(
        `INSERT INTO belief_probes (belief_id, probe_id, verdict, side, fingerprint, cited, trace_id, span_id, valid, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(beliefId, probe.id, verdict.verdict, side, designFingerprint(claim, probe), side ? 1 : 0, probe.traceId, probe.spanId ?? null, this.probeSeq);

    const probesApplied = Number(r.probes_applied) + 1;
    const confidence = pHolds(alpha, beta);
    this.save(beliefId, { alpha, beta, confidence, class: cls, probes_applied: probesApplied });

    const updated = side !== null;
    // Every applied probe is logged, including the no-update verdicts (FR-6).
    const { event } = this.evaluate(beliefId, status, reason, probe.id, true);
    return { belief: this.get(beliefId)!, updated, applied: true, ...(event ? { event } : {}) };
  }

  /**
   * Re-derive status from α/β after a change and append one event (always when `alwaysLog`, else
   * only on a status change).
   */
  private evaluate(beliefId: string, from: BeliefStatus, reason: string, probeId: string | undefined, alwaysLog: boolean): { event?: BeliefEvent } {
    const r = this.row(beliefId);
    const alpha = Number(r.alpha);
    const beta = Number(r.beta);
    const confidence = Number(r.confidence);
    const side = r.side == null ? null : (str(r.side) as Side);
    let to: BeliefStatus = from;
    let why = reason;
    const patch: Record<string, string | number | null> = {};
    let unlearned = false;

    if (from === "notarized" && side) {
      if ((side === "honored" && confidence < UNLEARN_LINE) || (side === "violated" && confidence > UNLEARN_LINE)) {
        to = "unlearned";
        unlearned = true;
        why = `${reason}; P(holds)=${confidence.toFixed(4)} crossed back over ${UNLEARN_LINE} against the notarized side (${side}): unlearned`;
        patch.side = null;
        patch.scope = null;
      }
    } else if (from === "candidate") {
      if (sidePastThreshold(confidence) !== side) {
        to = "hypothesis";
        why = `${reason}; P(holds)=${confidence.toFixed(4)} no longer past the ${side} threshold: back to hypothesis`;
        patch.side = null;
      }
    } else if (OPEN_STATUSES.has(from)) {
      const past = sidePastThreshold(confidence);
      if (past) {
        const n = this.independentProbes(beliefId, past);
        if (n >= MIN_INDEPENDENT_PROBES) {
          to = "candidate";
          why = `${reason}; P(holds)=${confidence.toFixed(4)} past the ${past} threshold with ${n} independent probes: candidate`;
          patch.side = past;
          if (past === "honored") patch.class = "honored";
          if (r.probes_to_candidate == null) patch.probes_to_candidate = Number(r.probes_applied);
        } else {
          why = `${reason}; P(holds)=${confidence.toFixed(4)} past the ${past} threshold but only ${n} independent probe(s) (need ${MIN_INDEPENDENT_PROBES})`;
        }
      }
    }

    if (to !== from) patch.status = to;
    if (Object.keys(patch).length) this.save(beliefId, patch);
    if (to === from && !alwaysLog) return {};
    const event = this.appendEvent({ beliefId, from, to, alpha, beta, confidence, reason: why, ...(probeId ? { probeId } : {}) });
    if (from === "notarized" && to !== "notarized") {
      const b = this.get(beliefId)!;
      if (unlearned) this.onUnlearn?.(b, event);
      this.onLeaveNotarized?.(b, event);
    }
    return { event };
  }

  /** Budget ended between the thresholds: hypothesis/unlearned → abstained. Other statuses are left alone. */
  abstain(beliefId: string, reason: string): Belief {
    const r = this.row(beliefId);
    const from = str(r.status) as BeliefStatus;
    if (from !== "hypothesis" && from !== "unlearned") return this.toBelief(r);
    this.save(beliefId, { status: "abstained" });
    this.appendEvent({
      beliefId,
      from,
      to: "abstained",
      alpha: Number(r.alpha),
      beta: Number(r.beta),
      confidence: Number(r.confidence),
      reason: `abstain: ${reason}`,
    });
    return this.get(beliefId)!;
  }

  /**
   * Adversary verdict for a candidate (FR-7). uphold → notarized; narrow → notarized with the
   * narrowed scope in the statement; downgrade → hypothesis; null → stays candidate (fail safe).
   */
  applyAdversary(beliefId: string, review: AdversaryReview | null, failure?: string): Belief {
    const r = this.row(beliefId);
    const from = str(r.status) as BeliefStatus;
    if (from !== "candidate") throw new Error(`applyAdversary: belief ${beliefId} is ${from}, not candidate`);
    const base = { beliefId, from, alpha: Number(r.alpha), beta: Number(r.beta), confidence: Number(r.confidence) };
    if (review === null) {
      this.appendEvent({ ...base, to: "candidate", reason: `adversary review unavailable (${failure ?? "no review"}): stays candidate` });
      return this.toBelief(r);
    }
    const rev = AdversaryReviewSchema.parse(review);
    if (rev.verdict !== "downgrade") {
      // P9 (AUDIT-02): only evidence that PASSED the FR-10 check (valid = 1, not merely unchecked) can be notarized.
      const side = r.side == null ? null : (str(r.side) as Side);
      const verified = side ? this.verifiedIndependentProbes(beliefId, side) : 0;
      if (verified < MIN_INDEPENDENT_PROBES) {
        throw new Error(
          `applyAdversary: belief ${beliefId} has ${verified} independent probe(s) whose evidence passed the FR-10 check (need ${MIN_INDEPENDENT_PROBES}); run the evidence check before the adversary`,
        );
      }
    }
    const by = `adversary ${rev.verdict} (${rev.backend ?? "bedrock"}, ${rev.model})`;
    if (rev.verdict === "downgrade") {
      this.save(beliefId, { status: "hypothesis", side: null, scope: null, adversary_json: JSON.stringify(rev) });
      this.appendEvent({ ...base, to: "hypothesis", reason: `${by}: ${rev.reason}` });
    } else {
      const scope = rev.verdict === "narrow" ? (rev.scope ?? rev.reason) : null;
      this.save(beliefId, { status: "notarized", scope, adversary_json: JSON.stringify(rev) });
      this.appendEvent({ ...base, to: "notarized", reason: `${by}: ${rev.reason}${scope ? ` [scope: ${scope}]` : ""}` });
    }
    return this.get(beliefId)!;
  }

  /**
   * Record the evidence-validity check (FR-10). Each listed probe's evidence gets valid:true/false;
   * if any is invalid the belief reverts to hypothesis (from any other status) with an event.
   */
  applyEvidenceCheck(beliefId: string, results: readonly EvidenceVerdict[]): Belief {
    const before = this.row(beliefId);
    const stmt = this.db.prepare("UPDATE belief_probes SET valid = ? WHERE belief_id = ? AND probe_id = ? AND cited = 1");
    const prevStmt = this.db.prepare("SELECT side, valid FROM belief_probes WHERE belief_id = ? AND probe_id = ? AND cited = 1");
    // P9 (AUDIT-01): an observation that fails the check gives back the α/β it added (and gets it
    // back if a later check passes it), so invalid evidence never moves P(holds).
    let alpha = Number(before.alpha);
    let beta = Number(before.beta);
    for (const res of results) {
      const prev = prevStmt.get(beliefId, res.probeId) as Row | undefined;
      if (!prev) continue;
      const counted = prev.valid == null || Number(prev.valid) === 1;
      if (counted !== res.valid) {
        const d = res.valid ? 1 : -1;
        if (str(prev.side) === "honored") alpha += d;
        else if (str(prev.side) === "violated") beta += d;
      }
      stmt.run(res.valid ? 1 : 0, beliefId, res.probeId);
    }
    if (alpha !== Number(before.alpha) || beta !== Number(before.beta)) {
      this.save(beliefId, { alpha, beta, confidence: pHolds(alpha, beta) });
    }
    const r = this.row(beliefId);
    const bad = results.filter((x) => !x.valid);
    const from = str(r.status) as BeliefStatus;
    if (bad.length === 0 || from === "hypothesis") {
      if (bad.length) {
        this.appendEvent({
          beliefId,
          from,
          to: from,
          alpha: Number(r.alpha),
          beta: Number(r.beta),
          confidence: Number(r.confidence),
          reason: `invalid evidence: ${bad.map((b) => `${b.probeId} (${b.reason})`).join("; ")}`,
          probeId: bad[0]!.probeId,
        });
      }
      return this.get(beliefId)!;
    }
    this.save(beliefId, { status: "hypothesis", side: null, scope: null });
    const event = this.appendEvent({
      beliefId,
      from,
      to: "hypothesis",
      alpha: Number(r.alpha),
      beta: Number(r.beta),
      confidence: Number(r.confidence),
      reason: `invalid evidence, reverted to hypothesis: ${bad.map((b) => `${b.probeId} (${b.reason})`).join("; ")}`,
      probeId: bad[0]!.probeId,
    });
    if (from === "notarized") this.onLeaveNotarized?.(this.get(beliefId)!, event);
    return this.get(beliefId)!;
  }
}
