/**
 * A missing field path makes an observation UNINFORMATIVE, never "honored" (checker, metrics,
 * probe templates, evidence check), plus the AUDIT A-14 belief_precision disclosure.
 *
 * Every claim and exchange here is hand-built TEST DATA; nothing describes real tool behaviour and
 * nothing touches the network.
 *
 * Present-but-null (documented here and in src/checker/check.ts): a null value is PRESENT. The
 * checker counts it as observed and `type` judges it as before (a violation unless the documented
 * type admits null); `fieldPresent` accepts it. type_edge skips nulls as values (null-only is
 * uninformative, as before) but a null never makes the path "absent".
 */
import { afterEach, describe, expect, it } from "vitest";
import { checkEvidence } from "../src/beliefs/evidence.js";
import { BeliefStore, beliefIdFor } from "../src/beliefs/store.js";
import { buildSampleBundle } from "../src/bundle/index.js";
import { checkAll, checkClaim, checkClaimDetailed, formatReconSummary, observedClaimIds } from "../src/checker/index.js";
import type { Observation, ReconResult } from "../src/checker/index.js";
import { contractEntryById } from "../src/contracts/index.js";
import type { ContractEntry } from "../src/contracts/types.js";
import { BELIEF_PRECISION_DISCLOSURE, consolidateMetrics, withMetricDisclosures } from "../src/eval/metrics.js";
import { renderEvaluationMd } from "../src/export/evaluation.js";
import { runProbe } from "../src/reflect/runner.js";
import { BurstCounter, SimplePaymentPool, buildCostModel, isSkip, typeEdge, unitRoundtrip } from "../src/reflect/templates/index.js";
import type { ProbeContext, ProbeDesign, ProbeIo, ProbeTemplateModule, TaggedExchange, Variant } from "../src/reflect/templates/index.js";
import { judge } from "../src/reflect/verdict.js";
import type { Anomaly, Belief, Claim, ExpectRule, Hypothesis, Probe, RunBundle } from "../src/schema/index.js";
import { NotaryDb, predictionHash } from "../src/store/db.js";
import { CreditLedger } from "../src/tools/index.js";
import type { Exchange } from "../src/tools/index.js";
import type { SpanRecord } from "../src/trace/index.js";

// ---------------------------------------------------------------------------------------------
// Builders

let seq = 0;
function ex(op: string, status: number, responseBody: unknown, over: Partial<Exchange> = {}): Exchange {
  seq += 1;
  return {
    id: `ex-${seq}`,
    tool: op.split(".")[0]!,
    op,
    method: "POST",
    url: `https://test.example/${op}`,
    requestHeaders: {},
    requestBody: undefined,
    status,
    responseHeaders: {},
    responseBody,
    latencyMs: 1,
    credits: null,
    recordedAt: "2026-10-10T10:00:00.000Z",
    requestHash: `h-${seq}`,
    occurrence: 0,
    ...over,
  };
}

function claim(id: string, expect: ExpectRule, param = "", operation = "test.op"): Claim {
  return { id, tool: "crustdata", operation, param, docText: "[test] hand-built claim", expect, docUrl: "https://example.com/test-doc" };
}

const TOTAL = claim("test.headcount-total", { kind: "type", field: "headcount.total", type: "integer" });
/** The real response carries headcount.count, not headcount.total. */
const COUNT_BODY = { headcount: { count: 42 } };

