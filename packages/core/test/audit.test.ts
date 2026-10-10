/**
 * P9 self-audit regression tests (docs/AUDIT.md). Each block names the finding it pins down.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConverseTransport } from "../src/llm/client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeliefStore, beliefIdFor } from "../src/beliefs/store.js";
import { buildSampleBundle, finalizeBundle, writeBundle } from "../src/bundle/index.js";
import { consolidateMetrics, HEADLINE_KEYS } from "../src/eval/metrics.js";
import { LlmClient } from "../src/llm/client.js";
import type { AdversaryReview, Claim, Hypothesis, Probe, ProbeVerdict } from "../src/schema/index.js";
import { NotaryDb, predictionHash } from "../src/store/db.js";
import { Recorder, TestModeLockError } from "../src/tools/index.js";

const dbs: NotaryDb[] = [];
const dirs: string[] = [];
function freshDb(): NotaryDb {
  const db = new NotaryDb(":memory:");
  dbs.push(db);
  return db;
}
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.unstubAllGlobals();
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
const HYPS = new Map<string, Hypothesis>([
  ["h-ok", { id: "h-ok", anomalyId: "a1", class: "honored", statement: "s", distinguishingTest: "boundary_sweep" }],
  ["h-trunc", { id: "h-trunc", anomalyId: "a1", class: "silent_truncation", statement: "s", distinguishingTest: "boundary_sweep" }],
]);

let n = 0;
function probe(verdict: ProbeVerdict, t: number, winner?: string): Probe {
  n += 1;
  const prediction = { "h-ok": { class: "honored", outcomes: ["rejected"] }, "h-trunc": { class: "silent_truncation", outcomes: ["clamped"] } };
  return {
    id: `audit-p${n}`,
    tool: "dodo",
    claimId: CLAIM.id,
    hypothesisIds: ["h-ok", "h-trunc"],
    template: "boundary_sweep",
    params: { steps: [{ op: CLAIM.operation, params: { page_size: t } }] },
    control: { params: { steps: [{ op: CLAIM.operation, params: { page_size: 1 } }] } },
    prediction,
    predictionHash: predictionHash(prediction),
    committedAt: "2026-10-10T10:00:00.000Z",
    ranAt: "2026-10-10T10:00:01.000Z",
    observed: { outcome: verdict === "confirmed" ? "rejected" : null, reason: "r" },
    verdict,
    ...(winner ? { winningHypothesisId: winner } : {}),
    costCredits: 0,
    calls: 2,
    traceId: `trace-${n}`,
    spanId: `span-${n}`,
  };
}
const apply = (store: BeliefStore, p: Probe) =>
  store.applyProbe(beliefIdFor(CLAIM.id), p, { verdict: p.verdict!, ...(p.winningHypothesisId ? { winningHypothesisId: p.winningHypothesisId } : {}), reason: "t" }, HYPS);
const honored = (t: number) => probe("confirmed", t, "h-ok");
const review = (verdict: AdversaryReview["verdict"]): AdversaryReview => ({ verdict, reason: `because ${verdict}`, model: "adv", backend: "bedrock" });

/** Beta(4,1) from three distinct honored designs: a candidate. */
function candidate(store: BeliefStore): string {
  store.ensure(CLAIM);
  for (const t of [101, 150, 200]) apply(store, honored(t));
  const id = beliefIdFor(CLAIM.id);
  expect(store.get(id)!.status).toBe("candidate");
  return id;
}

