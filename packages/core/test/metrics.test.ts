/**
 * P8 metrics, exact comparison and noise floor — pure functions over hand-built TEST bundles (no
 * runs, no recordings).
 */
import { describe, expect, it } from "vitest";
import {
  BELIEF_STATUSES,
  HEADLINE_KEYS,
  beliefPrecision,
  checkerGroundTruth,
  compareExact,
  consolidateMetrics,
  formatComparison,
} from "../src/eval/metrics.js";
import { compareRuns, computeNoiseFloor } from "../src/eval/noise-floor.js";
import type { Anomaly, Belief, BeliefStatus, RunBundle } from "../src/schema/index.js";

const T0 = "2026-10-10T12:00:00.000Z";
const ZERO = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };

function belief(claimId: string, status: BeliefStatus, side: "honored" | "violated"): Belief {
  return {
    id: `belief-${claimId}`,
    claimId,
    tool: "dodo",
    ...(side === "violated" ? { class: "unit_mismatch" as const } : {}),
    statement: `test belief ${claimId}`,
    alpha: side === "honored" ? 4 : 1,
    beta: side === "honored" ? 1 : 4,
    confidence: side === "honored" ? 0.9375 : 0.0625,
    status,
    evidence: [],
    updatedAt: T0,
  };
}

function anomaly(claimId: string): Anomaly {
  return { id: `anom-${claimId}`, claimId, tool: "dodo", observed: {}, expected: {}, traceId: "", spanId: "" };
}

type BundleLike = Parameters<typeof consolidateMetrics>[0];

function notarizeBundle(beliefs: Belief[], anomalies: Anomaly[], metrics: RunBundle["metrics"] = {}): BundleLike {
  return {
    kind: "notarize",
    variant: "notarize",
    beliefs: { before: [], after: beliefs },
    anomalies,
    claims: [],
    usageByRole: { executor: ZERO, reflector: { inputTokens: 1200, outputTokens: 300, usd: 0.0123, calls: 2 }, adversary: { inputTokens: 900, outputTokens: 100, usd: 0.02, calls: 1 } },
    credits: { byEndpoint: { "crustdata.enrichCompany": 6, "crustdata.identifyCompany": 0 }, total: 6, budget: 50 },
    metrics,
  };
}

function runBundle(variant: "naive" | "guarded", graderMetrics: RunBundle["metrics"], beliefs: Belief[] = []): BundleLike {
  return {
    kind: "run",
    variant,
    beliefs: { before: beliefs, after: beliefs },
    anomalies: [],
    claims: [],
    usageByRole: { executor: ZERO, reflector: ZERO, adversary: ZERO },
    credits: { byEndpoint: {}, total: 0, budget: 50 },
    metrics: graderMetrics,
  };
}

const GRADED = {
  items_total: 20,
  unsafe_actions_total: 3,
  unsafe_duplicates: 1,
  unsafe_wrong_unit: 1,
  unsafe_missed_existing_refund: 1,
  decision_accuracy: 0.75,
  automation_rate: 0.5,
  holds: 4,
  escalations: 2,
};

describe("belief precision (ground truth = deterministic checker verdicts on recorded recon)", () => {
  it("violated from an anomaly, honored from a checked claim without one; only notarized beliefs with ground truth count", () => {
    const truth = checkerGroundTruth([anomaly("c.viol")], ["c.viol", "c.ok", "c.ok2"]);
    expect(truth).toEqual({ "c.viol": "violated", "c.ok": "honored", "c.ok2": "honored" });
    const r = beliefPrecision(
      [
        belief("c.viol", "notarized", "violated"), // right
        belief("c.ok", "notarized", "honored"), // right
        belief("c.ok2", "notarized", "violated"), // FALSE belief
        belief("c.none", "notarized", "violated"), // no ground truth: not counted
        belief("c.ok", "candidate", "violated"), // not notarized: not counted
      ],
      truth,
    );
    expect(r).toEqual({ precision: 0.666667, falseBeliefs: 1, n: 3 });
  });

  it("no notarized belief with ground truth -> null (never 0)", () => {
    expect(beliefPrecision([belief("a", "notarized", "violated")], {})).toEqual({ precision: null, falseBeliefs: null, n: null });
    expect(beliefPrecision([], { a: "violated" })).toEqual({ precision: null, falseBeliefs: null, n: null });
  });

  it("without the checked-claim list only the violated side is known", () => {
    expect(checkerGroundTruth([anomaly("x")])).toEqual({ x: "violated" });
  });
});

