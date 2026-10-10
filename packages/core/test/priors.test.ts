/**
 * P7 transfer priors. All beliefs, bundles, tools and model replies here are TEST-ONLY data built in
 * this file (or in temp dirs); nothing is a run result.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeBundle, writeBundle } from "../src/bundle/index.js";
import { pHolds } from "../src/beliefs/math.js";
import {
  DEFAULT_PRIOR_STRENGTH,
  MAX_PRIOR_STRENGTH,
  baseRates,
  loadPriorsSource,
  priorStrengthFromEnv,
  probesToCandidateMetrics,
  transferPriors,
} from "../src/beliefs/priors.js";
import { BeliefStore } from "../src/beliefs/store.js";
import { allContracts, contractEntryById } from "../src/contracts/index.js";
import { SUSPECTED_CLASS, suspectedClassOf } from "../src/contracts/priors-map.js";
import type { CompleteRequest, CompleteResult, LlmLike } from "../src/llm/client.js";
import { comparePriorArms, comparePriors } from "../src/reflect/compare-priors.js";
import { notarize } from "../src/reflect/notarize.js";
import type { ProbeIo } from "../src/reflect/templates/index.js";
import type { Anomaly, Belief, BeliefStatus, Claim, DefectClass, RunBundle, Tool } from "../src/schema/index.js";
import { NotaryDb } from "../src/store/db.js";
import { CreditLedger } from "../src/tools/index.js";
import type { Exchange } from "../src/tools/index.js";

const T0 = "2026-10-10T12:00:00.000Z";

function claimOf(id: string): Claim {
  const e = contractEntryById(id);
  if (!e) throw new Error(`no claim ${id}`);
  return e.claim;
}

/** Test belief: violated (Beta(1,4), class cls) or honored (Beta(4,1)). */
function belief(claimId: string, status: BeliefStatus, side: "honored" | "violated", cls?: DefectClass): Belief {
  const [alpha, beta] = side === "honored" ? [4, 1] : [1, 4];
  return {
    id: `belief-${claimId}`,
    claimId,
    tool: claimId.split(".")[0] as Tool,
    ...(side === "honored" ? { class: "honored" as const } : cls ? { class: cls } : {}),
    statement: "test belief",
    alpha,
    beta,
    confidence: pHolds(alpha, beta),
    status,
    evidence: [],
    updatedAt: T0,
  };
}

// A hand-built crustdata outcome (test data, not a run):
//   silent_coercion: headcount violated, funding honored, date violated (candidate) -> 2/3
//   silent_truncation: max-25 violated -> 1/1
//   honored controls: default-fields honored (balance abstained: not settled) -> 0/1
//   not settled: no-match hypothesis, invalid-fields unlearned
const SOURCE: Belief[] = [
  belief("crustdata.enrich.headcount-total-integer", "notarized", "violated", "silent_coercion"),
  belief("crustdata.enrich.funding-total-investment-number", "notarized", "honored"),
  belief("crustdata.enrich.last-fundraise-date-string", "candidate", "violated", "silent_coercion"),
  belief("crustdata.identify.max-25-identifiers", "notarized", "violated", "silent_truncation"),
  belief("crustdata.enrich.default-fields-basic-info", "notarized", "honored"),
  belief("crustdata.credits.balance-number", "abstained", "violated", "silent_coercion"),
  belief("crustdata.enrich.no-match-200-empty", "hypothesis", "violated", "mislabelled_semantics"),
  belief("crustdata.identify.invalid-fields-400", "unlearned", "violated", "undocumented_flag"),
];

const DODO_TARGETS = [
  "dodo.refunds.page-size-max-100", // silent_truncation
  "dodo.refunds.amount-integer", // silent_coercion
  "dodo.product.price-minor-units", // honored (control)
  "dodo.refund.amount-minor-units", // unit_mismatch: no crustdata evidence
  "dodo.payment.refunds-lists-issued-refund", // eventual_consistency: no crustdata evidence
].map(claimOf);

describe("suspected-class map", () => {
  it("has exactly one entry per contract claim (both tools)", () => {
    expect(Object.keys(SUSPECTED_CLASS).sort()).toEqual(allContracts.map((e) => e.claim.id).sort());
    expect(suspectedClassOf("dodo.refunds.page-size-max-100")).toBe("silent_truncation");
    expect(suspectedClassOf("no.such.claim")).toBeUndefined();
  });
});

