import { describe, expect, it } from "vitest";
import {
  AnomalySchema,
  BeliefEventSchema,
  BeliefSchema,
  BundleIndexSchema,
  ClaimSchema,
  DecisionSchema,
  DefectClassSchema,
  ExpectRuleSchema,
  GuardSchema,
  HypothesisSchema,
  ProbeSchema,
  QueueRequestSchema,
  RunBundleSchema,
  type Anomaly,
  type Belief,
  type BeliefEvent,
  type Claim,
  type Decision,
  type Guard,
  type Hypothesis,
  type Probe,
  type QueueRequest,
  type RunBundle,
} from "../src/schema/index.js";

const HASH = "a".repeat(64);

const claim: Claim = {
  id: "c1",
  tool: "crustdata",
  operation: "company.search",
  param: "limit",
  docText: "Returns up to 100 results per page.",
  expect: { kind: "maxItems", max: 100 },
  docUrl: "https://docs.example.com/search",
  endpoint: "POST /search",
  costCredits: 1,
};

const anomaly: Anomaly = {
  id: "a1",
  claimId: "c1",
  tool: "crustdata",
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
  tool: "crustdata",
  claimId: "c1",
  hypothesisIds: ["h1", "h2"],
  template: "boundary_sweep",
  params: { limits: [24, 25, 26, 100] },
  control: { params: { limits: [10] } },
  prediction: { h1: { maxSeen: 25 }, h2: { maxSeen: 100 } },
  predictionHash: HASH,
  committedAt: "2026-10-10T12:00:00Z",
  costCredits: 4,
  calls: 4,
  traceId: "t2",
};

const belief: Belief = {
  id: "b1",
  claimId: "c1",
  tool: "crustdata",
  class: "silent_truncation",
  statement: "limit is clamped to 25",
  alpha: 1,
  beta: 5,
  confidence: 0.05,
  status: "candidate",
  evidence: [{ probeId: "p1", traceId: "t2" }],
  adversary: { verdict: "uphold", reason: "evidence tests the param", model: "m" },
  updatedAt: "2026-10-10T12:01:00Z",
};

const beliefEvent: BeliefEvent = {
  beliefId: "b1",
  at: "2026-10-10T12:01:00Z",
  from: null,
  to: "hypothesis",
  alpha: 1,
  beta: 1,
  confidence: 0.5,
  reason: "created",
};

const guard: Guard = {
  id: "g1",
  beliefId: "b1",
  operation: "company.search",
  kind: "paginate_fully",
  class: "silent_truncation",
  rule: { pageSize: 25 },
  reason: "pages clamp at 25",
  active: true,
  compiledAt: "2026-10-10T12:02:00Z",
};

const request: QueueRequest = {
  id: "r1",
  customerId: "cus_1",
  companyDomain: "acme.example.com",
  type: "refund",
  plan: "starter",
  amount: 4900,
  currency: "USD",
  reason: "double charge",
};

const decision: Decision = {
  id: "d1",
  requestId: "r1",
  customerId: "cus_1",
  tier: "smb",
  requestType: "refund",
  policyOutcome: "approve",
  action: "full_refund",
  requiredBeliefs: ["b1"],
  missingBeliefs: [],
  status: "executed",
  guardsApplied: ["g1"],
  effects: [
    { op: "dodo.createRefund", params: { amount: 4900 }, status: null, amount: 4900, currency: "USD", at: "2026-10-10T12:03:00Z" },
  ],
  traceId: "",
};

const usage = { inputTokens: 10, outputTokens: 5, usd: 0.01, calls: 1 };

