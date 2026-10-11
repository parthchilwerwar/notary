import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkEvidence, loadSpanRecords, parseSpanJsonl } from "../src/beliefs/evidence.js";
import { designFingerprint, paramVariation, valuesAtPath } from "../src/beliefs/params.js";
import { runBeliefsPhase } from "../src/beliefs/phase.js";
import type { ReviewBeliefArgs, ReviewOutcome } from "../src/adversary/index.js";
import type { Belief, Claim, Hypothesis, Probe, ProbeTemplate } from "../src/schema/index.js";
import { NotaryDb, predictionHash } from "../src/store/db.js";
import { initTracing, setSpanSink, shutdownTracing, tracingEnabled, withSpan } from "../src/trace/index.js";
import type { SpanRecord } from "../src/trace/index.js";
import { MissingCredentialError } from "../src/tools/errors.js";
import { UsdCapExceededError } from "../src/llm/budget.js";

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

type StepSpec = { op?: string; params: Record<string, unknown>; repeat?: number; setup?: boolean };

function mkProbe(o: {
  id?: string;
  claim?: Claim;
  template?: ProbeTemplate;
  t: StepSpec[];
  c?: StepSpec[] | null;
  verdict?: Probe["verdict"];
  outcome?: string | null;
  traceId?: string;
  spanId?: string;
}): Probe {
  const claim = o.claim ?? CLAIM;
  const step = (s: StepSpec) => ({ op: s.op ?? claim.operation, params: s.params, ...(s.repeat ? { repeat: s.repeat } : {}), ...(s.setup ? { setup: true } : {}) });
  return {
    id: o.id ?? "run-a-p001",
    tool: claim.tool,
    claimId: claim.id,
    hypothesisIds: ["h-ok", "h-trunc"],
    template: o.template ?? "boundary_sweep",
    params: { steps: o.t.map(step) },
    ...(o.c === null ? {} : { control: { params: { steps: (o.c ?? []).map(step) } } }),
    prediction: PREDICTION,
    predictionHash: predictionHash(PREDICTION),
    committedAt: "2026-10-10T10:00:00.000Z",
    observed: { outcome: o.outcome === undefined ? "rejected" : o.outcome },
    verdict: o.verdict ?? "confirmed",
    ...((o.verdict ?? "confirmed") === "confirmed" ? { winningHypothesisId: "h-ok" } : {}),
    costCredits: 0,
    calls: 2,
    traceId: o.traceId ?? "a".repeat(32),
    spanId: o.spanId ?? "b".repeat(16),
  };
}

function mkSpan(p: Probe, over: Partial<SpanRecord> & { attrs?: SpanRecord["attrs"] } = {}): SpanRecord {
  return {
    name: "notary.probe",
    traceId: p.traceId,
    spanId: p.spanId!,
    startedAt: "2026-10-10T10:00:00.000Z",
    endedAt: "2026-10-10T10:00:01.000Z",
    status: "ok",
    ...over,
    attrs: {
      "notary.probeId": p.id,
      "notary.claimId": p.claimId,
      "notary.template": p.template,
      "notary.predictionHash": p.predictionHash,
      "notary.verdict": p.verdict!,
      ...(over.attrs ?? {}),
    },
  };
}

function beliefCiting(probes: readonly Probe[]): Pick<Belief, "id" | "claimId" | "evidence"> {
  return { id: `belief-${CLAIM.id}`, claimId: CLAIM.id, evidence: probes.map((p) => ({ probeId: p.id, traceId: p.traceId, spanId: p.spanId! })) };
}

const SWEEP = { t: [{ params: { page_size: 101 } }], c: [{ params: { page_size: 1 } }, { params: { page_size: 100 } }] };

// ------------------------------------------------------------------ params