const dbs: NotaryDb[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function freshDb(): NotaryDb {
  const db = new NotaryDb(":memory:");
  dbs.push(db);
  return db;
}

// ---------------------------------------------------------------------------------------------
// Checker

describe("checker: a claim path that doesn't match the response is unobservable", () => {
  it("headcount.total vs a response with headcount.count: no anomaly, observed 0, unobservable recorded", () => {
    const e = ex("test.op", 200, COUNT_BODY);
    const r = checkClaimDetailed(TOTAL, [e]);
    expect(r.anomalies).toEqual([]);
    expect(r.observed).toBe(0);
    expect(r.unobservable).toEqual([{ exchangeId: e.requestHash, path: "headcount.total" }]);
    // The old signatures keep working (and still emit no anomaly).
    expect(checkClaim(TOTAL, [e])).toEqual([]);
    const entries: ContractEntry[] = [{ claim: TOTAL, recon: [] }];
    expect(checkAll(entries, [{ claimId: TOTAL.id, exchange: e }])).toEqual([]);
  });

  it("only observed claims count as checked; a matching path is observed", () => {
    const ok = claim("test.headcount-count", { kind: "type", field: "headcount.count", type: "integer" });
    const entries: ContractEntry[] = [
      { claim: TOTAL, recon: [] },
      { claim: ok, recon: [] },
    ];
    const e = ex("test.op", 200, COUNT_BODY);
    const observations: Observation[] = [
      { claimId: TOTAL.id, exchange: e },
      { claimId: ok.id, exchange: e },
    ];
    expect(observedClaimIds(entries, observations)).toEqual([ok.id]);
    expect(checkClaimDetailed(ok, [e])).toMatchObject({ anomalies: [], observed: 1, unobservable: [] });
  });

  it("non-2xx exchanges are neither observed nor unobservable for type", () => {
    expect(checkClaimDetailed(TOTAL, [ex("test.op", 500, COUNT_BODY)])).toEqual({ anomalies: [], observed: 0, unobservable: [] });
  });

  it("unit: an echoed field path absent from the response is unobservable, not an equal echo", () => {
    const u = claim("test.unit", { kind: "unit", field: "price.price", unit: "minor" }, "price.price");
    const e = ex("test.op", 200, { price: { amount: 1234 } }, { requestBody: { price: { price: 1234 } } });
    expect(checkClaimDetailed(u, [e])).toEqual({ anomalies: [], observed: 0, unobservable: [{ exchangeId: e.requestHash, path: "price.price" }] });
    const good = ex("test.op", 200, { price: { price: 1234 } }, { requestBody: { price: { price: 1234 } } });
    expect(checkClaimDetailed(u, [good])).toMatchObject({ anomalies: [], observed: 1 });
  });

  it("fieldPresent still raises an anomaly when the field is absent (absence IS its violation) and counts as observed", () => {
    const fp = claim("test.present", { kind: "fieldPresent", field: "headcount.total" });
    const r = checkClaimDetailed(fp, [ex("test.op", 200, COUNT_BODY)]);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]!.observed).toMatchObject({ field: "headcount.total", missing: ["headcount.total"] });
    expect(r.observed).toBe(1);
    expect(r.unobservable).toEqual([]);
  });

  it("present-but-null behaves as before: observed; a type violation unless the type admits null; present for fieldPresent", () => {
    const nullBody = { headcount: { total: null } };
    const strict = checkClaimDetailed(TOTAL, [ex("test.op", 200, nullBody)]);
    expect(strict.observed).toBe(1);
    expect(strict.anomalies).toHaveLength(1);
    expect(strict.anomalies[0]!.observed).toMatchObject({ mismatches: [{ path: "headcount.total", type: "null", value: null }] });
    const nullable = claim("test.nullable", { kind: "type", field: "headcount.total", type: "integer|null" });
    expect(checkClaimDetailed(nullable, [ex("test.op", 200, nullBody)])).toMatchObject({ anomalies: [], observed: 1, unobservable: [] });
    const fp = claim("test.present", { kind: "fieldPresent", field: "headcount.total" });
    expect(checkClaimDetailed(fp, [ex("test.op", 200, nullBody)])).toMatchObject({ anomalies: [], observed: 1 });
  });

  it("recon summary says the claim was not observed (never honored)", () => {
    const e = ex("test.op", 200, COUNT_BODY);
    const r: ReconResult = {
      tool: "crustdata",
      mode: "replay",
      cassetteName: "test",
      cassetteHash: "0".repeat(64),
      entries: [{ claim: TOTAL, recon: [] }],
      observations: [{ claimId: TOTAL.id, exchange: e }],
      anomalies: [],
      steps: [],
      creditsUsed: 0,
      creditsByEndpoint: {},
      budget: 0,
    };
    const lines = formatReconSummary(r, { runId: "test-run" });
    expect(lines).toContain(`not observed: ${TOTAL.id} — path absent in 1 2xx exchange(s) (headcount.total); no anomaly, not honored`);
  });
});

// ---------------------------------------------------------------------------------------------
// Metrics

function notarizedHonored(claimId: string): Belief {
  return {
    id: beliefIdFor(claimId),
    claimId,
    tool: "crustdata",
    statement: "test belief",
    class: "honored",
    alpha: 4,
    beta: 1,
    confidence: 0.8,
    status: "notarized",
    evidence: [],
  } as unknown as Belief;
}

function notarizeLike(beliefs: Belief[], anomalies: Anomaly[] = []): Parameters<typeof consolidateMetrics>[0] & { disclosure: string[] } {
  const zero = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
  return {
    kind: "notarize",
    variant: "notarize",
    beliefs: { before: [], after: beliefs },
    anomalies,
    claims: [],
    usageByRole: { executor: zero, reflector: zero, adversary: zero },
    credits: { byEndpoint: {}, total: 0, budget: 0 },
    metrics: {},
    disclosure: [],
  };
}

