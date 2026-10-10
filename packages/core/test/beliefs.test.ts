import { afterEach, describe, expect, it } from "vitest";
import {
  CANDIDATE_HOLDS_ABOVE,
  CANDIDATE_VIOLATED_BELOW,
  pHolds,
  posteriorMean,
  regularizedIncompleteBeta,
} from "../src/beliefs/math.js";
import { BeliefStore, beliefIdFor, statementFor } from "../src/beliefs/store.js";
import type { BeliefCallback } from "../src/beliefs/store.js";
import type { AdversaryReview, Claim, Hypothesis, Probe, ProbeTemplate, ProbeVerdict } from "../src/schema/index.js";
import { NotaryDb, predictionHash } from "../src/store/db.js";

// ------------------------------------------------------------------ math

describe("Beta math: confidence = P(θ > 0.5 | Beta(α, β))", () => {
  it("known values", () => {
    expect(pHolds(1, 1)).toBe(0.5);
    expect(pHolds(1, 4)).toBeCloseTo(0.0625, 15);
    expect(pHolds(4, 1)).toBeCloseTo(0.9375, 15);
    expect(pHolds(3, 1)).toBeCloseTo(0.875, 15);
    expect(pHolds(1, 3)).toBeCloseTo(0.125, 15);
    expect(pHolds(2, 2)).toBeCloseTo(0.5, 15);
    // Beta(2,3): Σ_{j<2} C(4,j)/16 = 5/16
    expect(pHolds(2, 3)).toBeCloseTo(5 / 16, 15);
  });

  it("symmetry: P(α, β) = 1 − P(β, α), integer and fractional", () => {
    for (const [a, b] of [[1, 2], [3, 7], [5, 5], [10, 2], [0.5, 2.5], [1.7, 0.3], [12.25, 9.5]] as const) {
      expect(pHolds(a, b) + pHolds(b, a)).toBeCloseTo(1, 10);
    }
  });

  it("exact binomial sum agrees with the numeric incomplete beta", () => {
    for (let a = 1; a <= 12; a++) {
      for (let b = 1; b <= 12; b++) {
        expect(pHolds(a, b)).toBeCloseTo(1 - regularizedIncompleteBeta(0.5, a, b), 10);
      }
    }
  });

  it("non-integer priors use the numeric fallback (Beta(0.5,0.5) is symmetric → 0.5)", () => {
    expect(pHolds(0.5, 0.5)).toBeCloseTo(0.5, 10);
    expect(pHolds(2.5, 1)).toBeGreaterThan(pHolds(2, 1));
    expect(pHolds(2.5, 1)).toBeLessThan(pHolds(3, 1));
  });

  it("large counts stay finite (log-space sum)", () => {
    const p = pHolds(1200, 1100);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0.9);
    expect(pHolds(1100, 1200)).toBeCloseTo(1 - p, 10);
  });

  it("posterior mean and parameter validation", () => {
    expect(posteriorMean(1, 1)).toBe(0.5);
    expect(posteriorMean(4, 1)).toBe(0.8);
    expect(() => pHolds(0, 1)).toThrow(RangeError);
    expect(() => pHolds(1, Number.NaN)).toThrow(RangeError);
  });

  it("from Beta(1,1), 3 same-side confirmations reach each threshold (2 do not)", () => {
    expect(pHolds(3, 1)).toBeLessThanOrEqual(CANDIDATE_HOLDS_ABOVE);
    expect(pHolds(4, 1)).toBeGreaterThan(CANDIDATE_HOLDS_ABOVE);
    expect(pHolds(1, 3)).toBeGreaterThanOrEqual(CANDIDATE_VIOLATED_BELOW);
    expect(pHolds(1, 4)).toBeLessThan(CANDIDATE_VIOLATED_BELOW);
  });
});

// ------------------------------------------------------------------ store fixtures

const dbs: NotaryDb[] = [];
function freshDb(): NotaryDb {
  const db = new NotaryDb(":memory:");
  dbs.push(db);
  return db;
}
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

const CLAIM: Claim = {
  id: "dodo.refunds.page-size-max",
  tool: "dodo",
  operation: "dodo.listRefunds",
  param: "page_size",
  docText: "page_size: maximum 100",
  expect: { kind: "maxItems", max: 100 },
  docUrl: "https://docs.dodopayments.com/api-reference/refunds/list-refunds",
};