describe("paramVariation (did the probe vary the claim's parameter?)", () => {
  it("dotted / array paths", () => {
    expect(valuesAtPath({ items: [{ amount: 1 }, { amount: 2 }] }, "items[].amount")).toEqual([1, 2]);
    expect(valuesAtPath({ price: { price: 1234 } }, "price.price")).toEqual([1234]);
    expect(valuesAtPath({ a: 1 }, "b.c")).toEqual([]);
  });

  it("value rule: treatment vs control differ at claim.param", () => {
    const v = paramVariation(CLAIM, mkProbe(SWEEP));
    expect(v.varied).toBe(true);
    expect(v.how).toMatch(/page_size differs/);
  });

  it("identical values at the param → not varied", () => {
    const v = paramVariation(CLAIM, mkProbe({ t: [{ params: { page_size: 50, page_number: 1 } }], c: [{ params: { page_size: 50, page_number: 0 } }] }));
    expect(v).toMatchObject({ varied: false });
    expect(v.how).toMatch(/page_size is identical/);
  });

  it("present vs absent counts as varied (unknown_param); no control is never varied", () => {
    const claim: Claim = { ...CLAIM, id: "c-unknown", param: "fields", expect: { kind: "errorOnUnknownParam" } };
    expect(paramVariation(claim, mkProbe({ claim, template: "unknown_param", t: [{ params: { fields: "x" } }], c: [{ params: {} }] })).varied).toBe(true);
    expect(paramVariation(CLAIM, mkProbe({ ...SWEEP, c: null })).varied).toBe(false);
  });

  it("setup steps are ignored", () => {
    const v = paramVariation(CLAIM, mkProbe({ t: [{ params: { page_size: 101 }, setup: true }, { params: { page_size: 5 } }], c: [{ params: { page_size: 5 } }] }));
    expect(v.varied).toBe(false);
  });

  it("count rule: retry templates exercise the param by repeating the write", () => {
    const claim: Claim = { ...CLAIM, id: "c-retry", operation: "dodo.createRefund", param: "refund_id", expect: { kind: "idempotentOnRetry" } };
    const p = mkProbe({
      claim,
      template: "retry_after_timeout",
      t: [{ op: "dodo.getPayment", params: { payment_id: "p" } }, { params: { payment_id: "p" }, repeat: 2 }, { op: "dodo.getPayment", params: { payment_id: "p" } }],
      c: [{ op: "dodo.getPayment", params: { payment_id: "p" } }],
    });
    expect(paramVariation(claim, p)).toMatchObject({ varied: true, how: expect.stringMatching(/treatment sends dodo.createRefund 2x vs control 0x/) });
    // the same shape under a non-count template is not variation
    expect(paramVariation(claim, { ...p, template: "unit_roundtrip" }).varied).toBe(false);
  });

  it("claims with no single param: requests must differ", () => {
    const claim: Claim = { ...CLAIM, id: "c-noparam", param: "", expect: { kind: "type", field: "items[].amount", type: "integer|null" } };
    expect(paramVariation(claim, mkProbe({ claim, template: "type_edge", t: [{ params: { page_size: 100 } }], c: [{ params: { page_size: 1 } }] })).varied).toBe(true);
    expect(paramVariation(claim, mkProbe({ claim, template: "type_edge", t: [{ params: { page_size: 1 } }], c: [{ params: { page_size: 1 } }] })).varied).toBe(false);
  });

  it("exercise rule (type_edge): the param is sent and the records differ", () => {
    const claim: Claim = { ...CLAIM, id: "c-type", operation: "crustdata.enrich", param: "fields", tool: "crustdata", expect: { kind: "type", field: "x", type: "integer" } };
    const p = mkProbe({ claim, template: "type_edge", t: [{ params: { fields: ["headcount"], domains: ["a.com"] } }], c: [{ params: { fields: ["headcount"], domains: ["b.com"] } }] });
    expect(paramVariation(claim, p)).toMatchObject({ varied: true, how: expect.stringMatching(/fields exercised/) });
  });

  it("design fingerprint: template + treatment values at the param", () => {
    expect(designFingerprint(CLAIM, mkProbe(SWEEP))).toBe('boundary_sweep|page_size=["101"]');
    expect(designFingerprint({ ...CLAIM, param: "" }, mkProbe(SWEEP))).toBe("boundary_sweep");
  });
});

// ------------------------------------------------------------------ checkEvidence