describe("metrics: an unobserved claim is not ground truth for belief_precision", () => {
  it("a notarized honored belief on a claim whose path never resolved is not counted", () => {
    const entries: ContractEntry[] = [{ claim: TOTAL, recon: [] }];
    const observations: Observation[] = [{ claimId: TOTAL.id, exchange: ex("test.op", 200, COUNT_BODY) }];
    const bundle = notarizeLike([notarizedHonored(TOTAL.id)]);
    const m = consolidateMetrics(bundle, { checkedClaimIds: observedClaimIds(entries, observations) });
    expect(m.belief_precision).toBeNull();
    expect(m.belief_precision_n).toBeNull();
    // What the old "had an observation" rule would have done: counted it as honored ground truth.
    const old = consolidateMetrics(bundle, { checkedClaimIds: observations.map((o) => o.claimId) });
    expect(old.belief_precision).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Probe templates

function ctx(c: Claim, over: Partial<ProbeContext> = {}): ProbeContext {
  return { runId: "run-t", tag: "run-t-p1", costs: buildCostModel({ claims: [c] }), burst: new BurstCounter(), payments: new SimplePaymentPool(), ...over };
}

function hyps(classes: Array<Hypothesis["class"]>, test: Hypothesis["distinguishingTest"]): Hypothesis[] {
  return classes.map((cls) => ({ id: `hyp-${cls}`, anomalyId: "anom-test", class: cls, statement: `${cls} explains it`, distinguishingTest: test }));
}

function designOf(m: ProbeTemplateModule, c: Claim, h: Hypothesis[]): ProbeDesign {
  const d = m.design(c, h, ctx(c));
  if (isSkip(d)) throw new Error(`unexpected skip: ${d.skip}`);
  return d;
}

const tag = (variant: Variant, t: string, exchange: Exchange): TaggedExchange => ({ variant, step: 0, tag: t, exchange });

/** A ProbeIo that answers every call with `body(op, args)` (status 200). */
function io(body: (op: string, args: unknown[]) => unknown): ProbeIo {
  let clock = Date.parse("2026-10-10T10:00:00.000Z");
  return {
    async sleep() {},
    async call(op, args) {
      clock += 10;
      const last = args[args.length - 1];
      return [ex(op, 200, body(op, args), { requestBody: last !== null && typeof last === "object" ? last : undefined, recordedAt: new Date(clock).toISOString() })];
    },
  };
}

/** Run one probe through commit-then-run, then apply it to a fresh belief; returns the probe and the belief before/after. */
async function probeAndApply(c: Claim, m: ProbeTemplateModule, h: Hypothesis[], probeIo: ProbeIo) {
  const db = freshDb();
  const store = new BeliefStore(db);
  const before = store.ensure(c);
  const design = designOf(m, c, h);
  const res = await runProbe({ io: probeIo, db, runId: "run-t", probeId: "run-t-p001", claim: c, template: m, design, ctx: ctx(c), ledger: new CreditLedger({ budget: 100 }) });
  store.applyProbe(before.id, res.probe, res.verdict, new Map(h.map((x) => [x.id, x])));
  return { res, before, after: store.get(before.id)! };
}

describe("type_edge: an absent claim path is uninformative, never doc_type", () => {
  const real = contractEntryById("crustdata.enrich.headcount-total-integer")!;
  // Same recipe, but the claim's path is `headcount.total` while the (test) response has `headcount.count`.
  const c: Claim = { ...real.claim, expect: { kind: "type", field: "[].matches[].company_data.headcount.total", type: "integer" } };
  const h = hyps(["honored", "silent_coercion"], "type_edge");
  const countBody = [{ matches: [{ company_data: { headcount: { count: 1200 } } }] }];
  const totalBody = (n: number) => [{ matches: [{ company_data: { headcount: { total: n } } }] }];

  it("observe: absent in both variants -> outcome null, missingPaths, judge uninformative", () => {
    const d = designOf(typeEdge, c, h);
    const o = typeEdge.observe([tag("control", "read", ex(c.operation, 200, countBody)), tag("treatment", "read", ex(c.operation, 200, countBody))], d, c);
    expect(o.outcome).toBeNull();
    expect(o.missingPaths).toEqual([c.expect.kind === "type" ? c.expect.field : ""]);
    expect(judge(typeEdge, d, o).verdict).toBe("uninformative");
  });

  it("observe: present only in the treatment is still uninformative (would otherwise read doc_type and confirm honored)", () => {
    const d = designOf(typeEdge, c, h);
    const o = typeEdge.observe([tag("control", "read", ex(c.operation, 200, countBody)), tag("treatment", "read", ex(c.operation, 200, totalBody(1200)))], d, c);
    expect(o.outcome).toBeNull();
    expect(o.note).toMatch(/absent in the control response/);
    expect(judge(typeEdge, d, o).verdict).toBe("uninformative");
  });

  it("observe: present in both still classifies as before (control check)", () => {
    const d = designOf(typeEdge, c, h);
    const o = typeEdge.observe([tag("control", "read", ex(c.operation, 200, totalBody(15))), tag("treatment", "read", ex(c.operation, 200, totalBody(1200)))], d, c);
    expect(o.outcome).toBe("doc_type");
    expect(o.missingPaths).toBeUndefined();
  });

  it("probe end to end: verdict uninformative, belief α/β and status unchanged, missingPaths recorded on the probe", async () => {
    const { res, before, after } = await probeAndApply(c, typeEdge, h, io(() => countBody));
    expect(res.verdict.verdict).toBe("uninformative");
    expect(res.probe.verdict).toBe("uninformative");
    expect((res.probe.observed as { missingPaths?: string[] }).missingPaths).toEqual(["[].matches[].company_data.headcount.total"]);
    expect({ alpha: after.alpha, beta: after.beta, confidence: after.confidence, status: after.status }).toEqual({
      alpha: before.alpha,
      beta: before.beta,
      confidence: before.confidence,
      status: before.status,
    });
  });
});

describe("unit_roundtrip: an absent echo path is uninformative, never equal", () => {
  const c = contractEntryById("dodo.product.price-minor-units")!.claim; // param + field: price.price
  const h = hyps(["honored", "unit_mismatch"], "unit_roundtrip");

  it("observe: echo path absent -> outcome null with missingPaths; judge uninformative", () => {
    const d = designOf(unitRoundtrip, c, h);
    const o = unitRoundtrip.observe(
      [
        tag("control", "write", ex(c.operation, 200, { price: { amount: 2468 } }, { requestBody: { price: { price: 2468 } } })),
        tag("treatment", "write", ex(c.operation, 200, { price: { amount: 1234 } }, { requestBody: { price: { price: 1234 } } })),
      ],
      d,
      c,
    );
    expect(o.outcome).toBeNull();
    expect(o.missingPaths).toEqual(["price.price"]);
    expect(judge(unitRoundtrip, d, o).verdict).toBe("uninformative");
  });

  it("probe end to end: verdict uninformative and the belief does not move", async () => {
    const { res, before, after } = await probeAndApply(
      c,
      unitRoundtrip,
      h,
      io((_op, args) => ({ price: { amount: (args[0] as { price: { price: number } }).price.price } })),
    );
    expect(res.verdict.verdict).toBe("uninformative");
    expect([after.alpha, after.beta, after.status]).toEqual([before.alpha, before.beta, before.status]);
  });
});

describe("judge: missingPaths overrides a template that reports an outcome", () => {
  it("a template whose informative() ignores missingPaths still yields uninformative", () => {
    const c = contractEntryById("dodo.product.price-minor-units")!.claim;
    const h = hyps(["honored", "unit_mismatch"], "unit_roundtrip");
    const d = designOf(unitRoundtrip, c, h);
    const lax: ProbeTemplateModule = { ...unitRoundtrip, informative: (o) => o.outcome !== null };
    const v = judge(lax, d, { outcome: "equal", treatment: {}, control: {}, instrument: { treatment: 1, control: 2 }, missingPaths: ["price.price"] });
    expect(v.verdict).toBe("uninformative");
  });
});

// ---------------------------------------------------------------------------------------------
// Evidence check

describe("evidence: an observation with an absent claim path is never valid evidence", () => {
  const CLAIM: Claim = {
    id: "dodo.refunds.page-size-max",
    tool: "dodo",
    operation: "dodo.listRefunds",
    param: "page_size",
    docText: "page_size: maximum 100",
    expect: { kind: "maxItems", max: 100 },
    docUrl: "https://docs.dodopayments.com/api-reference/refunds/list-refunds",
  };
  const PREDICTION = { "h-ok": { class: "honored", outcomes: ["rejected"] }, "h-trunc": { class: "silent_truncation", outcomes: ["clamped"] } };
  const probe = (observed: Record<string, unknown>): Probe => ({
    id: "run-a-p001",
    tool: "dodo",
    claimId: CLAIM.id,
    hypothesisIds: ["h-ok", "h-trunc"],
    template: "boundary_sweep",
    params: { steps: [{ op: CLAIM.operation, params: { page_size: 101 } }] },
    control: { params: { steps: [{ op: CLAIM.operation, params: { page_size: 1 } }, { op: CLAIM.operation, params: { page_size: 100 } }] } },
    prediction: PREDICTION,
    predictionHash: predictionHash(PREDICTION),
    committedAt: "2026-10-10T10:00:00.000Z",
    observed,
    verdict: "confirmed",
    winningHypothesisId: "h-ok",
    costCredits: 0,
    calls: 3,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
  });
  const span = (p: Probe): SpanRecord => ({
    name: "notary.probe",
    traceId: p.traceId,
    spanId: p.spanId!,
    startedAt: "2026-10-10T10:00:00.000Z",
    endedAt: "2026-10-10T10:00:01.000Z",
    status: "ok",
    attrs: { "notary.probeId": p.id, "notary.claimId": p.claimId, "notary.predictionHash": p.predictionHash, "notary.verdict": p.verdict! },
  });
  const check = (p: Probe) =>
    checkEvidence({ belief: { id: `belief-${CLAIM.id}`, claimId: CLAIM.id, evidence: [{ probeId: p.id, traceId: p.traceId, spanId: p.spanId! }] }, claim: CLAIM, probes: [p], spans: [span(p)] })[0]!;

  it("control: the same probe without missingPaths passes", () => {
    expect(check(probe({ outcome: "rejected" })).valid).toBe(true);
  });

  it("missingPaths on the recorded observation makes the evidence invalid", () => {
    const r = check(probe({ outcome: "rejected", missingPaths: ["(response list)"] }));
    expect(r.valid).toBe(false);
    expect(r.failures).toContain("uninformative: claim path(s) absent from the response ((response list))");
  });
});

// ---------------------------------------------------------------------------------------------
// TASK B: belief_precision disclosure (AUDIT A-14)

describe("belief_precision disclosure (AUDIT A-14)", () => {
  it("the exact disclosure text", () => {
    expect(BELIEF_PRECISION_DISCLOSURE).toBe(
      "belief_precision is measured against the deterministic checker on the SAME recording (not an independent ground truth); see docs/AUDIT.md A-14",
    );
  });

  it("a bundle with a non-null belief_precision gets the disclosure once; a null one does not", () => {
    const withValue = withMetricDisclosures({ disclosure: ["x"], metrics: { belief_precision: 0.5 } });
    expect(withValue.disclosure).toEqual(["x", BELIEF_PRECISION_DISCLOSURE]);
    expect(withMetricDisclosures(withValue).disclosure).toEqual(["x", BELIEF_PRECISION_DISCLOSURE]);
    expect(withMetricDisclosures({ disclosure: ["x"], metrics: { belief_precision: null } }).disclosure).toEqual(["x"]);
    expect(withMetricDisclosures({ disclosure: [], metrics: {} }).disclosure).toEqual([]);
    // 0 is a value, not "absent".
    expect(withMetricDisclosures({ disclosure: [], metrics: { belief_precision: 0 } }).disclosure).toEqual([BELIEF_PRECISION_DISCLOSURE]);
  });

  it("EVALUATION.md prints the note next to the Belief precision row (absent and present) and next to the per-bundle metric row", () => {
    const empty = renderEvaluationMd({ bundles: [], skipped: [], excluded: [], checks: null, driftFixtures: [], generatedAt: "2026-10-10T00:00:00.000Z" });
    const row = empty.split("\n").find((l) => l.startsWith("| Belief precision |"));
    expect(row).toContain("Note: `belief_precision` is measured against the deterministic checker on the SAME recording (not an independent ground truth); see `docs/AUDIT.md A-14`");

    const sample = buildSampleBundle();
    const b: RunBundle = { ...sample, sample: false, kind: "notarize", variant: "notarize", runId: "test-notarize", metrics: { ...sample.metrics, belief_precision: 1 } };
    const md = renderEvaluationMd({ bundles: [b], skipped: [], excluded: [], checks: null, driftFixtures: [], generatedAt: "2026-10-10T00:00:00.000Z" });
    const prd = md.split("\n").find((l) => l.startsWith("| Belief precision |"))!;
    expect(prd).toContain("| 1 |");
    expect(prd).toContain("see `docs/AUDIT.md A-14`");
    const perBundle = md.split("\n").find((l) => l.startsWith("| `belief_precision` |"))!;
    expect(perBundle).toContain("see `docs/AUDIT.md A-14`");
  });
});