const HYPS: Hypothesis[] = [
  { id: "h-ok", anomalyId: "a1", class: "honored", statement: "limit enforced", distinguishingTest: "boundary_sweep" },
  { id: "h-trunc", anomalyId: "a1", class: "silent_truncation", statement: "clamped", distinguishingTest: "boundary_sweep" },
  { id: "h-coerce", anomalyId: "a1", class: "silent_coercion", statement: "coerced", distinguishingTest: "boundary_sweep" },
];
const BY_ID = new Map(HYPS.map((h) => [h.id, h]));

let n = 0;
/** A probe whose treatment sends page_size=`t` and control page_size=`c` (distinct values = distinct design). */
function probe(o: {
  verdict: ProbeVerdict;
  winner?: string;
  t?: number;
  c?: number;
  template?: ProbeTemplate;
  outcome?: string | null;
  claimId?: string;
}): Probe {
  n += 1;
  const prediction = { "h-ok": { class: "honored", outcomes: ["rejected"] }, "h-trunc": { class: "silent_truncation", outcomes: ["clamped"] } };
  return {
    id: `run-x-p${String(n).padStart(3, "0")}`,
    tool: "dodo",
    claimId: o.claimId ?? CLAIM.id,
    hypothesisIds: ["h-ok", "h-trunc"],
    template: o.template ?? "boundary_sweep",
    params: { steps: [{ op: CLAIM.operation, params: { page_size: o.t ?? 101 } }] },
    control: { params: { steps: [{ op: CLAIM.operation, params: { page_size: o.c ?? 1 } }] } },
    prediction,
    predictionHash: predictionHash(prediction),
    committedAt: "2026-10-10T10:00:00.000Z",
    ranAt: "2026-10-10T10:00:01.000Z",
    observed: { outcome: o.outcome === undefined ? "rejected" : o.outcome, reason: "r" },
    verdict: o.verdict,
    ...(o.winner ? { winningHypothesisId: o.winner } : {}),
    costCredits: 0,
    calls: 2,
    traceId: `trace-${n}`,
    spanId: `span-${n}`,
  };
}

function apply(store: BeliefStore, p: Probe, reason = "test") {
  return store.applyProbe(beliefIdFor(p.claimId), p, { verdict: p.verdict!, ...(p.winningHypothesisId ? { winningHypothesisId: p.winningHypothesisId } : {}), reason }, BY_ID);
}

const honored = (t: number) => probe({ verdict: "confirmed", winner: "h-ok", t });
const violated = (t: number) => probe({ verdict: "confirmed", winner: "h-trunc", t, outcome: "clamped" });

function review(verdict: AdversaryReview["verdict"], extra: Partial<AdversaryReview> = {}): AdversaryReview {
  return { verdict, reason: `because ${verdict}`, model: "adv-model", backend: "bedrock", ...extra };
}

/** Drive a fresh belief to candidate on the honored side: Beta(4,1) from 3 distinct designs. */
function toHonoredCandidate(store: BeliefStore): void {
  store.ensure(CLAIM);
  apply(store, honored(101));
  apply(store, honored(150));
  apply(store, honored(200));
}

/** The FR-10 evidence check passed for every cited probe (P9: required before an uphold/narrow). */
function passEvidence(store: BeliefStore): void {
  const id = beliefIdFor(CLAIM.id);
  store.applyEvidenceCheck(id, store.get(id)!.evidence.map((e) => ({ probeId: e.probeId, valid: true, reason: "ok" })));
}

// ------------------------------------------------------------------ store

describe("BeliefStore: ensure", () => {
  it("creates a hypothesis at Beta(1,1) with a creation event; idempotent", () => {
    const store = new BeliefStore(freshDb());
    const b = store.ensure(CLAIM);
    expect(b).toMatchObject({ id: "belief-dodo.refunds.page-size-max", status: "hypothesis", alpha: 1, beta: 1, confidence: 0.5, evidence: [] });
    expect(b.statement).toBe(statementFor(CLAIM, "honored"));
    expect(store.ensure(CLAIM)).toEqual(b);
    const ev = store.events(b.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ from: null, to: "hypothesis", alpha: 1, beta: 1, confidence: 0.5 });
  });

  it("starts from a transfer prior when given", () => {
    const store = new BeliefStore(freshDb());
    const b = store.ensure(CLAIM, { alpha: 1, beta: 3, from: "crustdata" });
    expect(b).toMatchObject({ alpha: 1, beta: 3, prior: { alpha: 1, beta: 3, from: "crustdata" } });
    expect(b.confidence).toBeCloseTo(0.125, 12);
    expect(store.events(b.id)[0]!.reason).toMatch(/transfer prior Beta\(1, 3\)/);
  });
});

