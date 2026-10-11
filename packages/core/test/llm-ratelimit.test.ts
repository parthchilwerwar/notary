/**
 * Model-call rate limiter (src/llm/limiter.ts) on a VirtualClock: waits are computed, not slept.
 * Transports are TEST DOUBLES (no network); 429s are hand-built errors shaped like the openai
 * SDK's (status + Headers) and Bedrock's (ThrottlingException).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_CONCURRENCY,
  DEFAULT_LLM_RPM,
  LlmClient,
  LlmLimiter,
  LlmRateLimitedError,
  UsdCapExceededError,
  defaultBackOffMs,
  llmConcurrencyFromEnv,
  llmRpmFromEnv,
  rateLimitInfo,
  setLlmWarningSink,
} from "../src/llm/index.js";
import type { ChatRequest, ChatTransport } from "../src/llm/index.js";
import { runLlmDoctor } from "../src/llm/doctor.js";
import { VirtualClock } from "../src/tools/ratelimit.js";
import { setSpanSink } from "../src/trace/index.js";
import type { SpanRecord } from "../src/trace/index.js";

const ENV = {
  NOTARY_LLM_PROVIDER: "litellm",
  LITELLM_BASE_URL: "https://litellm.test.example/v1",
  LITELLM_API_KEY: ["fake", "rate", "key", "424242"].join("-"),
  NOTARY_MODEL_EXECUTOR: "test-haiku",
  NOTARY_MODEL_REFLECTOR: "test-sonnet",
  NOTARY_MODEL_ADVERSARY: "test-nova-pro",
  NOTARY_PRICE_EXECUTOR_IN: "0",
  NOTARY_PRICE_EXECUTOR_OUT: "0",
};
const ask = { role: "executor" as const, messages: [{ role: "user" as const, content: "x" }] };

function completion(): ChatCompletion {
  return {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok", refusal: null }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

function tooMany(headers: Record<string, string> = {}): Error {
  return Object.assign(new Error("429 Rate limit reached"), { status: 429, name: "RateLimitError", headers: new Headers(headers) });
}

/** Scripted transport: each call takes the next step ("ok" or an error). */
function scripted(steps: Array<"ok" | Error>, headers: Record<string, string> = {}) {
  const calls: ChatRequest[] = [];
  const t: ChatTransport = async (body) => {
    calls.push(body);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step !== "ok") throw step;
    return { completion: completion(), headers };
  };
  return { t, calls };
}

const tmp: string[] = [];
afterEach(() => {
  setSpanSink(null);
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function spans(): { read: () => SpanRecord[] } {
  const dir = mkdtempSync(join(tmpdir(), "notary-llm-rl-"));
  tmp.push(dir);
  const path = join(dir, "spans.jsonl");
  setSpanSink(path);
  return {
    read: () =>
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as SpanRecord),
  };
}

describe("limits from env", () => {
  it("defaults 30/min and 2 in flight; positive integers only", () => {
    expect(llmRpmFromEnv({})).toBe(DEFAULT_LLM_RPM);
    expect(DEFAULT_LLM_RPM).toBe(30);
    expect(llmConcurrencyFromEnv({})).toBe(DEFAULT_LLM_CONCURRENCY);
    expect(DEFAULT_LLM_CONCURRENCY).toBe(2);
    expect(llmRpmFromEnv({ NOTARY_LLM_RPM: "5" })).toBe(5);
    expect(llmRpmFromEnv({ NOTARY_LLM_RPM: "0" })).toBe(30);
    expect(llmRpmFromEnv({ NOTARY_LLM_RPM: "2.5" })).toBe(30);
    expect(llmConcurrencyFromEnv({ NOTARY_LLM_CONCURRENCY: "1" })).toBe(1);
    expect(llmConcurrencyFromEnv({ NOTARY_LLM_CONCURRENCY: "x" })).toBe(2);
  });

  it("doctor --llm prints the effective limits", async () => {
    const r = await runLlmDoctor({ env: { ...ENV, NOTARY_LLM_RPM: "12", NOTARY_LLM_CONCURRENCY: "3" }, chatTransport: scripted(["ok"]).t, listModels: async () => ["test-haiku", "test-sonnet", "test-nova-pro"] });
    expect(r.lines.join("\n")).toContain("limits: NOTARY_LLM_RPM=12/min, NOTARY_LLM_CONCURRENCY=3 in flight (429 → up to 3 retries honoring Retry-After, ≤ 60 s each)");
  });
});

describe("LlmLimiter (virtual clock)", () => {
  it("RPM: the (rpm+1)th start waits until the oldest leaves the rolling minute", async () => {
    const clock = new VirtualClock();
    const l = new LlmLimiter({ rpm: 2, concurrency: 5, clock });
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await l.acquire();
      waits.push(s.waitedMs);
      s.release();
      clock.advance(1_000);
    }
    // starts at 0 and 1000; the 3rd (asked at 2000) waits until 0 leaves the window (60000); the 4th
    // (61000) finds 1000 gone; the 5th (62000) waits for 60000 to leave (120000).
    expect(waits).toEqual([0, 0, 58_000, 0, 58_000]);
    expect(l.stats()).toMatchObject({ rpm: 2, requests: 5, virtual: true, waits: 2, maxWaitMs: 58_000 });
  });

  it("concurrency: never more than N provider calls in flight; FIFO hand-off", async () => {
    const limiter = new LlmLimiter({ rpm: 1000, concurrency: 2, clock: new VirtualClock() });
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const t: ChatTransport = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight -= 1;
      return { completion: completion() };
    };
    const llm = new LlmClient({ env: ENV, chatTransport: t, limiter });
    const runs = [1, 2, 3, 4, 5].map(() => llm.complete(ask));
    for (let i = 0; i < 20 && gates.length < 2; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(gates.length).toBe(2);
    expect(limiter.inFlightNow()).toBe(2);
    while (gates.length || inFlight) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(limiter.stats().maxInFlight).toBe(2);
    expect(limiter.inFlightNow()).toBe(0);
    expect(llm.meter.snapshot().executor.calls).toBe(5);
  });
});