describe("AUDIT-01: evidence that fails the FR-10 check gives back its α/β", () => {
  it("an invalidated observation no longer counts toward P(holds)", () => {
    const store = new BeliefStore(freshDb());
    const id = candidate(store);
    const [, , e3] = store.get(id)!.evidence;
    const b = store.applyEvidenceCheck(id, [{ probeId: e3!.probeId, valid: false, reason: "parameter not varied" }]);
    expect(b.status).toBe("hypothesis");
    expect(b).toMatchObject({ alpha: 3, beta: 1 });
    expect(b.confidence).toBeCloseTo(0.875, 12);
  });

  it("an uninformative probe cannot then promote the belief on the invalid probe's weight", () => {
    const store = new BeliefStore(freshDb());
    const id = candidate(store);
    const [, , e3] = store.get(id)!.evidence;
    store.applyEvidenceCheck(id, [{ probeId: e3!.probeId, valid: false, reason: "span missing" }]);
    const after = apply(store, probe("uninformative", 300)).belief;
    expect(after.status).toBe("hypothesis");
    expect(after.alpha).toBe(3);
  });

  it("re-checking the same invalid probe does not subtract twice; a later valid re-check restores it", () => {
    const store = new BeliefStore(freshDb());
    const id = candidate(store);
    const [, , e3] = store.get(id)!.evidence;
    store.applyEvidenceCheck(id, [{ probeId: e3!.probeId, valid: false, reason: "x" }]);
    store.applyEvidenceCheck(id, [{ probeId: e3!.probeId, valid: false, reason: "x" }]);
    expect(store.get(id)!.alpha).toBe(3);
    store.applyEvidenceCheck(id, [{ probeId: e3!.probeId, valid: true, reason: "ok" }]);
    expect(store.get(id)!.alpha).toBe(4);
  });
});

describe("AUDIT-02: the adversary cannot notarize evidence that never passed the FR-10 check", () => {
  it("uphold on a candidate whose evidence is unchecked is refused; the belief stays candidate", () => {
    const store = new BeliefStore(freshDb());
    const id = candidate(store);
    expect(() => store.applyAdversary(id, review("uphold"))).toThrow(/evidence/);
    expect(store.get(id)!.status).toBe("candidate");
  });

  it("uphold after the evidence check passes notarizes; downgrade never needs it", () => {
    const store = new BeliefStore(freshDb());
    const id = candidate(store);
    store.applyEvidenceCheck(id, store.get(id)!.evidence.map((e) => ({ probeId: e.probeId, valid: true, reason: "ok" })));
    expect(store.applyAdversary(id, review("uphold")).status).toBe("notarized");

    const s2 = new BeliefStore(freshDb());
    const id2 = candidate(s2);
    expect(s2.applyAdversary(id2, review("downgrade")).status).toBe("hypothesis");
  });
});

describe("AUDIT-03: applyProbe refuses a verdict that disagrees with the probe's recorded verdict", () => {
  it("a recorded 'uninformative' probe passed in as 'confirmed' moves nothing", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    const p = probe("uninformative", 120);
    expect(() =>
      store.applyProbe(beliefIdFor(CLAIM.id), p, { verdict: "confirmed", winningHypothesisId: "h-ok", reason: "forged" }, HYPS),
    ).toThrow(/recorded verdict/);
    expect(store.get(beliefIdFor(CLAIM.id))).toMatchObject({ alpha: 1, beta: 1, evidence: [] });
  });

  it("a confirmed probe passed in with a different winner is refused", () => {
    const store = new BeliefStore(freshDb());
    store.ensure(CLAIM);
    const p = honored(120);
    expect(() =>
      store.applyProbe(beliefIdFor(CLAIM.id), p, { verdict: "confirmed", winningHypothesisId: "h-trunc", reason: "forged" }, HYPS),
    ).toThrow(/recorded winner/);
  });
});

describe("AUDIT-04: a probe's recorded result is immutable too", () => {
  it("an SQL UPDATE of verdict / observed / winner after recordResult is rejected", () => {
    const db = freshDb();
    const prediction = { "hyp-a": { class: "honored", outcomes: ["equal"] } };
    const hash = db.commitProbe({
      id: "p1",
      runId: "r1",
      tool: "dodo",
      claimId: "c1",
      hypothesisIds: ["hyp-a"],
      template: "unit_roundtrip",
      params: { steps: [] },
      prediction,
      committedAt: "2026-10-10T10:00:00.000Z",
      traceId: "t1",
    });
    db.recordResult("p1", hash, { observed: { outcome: "equal" }, verdict: "confirmed", winningHypothesisId: "hyp-a", ranAt: "2026-10-10T10:00:01.000Z", costCredits: 0, calls: 1 });
    for (const sql of [
      "UPDATE probes SET verdict = 'refuted'",
      `UPDATE probes SET observed_json = '{"outcome":"x100"}'`,
      "UPDATE probes SET winning_hypothesis_id = NULL",
      "UPDATE probes SET trace_id = 'other'",
    ]) {
      expect(() => db.db.exec(sql), sql).toThrow(/immutable/);
    }
    expect(db.loadProbes("r1")[0]).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-a", traceId: "t1" });
  });
});

