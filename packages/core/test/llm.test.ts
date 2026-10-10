/**
 * LLM client tests. The Bedrock transport is a TEST DOUBLE: it returns hand-built Converse replies
 * and never touches AWS. Model ids below are labels for the test roster, not real calls.
 */
import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import {
  LlmClient,
  ModelConfigError,
  PRICE_TABLE,
  UsageMeter,
  costUsd,
  resolveModels,
  resolvePrice,
} from "../src/llm/index.js";
import type { ConverseTransport } from "../src/llm/index.js";
import { UsageByRoleSchema } from "../src/schema/bundle.js";
import { MissingCredentialError, isBlocked } from "../src/tools/errors.js";

const SONNET = "anthropic.claude-sonnet-4-20250514-v1:0"; // $3 / $15 per 1M in the table
const OPUS = "anthropic.claude-opus-4-1-20250805-v1:0"; // $15 / $75 per 1M in the table
const HAIKU45 = "anthropic.claude-haiku-4-5-20251001-v1:0"; // $1 / $5 per 1M, +10% off global

const ENV = {
  AWS_REGION: "us-east-1",
  NOTARY_MODEL_EXECUTOR: "test-executor-model",
  NOTARY_MODEL_REFLECTOR: SONNET,
  NOTARY_MODEL_ADVERSARY: OPUS,
};

/** Test double: records every Converse input and answers with a fixed fake reply. */
function fakeTransport(reply: { text?: string; inputTokens?: number; outputTokens?: number; stopReason?: string } = {}) {
  const calls: ConverseCommandInput[] = [];
  const transport: ConverseTransport = async (input) => {
    calls.push(input);
    return {
      output: { message: { role: "assistant", content: [{ text: reply.text ?? "fake reply" }] } },
      usage: { inputTokens: reply.inputTokens ?? 1000, outputTokens: reply.outputTokens ?? 200, totalTokens: 0 },
      stopReason: reply.stopReason ?? "end_turn",
      metrics: { latencyMs: 1 },
      $metadata: {},
    } as ConverseCommandOutput;
  };
  return { transport, calls };
}

