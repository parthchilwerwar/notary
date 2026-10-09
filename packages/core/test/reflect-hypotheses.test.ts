/**
 * Reflector (batched hypotheses) tests. The claims, anomalies and model replies here are hand-built
 * TEST DATA; the Bedrock transport is a TEST DOUBLE returning canned text. Nothing reaches AWS.
 */
import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { LlmClient } from "../src/llm/index.js";
import type { ConverseTransport } from "../src/llm/index.js";
import {
  extractJson,
  hypothesisId,
  parseHypothesesReply,
  proposeHypotheses,
  reproposeAfterRefutation,
} from "../src/reflect/hypotheses.js";
import { HypothesisSchema } from "../src/schema/hypothesis.js";
import type { Anomaly, Claim, Hypothesis } from "../src/schema/index.js";

const ENV = {
  AWS_REGION: "us-east-1",
  NOTARY_MODEL_REFLECTOR: "anthropic.claude-sonnet-4-20250514-v1:0",
  NOTARY_MODEL_ADVERSARY: "anthropic.claude-opus-4-1-20250805-v1:0",
};

const claimA: Claim = {
  id: "test-claim-page-size",
  tool: "dodo",
  operation: "listRefunds",
  param: "page_size",
  docText: "test doc text: page_size up to 100",
  expect: { kind: "maxItems", max: 100 },
  docUrl: "https://example.test/docs",
};
const claimB: Claim = {
  id: "test-claim-unknown-param",
  tool: "crustdata",
  operation: "enrich",
  param: "bogus",
  docText: "test doc text: unknown params are rejected",
  expect: { kind: "errorOnUnknownParam" },
  docUrl: "https://example.test/docs2",
};

function anomaly(id: string, claimId: string): Anomaly {
  return { id, claimId, tool: "dodo", observed: { count: 50 }, expected: { max: 100 }, traceId: "", spanId: "" };
}
const anA = anomaly("test-an-a", claimA.id);
const anB = anomaly("test-an-b", claimB.id);
const anC = anomaly("test-an-c", claimA.id);

/** Test double transport: returns the given texts in order and records the requests. */
function scripted(...texts: string[]) {
  const calls: ConverseCommandInput[] = [];
  const transport: ConverseTransport = async (input) => {
    calls.push(input);
    const text = texts[Math.min(calls.length - 1, texts.length - 1)] ?? "";
    return {
      output: { message: { role: "assistant", content: [{ text }] } },
      usage: { inputTokens: 500, outputTokens: 300, totalTokens: 800 },
      stopReason: "end_turn",
      metrics: { latencyMs: 1 },
      $metadata: {},
    } as ConverseCommandOutput;
  };
  return { llm: new LlmClient({ env: ENV, transport }), calls };
}

const goodEntry = (anomalyId: string) => ({
  anomalyId,
  hypotheses: [
    { class: "silent_truncation", statement: "Server caps pages at 50.", distinguishingTest: "boundary_sweep" },
    { class: "honored", statement: "Only 50 refunds exist.", distinguishingTest: "pagination_completeness" },
  ],
});

describe("extractJson", () => {
  it("finds JSON wrapped in prose and code fences", () => {
    expect(extractJson('Sure! Here you go:\n```json\n{"a":[1,{"b":"}"}]}\n```\nHope that helps.')).toEqual({
      a: [1, { b: "}" }],
    });
  });
  it("returns undefined when there is no JSON", () => {
    expect(extractJson("no json here { not: valid")).toBeUndefined();
  });
});

