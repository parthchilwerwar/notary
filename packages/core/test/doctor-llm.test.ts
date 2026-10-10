/**
 * `notary doctor --llm` tests. The proxy (model listing and chat completions) and Bedrock are TEST
 * DOUBLES; nothing reaches the network. Model names and the key are test labels, not real values.
 */
import type { ChatCompletion } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import { runLlmDoctor } from "../src/llm/doctor.js";
import type { ChatRequest, ChatTransport, ConverseTransport } from "../src/llm/index.js";

// Built at runtime so no committed line looks like a real key (pnpm check:secrets).
const KEY = ["fake", "doctor", "key", "9876543210"].join("-");
const ENV = {
  NOTARY_LLM_PROVIDER: "litellm",
  LITELLM_BASE_URL: "https://litellm.test.example/v1",
  LITELLM_API_KEY: KEY,
  NOTARY_MODEL_EXECUTOR: "test-haiku",
  NOTARY_MODEL_REFLECTOR: "test-sonnet",
  NOTARY_MODEL_ADVERSARY: "test-nova-pro",
};
const LISTED = ["test-micro", "test-haiku", "test-sonnet", "test-nova-pro"];

function reply(text = "OK"): ChatCompletion {
  return {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: text, refusal: null }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  };
}

function chat(fail?: (body: ChatRequest) => Error | undefined) {
  const calls: ChatRequest[] = [];
  const t: ChatTransport = async (body) => {
    calls.push(body);
    const e = fail?.(body);
    if (e) throw e;
    return { completion: reply() };
  };
  return { t, calls };
}

/** A clock that advances 25 ms per reading. */
function clock() {
  let t = 0;
  return () => (t += 25);
}