describe("BeliefStore: applyProbe update rules", () => {
  it("confirmed honored → α+1, cited as evidence {probeId, traceId, spanId}", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    const p = honored(101);
    const r = apply(store, p);
    expect(r).toMatchObject({ updated: true, applied: true });
    expect(r.belief).toMatchObject({ alpha: 2, beta: 1, confidence: 0.75, status: "hypothesis" });
    expect(r.belief.evidence).toEqual([{ probeId: p.id, traceId: p.traceId, spanId: p.spanId }]);
    expect(r.belief.class).toBeUndefined();
  });

  it("confirmed violation → β+1 and belief.class := the winning class", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    const r = apply(store, violated(101));
    expect(r.belief).toMatchObject({ alpha: 1, beta: 2, confidence: 0.25, class: "silent_truncation" });
    expect(r.belief.statement).toBe(statementFor(CLAIM, "violated", "silent_truncation"));
    expect(r.belief.statement).toMatch(/^Doc claim violated \(silent_truncation\): dodo\.listRefunds \[page_size\]/);
  });

  for (const verdict of ["inconclusive", "uninformative", "invalid", "refuted"] as const) {
    it(`${verdict} → no α/β change, not cited, event with reason (FR-6)`, () => {
      const store = new BeliefStore(freshDb());
      store.ensure(CLAIM);
      const p = probe({ verdict, outcome: verdict === "uninformative" ? null : "rejected" });
      const r = apply(store, p, `why ${verdict}`);
      expect(r).toMatchObject({ updated: false, applied: true });
      expect(r.belief).toMatchObject({ alpha: 1, beta: 1, confidence: 0.5, status: "hypothesis", evidence: [] });
      const last = store.events(r.belief.id).at(-1)!;
      expect(last).toMatchObject({ from: "hypothesis", to: "hypothesis", alpha: 1, beta: 1, probeId: p.id });
      expect(last.reason).toContain(`${verdict}: no update (why ${verdict})`);
    });
  }

  it("confirmed with an unknown winning hypothesis does not update", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    const r = apply(store, probe({ verdict: "confirmed", winner: "h-nope" }));
    expect(r.updated).toBe(false);
    expect(r.belief).toMatchObject({ alpha: 1, beta: 1 });
  });

  it("the same probe applies once", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    const p = honored(101);
    apply(store, p);
    const again = apply(store, p);
    expect(again).toMatchObject({ applied: false, updated: false });
    expect(again.belief.alpha).toBe(2);
  });

  it("refuses a probe of another claim", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    const p = probe({ verdict: "confirmed", winner: "h-ok", claimId: "other" });
    expect(() => store.applyProbe(beliefIdFor(CLAIM.id), p, { verdict: "confirmed", winningHypothesisId: "h-ok", reason: "" }, BY_ID)).toThrow(/claim other/);
  });
});