describe("proposeHypotheses", () => {
  it("makes ONE reflector call for N anomalies and parses valid JSON", async () => {
    const reply = JSON.stringify({ anomalies: [goodEntry(anA.id), goodEntry(anB.id), goodEntry(anC.id)] });
    const { llm, calls } = scripted(reply);
    const res = await proposeHypotheses({ anomalies: [anA, anB, anC], claims: [claimA, claimB], llm });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.inferenceConfig?.temperature).toBe(0);
    const prompt = calls[0]!.messages![0]!.content![0]!;
    expect("text" in prompt && prompt.text).toContain(anB.id);
    expect(res.rejected).toEqual([]);
    expect(res.hypotheses).toHaveLength(6);
    for (const h of res.hypotheses) expect(HypothesisSchema.parse(h)).toEqual(h);
    expect(res.usage).toMatchObject({ inputTokens: 500, outputTokens: 300, calls: 1 });
    expect(llm.meter.snapshot().reflector.calls).toBe(1);
  });

  it("extracts prose-wrapped JSON (and ignores a stray bracket in the prose)", async () => {
    const reply = `Here are my hypotheses [1]:\n\`\`\`json\n${JSON.stringify({ anomalies: [goodEntry(anA.id)] })}\n\`\`\``;
    const { llm } = scripted(reply);
    const res = await proposeHypotheses({ anomalies: [anA], claims: [claimA], llm });
    expect(res.rejected).toEqual([]);
    expect(res.hypotheses.map((h) => h.class)).toEqual(["silent_truncation", "honored"]);
  });

  it("fails safe on malformed output: every anomaly rejected, no throw", async () => {
    const { llm } = scripted("I think the API is broken. {anomalies: [oops");
    const res = await proposeHypotheses({ anomalies: [anA, anB], claims: [claimA, claimB], llm });
    expect(res.hypotheses).toEqual([]);
    expect(res.rejected.map((r) => r.anomalyId)).toEqual([anA.id, anB.id]);
    expect(res.rejected[0]!.reason).toMatch(/malformed output/);
  });

  it("partial output: valid anomalies kept, missing/invalid ones rejected", async () => {
    const bad = {
      anomalyId: anB.id,
      hypotheses: [{ class: "silent_truncation", statement: "x" }], // missing test, and only one
    };
    const { llm } = scripted(JSON.stringify({ anomalies: [goodEntry(anA.id), bad] }));
    const res = await proposeHypotheses({ anomalies: [anA, anB, anC], claims: [claimA, claimB], llm });
    expect(new Set(res.hypotheses.map((h) => h.anomalyId))).toEqual(new Set([anA.id]));
    const reasons = Object.fromEntries(res.rejected.map((r) => [r.anomalyId, r.reason]));
    expect(reasons[anB.id]).toMatch(/at least 2/);
    expect(reasons[anC.id]).toMatch(/no valid entry/);
  });

  it("rejects rivals that share a single defect class", async () => {
    const same = {
      anomalyId: anA.id,
      hypotheses: [
        { class: "silent_truncation", statement: "cap at 50", distinguishingTest: "boundary_sweep" },
        { class: "silent_truncation", statement: "cap varies", distinguishingTest: "pagination_completeness" },
      ],
    };
    const { llm } = scripted(JSON.stringify({ anomalies: [same] }));
    const res = await proposeHypotheses({ anomalies: [anA], claims: [claimA], llm });
    expect(res.hypotheses).toEqual([]);
    expect(res.rejected[0]!.reason).toMatch(/2 distinct defect classes/);
  });

  it("rejects an unknown defect class or probe template", async () => {
    const unknownClass = {
      anomalyId: anA.id,
      hypotheses: [
        { class: "cosmic_rays", statement: "bit flip", distinguishingTest: "boundary_sweep" },
        { class: "honored", statement: "fine", distinguishingTest: "pagination_completeness" },
      ],
    };
    const unknownTemplate = {
      anomalyId: anB.id,
      hypotheses: [
        { class: "undocumented_flag", statement: "ignored", distinguishingTest: "ask_support" },
        { class: "honored", statement: "fine", distinguishingTest: "unknown_param" },
      ],
    };
    const { llm } = scripted(JSON.stringify({ anomalies: [unknownClass, unknownTemplate] }));
    const res = await proposeHypotheses({ anomalies: [anA, anB], claims: [claimA, claimB], llm });
    expect(res.hypotheses).toEqual([]);
    expect(res.rejected.find((r) => r.anomalyId === anA.id)!.reason).toMatch(/class/);
    expect(res.rejected.find((r) => r.anomalyId === anB.id)!.reason).toMatch(/distinguishingTest/);
  });

  it("rejects more than maxPerAnomaly and duplicate entries", async () => {
    const four = {
      anomalyId: anA.id,
      hypotheses: [
        { class: "silent_truncation", statement: "a", distinguishingTest: "boundary_sweep" },
        { class: "honored", statement: "b", distinguishingTest: "pagination_completeness" },
        { class: "rate_limit", statement: "c", distinguishingTest: "header_burst" },
        { class: "expiry", statement: "d", distinguishingTest: "write_then_read" },
      ],
    };
    const { llm } = scripted(JSON.stringify({ anomalies: [four, goodEntry(anB.id), goodEntry(anB.id)] }));
    const res = await proposeHypotheses({ anomalies: [anA, anB], claims: [claimA, claimB], llm });
    expect(res.hypotheses).toEqual([]);
    expect(res.rejected.find((r) => r.anomalyId === anA.id)!.reason).toMatch(/at most 3/);
    expect(res.rejected.find((r) => r.anomalyId === anB.id)!.reason).toMatch(/ambiguous/);
  });

  it("produces deterministic ids", async () => {
    const reply = JSON.stringify({ anomalies: [goodEntry(anA.id)] });
    const r1 = await proposeHypotheses({ anomalies: [anA], claims: [claimA], llm: scripted(reply).llm });
    const r2 = await proposeHypotheses({ anomalies: [anA], claims: [claimA], llm: scripted(reply).llm });
    expect(r1.hypotheses.map((h) => h.id)).toEqual(r2.hypotheses.map((h) => h.id));
    expect(r1.hypotheses[0]!.id).toBe(hypothesisId(anA.id, "silent_truncation", "boundary_sweep"));
    expect(r1.hypotheses[0]!.id).toMatch(/^hyp-[0-9a-f]{12}$/);
    expect(hypothesisId(anB.id, "silent_truncation", "boundary_sweep")).not.toBe(r1.hypotheses[0]!.id);
  });

  it("makes no call when there are no anomalies, and rejects anomalies whose claim is unknown", async () => {
    const { llm, calls } = scripted("unused");
    const res = await proposeHypotheses({ anomalies: [anomaly("test-orphan", "nope")], claims: [claimA], llm });
    expect(calls).toHaveLength(0);
    expect(res.rejected).toEqual([{ anomalyId: "test-orphan", reason: "claim nope not found" }]);
    expect(res.usage.calls).toBe(0);
  });

  it("propagates BLOCKED from the client (not swallowed as malformed output)", async () => {
    const transport: ConverseTransport = async () => {
      throw new Error("test double: must not be reached");
    };
    const llm = new LlmClient({ env: { ...ENV, NOTARY_MODEL_REFLECTOR: "" }, transport });
    await expect(proposeHypotheses({ anomalies: [anA], claims: [claimA], llm })).rejects.toThrow(
      "BLOCKED: NOTARY_MODEL_REFLECTOR not set",
    );
  });
});