describe("doctor --llm (litellm)", () => {
  it("all good: lists models, checks every role, one tiny call per role, exit 0", async () => {
    const { t, calls } = chat();
    const r = await runLlmDoctor({ env: ENV, chatTransport: t, listModels: async () => LISTED, now: clock() });
    expect(r.exitCode).toBe(0);
    expect(r.status).toBe("ok");
    const text = r.lines.join("\n");
    expect(text).toContain("provider: litellm");
    expect(text).toContain("LITELLM_BASE_URL: https://litellm.test.example/v1 (normalized)");
    expect(text).toContain("LITELLM_API_KEY: set (value never shown)");
    expect(text).toContain("ok   GET /v1/models: 4 model(s)");
    for (const id of ["test-haiku", "test-sonnet", "test-nova-pro"]) expect(text).toContain(`"${id}" is offered by the proxy`);
    expect(text).toContain('separation of duties: reflector "test-sonnet" ≠ adversary "test-nova-pro"');
    expect(text).toMatch(/ok {3}executor test call: "test-haiku" 25 ms, 11 in \/ 1 out tokens/);
    expect(calls.map((c) => [c.model, c.max_tokens, c.messages])).toEqual([
      ["test-haiku", 5, [{ role: "user", content: "Reply with OK" }]],
      ["test-sonnet", 5, [{ role: "user", content: "Reply with OK" }]],
      ["test-nova-pro", 5, [{ role: "user", content: "Reply with OK" }]],
    ]);
    expect(r.lines.at(-1)).toMatch(/^result: OK/);
  });

  it("normalizes a base URL without /v1 and never prints user:password", async () => {
    const r = await runLlmDoctor({
      env: { ...ENV, LITELLM_BASE_URL: "https://user:pw-secret@litellm.test.example/" },
      chatTransport: chat().t,
      listModels: async () => LISTED,
    });
    const text = r.lines.join("\n");
    expect(text).toContain("https://litellm.test.example/v1 (normalized)");
    expect(text).not.toContain("pw-secret");
  });

  it("a role model the proxy doesn't offer: FAIL with the listed ids, exit 1, no call for it", async () => {
    const { t, calls } = chat();
    const r = await runLlmDoctor({ env: { ...ENV, NOTARY_MODEL_REFLECTOR: "claude-typo" }, chatTransport: t, listModels: async () => LISTED });
    expect(r.exitCode).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toContain('FAIL reflector: model "claude-typo" is not offered by the proxy for this key');
    expect(text).toContain("FIX: set NOTARY_MODEL_REFLECTOR to one of: test-micro, test-haiku, test-sonnet, test-nova-pro (e.g. NOTARY_MODEL_REFLECTOR=test-micro)");
    expect(calls.map((c) => c.model)).toEqual(["test-haiku", "test-nova-pro"]);
  });

  it("reflector = adversary: separation-of-duties FAIL with a different example, other roles still checked", async () => {
    const { t, calls } = chat();
    const r = await runLlmDoctor({ env: { ...ENV, NOTARY_MODEL_ADVERSARY: "test-sonnet" }, chatTransport: t, listModels: async () => LISTED });
    expect(r.exitCode).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toContain('FAIL separation of duties: reflector and adversary are the same model ("test-sonnet")');
    expect(text).toContain("FIX: set NOTARY_MODEL_ADVERSARY to a different model, e.g. NOTARY_MODEL_ADVERSARY=test-micro");
    expect(calls.map((c) => c.model)).toEqual(["test-haiku", "test-sonnet", "test-sonnet"]);
  });

  it("missing variables are BLOCKED (exit 3) with one FIX line each, no network", async () => {
    let listed = 0;
    const { t, calls } = chat();
    const r = await runLlmDoctor({
      env: { NOTARY_LLM_PROVIDER: "litellm", NOTARY_MODEL_EXECUTOR: "test-haiku" },
      chatTransport: t,
      listModels: async () => {
        listed += 1;
        return LISTED;
      },
    });
    expect(r.exitCode).toBe(3);
    expect(r.status).toBe("blocked");
    const text = r.lines.join("\n");
    expect(text).toContain("BLOCKED: LITELLM_BASE_URL not set — set it in .env (see .env.example) and run `pnpm notary doctor --llm`");
    expect(text).toContain("FIX: add LITELLM_BASE_URL=https://litellm.example.com/v1 to .env");
    expect(text).toContain("BLOCKED: LITELLM_API_KEY not set");
    expect(text).toContain("BLOCKED: NOTARY_MODEL_REFLECTOR not set");
    expect(text).toContain("FIX: add NOTARY_MODEL_REFLECTOR=<model id> to .env");
    expect(listed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("a missing role model alone is BLOCKED, with a listed id as the example; other roles are called", async () => {
    const { t, calls } = chat();
    const r = await runLlmDoctor({ env: { ...ENV, NOTARY_MODEL_EXECUTOR: "" }, chatTransport: t, listModels: async () => LISTED });
    expect(r.exitCode).toBe(3);
    expect(r.lines.join("\n")).toContain("FIX: add NOTARY_MODEL_EXECUTOR=test-micro to .env");
    expect(calls.map((c) => c.model)).toEqual(["test-sonnet", "test-nova-pro"]);
  });

  it("never prints the key, even when the HTTP client's errors contain it", async () => {
    const leaky = Object.assign(new Error(`401 invalid api key ${KEY} for ${ENV.LITELLM_BASE_URL}`), { status: 401 });
    const r = await runLlmDoctor({ env: ENV, chatTransport: chat().t, listModels: async () => Promise.reject(leaky) });
    expect(r.exitCode).toBe(1);
    const text = r.lines.join("\n");
    expect(text).not.toContain(KEY);
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("FIX: the proxy rejected the key; set LITELLM_API_KEY=<a valid proxy key> in .env");
    expect(text).toContain("skip test calls: the proxy rejected the key");

    const callLeak = await runLlmDoctor({
      env: ENV,
      chatTransport: chat(() => Object.assign(new Error(`upstream said key=${KEY}`), { status: 500 })).t,
      listModels: async () => LISTED,
    });
    expect(callLeak.exitCode).toBe(1);
    expect(callLeak.lines.join("\n")).not.toContain(KEY);
    expect(callLeak.lines.filter((l) => l.startsWith("FAIL "))).toHaveLength(3);
  });

  it("an unreachable proxy fails with a LITELLM_BASE_URL fix", async () => {
    const r = await runLlmDoctor({ env: ENV, chatTransport: chat().t, listModels: async () => Promise.reject(new TypeError("fetch failed")) });
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("FIX: check LITELLM_BASE_URL (e.g. LITELLM_BASE_URL=https://litellm.example.com/v1)");
  });

  it("an invalid provider fails (exit 1) with the fix", async () => {
    const r = await runLlmDoctor({ env: { NOTARY_LLM_PROVIDER: "openai" } });
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("FIX: set NOTARY_LLM_PROVIDER=litellm (or bedrock) in .env");
  });
});

describe("doctor --llm (bedrock)", () => {
  it("reports config, skips listing, still checks roles and calls each one", async () => {
    const seen: string[] = [];
    const transport: ConverseTransport = async (input) => {
      seen.push(String(input.modelId));
      return {
        output: { message: { role: "assistant", content: [{ text: "OK" }] } },
        usage: { inputTokens: 9, outputTokens: 1, totalTokens: 10 },
        stopReason: "end_turn",
        metrics: { latencyMs: 1 },
        $metadata: {},
      };
    };
    const env = {
      AWS_REGION: "us-east-1",
      NOTARY_MODEL_EXECUTOR: "anthropic.claude-haiku-4-5-20251001-v1:0",
      NOTARY_MODEL_REFLECTOR: "anthropic.claude-sonnet-4-20250514-v1:0",
      NOTARY_MODEL_ADVERSARY: "anthropic.claude-opus-4-1-20250805-v1:0",
    };
    const r = await runLlmDoctor({ env, transport });
    expect(r.exitCode).toBe(0);
    const text = r.lines.join("\n");
    expect(text).toContain("provider: bedrock (NOTARY_LLM_PROVIDER unset: default)");
    expect(text).toContain("skip model listing: not available for bedrock");
    expect(seen).toHaveLength(3);
  });

  it("is BLOCKED without AWS_REGION", async () => {
    const r = await runLlmDoctor({ env: { NOTARY_MODEL_EXECUTOR: "a", NOTARY_MODEL_REFLECTOR: "b", NOTARY_MODEL_ADVERSARY: "c" } });
    expect(r.exitCode).toBe(3);
    expect(r.lines.join("\n")).toContain("FIX: add AWS_REGION=us-east-1 to .env");
  });
});
