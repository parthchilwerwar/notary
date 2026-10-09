import { describe, expect, it } from "vitest";
import {
  AnomalySchema,
  BeliefSchema,
  ClaimSchema,
  DecisionSchema,
  DefectClassSchema,
  ExpectRuleSchema,
  GuardSchema,
  HypothesisSchema,
  ProbeSchema,
  RunBundleSchema,
  type Anomaly,
  type Belief,
  type Claim,
  type Decision,
  type Guard,
  type Hypothesis,
  type Probe,
  type RunBundle,
} from "../src/schema/index.js";

const claim: Claim = {
  id: "c1",
  tool: "crustdata",
  operation: "company.search",
  param: "limit",
  docText: "Returns up to 100 results per page.",
  expect: { kind: "maxItems", max: 100 },
  docUrl: "https://docs.example.com/search",
};

const anomaly: Anomaly = {
  id: "a1",
  claimId: "c1",
  observed: 25,
  expected: 100,
  traceId: "t1",
  spanId: "s1",
};

const hypothesis: Hypothesis = {
  id: "h1",
  anomalyId: "a1",
  class: "silent_truncation",
  statement: "Page size is silently clamped to 25.",
  distinguishingTest: "boundary_sweep",
};

const probe: Probe = {
  id: "p1",
  hypothesisIds: ["h1", "h2"],
  template: "boundary_sweep",
  params: { limits: [24, 25, 26, 100] },
  prediction: { h1: { maxSeen: 25 }, h2: { maxSeen: 100 } },
  committedAt: "2026-10-10T12:00:00Z",
  costCredits: 4,
  traceId: "t2",
};

const belief: Belief = {
  id: "b1",
  claimId: "c1",
  statement: "limit is clamped to 25",
  alpha: 1,
  beta: 5,
  confidence: 0.05,
  status: "candidate",
  evidence: [{ probeId: "p1", traceId: "t2" }],
  adversary: { verdict: "uphold", reason: "evidence tests the param", model: "m" },
};

const guard: Guard = {
  id: "g1",
  beliefId: "b1",
  operation: "company.search",
  kind: "paginate_fully",
  rule: { pageSize: 25 },
};

const decision: Decision = {
  id: "d1",
  requestId: "r1",
  policyOutcome: "approve",
  action: "full_refund",
  requiredBeliefs: ["b1"],
  missingBeliefs: [],
  status: "executed",
  guardsApplied: ["g1"],
  traceId: "t3",
};

const usage = { inputTokens: 10, outputTokens: 5, usd: 0.01 };

const bundle: RunBundle = {
  runId: "run-1",
  mode: "replay",
  startedAt: "2026-10-10T12:00:00Z",
  seed: 42,
  queue: [],
  decisions: [decision],
  claims: [claim],
  anomalies: [anomaly],
  probes: [probe],
  beliefs: { before: [], after: [belief] },
  guards: [guard],
  usageByRole: { executor: usage, reflector: usage, adversary: usage },
  credits: { "company.search": 12 },
  metrics: { decisionAccuracy: 0.9 },
  traceLinks: { t1: "https://traces.example.com/t1" },
  contentHash: "sha256:abc",
};

describe("schemas", () => {
  it("Claim", () => {
    expect(ClaimSchema.safeParse(claim).success).toBe(true);
    expect(ClaimSchema.safeParse({ ...claim, tool: "stripe" }).success).toBe(false);
  });

  it("ExpectRule", () => {
    expect(ExpectRuleSchema.safeParse({ kind: "consistentWithin", ms: 500 }).success).toBe(true);
    expect(ExpectRuleSchema.safeParse({ kind: "consistentWithin" }).success).toBe(false);
    expect(ExpectRuleSchema.safeParse({ kind: "nope" }).success).toBe(false);
  });

  it("Anomaly", () => {
    expect(AnomalySchema.safeParse(anomaly).success).toBe(true);
    const { spanId: _, ...missing } = anomaly;
    expect(AnomalySchema.safeParse(missing).success).toBe(false);
  });

  it("Hypothesis", () => {
    expect(HypothesisSchema.safeParse(hypothesis).success).toBe(true);
    expect(HypothesisSchema.safeParse({ ...hypothesis, class: "flaky" }).success).toBe(false);
  });

  it("Probe", () => {
    expect(ProbeSchema.safeParse(probe).success).toBe(true);
    expect(
      ProbeSchema.safeParse({ ...probe, observed: { maxSeen: 25 }, verdict: "confirmed" }).success,
    ).toBe(true);
    expect(ProbeSchema.safeParse({ ...probe, committedAt: "yesterday" }).success).toBe(false);
    expect(ProbeSchema.safeParse({ ...probe, verdict: "maybe" }).success).toBe(false);
  });

  it("Belief", () => {
    expect(BeliefSchema.safeParse(belief).success).toBe(true);
    expect(BeliefSchema.safeParse({ ...belief, confidence: 1.5 }).success).toBe(false);
    expect(BeliefSchema.safeParse({ ...belief, status: "certain" }).success).toBe(false);
  });

  it("Guard", () => {
    expect(GuardSchema.safeParse(guard).success).toBe(true);
    expect(GuardSchema.safeParse({ ...guard, kind: "require-param" }).success).toBe(false);
  });

  it("Decision", () => {
    expect(DecisionSchema.safeParse(decision).success).toBe(true);
    expect(DecisionSchema.safeParse({ ...decision, status: "done" }).success).toBe(false);
  });

  it("RunBundle", () => {
    expect(RunBundleSchema.safeParse(bundle).success).toBe(true);
    expect(RunBundleSchema.safeParse({ ...bundle, mode: "dry" }).success).toBe(false);
    expect(
      RunBundleSchema.safeParse({ ...bundle, beliefs: [belief] }).success,
    ).toBe(false);
  });

  it("DefectClass has exactly the 10 TDD values", () => {
    expect([...DefectClassSchema.options].sort()).toEqual(
      [
        "silent_truncation",
        "silent_coercion",
        "unit_mismatch",
        "undocumented_flag",
        "eventual_consistency",
        "idempotency_hazard",
        "rate_limit",
        "expiry",
        "mislabelled_semantics",
        "honored",
      ].sort(),
    );
  });
});
