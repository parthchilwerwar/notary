/**
 * Cost precedence and the NOTARY_MAX_USD cap. Transports are TEST DOUBLES (no network); prices
 * here are test inputs set through the env overrides, not real model prices.
 */
import type { ChatCompletion } from "openai/resources/chat/completions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LlmClient,
  ModelConfigError,
  UsdCapExceededError,
  UsdPriceUnknownError,
  isUsdCapExceeded,
  maxUsdFromEnv,
  priceCall,
  reportedCostUsd,
  setLlmWarningSink,
  usdCapFromStopReason,
} from "../src/llm/index.js";
import type { ChatRequest, ChatTransport } from "../src/llm/index.js";
import { budgetSnapshot } from "../src/timeline/derive.js";
import { buildSampleBundle } from "../src/bundle/index.js";

const SONNET = "anthropic.claude-sonnet-4-20250514-v1:0"; // in the Bedrock table ($3 / $15 per 1M)
const LITE = {
  NOTARY_LLM_PROVIDER: "litellm",
  LITELLM_BASE_URL: "https://litellm.test.example",
  LITELLM_API_KEY: ["fake", "cap", "key", "000111"].join("-"),
  NOTARY_MODEL_EXECUTOR: "test-haiku",
  NOTARY_MODEL_REFLECTOR: "test-sonnet",
  NOTARY_MODEL_ADVERSARY: "test-nova-pro",
};

function completion(prompt = 1000, out = 100): ChatCompletion {
  return {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok", refusal: null }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: prompt, completion_tokens: out, total_tokens: prompt + out },
  };
}

function chat(headers: Record<string, string> = {}) {
  const calls: ChatRequest[] = [];
  const t: ChatTransport = async (body) => {
    calls.push(body);
    return { completion: completion(), headers };
  };
  return { t, calls };
}

const warned: string[] = [];
let prevSink: ReturnType<typeof setLlmWarningSink>;
beforeEach(() => {
  warned.length = 0;
  prevSink = setLlmWarningSink((m) => warned.push(m));
});
afterEach(() => {
  setLlmWarningSink(prevSink);
});

describe("cost precedence: env override > LiteLLM-reported > table > unknown", () => {
  const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  it("resolves each source in order", () => {
    const env = { NOTARY_PRICE_REFLECTOR_IN: "1", NOTARY_PRICE_REFLECTOR_OUT: "2" };
    expect(priceCall("reflector", SONNET, tokens, env, 0.5)).toEqual({ usd: 3, source: "env" });
    expect(priceCall("reflector", SONNET, tokens, {}, 0.5)).toEqual({ usd: 0.5, source: "litellm" });
    expect(priceCall("reflector", SONNET, tokens, {}, null)).toEqual({ usd: 18, source: "table" });
    const unknown = priceCall("reflector", "test-sonnet", tokens, {}, null);
    expect(unknown).toMatchObject({ usd: 0, source: "unknown" });
    expect(unknown.warning).toContain("NOTARY_PRICE_REFLECTOR_IN and NOTARY_PRICE_REFLECTOR_OUT");
  });

  it("parses the proxy's x-litellm-response-cost header, ignoring junk", () => {
    expect(reportedCostUsd({ "x-litellm-response-cost": "0.00042" })).toBe(0.00042);
    expect(reportedCostUsd({ "x-litellm-response-cost": "nan" })).toBeNull();
    expect(reportedCostUsd({ "x-litellm-response-cost": "-1" })).toBeNull();
    expect(reportedCostUsd({})).toBeNull();
    expect(reportedCostUsd(undefined)).toBeNull();
  });

  it("LlmClient records the proxy-reported cost, and an env override beats it", async () => {
    const reported = new LlmClient({ env: LITE, chatTransport: chat({ "x-litellm-response-cost": "0.0125" }).t });
    const r1 = await reported.complete({ role: "executor", messages: [{ role: "user", content: "x" }] });
    expect(r1).toMatchObject({ usd: 0.0125, priceSource: "litellm" });
    expect(reported.meter.snapshot().executor.usd).toBe(0.0125);

    const overridden = new LlmClient({
      env: { ...LITE, NOTARY_PRICE_EXECUTOR_IN: "10", NOTARY_PRICE_EXECUTOR_OUT: "20" },
      chatTransport: chat({ "x-litellm-response-cost": "0.0125" }).t,
    });
    const r2 = await overridden.complete({ role: "executor", messages: [{ role: "user", content: "x" }] });
    expect(r2).toMatchObject({ usd: (1000 * 10 + 100 * 20) / 1e6, priceSource: "env" });
    expect(warned).toEqual([]);
  });

  it("an unknown price records $0, marks the source unknown and warns ONCE naming the env vars", async () => {
    const llm = new LlmClient({ env: LITE, chatTransport: chat().t });
    const a = await llm.complete({ role: "adversary", messages: [{ role: "user", content: "x" }] });
    await llm.complete({ role: "adversary", messages: [{ role: "user", content: "y" }] });
    await new LlmClient({ env: LITE, chatTransport: chat().t }).complete({ role: "adversary", messages: [{ role: "user", content: "z" }] });
    expect(a).toMatchObject({ usd: 0, priceSource: "unknown" });
    expect(llm.meter.warnings).toHaveLength(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/No price for model "test-nova-pro" \(Adversary\); usd recorded as 0\. Set NOTARY_PRICE_ADVERSARY_IN and NOTARY_PRICE_ADVERSARY_OUT/);
  });
});