describe("BeliefStore: candidate needs ≥ 2 independent probes", () => {
  it("3 confirmations of the SAME design reach 0.9375 but stay hypothesis; a 2nd design makes it a candidate", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    apply(store, honored(101));
    apply(store, honored(101));
    const third = apply(store, honored(101));
    expect(third.belief).toMatchObject({ alpha: 4, beta: 1, status: "hypothesis" });
    expect(third.belief.confidence).toBeCloseTo(0.9375, 12);
    expect(store.independentProbes(third.belief.id, "honored")).toBe(1);
    expect(store.events(third.belief.id).at(-1)!.reason).toMatch(/only 1 independent probe\(s\) \(need 2\)/);

    // An inconclusive probe in between counts toward probes-to-candidate but not α/β.
    apply(store, probe({ verdict: "inconclusive" }));
    const other = apply(store, probe({ verdict: "confirmed", winner: "h-ok", template: "pagination_completeness", t: 10, c: 30 }));
    expect(other.belief).toMatchObject({ alpha: 5, status: "candidate", class: "honored", probesToCandidate: 5 });
    expect(store.independentProbes(other.belief.id, "honored")).toBe(2);
    const ev = store.events(other.belief.id).at(-1)!;
    expect(ev).toMatchObject({ from: "hypothesis", to: "candidate", alpha: 5, beta: 1 });
    expect(ev.reason).toMatch(/2 independent probes: candidate/);
  });

  it("from Beta(1,1): 3 confirmations over 3 distinct designs → candidate at the 3rd (probesToCandidate 3)", () => {
    const store = new BeliefStore(freshDb());
    toHonoredCandidate(store);
    const b = store.byClaim(CLAIM.id)!;
    expect(b).toMatchObject({ status: "candidate", alpha: 4, beta: 1, probesToCandidate: 3 });
    expect(b.statement).toMatch(/^Doc claim holds: /);
  });

  it("violated side: Beta(1,4) with 2+ designs → candidate carrying the defect class", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    apply(store, violated(101));
    apply(store, violated(150));
    const r = apply(store, violated(101)); // replicate: moves β, no new independence
    expect(r.belief).toMatchObject({ beta: 4, status: "candidate", class: "silent_truncation", probesToCandidate: 3 });
    expect(r.belief.confidence).toBeCloseTo(0.0625, 12);
    expect(r.belief.statement).toMatch(/^Doc claim violated \(silent_truncation\)/);
  });

  it("a candidate whose P(holds) falls back between thresholds returns to hypothesis", () => {
    const store = new BeliefStore(freshDb());
    toHonoredCandidate(store);
    const r = apply(store, violated(300));
    expect(r.belief).toMatchObject({ alpha: 4, beta: 2, status: "hypothesis" });
    expect(store.events(r.belief.id).at(-1)).toMatchObject({ from: "candidate", to: "hypothesis" });
  });
});

describe("BeliefStore: adversary", () => {
  it("uphold → notarized", () => {
    const store = new BeliefStore(freshDb());
    toHonoredCandidate(store);
    passEvidence(store);
    const b = store.applyAdversary(beliefIdFor(CLAIM.id), review("uphold"));
    expect(b).toMatchObject({ status: "notarized", adversary: { verdict: "uphold", model: "adv-model" } });
    expect(store.events(b.id).at(-1)).toMatchObject({ from: "candidate", to: "notarized" });
  });

  it("narrow → notarized with the narrowed scope in the statement", () => {
    const store = new BeliefStore(freshDb());
    toHonoredCandidate(store);
    passEvidence(store);
    const b = store.applyAdversary(beliefIdFor(CLAIM.id), review("narrow", { scope: "test-mode refunds list only" }));
    expect(b.status).toBe("notarized");
    expect(b.statement).toBe(`${statementFor(CLAIM, "honored")} [narrowed scope: test-mode refunds list only]`);
  });

  it("downgrade → back to hypothesis (FR-7)", () => {
    const store = new BeliefStore(freshDb());
    toHonoredCandidate(store);
    const b = store.applyAdversary(beliefIdFor(CLAIM.id), review("downgrade"));
    expect(b).toMatchObject({ status: "hypothesis", adversary: { verdict: "downgrade" } });
    expect(store.events(b.id).at(-1)).toMatchObject({ from: "candidate", to: "hypothesis", reason: expect.stringMatching(/adversary downgrade/) });
  });

  it("null review (malformed / failed) → stays candidate, with an event (fail safe)", () => {
    const store = new BeliefStore(freshDb());
    toHonoredCandidate(store);
    const b = store.applyAdversary(beliefIdFor(CLAIM.id), null, "reply was not JSON");
    expect(b.status).toBe("candidate");
    expect(b.adversary).toBeUndefined();
    expect(store.events(b.id).at(-1)).toMatchObject({ from: "candidate", to: "candidate", reason: expect.stringMatching(/reply was not JSON/) });
  });

  it("only candidates can be reviewed", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    expect(() => store.applyAdversary(beliefIdFor(CLAIM.id), review("uphold"))).toThrow(/not candidate/);
  });
});