describe("roles", () => {
  it("reads the three roles from env and treats empty as unset", () => {
    expect(resolveModels({ ...ENV, NOTARY_MODEL_EXECUTOR: "  " })).toEqual({
      executor: undefined,
      reflector: SONNET,
      adversary: OPUS,
    });
  });

  it("rejects a reflector and adversary on the same model (separation of duties)", () => {
    expect(() => resolveModels({ ...ENV, NOTARY_MODEL_ADVERSARY: SONNET })).toThrow(ModelConfigError);
    // a cross-region profile of the same model is still the same model
    expect(() => resolveModels({ ...ENV, NOTARY_MODEL_ADVERSARY: `us.${SONNET}` })).toThrow(/Separation of duties/);
    expect(() => new LlmClient({ env: { ...ENV, NOTARY_MODEL_ADVERSARY: SONNET } })).toThrow(ModelConfigError);
  });

  it("is BLOCKED only when a missing role is actually used", async () => {
    const { transport, calls } = fakeTransport();
    const llm = new LlmClient({ env: { ...ENV, NOTARY_MODEL_REFLECTOR: "" }, transport });
    // executor still works
    await llm.complete({ role: "executor", messages: [{ role: "user", content: "hi" }] });
    const err = await llm.complete({ role: "reflector", messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(MissingCredentialError);
    expect(isBlocked(err)).toBe(true);
    expect((err as Error).message).toBe("BLOCKED: NOTARY_MODEL_REFLECTOR not set — set it in .env (see .env.example) and run `pnpm notary doctor --llm`");
    expect(calls).toHaveLength(1);
  });

  it("is BLOCKED without AWS_REGION when using the real transport", async () => {
    const llm = new LlmClient({ env: { ...ENV, AWS_REGION: "" } });
    await expect(llm.complete({ role: "reflector", messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      "BLOCKED: AWS_REGION not set",
    );
  });
});

describe("pricing", () => {
  it("uses the table, with the 10% regional premium only for Claude 4.5+ off global endpoints", () => {
    expect(resolvePrice("reflector", SONNET, {})).toEqual({ price: { inPerM: 3, outPerM: 15 }, source: "table" });
    expect(resolvePrice("reflector", `us.${SONNET}`, {}).price).toEqual({ inPerM: 3, outPerM: 15 });
    expect(resolvePrice("executor", `global.${HAIKU45}`, {}).price).toEqual({ inPerM: 1, outPerM: 5 });
    const regional = resolvePrice("executor", `us.${HAIKU45}`, {}).price!;
    expect(regional.inPerM).toBeCloseTo(1.1);
    expect(regional.outPerM).toBeCloseTo(5.5);
    expect(Object.keys(PRICE_TABLE).length).toBeGreaterThan(0);
  });

  it("prefers per-role env overrides", () => {
    const env = { NOTARY_PRICE_REFLECTOR_IN: "2.5", NOTARY_PRICE_REFLECTOR_OUT: "12" };
    expect(resolvePrice("reflector", SONNET, env)).toEqual({ price: { inPerM: 2.5, outPerM: 12 }, source: "env" });
    // only applies to its own role
    expect(resolvePrice("adversary", OPUS, env).source).toBe("table");
  });

  it("never guesses: an unknown model or half-set override prices at 0 with a warning", () => {
    const unknown = resolvePrice("executor", "some.unlisted-model-v1:0", {});
    expect(unknown.price).toBeNull();
    expect(unknown.warning).toMatch(/No price for model/);
    expect(costUsd(unknown.price, 1_000_000, 1_000_000)).toBe(0);
    const half = resolvePrice("reflector", SONNET, { NOTARY_PRICE_REFLECTOR_IN: "3" });
    expect(half.price).toBeNull();
    expect(half.warning).toMatch(/must both be/);
  });
});

describe("LlmClient", () => {
  it("sends a Converse request with temperature 0, system text and the role's model", async () => {
    const { transport, calls } = fakeTransport({ text: "ok" });
    const llm = new LlmClient({ env: ENV, transport });
    const res = await llm.complete({
      role: "reflector",
      system: "be precise",
      messages: [{ role: "user", content: "question" }],
      maxTokens: 321,
    });
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input.modelId).toBe(SONNET);
    expect(input.inferenceConfig).toEqual({ maxTokens: 321, temperature: 0 });
    expect(input.system).toEqual([{ text: "be precise" }]);
    expect(input.messages).toEqual([{ role: "user", content: [{ text: "question" }] }]);
    expect(res).toMatchObject({ text: "ok", inputTokens: 1000, outputTokens: 200, modelId: SONNET, stopReason: "end_turn" });
    // 1000 * 3/1M + 200 * 15/1M = 0.003 + 0.003
    expect(res.usd).toBeCloseTo(0.006, 9);
  });

  it("accumulates usage per role and snapshots all three roles", async () => {
    const { transport } = fakeTransport({ inputTokens: 2000, outputTokens: 100 });
    const meter = new UsageMeter();
    const llm = new LlmClient({ env: ENV, transport, meter });
    await llm.complete({ role: "reflector", messages: [{ role: "user", content: "a" }] });
    await llm.complete({ role: "reflector", messages: [{ role: "user", content: "b" }] });
    await llm.complete({ role: "adversary", messages: [{ role: "user", content: "c" }] });
    const snap = meter.snapshot();
    expect(UsageByRoleSchema.parse(snap)).toEqual(snap);
    expect(snap.reflector).toEqual({ inputTokens: 4000, outputTokens: 200, usd: expect.any(Number), calls: 2 });
    expect(snap.reflector.usd).toBeCloseTo(2 * (2000 * 3 + 100 * 15) / 1e6, 9);
    expect(snap.adversary.calls).toBe(1);
    expect(snap.adversary.usd).toBeCloseTo((2000 * 15 + 100 * 75) / 1e6, 9);
    expect(snap.executor).toEqual({ inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 });
    // snapshot is a copy
    snap.reflector.calls = 99;
    expect(meter.snapshot().reflector.calls).toBe(2);
  });

  it("records a warning and usd 0 for an unpriced model", async () => {
    const { transport } = fakeTransport();
    const llm = new LlmClient({ env: ENV, transport });
    const res = await llm.complete({ role: "executor", messages: [{ role: "user", content: "a" }] });
    expect(res.usd).toBe(0);
    expect(llm.meter.snapshot().executor).toMatchObject({ inputTokens: 1000, outputTokens: 200, usd: 0, calls: 1 });
    expect(llm.meter.warnings).toHaveLength(1);
    expect(llm.meter.warnings[0]).toMatch(/test-executor-model/);
  });

  it("turns an AWS SDK credentials error into BLOCKED", async () => {
    const transport: ConverseTransport = async () => {
      const e = new Error("Could not load credentials from any providers");
      e.name = "CredentialsProviderError";
      throw e;
    };
    const llm = new LlmClient({ env: ENV, transport });
    const err = await llm.complete({ role: "reflector", messages: [{ role: "user", content: "a" }] }).catch((e) => e);
    expect(isBlocked(err)).toBe(true);
    expect((err as Error).message).toMatch(/^BLOCKED: AWS credentials/);
    expect(llm.meter.snapshot().reflector.calls).toBe(0);
  });

  it("passes other transport errors through unchanged", async () => {
    const transport: ConverseTransport = async () => {
      const e = new Error("Rate exceeded");
      e.name = "ThrottlingException";
      throw e;
    };
    const llm = new LlmClient({ env: ENV, transport });
    const err = await llm.complete({ role: "reflector", messages: [{ role: "user", content: "a" }] }).catch((e) => e);
    expect(isBlocked(err)).toBe(false);
    expect((err as Error).name).toBe("ThrottlingException");
  });
});