describe("checkEvidence (FR-10)", () => {
  it("valid: span exists, ids match, param varied, informative", () => {
    const p = mkProbe(SWEEP);
    const [r] = checkEvidence({ belief: beliefCiting([p]), claim: CLAIM, probes: [p], spans: [mkSpan(p)] });
    expect(r).toMatchObject({ probeId: p.id, valid: true, failures: [] });
    expect(r!.reason).toMatch(/span verified; page_size differs/);
  });

  it("span missing", () => {
    const p = mkProbe(SWEEP);
    const [r] = checkEvidence({ belief: beliefCiting([p]), claim: CLAIM, probes: [p], spans: [] });
    expect(r!.valid).toBe(false);
    expect(r!.failures).toEqual([`span missing (trace ${p.traceId}, span ${p.spanId})`]);
  });

  it("parameter not varied", () => {
    const p = mkProbe({ t: [{ params: { page_size: 100 } }], c: [{ params: { page_size: 100 } }] });
    const [r] = checkEvidence({ belief: beliefCiting([p]), claim: CLAIM, probes: [p], spans: [mkSpan(p)] });
    expect(r!.valid).toBe(false);
    expect(r!.failures).toEqual([expect.stringMatching(/^parameter not varied: page_size is identical/)]);
  });

  it("ids mismatch: span claimId / probeId / traceId / predictionHash", () => {
    const p = mkProbe(SWEEP);
    const claimWrong = checkEvidence({ belief: beliefCiting([p]), claim: CLAIM, probes: [p], spans: [mkSpan(p, { attrs: { "notary.claimId": "other.claim" } })] })[0]!;
    expect(claimWrong.valid).toBe(false);
    expect(claimWrong.failures).toEqual([`span notary.claimId other.claim != ${CLAIM.id}`]);

    const probeWrong = checkEvidence({ belief: beliefCiting([p]), claim: CLAIM, probes: [p], spans: [mkSpan(p, { attrs: { "notary.probeId": "run-z-p009" } })] })[0]!;
    expect(probeWrong.failures).toEqual([`span notary.probeId run-z-p009 != ${p.id}`]);

    const traceWrong = checkEvidence({ belief: beliefCiting([p]), claim: CLAIM, probes: [p], spans: [mkSpan(p, { traceId: "c".repeat(32) })] })[0]!;
    expect(traceWrong.failures).toEqual([expect.stringMatching(/^trace id mismatch/)]);

    const hashWrong = checkEvidence({ belief: beliefCiting([p]), claim: CLAIM, probes: [p], spans: [mkSpan(p, { attrs: { "notary.predictionHash": "0".repeat(64) } })] })[0]!;
    expect(hashWrong.failures).toEqual(["span notary.predictionHash differs from the committed prediction hash"]);
  });

  it("probe record missing or of another claim", () => {
    const p = mkProbe(SWEEP);
    expect(checkEvidence({ belief: beliefCiting([p]), claim: CLAIM, probes: [], spans: [mkSpan(p)] })[0]!.failures).toContain("probe record missing");
    const other = { ...p, claimId: "other.claim" };
    expect(checkEvidence({ belief: beliefCiting([p]), claim: CLAIM, probes: [other], spans: [mkSpan(p)] })[0]!.failures).toContain("probe is for claim other.claim, not dodo.refunds.page-size-max");
  });

  it("uninformative: verdict not confirmed, or no observed outcome", () => {
    const u = mkProbe({ ...SWEEP, verdict: "uninformative", outcome: null });
    const r = checkEvidence({ belief: beliefCiting([u]), claim: CLAIM, probes: [u], spans: [mkSpan(u)] })[0]!;
    expect(r.valid).toBe(false);
    expect(r.failures).toEqual(["uninformative: verdict uninformative", "uninformative: no observed outcome"]);

    const noOutcome = mkProbe({ ...SWEEP, outcome: null });
    expect(checkEvidence({ belief: beliefCiting([noOutcome]), claim: CLAIM, probes: [noOutcome], spans: [mkSpan(noOutcome)] })[0]!.failures).toEqual([
      "uninformative: no observed outcome",
    ]);
  });

  it("span verdict disagreeing with the probe, or a span that ended in error, is invalid", () => {
    const p = mkProbe(SWEEP);
    const r = checkEvidence({ belief: beliefCiting([p]), claim: CLAIM, probes: [p], spans: [mkSpan(p, { status: "error", error: "boom", attrs: { "notary.verdict": "invalid" } })] })[0]!;
    expect(r.failures).toEqual(["span ended in error (boom)", "span notary.verdict invalid != probe verdict confirmed"]);
  });

  it("finds the span by probeId when the evidence has no spanId", () => {
    const p = mkProbe(SWEEP);
    const belief = { ...beliefCiting([p]), evidence: [{ probeId: p.id, traceId: p.traceId }] };
    expect(checkEvidence({ belief, claim: CLAIM, probes: [p], spans: [mkSpan(p, { spanId: "d".repeat(16) })] })[0]!.valid).toBe(true);
  });
});