const bundle: RunBundle = {
  runId: "run-1",
  kind: "run",
  variant: "guarded",
  mode: "replay",
  sample: false,
  disclosure: ["seeded queue"],
  startedAt: "2026-10-10T12:00:00Z",
  status: "completed",
  seed: 42,
  queue: [request],
  decisions: [decision],
  claims: [claim],
  anomalies: [anomaly],
  hypotheses: [hypothesis],
  probes: [probe],
  beliefs: { before: [], after: [belief] },
  beliefEvents: [beliefEvent],
  guards: [guard],
  usageByRole: { executor: usage, reflector: usage, adversary: usage },
  credits: { byEndpoint: { "POST /search": 12 }, total: 12, budget: 500 },
  metrics: { decisionAccuracy: 0.9, beliefPrecision: null },
  traceLinks: { t1: "https://traces.example.com/t1" },
  cassettes: ["crustdata.json"],
  contentHash: HASH,
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
      ProbeSchema.safeParse({ ...probe, observed: { maxSeen: 25 }, verdict: "confirmed", winningHypothesisId: "h1" }).success,
    ).toBe(true);
    expect(ProbeSchema.safeParse({ ...probe, committedAt: "yesterday" }).success).toBe(false);
    expect(ProbeSchema.safeParse({ ...probe, verdict: "maybe" }).success).toBe(false);
    expect(ProbeSchema.safeParse({ ...probe, predictionHash: "sha256:abc" }).success).toBe(false);
    expect(ProbeSchema.safeParse({ ...probe, calls: 1.5 }).success).toBe(false);
  });

  it("Belief and BeliefEvent", () => {
    expect(BeliefSchema.safeParse(belief).success).toBe(true);
    expect(BeliefSchema.safeParse({ ...belief, confidence: 1.5 }).success).toBe(false);
    expect(BeliefSchema.safeParse({ ...belief, status: "certain" }).success).toBe(false);
    expect(BeliefEventSchema.safeParse(beliefEvent).success).toBe(true);
    expect(BeliefEventSchema.safeParse({ ...beliefEvent, from: "notarized", to: "unlearned" }).success).toBe(true);
    expect(BeliefEventSchema.safeParse({ ...beliefEvent, from: undefined }).success).toBe(false);
  });

  it("Guard", () => {
    expect(GuardSchema.safeParse(guard).success).toBe(true);
    expect(GuardSchema.safeParse({ ...guard, kind: "require-param" }).success).toBe(false);
    expect(GuardSchema.safeParse({ ...guard, active: false, retiredAt: "2026-10-10T13:00:00Z" }).success).toBe(true);
  });

  it("QueueRequest", () => {
    expect(QueueRequestSchema.safeParse(request).success).toBe(true);
    expect(QueueRequestSchema.safeParse({ ...request, amount: 49.0 }).success).toBe(true);
    expect(QueueRequestSchema.safeParse({ ...request, amount: 49.5 }).success).toBe(false); // minor units only
    expect(QueueRequestSchema.safeParse({ ...request, type: "chargeback" }).success).toBe(false);
  });

  it("Decision", () => {
    expect(DecisionSchema.safeParse(decision).success).toBe(true);
    expect(DecisionSchema.safeParse({ ...decision, status: "done" }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...decision, tier: "huge" }).success).toBe(false);
  });

  it("RunBundle", () => {
    expect(RunBundleSchema.safeParse(bundle).success).toBe(true);
    expect(RunBundleSchema.safeParse({ ...bundle, mode: "dry" }).success).toBe(false);
    expect(RunBundleSchema.safeParse({ ...bundle, beliefs: [belief] }).success).toBe(false);
    const { adversary: _, ...twoRoles } = bundle.usageByRole;
    expect(RunBundleSchema.safeParse({ ...bundle, usageByRole: twoRoles }).success).toBe(false);
    expect(RunBundleSchema.safeParse({ ...bundle, contentHash: "sha256:abc" }).success).toBe(false);
  });

  it("BundleIndex", () => {
    const { runId, kind, variant, mode, sample, startedAt, status, contentHash } = bundle;
    expect(BundleIndexSchema.safeParse([{ runId, kind, variant, mode, sample, startedAt, status, contentHash }]).success).toBe(true);
    expect(BundleIndexSchema.safeParse([{ runId }]).success).toBe(false);
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

  it("schema files import only zod (browser-safe)", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = new URL("../src/schema/", import.meta.url);
    for (const f of await readdir(dir)) {
      const src = await readFile(new URL(f, dir), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of imports) expect(spec === "zod" || spec!.startsWith("./"), `${f} imports ${spec}`).toBe(true);
    }
  });
});