describe("consolidateMetrics", () => {
  it("every headline key is present on every bundle kind", () => {
    for (const b of [notarizeBundle([], []), runBundle("naive", GRADED), runBundle("guarded", GRADED)]) {
      const m = consolidateMetrics(b);
      for (const k of HEADLINE_KEYS) expect(k in m, k).toBe(true);
    }
  });

  it("notarize: queue metrics null, belief counts + precision, credits by endpoint, usd/tokens by role, probes_to_candidate", () => {
    const m = consolidateMetrics(
      notarizeBundle([belief("p", "notarized", "violated"), belief("q", "hypothesis", "honored"), belief("r", "abstained", "honored")], [anomaly("p")], {
        probes_to_candidate_mean: 3,
        claims: 3,
      }),
      { checkedClaimIds: ["p", "q"], unguardedCallSites: 0 },
    );
    expect(m).toMatchObject({
      claims: 3, // existing keys are kept
      unsafe_actions_total: null,
      decision_accuracy: null,
      automation_rate: null,
      holds: null,
      escalations: null,
      beliefs_notarized: 1,
      beliefs_hypothesis: 1,
      beliefs_abstained: 1,
      beliefs_candidate: 0,
      belief_precision: 1,
      beliefs_false: 0,
      belief_precision_n: 1,
      unguarded_call_sites: 0,
      credits_total: 6,
      "credits_crustdata.enrichCompany": 6,
      "credits_crustdata.identifyCompany": 0,
      usd_reflector: 0.0123,
      tokens_reflector: 1500,
      usd_adversary: 0.02,
      tokens_adversary: 1000,
      usd_executor: 0,
      tokens_executor: 0,
      usd_total: 0.0323,
      probes_to_candidate: 3,
    });
  });

  it("naive run: grader metrics carried, belief metrics null (no store), coverage null when not run", () => {
    const m = consolidateMetrics(runBundle("naive", GRADED));
    expect(m).toMatchObject(GRADED);
    for (const s of BELIEF_STATUSES) expect(m[`beliefs_${s}`]).toBeNull();
    expect(m.belief_precision).toBeNull();
    expect(m.unguarded_call_sites).toBeNull();
    expect(m.probes_to_candidate).toBeNull();
    expect(m.credits_total).toBe(0);
  });

  it("guarded run with an empty store: belief counts are a real 0; a grader null stays null", () => {
    const m = consolidateMetrics(runBundle("guarded", { ...GRADED, unsafe_actions_total: null, unsafe_duplicates: null }));
    expect(m.beliefs_notarized).toBe(0);
    expect(m.unsafe_actions_total).toBeNull();
    expect(m.unsafe_duplicates).toBeNull();
    expect(m.decision_accuracy).toBe(0.75);
  });

  it("grader keys missing from a run bundle become null, not 0", () => {
    const m = consolidateMetrics(runBundle("guarded", {}));
    expect(m.decision_accuracy).toBeNull();
    expect(m.holds).toBeNull();
  });
});

describe("compareExact (replay headline check)", () => {
  it("identical records match on every key", () => {
    const a = { x: 1, y: null, z: 0.1 + 0.2 };
    const r = compareExact(a, { ...a });
    expect(r.allMatch).toBe(true);
    expect(r.rows.map((x) => x.key)).toEqual(["x", "y", "z"]);
  });

  it("exact means exact: 0.30000000000000004 != 0.3; 0 != null; null == null; a missing key never matches", () => {
    const r = compareExact({ a: 0.1 + 0.2, b: 0, c: null, d: 5, e: null }, { a: 0.3, b: null, c: null, d: 5 });
    expect(Object.fromEntries(r.rows.map((x) => [x.key, x.match]))).toEqual({ a: false, b: false, c: true, d: true, e: false });
    expect(r.allMatch).toBe(false);
    const lines = formatComparison(r.rows);
    expect(lines[0]).toMatch(/metric \| +original \| +replay \| match/);
    expect(lines.find((l) => l.trimStart().startsWith("e "))).toMatch(/null \| \(missing\) \| NO$/);
  });

  it("a number in the original vs null in the replay (or the reverse) is a mismatch", () => {
    expect(compareExact({ k: 1 }, { k: null }).allMatch).toBe(false);
    expect(compareExact({ k: null }, { k: 1 }).allMatch).toBe(false);
  });
});

describe("noise floor", () => {
  it("floor = max - min per metric over the runs; a metric null in any run gets no floor", () => {
    const { floor, notComparable } = computeNoiseFloor([
      { acc: 0.8, usd: 0.012, unsafe: 0, p: null },
      { acc: 0.85, usd: 0.0105, unsafe: 0, p: 3 },
      { acc: 0.8, usd: 0.011, unsafe: 0, p: 2 },
    ]);
    expect(floor).toEqual({ acc: 0.05, usd: 0.0015, unsafe: 0 });
    expect(notComparable).toEqual(["p"]);
  });

  it('compareRuns: |delta| <= floor is "no change"; above it increase/decrease; null is not comparable', () => {
    const floor = { acc: 0.05, usd: 0.0015, unsafe: 0 };
    const rows = compareRuns(
      { acc: 0.8, usd: 0.012, unsafe: 3, holds: 2, p: null },
      { acc: 0.84, usd: 0.009, unsafe: 0, holds: 2, p: 1 },
      floor,
    );
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.acc).toMatchObject({ delta: 0.04, floor: 0.05, label: "no change" });
    expect(by.usd).toMatchObject({ delta: -0.003, label: "decrease" });
    expect(by.unsafe).toMatchObject({ delta: -3, floor: 0, label: "decrease" });
    expect(by.holds).toMatchObject({ delta: 0, floor: null, label: "no change" });
    expect(by.p).toMatchObject({ delta: null, label: "not comparable" });
  });

  it("a change exactly at the floor is no change; just above it is a change", () => {
    expect(compareRuns({ m: 1 }, { m: 1.05 }, { m: 0.05 })[0]!.label).toBe("no change");
    expect(compareRuns({ m: 1 }, { m: 1.06 }, { m: 0.05 })[0]!.label).toBe("increase");
  });
});