// ------------------------------------------------------------------ loader + span sink

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "notary-ev-"));
  tmpDirs.push(d);
  return d;
}

describe("span sink (runs/<runId>/spans.jsonl) with neatlogs disabled", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(async () => {
    saved = { NEATLOGS_API_KEY: process.env.NEATLOGS_API_KEY, NOTARY_TEST_SECRET_KEY: process.env.NOTARY_TEST_SECRET_KEY };
    delete process.env.NEATLOGS_API_KEY;
    await shutdownTracing();
    await initTracing();
  });
  afterEach(() => {
    setSpanSink(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("writes one record per span with local ids, late attrs, nesting and error status", async () => {
    expect(tracingEnabled()).toBe(false);
    const path = join(tmp(), "run-1", "spans.jsonl");
    setSpanSink(path);
    let ids: { traceId: string; spanId: string } | undefined;
    await withSpan(
      "notary.probe",
      { "notary.probeId": "p1", "notary.claimId": "c1" },
      async () => {
        await withSpan("notary.inner", { x: 1 }, () => "inner");
        return "outer";
      },
      { onSpan: (i, set) => ((ids = i), set("notary.verdict", "confirmed")) },
    );
    await expect(withSpan("notary.fails", {}, () => { throw new Error("boom"); })).rejects.toThrow("boom");

    const recs = parseSpanJsonl(readFileSync(path, "utf8"));
    expect(recs.map((r) => r.name)).toEqual(["notary.inner", "notary.probe", "notary.fails"]);
    const [inner, outer, fails] = recs as [SpanRecord, SpanRecord, SpanRecord];
    expect(outer.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(outer.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ids).toEqual({ traceId: outer.traceId, spanId: outer.spanId });
    expect(outer.attrs).toEqual({ "notary.probeId": "p1", "notary.claimId": "c1", "notary.verdict": "confirmed" });
    expect(outer.status).toBe("ok");
    expect(inner.traceId).toBe(outer.traceId);
    expect(inner.parentSpanId).toBe(outer.spanId);
    expect(fails).toMatchObject({ status: "error", error: "Error: boom" });
    expect(fails.traceId).not.toBe(outer.traceId);
  });

  it("masks secrets like exported spans: secret-looking keys dropped, secret env values scrubbed", async () => {
    process.env.NOTARY_TEST_SECRET_KEY = "sk_test_supersecretvalue";
    const path = join(tmp(), "spans.jsonl");
    setSpanSink(path);
    await withSpan("s", { "notary.note": "key=sk_test_supersecretvalue", api_key: "x" }, () => 1, {
      onSpan: (_i, set) => set("authorization", "Bearer abc"),
    });
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("sk_test_supersecretvalue");
    const [rec] = parseSpanJsonl(text);
    expect(rec!.attrs).toEqual({ "notary.note": "key=[REDACTED]" });
  });

  it("no sink, no file; setSpanSink(null) stops writing", async () => {
    const path = join(tmp(), "spans.jsonl");
    await withSpan("before", {}, () => 1);
    expect(existsSync(path)).toBe(false);
    setSpanSink(path);
    await withSpan("during", {}, () => 1);
    setSpanSink(null);
    await withSpan("after", {}, () => 1);
    expect(parseSpanJsonl(readFileSync(path, "utf8")).map((r) => r.name)).toEqual(["during"]);
  });

  it("loadSpanRecords reads runs/<runId>/spans.jsonl, skips malformed lines, notes missing runs", () => {
    const runs = tmp();
    mkdirSync(join(runs, "run-a"), { recursive: true });
    const p = mkProbe(SWEEP);
    writeFileSync(join(runs, "run-a", "spans.jsonl"), `${JSON.stringify(mkSpan(p))}\nnot json\n\n`, "utf8");
    const src = loadSpanRecords({ runsDir: runs, runIds: ["run-a", "run-b"], env: { PATH: "" } });
    expect(src.source).toBe("jsonl");
    expect(src.records).toHaveLength(1);
    expect(src.notes).toEqual(["no spans.jsonl for run run-b"]);
  });
});

// ------------------------------------------------------------------ the beliefs phase end to end

describe("runBeliefsPhase: probes -> beliefs -> evidence check -> adversary", () => {
  const dbs: NotaryDb[] = [];
  afterEach(() => {
    setSpanSink(null);
    while (dbs.length) dbs.pop()!.close();
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  const HYPS: Hypothesis[] = [
    { id: "h-ok", anomalyId: "a1", class: "honored", statement: "s", distinguishingTest: "boundary_sweep" },
    { id: "h-trunc", anomalyId: "a1", class: "silent_truncation", statement: "s", distinguishingTest: "boundary_sweep" },
  ];

  /** Commit + record 3 confirmed-violation probes inside real spans (sink on), like the runner does. */
  async function seed(opts: { breakVariation?: boolean } = {}): Promise<{ db: NotaryDb; runsDir: string; probes: Probe[] }> {
    delete process.env.NEATLOGS_API_KEY;
    await shutdownTracing();
    const db = new NotaryDb(":memory:");
    dbs.push(db);
    const runsDir = tmp();
    const runId = "notarize-dodo-test";
    setSpanSink(join(runsDir, runId, "spans.jsonl"));
    const designs: Array<[ProbeTemplate, number, number]> = [
      ["boundary_sweep", 101, 1],
      ["pagination_completeness", 10, 30],
      ["boundary_sweep", 150, opts.breakVariation ? 150 : 1],
    ];
    const probes: Probe[] = [];
    for (let i = 0; i < designs.length; i++) {
      const [template, t, c] = designs[i]!;
      const id = `${runId}-p00${i + 1}`;
      await withSpan(
        "notary.probe",
        { "notary.probeId": id, "notary.claimId": CLAIM.id, "notary.template": template, "notary.predictionHash": predictionHash(PREDICTION) },
        async () => {},
        {
          onSpan: (ids, set) => {
            const params = { steps: [{ op: CLAIM.operation, params: { page_size: t } }] };
            const control = { params: { steps: [{ op: CLAIM.operation, params: { page_size: c } }] } };
            db.commitProbe({ id, runId, tool: "dodo", claimId: CLAIM.id, hypothesisIds: ["h-ok", "h-trunc"], template, params, control, prediction: PREDICTION, committedAt: "2026-10-10T10:00:00.000Z", traceId: ids.traceId, spanId: ids.spanId });
            db.recordResult(id, predictionHash(PREDICTION), { observed: { outcome: "clamped", reason: "matches h-trunc" }, verdict: "confirmed", winningHypothesisId: "h-trunc", ranAt: "2026-10-10T10:00:01.000Z", costCredits: 0, calls: 2 });
            set("notary.verdict", "confirmed");
          },
        },
      );
    }
    probes.push(...db.loadProbes(runId));
    setSpanSink(null);
    return { db, runsDir, probes };
  }

  it("violated candidate with verified evidence is notarized by an upholding adversary", async () => {
    const { db, runsDir, probes } = await seed();
    const seen: ReviewBeliefArgs[] = [];
    const review = async (args: ReviewBeliefArgs): Promise<ReviewOutcome> => {
      seen.push(args);
      return { review: { verdict: "uphold", reason: "evidence varies page_size", model: "fake-adversary", backend: args.backend } };
    };
    const res = await runBeliefsPhase({ db, tool: "dodo", runsDir, claims: [CLAIM], probes, hypotheses: HYPS, backend: "session", review });
    expect(res.before).toHaveLength(1);
    expect(res.before[0]).toMatchObject({ status: "hypothesis", alpha: 1, beta: 1 });
    const b = res.after[0]!;
    expect(b).toMatchObject({ status: "notarized", beta: 4, class: "silent_truncation", probesToCandidate: 3, adversary: { verdict: "uphold" } });
    expect(b.evidence.map((e) => e.valid)).toEqual([true, true, true]);
    expect(res.evidence).toEqual({ checked: 3, invalid: 0, source: "jsonl" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.backend).toBe("session");
    expect(seen[0]!.probes.map((p) => p.id)).toEqual(probes.map((p) => p.id));
    expect(res.events.map((e) => `${e.from}->${e.to}`)).toEqual(["null->hypothesis", "hypothesis->hypothesis", "hypothesis->hypothesis", "hypothesis->candidate", "candidate->notarized"]);
    expect(res.lines[0]).toBe("beliefs: 1  hypothesis=0 candidate=0 notarized=1 refuted=0 abstained=0 unlearned=0");
  });

  it("evidence whose probe did not vary the param reverts the belief to hypothesis before review", async () => {
    const { db, runsDir, probes } = await seed({ breakVariation: true });
    let reviewed = 0;
    const res = await runBeliefsPhase({
      db, tool: "dodo", runsDir, claims: [CLAIM], probes, hypotheses: HYPS, backend: "session",
      review: async () => ((reviewed += 1), { review: null }),
    });
    expect(reviewed).toBe(0);
    // P9 (AUDIT-01): the invalid probe's β+1 is taken back, Beta(1,4) -> Beta(1,3).
    expect(res.after[0]).toMatchObject({ status: "hypothesis", beta: 3 });
    expect(res.after[0]!.evidence.map((e) => e.valid)).toEqual([true, true, false]);
    expect(res.evidence.invalid).toBe(1);
    expect(res.lines.some((l) => /invalid evidence .* parameter not varied/.test(l))).toBe(true);
  });

  it("bedrock adversary with no model id: BLOCKED, the candidate stays candidate", async () => {
    const { db, runsDir, probes } = await seed();
    const llm = {
      complete: async () => { throw new Error("must not be called"); },
      modelFor: (_role: string) => { throw new MissingCredentialError("NOTARY_MODEL_ADVERSARY"); },
    };
    const res = await runBeliefsPhase({ db, tool: "dodo", runsDir, claims: [CLAIM], probes, hypotheses: HYPS, backend: "bedrock", llm: llm as never });
    expect(res.adversaryBlocked).toBe("BLOCKED: NOTARY_MODEL_ADVERSARY not set");
    expect(res.after[0]!.status).toBe("candidate");
    expect(res.lines.at(-1)).toBe("BLOCKED: NOTARY_MODEL_ADVERSARY not set (Adversary review skipped; 1 belief(s) stay candidate)");
    expect(res.events.at(-1)).toMatchObject({ from: "candidate", to: "candidate", reason: expect.stringMatching(/BLOCKED/) });
  });

  it("bedrock adversary at NOTARY_MAX_USD: review stops (not a failed review), the candidate stays candidate", async () => {
    const { db, runsDir, probes } = await seed();
    const llm = {
      complete: async () => {
        throw new UsdCapExceededError("adversary", 0.05, 0.05, 0);
      },
      modelFor: (_role: string) => "test-adversary-model",
    };
    const res = await runBeliefsPhase({ db, tool: "dodo", runsDir, claims: [CLAIM], probes, hypotheses: HYPS, backend: "bedrock", llm: llm as never });
    expect(res.usdCapStopped).toMatch(/^USD cap reached: NOTARY_MAX_USD=0\.05/);
    expect(res.reviews).toEqual({ uphold: 0, narrow: 0, downgrade: 0, failed: 0 });
    expect(res.after[0]!.status).toBe("candidate");
    expect(res.lines.at(-1)).toMatch(/^STOPPED: USD cap reached: NOTARY_MAX_USD=0\.05 .*\(Adversary review stopped; 1 belief\(s\) stay candidate\)$/);
    expect(res.events.at(-1)).toMatchObject({ from: "candidate", to: "candidate", reason: expect.stringMatching(/NOTARY_MAX_USD/) });
  });

  it("probed beliefs still between thresholds at the end of the run abstain", async () => {
    const { db, runsDir, probes } = await seed();
    const res = await runBeliefsPhase({
      db, tool: "dodo", runsDir, claims: [CLAIM], probes: probes.slice(0, 2), hypotheses: HYPS, backend: "session",
      stoppedReason: "Credit budget exceeded", review: async () => ({ review: null }),
    });
    expect(res.after[0]).toMatchObject({ status: "abstained", beta: 3 });
    expect(res.events.at(-1)!.reason).toMatch(/budget ended between thresholds \(Credit budget exceeded\)/);
  });
});