describe("parseHypothesesReply", () => {
  it("accepts a bare array of entries and ignores unrequested anomaly ids", () => {
    const text = JSON.stringify([goodEntry(anA.id), goodEntry("test-not-asked")]);
    const res = parseHypothesesReply(text, [anA.id]);
    expect(res.rejected).toEqual([]);
    expect(res.hypotheses.every((h) => h.anomalyId === anA.id)).toBe(true);
  });

  it("notes a max_tokens cut-off in the rejection reason", () => {
    const res = parseHypothesesReply('{"anomalies":[{"anomalyId":"test-an-a","hypo', [anA.id], { stopReason: "max_tokens" });
    expect(res.rejected[0]!.reason).toMatch(/max_tokens/);
  });
});

describe("reproposeAfterRefutation", () => {
  const refuted: Hypothesis[] = [
    { id: hypothesisId(anA.id, "silent_truncation", "boundary_sweep"), anomalyId: anA.id, class: "silent_truncation", statement: "cap at 50", distinguishingTest: "boundary_sweep" },
    { id: hypothesisId(anA.id, "honored", "pagination_completeness"), anomalyId: anA.id, class: "honored", statement: "only 50 exist", distinguishingTest: "pagination_completeness" },
  ];

  it("makes one call with the refutation as evidence and returns new rivals", async () => {
    const fresh = {
      anomalyId: anA.id,
      hypotheses: [
        { class: "undocumented_flag", statement: "page_size ignored without a sort param", distinguishingTest: "unknown_param" },
        { class: "honored", statement: "cap depends on test-mode data volume", distinguishingTest: "write_then_read" },
      ],
    };
    const { llm, calls } = scripted(JSON.stringify({ anomalies: [fresh] }));
    const res = await reproposeAfterRefutation({ anomaly: anA, claim: claimA, refuted, evidence: { probe: "test-probe-1", observed: 50 }, llm });
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages![0]!.content![0]!;
    expect("text" in prompt && prompt.text).toContain("test-probe-1");
    expect(res.rejected).toEqual([]);
    expect(res.hypotheses.map((h) => h.class)).toEqual(["undocumented_flag", "honored"]);
  });

  it("rejects a reply that repeats a refuted hypothesis", async () => {
    const { llm } = scripted(JSON.stringify({ anomalies: [goodEntry(anA.id)] }));
    const res = await reproposeAfterRefutation({ anomaly: anA, claim: claimA, refuted, evidence: {}, llm });
    expect(res.hypotheses).toEqual([]);
    expect(res.rejected[0]!.reason).toMatch(/repeats a refuted hypothesis/);
  });

  it("fails safe on garbage", async () => {
    const { llm } = scripted("¯\\_(ツ)_/¯");
    const res = await reproposeAfterRefutation({ anomaly: anA, claim: claimA, refuted, evidence: {}, llm });
    expect(res.hypotheses).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.usage.calls).toBe(1);
  });
});