describe("BeliefStore: unlearn", () => {
  it("a notarized belief unlearns when P(holds) crosses back over 0.5 (driven by confirmed verdicts)", () => {
    const calls: Array<Parameters<BeliefCallback>> = [];
    const left: string[] = [];
    const store = new BeliefStore(freshDb(), { onUnlearn: (b, e) => calls.push([b, e]), onLeaveNotarized: (b) => left.push(b.id) });
    toHonoredCandidate(store);
    const id = beliefIdFor(CLAIM.id);
    passEvidence(store);
    store.applyAdversary(id, review("uphold"));

    const seen: Array<[number, number, string]> = [];
    for (let i = 0; i < 4; i++) {
      const r = apply(store, violated(400 + i));
      seen.push([r.belief.beta, Number(r.belief.confidence.toFixed(2)), r.belief.status]);
    }
    // Beta(4,2)=0.8125, Beta(4,3)=0.65625, Beta(4,4)=0.5 (on the line, not across), Beta(4,5)=0.3633 → unlearned
    expect(seen).toEqual([
      [2, 0.81, "notarized"],
      [3, 0.66, "notarized"],
      [4, 0.5, "notarized"],
      [5, 0.36, "unlearned"],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].status).toBe("unlearned");
    expect(calls[0]![1]).toMatchObject({ from: "notarized", to: "unlearned", beta: 5 });
    expect(calls[0]![1].reason).toMatch(/crossed back over 0.5/);
    expect(left).toEqual([id]);

    // An unlearned belief can learn again: evidence pointing the other way makes it a violated candidate.
    for (let i = 0; i < 6; i++) apply(store, violated(500 + i));
    expect(store.get(id)).toMatchObject({ status: "candidate", class: "silent_truncation", probesToCandidate: 3 });
  });
});

describe("BeliefStore: abstain and evidence revert", () => {
  it("abstain moves a hypothesis to abstained; candidates are left alone", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    apply(store, honored(101));
    const b = store.abstain(beliefIdFor(CLAIM.id), "budget ended");
    expect(b.status).toBe("abstained");
    expect(store.events(b.id).at(-1)).toMatchObject({ from: "hypothesis", to: "abstained", reason: "abstain: budget ended" });
    // abstained beliefs keep learning
    apply(store, honored(150));
    expect(apply(store, honored(200)).belief.status).toBe("candidate");
    expect(store.abstain(b.id, "x").status).toBe("candidate");
  });

  it("invalid evidence marks valid:false, reverts to hypothesis and stops counting toward independence", () => {
    const left: string[] = [];
    const store = new BeliefStore(freshDb(), { onLeaveNotarized: (b) => left.push(b.status) });
    toHonoredCandidate(store);
    const id = beliefIdFor(CLAIM.id);
    passEvidence(store);
    store.applyAdversary(id, review("uphold"));
    const [e1, e2, e3] = store.get(id)!.evidence;
    const b = store.applyEvidenceCheck(id, [
      { probeId: e1!.probeId, valid: true, reason: "ok" },
      { probeId: e2!.probeId, valid: false, reason: "parameter not varied" },
      { probeId: e3!.probeId, valid: true, reason: "ok" },
    ]);
    expect(b.status).toBe("hypothesis");
    expect(b.evidence.map((e) => e.valid)).toEqual([true, false, true]);
    expect(store.independentProbes(id, "honored")).toBe(2);
    expect(store.events(id).at(-1)).toMatchObject({ from: "notarized", to: "hypothesis", probeId: e2!.probeId });
    expect(left).toEqual(["hypothesis"]);
  });

  it("all-valid evidence just records valid:true", () => {
    const store = new BeliefStore(freshDb());
    toHonoredCandidate(store);
    const id = beliefIdFor(CLAIM.id);
    const ev = store.get(id)!.evidence;
    const b = store.applyEvidenceCheck(id, ev.map((e) => ({ probeId: e.probeId, valid: true, reason: "ok" })));
    expect(b.status).toBe("candidate");
    expect(b.evidence.every((e) => e.valid === true)).toBe(true);
  });
});

describe("belief_events is append-only", () => {
  it("UPDATE and DELETE are rejected by triggers; INSERT works", () => {
    const db = freshDb();
    const store = new BeliefStore(db);
    store.ensure(CLAIM);
    expect(() => db.db.prepare("UPDATE belief_events SET reason = 'edited'").run()).toThrow(/append-only/);
    expect(() => db.db.prepare("DELETE FROM belief_events").run()).toThrow(/append-only/);
    apply(store, honored(101));
    expect(store.events()).toHaveLength(2);
    expect(store.events()[0]!.reason).toBe("created at Beta(1, 1)");
  });

  it("state survives a new store over the same db", () => {
    const db = freshDb();
    toHonoredCandidate(new BeliefStore(db));
    const again = new BeliefStore(db);
    expect(again.byClaim(CLAIM.id)).toMatchObject({ status: "candidate", alpha: 4 });
    expect(again.events(beliefIdFor(CLAIM.id))).toHaveLength(4);
  });
});