describe("AUDIT-06: the recorder refuses any non-test Dodo host, whatever built the request", () => {
  it("a live request to live.dodopayments.com never reaches fetch", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const rec = new Recorder({ mode: "live", env: {} });
    for (const url of ["https://live.dodopayments.com/refunds", "https://LIVE.DodoPayments.com/refunds", "http://test.dodopayments.com/refunds", "https://api.dodopayments.com/x"]) {
      await expect(rec.request({ tool: "dodo", op: "dodo.createRefund", method: "POST", url, body: {} }), url).rejects.toThrow(TestModeLockError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // the test host and other tools still go through
    await rec.request({ tool: "dodo", op: "dodo.listRefunds", method: "GET", url: "https://test.dodopayments.com/refunds" });
    await rec.request({ tool: "crustdata", op: "crustdata.getCreditBalance", method: "GET", url: "https://api.crustdata.com/account/credits" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("AUDIT-07: a bundle carrying a secret env value is never written", () => {
  it("writeBundle refuses it", async () => {
    const secret = "sk_test_audit_0123456789abcdef";
    vi.stubEnv("AUDIT_FAKE_API_KEY", secret);
    try {
      const { contentHash: _h, ...rest } = buildSampleBundle(42);
      const leaky = finalizeBundle({ ...rest, disclosure: [...rest.disclosure, `oops ${secret}`] });
      const dir = mkdtempSync(join(tmpdir(), "notary-audit-"));
      dirs.push(dir);
      await expect(writeBundle(leaky, dir)).rejects.toThrow(/secret/);
      await expect(writeBundle(buildSampleBundle(42), dir)).resolves.toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("AUDIT-08: secret env values are scrubbed from every model prompt", () => {
  it("system and user messages reach the transport with secrets masked", async () => {
    const secret = "AKIAAUDITSECRET0123456789";
    const seen: unknown[] = [];
    const transport: ConverseTransport = async (input) => {
      seen.push(input);
      return { output: { message: { role: "assistant", content: [{ text: "{}" }] } }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn", $metadata: {}, metrics: { latencyMs: 1 } } as never;
    };
    const llm = new LlmClient({
      env: { AWS_REGION: "us-east-1", NOTARY_MODEL_REFLECTOR: "model-r", NOTARY_MODEL_ADVERSARY: "model-a", AWS_SECRET_ACCESS_KEY: secret },
      transport,
    });
    await llm.complete({ role: "reflector", system: `sys ${secret}`, messages: [{ role: "user", content: `anomaly body ${secret}` }] });
    const sent = JSON.stringify(seen);
    expect(sent).not.toContain(secret);
    expect(sent).toContain("[REDACTED]");
  });
});

describe("AUDIT-09: the sample bundle uses the same metric keys real bundles carry", () => {
  it("every consolidated headline key is present in the sample's metrics, and no sample-only key", () => {
    const sample = buildSampleBundle(42);
    for (const k of HEADLINE_KEYS) expect(Object.keys(sample.metrics), k).toContain(k);
    // Keys a real bundle can carry: the headline keys, credits_<endpoint>, and compare-priors' pair.
    const graderExtras = ["items_total", "items_processed", "items_not_processed", "tier_accuracy", "executed", "denials"];
    const real = (k: string) =>
      HEADLINE_KEYS.includes(k) || graderExtras.includes(k) || k.startsWith("credits_") || k.startsWith("probes_to_candidate_with");
    expect(Object.keys(sample.metrics).filter((k) => !real(k))).toEqual([]);
    // consolidateMetrics over the sample (as if it were a guarded run) agrees on the belief counts it derives.
    const c = consolidateMetrics({ ...sample, kind: "run", variant: "guarded" });
    for (const k of Object.keys(c).filter((x) => x.startsWith("beliefs_") && x !== "beliefs_false")) expect(sample.metrics[k], k).toBe(c[k]);
    for (const k of Object.keys(sample.noiseFloor ?? {})) expect(HEADLINE_KEYS, k).toContain(k);
  });
});