describe("transferPriors: base rates", () => {
  it("counts only notarized/candidate beliefs; rate = settled violations of the class / settled relevant beliefs", () => {
    const settled = SOURCE.filter((b) => b.status === "notarized" || b.status === "candidate");
    expect(baseRates(settled)).toEqual({
      honored: { settled: 1, violated: 0, rate: 0 },
      silent_coercion: { settled: 3, violated: 2, rate: 0.666666667 },
      silent_truncation: { settled: 1, violated: 1, rate: 1 },
    });
    const r = transferPriors({ sourceBeliefs: SOURCE, targetClaims: DODO_TARGETS });
    expect(r.from).toBe("crustdata");
    expect(r.settledSource).toBe(5);
    expect(r.strength).toBe(DEFAULT_PRIOR_STRENGTH);
  });

  it("a belief that settled on a class other than its suspected one counts for both classes", () => {
    const r = baseRates([belief("crustdata.enrich.employee-count-range-string", "notarized", "violated", "silent_coercion")]);
    expect(r).toEqual({
      mislabelled_semantics: { settled: 1, violated: 0, rate: 0 },
      silent_coercion: { settled: 1, violated: 1, rate: 1 },
    });
  });

  it("prior = Beta(1 + s(1-r), 1 + s*r) with default strength 2; no evidence -> Beta(1, 1)", () => {
    const r = transferPriors({ sourceBeliefs: SOURCE, targetClaims: DODO_TARGETS });
    expect(r.priors).toEqual({
      "dodo.refunds.page-size-max-100": { alpha: 1, beta: 3, from: "crustdata" },
      "dodo.refunds.amount-integer": { alpha: 1.666666666, beta: 2.333333334, from: "crustdata" },
      "dodo.product.price-minor-units": { alpha: 3, beta: 1, from: "crustdata" },
      "dodo.refund.amount-minor-units": { alpha: 1, beta: 1, from: "crustdata" },
      "dodo.payment.refunds-lists-issued-refund": { alpha: 1, beta: 1, from: "crustdata" },
    });
    expect(r.perClaim.filter((p) => !p.informative).map((p) => p.claimId)).toEqual([
      "dodo.payment.refunds-lists-issued-refund",
      "dodo.refund.amount-minor-units",
    ]);
    expect(r.perClaim.find((p) => p.claimId === "dodo.refund.amount-minor-units")!.basis).toMatch(/no settled crustdata belief relevant to unit_mismatch/);
  });

  it("strength scales the pseudo-counts", () => {
    const r = transferPriors({ sourceBeliefs: SOURCE, targetClaims: DODO_TARGETS, strength: 1 });
    expect(r.priors["dodo.refunds.page-size-max-100"]).toEqual({ alpha: 1, beta: 2, from: "crustdata" });
    expect(r.priors["dodo.product.price-minor-units"]).toEqual({ alpha: 2, beta: 1, from: "crustdata" });
    expect(r.priors["dodo.refund.amount-minor-units"]).toEqual({ alpha: 1, beta: 1, from: "crustdata" });
    expect(() => transferPriors({ sourceBeliefs: SOURCE, targetClaims: DODO_TARGETS, strength: 0 })).toThrow(/positive/);
  });

  it("NOTARY_PRIOR_STRENGTH: a positive number up to the max, default 2", () => {
    expect(priorStrengthFromEnv({})).toBe(2);
    expect(priorStrengthFromEnv({ NOTARY_PRIOR_STRENGTH: "2" })).toBe(2);
    expect(priorStrengthFromEnv({ NOTARY_PRIOR_STRENGTH: "0.5" })).toBe(0.5);
    for (const bad of ["0", "-1", "x", " "]) expect(priorStrengthFromEnv({ NOTARY_PRIOR_STRENGTH: bad })).toBe(2);
  });

  it("P9 AUDIT-22: prior strength is bounded so two contrary probes always outweigh the prior", () => {
    expect(MAX_PRIOR_STRENGTH).toBe(2);
    // Over the bound is refused loudly, never silently clamped.
    for (const big of ["2.5", "4", "100"]) expect(() => priorStrengthFromEnv({ NOTARY_PRIOR_STRENGTH: big })).toThrow(RangeError);
    for (const big of [2.000001, 4, 100]) expect(() => transferPriors({ sourceBeliefs: SOURCE, targetClaims: DODO_TARGETS, strength: big })).toThrow(/at most 2/);
    // At the strongest allowed prior, two probes against it bring P(holds) back to 0.5 or past it.
    const r = transferPriors({ sourceBeliefs: SOURCE, targetClaims: DODO_TARGETS, strength: MAX_PRIOR_STRENGTH });
    const p = r.priors["dodo.refunds.page-size-max-100"]!; // violated-leaning prior Beta(1, 3)
    expect(pHolds(p.alpha + 2, p.beta)).toBeGreaterThanOrEqual(0.5);
    const q = r.priors["dodo.product.price-minor-units"]!; // honored-leaning prior Beta(3, 1)
    expect(pHolds(q.alpha, q.beta + 2)).toBeLessThanOrEqual(0.5);
  });

  it("no settled source beliefs -> every prior is Beta(1, 1); other tools' beliefs are ignored", () => {
    const none = transferPriors({ sourceBeliefs: [], targetClaims: DODO_TARGETS, from: "crustdata" });
    expect(Object.values(none.priors).every((p) => p.alpha === 1 && p.beta === 1)).toBe(true);
    expect(none.perClaim.every((p) => !p.informative)).toBe(true);
    const mixed = transferPriors({
      sourceBeliefs: [...SOURCE, belief("dodo.refunds.page-size-max-100", "notarized", "honored")],
      targetClaims: DODO_TARGETS,
      from: "crustdata",
    });
    expect(mixed.priors).toEqual(transferPriors({ sourceBeliefs: SOURCE, targetClaims: DODO_TARGETS }).priors);
    expect(() => transferPriors({ sourceBeliefs: [], targetClaims: DODO_TARGETS })).toThrow(/no `from` tool/);
  });

  it("is deterministic: input order does not change the output", () => {
    const a = transferPriors({ sourceBeliefs: SOURCE, targetClaims: DODO_TARGETS });
    const b = transferPriors({ sourceBeliefs: [...SOURCE].reverse(), targetClaims: [...DODO_TARGETS].reverse() });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("BeliefStore.ensure records the prior on Belief.prior and starts from it", () => {
    const db = new NotaryDb(":memory:");
    try {
      const store = new BeliefStore(db);
      const { priors } = transferPriors({ sourceBeliefs: SOURCE, targetClaims: DODO_TARGETS });
      const b = store.ensure(claimOf("dodo.refunds.page-size-max-100"), priors["dodo.refunds.page-size-max-100"]);
      expect(b).toMatchObject({ alpha: 1, beta: 3, prior: { alpha: 1, beta: 3, from: "crustdata" }, status: "hypothesis" });
      expect(b.confidence).toBeCloseTo(0.125, 12);
      expect(store.events(b.id)[0]!.reason).toBe("created from transfer prior Beta(1, 3) (from crustdata)");
    } finally {
      db.close();
    }
  });
});

describe("probes-to-candidate metrics", () => {
  it("per claim (null if never reached) and the mean over claims that reached candidate", () => {
    const b1 = { ...belief("dodo.refunds.page-size-max-100", "candidate", "violated", "silent_truncation"), probesToCandidate: 2 };
    const b2 = { ...belief("dodo.refunds.amount-integer", "notarized", "honored"), probesToCandidate: 3 };
    const b3 = belief("dodo.product.price-minor-units", "abstained", "violated");
    const m = probesToCandidateMetrics([b1, b2, b3], ["dodo.refunds.page-size-max-100", "dodo.refunds.amount-integer", "dodo.product.price-minor-units", "dodo.refund.amount-minor-units"]);
    expect(m).toEqual({
      perClaim: {
        "dodo.product.price-minor-units": null,
        "dodo.refund.amount-minor-units": null,
        "dodo.refunds.amount-integer": 3,
        "dodo.refunds.page-size-max-100": 2,
      },
      mean: 2.5,
      reached: 2,
    });
    expect(probesToCandidateMetrics([], ["x"]).mean).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Source bundle lookup

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const ZERO = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };

/** A minimal TEST notarize bundle (hand-built; never a run result). */
function testBundle(runId: string, tool: Tool, startedAt: string, beliefs: Belief[]): RunBundle {
  return finalizeBundle({
    runId,
    kind: "notarize",
    variant: "notarize",
    mode: "replay",
    sample: false,
    disclosure: ["TEST bundle built in test/priors.test.ts"],
    startedAt,
    finishedAt: startedAt,
    status: "completed",
    seed: 0,
    tool,
    queue: [],
    decisions: [],
    claims: [],
    anomalies: [],
    hypotheses: [],
    probes: [],
    beliefs: { before: [], after: beliefs },
    beliefEvents: [],
    guards: [],
    usageByRole: { executor: ZERO, reflector: ZERO, adversary: ZERO },
    credits: { byEndpoint: {}, total: 0, budget: 0 },
    metrics: {},
    traceLinks: {},
    cassettes: [],
  });
}

describe("loadPriorsSource", () => {
  it("no bundle -> the BLOCKED line", () => {
    const runs = tempDir("notary-priors-");
    expect(loadPriorsSource({ tool: "crustdata", runsDir: runs })).toEqual({
      blocked: "BLOCKED: no notarize bundle for crustdata — run notarize --tool crustdata first",
      notes: [],
    });
    expect(loadPriorsSource({ tool: "crustdata", runsDir: join(runs, "missing") }).blocked).toMatch(/^BLOCKED: no notarize bundle for crustdata/);
  });

  it("picks the newest verified notarize bundle of the tool that has beliefs", async () => {
    const runs = tempDir("notary-priors-");
    const put = async (b: RunBundle) => (await writeBundle(b, join(runs, b.runId))).bundlePath;
    await put(testBundle("notarize-crustdata-old", "crustdata", "2026-10-10T08:00:00.000Z", SOURCE));
    await put(testBundle("notarize-crustdata-new", "crustdata", "2026-10-10T09:00:00.000Z", SOURCE.slice(0, 2)));
    await put(testBundle("recon-crustdata-newest", "crustdata", "2026-10-10T10:00:00.000Z", [])); // recon-only: no beliefs
    await put(testBundle("compare-priors-crustdata-x", "crustdata", "2026-10-10T11:00:00.000Z", SOURCE)); // a measurement
    await put(testBundle("notarize-dodo-new", "dodo", "2026-10-10T12:00:00.000Z", [belief("dodo.refunds.amount-integer", "notarized", "honored")]));
    const tampered = await put(testBundle("notarize-crustdata-tampered", "crustdata", "2026-10-10T13:00:00.000Z", SOURCE));
    const raw = JSON.parse(readFileSync(tampered, "utf8")) as RunBundle;
    raw.beliefs.after = raw.beliefs.after.slice(0, 1);
    writeFileSync(tampered, JSON.stringify(raw));

    const src = loadPriorsSource({ tool: "crustdata", runsDir: runs });
    expect(src.blocked).toBeUndefined();
    expect(src.bundle!.runId).toBe("notarize-crustdata-new");
    expect(src.notes.join("\n")).toMatch(/content hash mismatch for notarize-crustdata-tampered/);

    const explicit = loadPriorsSource({ tool: "crustdata", runsDir: runs, bundlePath: join(runs, "notarize-crustdata-old", "notarize-crustdata-old.json") });
    expect(explicit.bundle!.runId).toBe("notarize-crustdata-old");
    const wrongTool = loadPriorsSource({ tool: "crustdata", runsDir: runs, bundlePath: join(runs, "notarize-dodo-new", "notarize-dodo-new.json") });
    expect(wrongTool.blocked).toMatch(/is not a notarize bundle for crustdata/);
  });
});

describe("notarize --priors-from / --compare-priors gating", () => {
  it("missing source bundle -> BLOCKED (exit 3), listed with any other BLOCKED reason", async () => {
    const runs = tempDir("notary-priors-");
    const r = await notarize({ tool: "dodo", priorsFrom: "crustdata", env: {}, dbPath: ":memory:", runsDir: runs });
    expect(r.exitCode).toBe(3);
    expect(r.status).toBe("blocked");
    expect(r.lines).toEqual([
      "BLOCKED: no notarize bundle for crustdata — run notarize --tool crustdata first",
      "BLOCKED: DODO_PAYMENTS_API_KEY not set",
      "BLOCKED: NOTARY_MODEL_REFLECTOR not set",
      "BLOCKED: AWS_REGION not set",
    ]);
  });

  it("priors from the same tool are refused", async () => {
    const r = await notarize({ tool: "dodo", priorsFrom: "dodo", env: {}, dbPath: ":memory:", runsDir: tempDir("notary-priors-") });
    expect(r).toMatchObject({ exitCode: 1, status: "failed" });
  });

  it("--compare-priors without a replay cassette -> BLOCKED (exit 3)", async () => {
    const runs = tempDir("notary-priors-");
    const cassettes = tempDir("notary-cassettes-");
    const r = await comparePriors({ tool: "dodo", env: {}, runsDir: runs, cassetteDir: cassettes });
    expect(r.exitCode).toBe(3);
    expect(r.lines[0]).toBe(`BLOCKED: no replay cassette recon-dodo, probes-dodo in ${cassettes} — record one with a live notarize --tool dodo run first`);
    expect(r.lines).toContain("BLOCKED: no notarize bundle for crustdata — run notarize --tool crustdata first");
  });
});

// ---------------------------------------------------------------------------------------------
// Measurement mechanics: both arms over the same fake tool (TEST doubles, not a real-world result)

/** Fake Dodo product API that echoes price.price x100 (a unit mismatch), as exchanges. */
class EchoIo implements ProbeIo {
  calls = 0;
  async call(op: string, args: unknown[]): Promise<Exchange[]> {
    this.calls += 1;
    const p = args[0] as { price: { price: number } };
    return [
      {
        id: `ex-${this.calls}`,
        tool: "dodo",
        op,
        method: "POST",
        url: `https://test.example/${op}`,
        requestHeaders: {},
        requestBody: p,
        status: 200,
        responseHeaders: {},
        responseBody: { price: { price: p.price.price * 100 } },
        latencyMs: 1,
        credits: null,
        recordedAt: T0,
        requestHash: `h-${this.calls}`,
        occurrence: 0,
      },
    ];
  }
  async sleep(): Promise<void> {}
}

/** Fake reflector with one scripted reply: rivals honored vs unit_mismatch for every anomaly. */
class OneReplyLlm implements LlmLike {
  readonly requests: CompleteRequest[] = [];
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.requests.push(req);
    const text = req.messages.map((m) => m.content).join("\n");
    const ids = [...new Set([...text.matchAll(/"anomalyId":\s*"([^"]+)"/g)].map((m) => m[1]!))];
    const reply = {
      anomalies: ids.map((anomalyId) => ({
        anomalyId,
        hypotheses: (["honored", "unit_mismatch"] as const).map((cls) => ({ class: cls, statement: `${cls} explains ${anomalyId}`, distinguishingTest: "unit_roundtrip" })),
      })),
    };
    return { text: JSON.stringify(reply), inputTokens: 100, outputTokens: 50, usd: 0.001, modelId: "fake", stopReason: "end_turn" };
  }
}

describe("comparePriorArms (fake tools)", () => {
  const claim = claimOf("dodo.product.price-minor-units");
  const anomaly: Anomaly = { id: "anom-1", claimId: claim.id, tool: "dodo", observed: {}, expected: {}, traceId: "", spanId: "" };
  const arms = (prior: { alpha: number; beta: number }, llm: LlmLike) =>
    comparePriorArms({
      tool: "dodo",
      claims: [claim],
      anomalies: [anomaly],
      llm,
      priors: { [claim.id]: { ...prior, from: "crustdata" } },
      runId: "cmp-test",
      io: () => new EchoIo(),
      ledger: () => new CreditLedger({ budget: 10 }),
    });

  it("a prior on the side the evidence falls measures fewer probes to candidate (3 -> 2)", async () => {
    const llm = new OneReplyLlm();
    const r = await arms({ alpha: 1, beta: 3 }, llm);
    // From Beta(1,1): 3 violations -> Beta(1,4) = 0.0625. From Beta(1,3): 2 -> Beta(1,5), 2 independent probes.
    expect(r.without.perClaim[claim.id]).toBe(3);
    expect(r.with.perClaim[claim.id]).toBe(2);
    expect(r.metrics).toMatchObject({
      probes_to_candidate_without_priors: 3,
      probes_to_candidate_with_priors: 2,
      [`probes_to_candidate_without_priors_${claim.id}`]: 3,
      [`probes_to_candidate_with_priors_${claim.id}`]: 2,
      candidates_without_priors: 1,
      candidates_with_priors: 1,
      probes_without_priors: 3,
      probes_with_priors: 2,
      paired_claims: 1,
    });
    // The reflector was asked once; the second arm got the same rivals from the memo.
    expect(llm.requests).toHaveLength(1);
    // Replay alignment: the with-priors arm reuses the without-priors arm's probe ids (and tags).
    expect(r.with.probes.map((p) => p.id)).toEqual(r.without.probes.slice(0, 2).map((p) => p.id));
    expect(r.with.before[0]!.prior).toEqual({ alpha: 1, beta: 3, from: "crustdata" });
  });

  it("a prior on the wrong side can cost probes: it is measured, not assumed (never reached -> null)", async () => {
    const r = await arms({ alpha: 3, beta: 1 }, new OneReplyLlm());
    expect(r.without.perClaim[claim.id]).toBe(3);
    // Beta(3,1) + 5 violations = Beta(3,6) (P(holds) 0.14): the per-claim cap (5) ends it before
    // candidate (unit_roundtrip has 6 amount designs since DECISIONS #100, so the cap binds, not the designs).
    expect(r.with.perClaim[claim.id]).toBeNull();
    expect(r.with.after[0]).toMatchObject({ alpha: 3, beta: 6, status: "abstained" });
    expect(r.metrics.probes_to_candidate_with_priors).toBeNull();
    expect(r.metrics.paired_claims).toBe(0);
  });
});