describe("NOTARY_MAX_USD", () => {
  it("parses: unset = no cap, non-negative numbers, anything else is invalid config", () => {
    expect(maxUsdFromEnv({})).toBeNull();
    expect(maxUsdFromEnv({ NOTARY_MAX_USD: " 2.5 " })).toBe(2.5);
    expect(maxUsdFromEnv({ NOTARY_MAX_USD: "0" })).toBe(0);
    expect(() => maxUsdFromEnv({ NOTARY_MAX_USD: "-1" })).toThrow(ModelConfigError);
    expect(() => maxUsdFromEnv({ NOTARY_MAX_USD: "five" })).toThrow(/NOTARY_MAX_USD must be a non-negative number/);
    expect(() => new LlmClient({ env: { ...LITE, NOTARY_MAX_USD: "abc" } })).toThrow(ModelConfigError);
  });

  it("known price: refuses the call whose high estimate would cross the cap, before any I/O, without metering", async () => {
    // $10 / $20 per 1M → each finished call costs (1000*10 + 100*20)/1e6 = $0.012; a call with
    // maxTokens 100 and a 4-char prompt is estimated at (2*10 + 100*20)/1e6 = $0.00202.
    const env = { ...LITE, NOTARY_PRICE_EXECUTOR_IN: "10", NOTARY_PRICE_EXECUTOR_OUT: "20", NOTARY_MAX_USD: "0.02" };
    const { t, calls } = chat();
    const llm = new LlmClient({ env, chatTransport: t });
    const req = { role: "executor" as const, messages: [{ role: "user" as const, content: "abcd" }], maxTokens: 100 };
    await llm.complete(req); // spent 0 + est 0.00202 ≤ 0.02 → runs, spent 0.012
    const err = (await llm.complete({ ...req, maxTokens: 500_000 }).catch((e) => e)) as UsdCapExceededError; // est ≈ $10
    expect(err).toBeInstanceOf(UsdCapExceededError);
    expect(isUsdCapExceeded(err)).toBe(true);
    expect(err.message).toMatch(/^USD cap reached: NOTARY_MAX_USD=0\.02 — \$0\.0120 already spent this run, the next Executor call could cost up to ~\$10\.0000/);
    expect(calls).toHaveLength(1);
    expect(llm.meter.snapshot().executor).toMatchObject({ calls: 1, usd: 0.012 });
    await llm.complete(req); // still fits: 0.012 + 0.00202 ≤ 0.02 → spent 0.024
    await expect(llm.complete(req)).rejects.toThrow(/NOTARY_MAX_USD=0\.02/); // spent ≥ cap
    expect(calls).toHaveLength(2);
  });

  it("unknown price: enforced on recorded (proxy-reported) spend; the call that crosses is the last", async () => {
    const { t, calls } = chat({ "x-litellm-response-cost": "0.004" });
    const llm = new LlmClient({ env: { ...LITE, NOTARY_MAX_USD: "0.01" }, chatTransport: t });
    const req = { role: "reflector" as const, messages: [{ role: "user" as const, content: "x" }] };
    await llm.complete(req);
    await llm.complete(req);
    await llm.complete(req); // 0.008 < 0.01 → allowed, ends at 0.012
    await expect(llm.complete(req)).rejects.toBeInstanceOf(UsdCapExceededError);
    expect(calls).toHaveLength(3);
  });

  it("unknown price, no proxy-reported cost: the cap refuses the next call (BLOCKED, naming NOTARY_PRICE_<ROLE>_IN/OUT) instead of counting $0 forever (audit #5)", async () => {
    const { t, calls } = chat(); // no x-litellm-response-cost header, no override, not in the table
    const llm = new LlmClient({ env: { ...LITE, NOTARY_MAX_USD: "0.01" }, chatTransport: t });
    const req = { role: "reflector" as const, messages: [{ role: "user" as const, content: "x" }] };
    const first = await llm.complete(req);
    expect(first).toMatchObject({ usd: 0, priceSource: "unknown" });
    expect(llm.meter.unknownCalls()).toBe(1);
    const err = (await llm.complete(req).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(UsdPriceUnknownError);
    expect(isUsdCapExceeded(err)).toBe(true); // callers stop cleanly, as at the cap
    expect(err.message).toMatch(/^BLOCKED: NOTARY_MAX_USD=0\.01 is set but .*cost is unknown.*NOTARY_PRICE_REFLECTOR_IN and NOTARY_PRICE_REFLECTOR_OUT/);
    expect(calls).toHaveLength(1);
    // Without a cap nothing is refused, but the unknown calls are still counted (never silently $0).
    const free = new LlmClient({ env: LITE, chatTransport: chat().t });
    await free.complete(req);
    await free.complete(req);
    expect(free.meter.unknownCalls()).toBe(2);
  });

  it("Bedrock with a cap and a model it cannot price: refused before any I/O (audit #5)", async () => {
    const calls: unknown[] = [];
    const transport = async (input: unknown) => {
      calls.push(input);
      return { output: { message: { role: "assistant", content: [{ text: "x" }] } }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn", metrics: { latencyMs: 1 }, $metadata: {} };
    };
    const env = { AWS_REGION: "us-east-1", NOTARY_MODEL_EXECUTOR: "test-unpriced-model", NOTARY_MODEL_REFLECTOR: SONNET, NOTARY_MODEL_ADVERSARY: "anthropic.claude-opus-4-1-20250805-v1:0", NOTARY_MAX_USD: "1" };
    const llm = new LlmClient({ env, transport: transport as never });
    const err = (await llm.complete({ role: "executor", messages: [{ role: "user", content: "x" }] }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(UsdPriceUnknownError);
    expect(err.message).toMatch(/^BLOCKED: .*"test-unpriced-model" is unknown.*NOTARY_PRICE_EXECUTOR_IN and NOTARY_PRICE_EXECUTOR_OUT/);
    expect(calls).toHaveLength(0);
    // A table-priced role still runs under the same cap.
    await llm.complete({ role: "reflector", messages: [{ role: "user", content: "x" }] });
    expect(calls).toHaveLength(1);
  });

  it("a replayed cap error (plain Error with the recorded name) is still recognised", () => {
    const replayed = Object.assign(new Error("USD cap reached: NOTARY_MAX_USD=1 — …"), { name: "UsdCapExceededError" });
    expect(isUsdCapExceeded(replayed)).toBe(true);
    expect(isUsdCapExceeded(new Error("other"))).toBe(false);
  });

  it("the budget snapshot reports the cap only when the bundle's stopReason states it", () => {
    const err = new UsdCapExceededError("adversary", 0.75, 0.74, 0.02);
    expect(usdCapFromStopReason(err.message)).toBe(0.75);
    expect(usdCapFromStopReason("Credit budget exceeded: x")).toBeNull();
    expect(usdCapFromStopReason(undefined)).toBeNull();
    const b = buildSampleBundle(7);
    expect(budgetSnapshot({ ...b, status: "stopped_budget", stopReason: `${err.message} (before the Reflector proposed hypotheses)` }).usdCap).toBe(0.75);
    const { stopReason: _drop, ...noStop } = b;
    expect(budgetSnapshot(noStop).usdCap).toBeNull();
  });
});

describe("Ask Notary at the cap", () => {
  it("returns the ok:false answer with a reason naming NOTARY_MAX_USD (no crash)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { answerQuestion, ASK_FAILED_ANSWER } = await import("../src/api/ask.js");
    const { finalizeBundle, writeBundle } = await import("../src/bundle/index.js");
    const root = mkdtempSync(join(tmpdir(), "notary-usd-ask-"));
    try {
      const real = finalizeBundle({ ...buildSampleBundle(42), runId: "real-usd-run", sample: false });
      const dir = join(root, "runs", real.runId);
      await writeBundle(real, dir);
      const d = real.decisions[0]!;
      // The real client, capped at $0: the executor call is refused before any I/O.
      const { t, calls } = chat();
      const llm = new LlmClient({ env: { ...LITE, NOTARY_MAX_USD: "0" }, chatTransport: t });
      const res = await answerQuestion({ question: `why was ${d.requestId} ${d.status}?` }, { bundleDirs: () => [dir], llm, runsDir: null, certificatesDir: null });
      expect(res.ok).toBe(false);
      expect(res.answer).toBe(ASK_FAILED_ANSWER);
      if (!res.ok) expect(res.reason).toMatch(/NOTARY_MAX_USD=0/);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