describe("429 handling in LlmClient", () => {
  it("honors Retry-After, retries, meters the success once and records attempts / wait on the notary.llm span", async () => {
    const clock = new VirtualClock(1_000_000);
    const limiter = new LlmLimiter({ rpm: 1000, concurrency: 2, clock });
    const { t, calls } = scripted([tooMany({ "retry-after": "7" }), tooMany({ "retry-after-ms": "2500" }), "ok"], { "x-litellm-response-cost": "0.003" });
    const sink = spans();
    const llm = new LlmClient({ env: { ...ENV, NOTARY_PRICE_EXECUTOR_IN: "", NOTARY_PRICE_EXECUTOR_OUT: "" }, chatTransport: t, limiter });
    const res = await llm.complete(ask);
    expect(calls).toHaveLength(3);
    expect(clock.now() - 1_000_000).toBe(9_500); // 7 s + 2.5 s, waited on the virtual clock
    expect(res).toMatchObject({ text: "ok", usd: 0.003, priceSource: "litellm" });
    // one success → one metered call, one USD amount (no double counting of the 429 attempts)
    expect(llm.meter.snapshot().executor).toEqual({ inputTokens: 10, outputTokens: 2, usd: 0.003, calls: 1 });
    const recs = sink.read();
    expect(recs.filter((r) => r.name === "notary.llm")).toHaveLength(1);
    expect(recs[0]!.attrs).toMatchObject({ "llm.attempts": 3, "llm.waited_ms": 9_500, "llm.retry_after_ms": 2_500 });
    expect(limiter.stats().backOffs).toBe(2);
  });

  it("gives up after 3 retries with a typed error naming NOTARY_LLM_RPM and the doctor; nothing metered", async () => {
    const limiter = new LlmLimiter({ rpm: 7, concurrency: 1, clock: new VirtualClock() });
    const { t, calls } = scripted([tooMany()]);
    const llm = new LlmClient({ env: ENV, chatTransport: t, limiter });
    const err = (await llm.complete(ask).catch((e) => e)) as LlmRateLimitedError;
    expect(err).toBeInstanceOf(LlmRateLimitedError);
    expect(err.attempts).toBe(4);
    expect(err.message).toBe(
      'Model call rate limited (HTTP 429) for the Executor ("test-haiku") after 4 attempts. Lower NOTARY_LLM_RPM (now 7/min) or NOTARY_LLM_CONCURRENCY (now 1) in .env and check with `pnpm notary doctor --llm`',
    );
    expect(calls).toHaveLength(4);
    expect(llm.meter.snapshot().executor.calls).toBe(0);
    // default back-offs 2 s, 4 s, 8 s when the 429 names none
    expect([1, 2, 3].map(defaultBackOffMs)).toEqual([2_000, 4_000, 8_000]);
    expect(limiter.stats().backOffs).toBe(3);
  });

  it("gives up at once when Retry-After is longer than Notary waits", async () => {
    const limiter = new LlmLimiter({ rpm: 30, concurrency: 2, clock: new VirtualClock() });
    const { t, calls } = scripted([tooMany({ "retry-after": "120" })]);
    const err = (await new LlmClient({ env: ENV, chatTransport: t, limiter }).complete(ask).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(LlmRateLimitedError);
    expect(err.message).toContain("after 1 attempt; the provider asked to wait 120 s, longer than Notary waits (60 s)");
    expect(calls).toHaveLength(1);
  });

  it("re-checks NOTARY_MAX_USD before every retry", async () => {
    const limiter = new LlmLimiter({ rpm: 1000, concurrency: 2, clock: new VirtualClock() });
    let releaseA!: () => void;
    const bDone = new Promise<void>((r) => (releaseA = r));
    let n = 0;
    const t: ChatTransport = async () => {
      n += 1;
      if (n === 1) {
        await bDone; // A's 429 lands only after B has been paid for
        throw tooMany({ "retry-after": "1" });
      }
      return { completion: completion(), headers: { "x-litellm-response-cost": "0.02" } };
    };
    const llm = new LlmClient({ env: { ...ENV, NOTARY_PRICE_EXECUTOR_IN: "", NOTARY_PRICE_EXECUTOR_OUT: "", NOTARY_MAX_USD: "0.01" }, chatTransport: t, limiter });
    const a = llm.complete(ask).catch((e) => e);
    const b = llm.complete(ask).then((r) => {
      releaseA();
      return r;
    });
    expect((await b).usd).toBe(0.02);
    const errA = await a;
    expect(errA).toBeInstanceOf(UsdCapExceededError);
    expect(n).toBe(2); // A was never sent again
    expect(llm.meter.snapshot().executor).toMatchObject({ calls: 1, usd: 0.02 });
  });

  it("Bedrock ThrottlingException is retried the same way (default back-off)", async () => {
    const prev = setLlmWarningSink(null);
    try {
      const clock = new VirtualClock();
      const limiter = new LlmLimiter({ rpm: 1000, concurrency: 2, clock });
      let n = 0;
      const llm = new LlmClient({
        env: { NOTARY_MODEL_EXECUTOR: "test-bedrock-model", AWS_REGION: "us-east-1" },
        limiter,
        transport: async () => {
          n += 1;
          if (n === 1) throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } });
          return {
            output: { message: { role: "assistant", content: [{ text: "OK" }] } },
            usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
            stopReason: "end_turn",
            metrics: { latencyMs: 1 },
            $metadata: {},
          };
        },
      });
      expect((await llm.complete(ask)).text).toBe("OK");
      expect(n).toBe(2);
      expect(clock.now()).toBe(2_000);
      expect(llm.meter.snapshot().executor.calls).toBe(1);
    } finally {
      setLlmWarningSink(prev);
    }
  });

  it("without a limiter (injected test transport, default) a 429 passes straight through", async () => {
    const { t, calls } = scripted([tooMany()]);
    const err = (await new LlmClient({ env: ENV, chatTransport: t }).complete(ask).catch((e) => e)) as { status?: number };
    expect(err.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it("recognises rate limits by status, class name or Bedrock throttling; reads retry-after-ms first", () => {
    expect(rateLimitInfo(tooMany({ "retry-after-ms": "1500", "retry-after": "9" }))).toEqual({ retryAfterMs: 1500 });
    expect(rateLimitInfo(tooMany({ "retry-after": "9" }))).toEqual({ retryAfterMs: 9000 });
    expect(rateLimitInfo(tooMany())).toEqual({ retryAfterMs: null });
    expect(rateLimitInfo({ status: 429, headers: { "Retry-After": "3" } })).toEqual({ retryAfterMs: 3000 });
    expect(rateLimitInfo(Object.assign(new Error("x"), { name: "ThrottlingException" }))).toEqual({ retryAfterMs: null });
    expect(rateLimitInfo(Object.assign(new Error("x"), { status: 500 }))).toBeNull();
    expect(rateLimitInfo(new Error("boom"))).toBeNull();
  });
});
