/**
 * LiteLLM backend tests. Every proxy here is a TEST DOUBLE: either an injected ChatTransport that
 * returns hand-built chat completions, or a fake `fetch` handed to the real `openai` client. Nothing
 * reaches the network. Model names and the key below are test labels, not real values.
 */
import type { ChatCompletion } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import { reviewWithBedrock } from "../src/adversary/bedrock.js";
import {
  LlmClient,
  ModelConfigError,
  llmBlockedReason,
  llmConfigIssues,
  llmConfigProblem,
  llmProvider,
  liteLlmModelLister,
  liteLlmTransport,
  normalizeLiteLlmBaseUrl,
  stopReasonFromFinish,
} from "../src/llm/index.js";
import type { ChatRequest, ChatTransport } from "../src/llm/index.js";
import { isBlocked } from "../src/tools/errors.js";

// Built at runtime so no committed line looks like a real key (pnpm check:secrets).
const KEY = ["fake", "litellm", "key", "0123456789"].join("-");
const ENV = {
  NOTARY_LLM_PROVIDER: "litellm",
  LITELLM_BASE_URL: "https://litellm.test.example/v1",
  LITELLM_API_KEY: KEY,
  NOTARY_MODEL_EXECUTOR: "test-haiku",
  NOTARY_MODEL_REFLECTOR: "test-sonnet",
  NOTARY_MODEL_ADVERSARY: "test-nova-pro",
};

function completion(o: { text?: string | null; prompt?: number; completion?: number; finish?: string | null } = {}): ChatCompletion {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: o.text === undefined ? "fake reply" : o.text, refusal: null },
        finish_reason: (o.finish === undefined ? "stop" : o.finish) as "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: o.prompt ?? 1000, completion_tokens: o.completion ?? 200, total_tokens: 0 },
  };
}

function fakeChat(o: Parameters<typeof completion>[0] = {}, headers: Record<string, string> = {}) {
  const calls: ChatRequest[] = [];
  const chatTransport: ChatTransport = async (body) => {
    calls.push(body);
    return { completion: completion(o), headers };
  };
  return { chatTransport, calls };
}

describe("provider config", () => {
  it("defaults to bedrock, accepts litellm, rejects anything else as invalid config", () => {
    expect(llmProvider({})).toBe("bedrock");
    expect(llmProvider({ NOTARY_LLM_PROVIDER: " LiteLLM " })).toBe("litellm");
    expect(() => llmProvider({ NOTARY_LLM_PROVIDER: "openai" })).toThrow(ModelConfigError);
    expect(() => new LlmClient({ env: { NOTARY_LLM_PROVIDER: "openai" } })).toThrow(ModelConfigError);
  });

  it("normalizes the base URL to exactly one /v1 (never /v1/v1)", () => {
    for (const raw of ["https://p.example", "https://p.example/", "https://p.example/v1", "https://p.example/v1/", " https://p.example/v1/v1 "]) {
      expect(normalizeLiteLlmBaseUrl(raw)).toBe("https://p.example/v1");
    }
    expect(normalizeLiteLlmBaseUrl("https://litellm.vision.example/v1")).toBe("https://litellm.vision.example/v1");
    expect(normalizeLiteLlmBaseUrl("https://p.example/proxy/v1")).toBe("https://p.example/proxy/v1");
    expect(normalizeLiteLlmBaseUrl("not a url")).toBeNull();
    expect(normalizeLiteLlmBaseUrl("ftp://p.example")).toBeNull();
  });

  it("names the exact missing variable per provider (one helper for every check)", () => {
    expect(llmConfigProblem(ENV, "executor")).toBeNull();
    expect(llmBlockedReason(ENV, "executor")).toBeNull();
    expect(llmConfigProblem({ ...ENV, NOTARY_MODEL_EXECUTOR: "" }, "executor")).toBe("NOTARY_MODEL_EXECUTOR");
    expect(llmConfigProblem({ ...ENV, LITELLM_BASE_URL: " " }, "reflector")).toBe("LITELLM_BASE_URL");
    expect(llmConfigProblem({ ...ENV, LITELLM_API_KEY: "" }, "adversary")).toBe("LITELLM_API_KEY");
    expect(llmConfigIssues({ ...ENV, LITELLM_BASE_URL: "nope" }, "executor")[0]).toMatchObject({ variable: "LITELLM_BASE_URL", problem: "invalid" });
    // litellm never asks for AWS_REGION; bedrock never asks for the LiteLLM settings
    expect(llmConfigIssues({ ...ENV, AWS_REGION: "" }, "executor")).toEqual([]);
    const bedrock = { NOTARY_MODEL_EXECUTOR: "m" };
    expect(llmConfigIssues(bedrock, "executor").map((i) => i.variable)).toEqual(["AWS_REGION"]);
    expect(llmConfigIssues({}, "reflector").map((i) => i.variable)).toEqual(["NOTARY_MODEL_REFLECTOR", "AWS_REGION"]);
    expect(llmConfigIssues({ NOTARY_LLM_PROVIDER: "litellm" }, "reflector").map((i) => i.variable)).toEqual([
      "NOTARY_MODEL_REFLECTOR",
      "LITELLM_BASE_URL",
      "LITELLM_API_KEY",
    ]);
    expect(llmBlockedReason({ NOTARY_LLM_PROVIDER: "x" }, "executor")).toMatch(/^BLOCKED: NOTARY_LLM_PROVIDER must be "litellm" or "bedrock"/);
  });
});

describe("LlmClient on litellm", () => {
  it("sends an OpenAI chat request: system first, temperature 0, max_tokens, the role's model", async () => {
    const { chatTransport, calls } = fakeChat({ text: "ok" });
    const llm = new LlmClient({ env: ENV, chatTransport });
    expect(llm.provider).toBe("litellm");
    const res = await llm.complete({
      role: "reflector",
      system: "be precise",
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "follow-up" },
      ],
      maxTokens: 321,
    });
    expect(calls).toEqual([
      {
        model: "test-sonnet",
        messages: [
          { role: "system", content: "be precise" },
          { role: "user", content: "question" },
          { role: "assistant", content: "earlier answer" },
          { role: "user", content: "follow-up" },
        ],
        max_tokens: 321,
        temperature: 0,
      },
    ]);
    expect(res).toMatchObject({ text: "ok", modelId: "test-sonnet", inputTokens: 1000, outputTokens: 200, stopReason: "end_turn" });
    // default maxTokens and no system message when none is given
    await llm.complete({ role: "executor", messages: [{ role: "user", content: "x" }] });
    expect(calls[1]).toMatchObject({ model: "test-haiku", max_tokens: 2048, messages: [{ role: "user", content: "x" }] });
  });

  it("meters prompt/completion tokens per role, like Bedrock", async () => {
    const { chatTransport } = fakeChat({ prompt: 1234, completion: 56 });
    const llm = new LlmClient({ env: { ...ENV, NOTARY_PRICE_ADVERSARY_IN: "2", NOTARY_PRICE_ADVERSARY_OUT: "10" }, chatTransport });
    const res = await llm.complete({ role: "adversary", messages: [{ role: "user", content: "x" }] });
    await llm.complete({ role: "adversary", messages: [{ role: "user", content: "y" }] });
    expect(res.usd).toBeCloseTo((1234 * 2 + 56 * 10) / 1e6, 12);
    expect(llm.meter.snapshot().adversary).toMatchObject({ inputTokens: 2468, outputTokens: 112, calls: 2 });
    expect(llm.meter.snapshot().executor.calls).toBe(0);
  });

  it("maps finish_reason onto the Bedrock stop reasons callers branch on", async () => {
    expect(stopReasonFromFinish("length")).toBe("max_tokens");
    expect(stopReasonFromFinish("stop")).toBe("end_turn");
    expect(stopReasonFromFinish("content_filter")).toBe("content_filtered");
    expect(stopReasonFromFinish(null)).toBe("unknown");
    const { chatTransport } = fakeChat({ text: null, finish: "length" });
    const res = await new LlmClient({ env: ENV, chatTransport }).complete({ role: "executor", messages: [{ role: "user", content: "x" }] });
    expect(res).toMatchObject({ text: "", stopReason: "max_tokens" });
  });

  it("scrubs secret env values from prompts and from transport error messages", async () => {
    const { chatTransport, calls } = fakeChat();
    const llm = new LlmClient({ env: ENV, chatTransport });
    await llm.complete({ role: "executor", system: `sys ${KEY}`, messages: [{ role: "user", content: `leak ${KEY} here` }] });
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(JSON.stringify(calls)).toContain("[REDACTED]");

    const failing = new LlmClient({
      env: ENV,
      chatTransport: async () => {
        throw Object.assign(new Error(`401 Authentication Error: invalid key ${KEY}`), { status: 401 });
      },
    });
    const err = (await failing.complete({ role: "executor", messages: [{ role: "user", content: "x" }] }).catch((e) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("401");
    expect(failing.meter.snapshot().executor.calls).toBe(0);
  });

  it("is BLOCKED before any I/O when the proxy URL or key is missing", async () => {
    for (const [name, env] of [
      ["LITELLM_BASE_URL", { ...ENV, LITELLM_BASE_URL: "" }],
      ["LITELLM_API_KEY", { ...ENV, LITELLM_API_KEY: "" }],
    ] as const) {
      const err = await new LlmClient({ env }).complete({ role: "executor", messages: [{ role: "user", content: "x" }] }).catch((e) => e);
      expect(isBlocked(err)).toBe(true);
      expect((err as Error).message).toMatch(new RegExp(`^BLOCKED: ${name} not set`));
    }
    const noModel = await new LlmClient({ env: { ...ENV, NOTARY_MODEL_REFLECTOR: "" }, chatTransport: fakeChat().chatTransport })
      .complete({ role: "reflector", messages: [{ role: "user", content: "x" }] })
      .catch((e) => e);
    expect((noModel as Error).message).toMatch(/^BLOCKED: NOTARY_MODEL_REFLECTOR not set/);
  });

  it("refuses a transport that doesn't match the provider", () => {
    expect(() => new LlmClient({ env: ENV, transport: async () => ({}) as never })).toThrow(/NOTARY_LLM_PROVIDER=litellm/);
    expect(() => new LlmClient({ env: { NOTARY_MODEL_EXECUTOR: "m" }, chatTransport: fakeChat().chatTransport })).toThrow(/provider is bedrock/);
  });

  it("keeps separation of duties on LiteLLM model names", () => {
    expect(() => new LlmClient({ env: { ...ENV, NOTARY_MODEL_ADVERSARY: "test-sonnet" } })).toThrow(ModelConfigError);
  });
});

describe("callers behave identically on litellm", () => {
  it("the adversary validates the JSON reply and fails safe on prose", async () => {
    const good = new LlmClient({ env: ENV, chatTransport: fakeChat({ text: '{"verdict":"uphold","reason":"Control and treatment differ only in page_size."}' }).chatTransport });
    const ok = await reviewWithBedrock({ packetJson: "{}", llm: good });
    expect(ok.review).toMatchObject({ verdict: "uphold", model: "test-nova-pro" });

    const prose = new LlmClient({ env: ENV, chatTransport: fakeChat({ text: "I think it is fine." }).chatTransport });
    const bad = await reviewWithBedrock({ packetJson: "{}", llm: prose });
    expect(bad.review).toBeNull();
    expect(bad.failure).toMatch(/adversary \(bedrock\)/);

    const boom = new LlmClient({
      env: ENV,
      chatTransport: async () => {
        throw new Error("502 Bad Gateway");
      },
    });
    const failed = await reviewWithBedrock({ packetJson: "{}", llm: boom });
    expect(failed.review).toBeNull();
    expect(failed.failure).toContain("502");

    const blocked = new LlmClient({ env: { ...ENV, LITELLM_API_KEY: "" } });
    await expect(reviewWithBedrock({ packetJson: "{}", llm: blocked })).rejects.toThrow(/^BLOCKED: LITELLM_API_KEY not set/);
  });
});

describe("liteLlmTransport (real openai client, fake fetch)", () => {
  function fakeFetch(reply: (url: string, init: RequestInit) => Response) {
    const seen: { url: string; headers: Headers; body: string | undefined; method: string | undefined }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined, method: init?.method });
      return reply(url, init ?? {});
    }) as typeof fetch;
    return { f, seen };
  }

  it("POSTs <base>/v1/chat/completions once (no /v1/v1, no SDK retries) and captures the cost header", async () => {
    const { f, seen } = fakeFetch(
      () =>
        new Response(JSON.stringify(completion({ text: "OK", prompt: 12, completion: 1 })), {
          status: 200,
          headers: { "content-type": "application/json", "x-litellm-response-cost": "0.000123" },
        }),
    );
    const transport = liteLlmTransport({ baseUrl: normalizeLiteLlmBaseUrl("https://p.example/v1/")!, apiKey: KEY, fetch: f });
    const reply = await transport({ model: "test-haiku", messages: [{ role: "user", content: "hi" }], max_tokens: 5, temperature: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://p.example/v1/chat/completions");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers.get("x-notary-call-id")).toBeNull();
    expect(JSON.parse(seen[0]!.body!)).toMatchObject({ model: "test-haiku", max_tokens: 5, temperature: 0 });
    expect(reply.completion.choices[0]!.message.content).toBe("OK");
    expect(reply.headers).toEqual({ "x-litellm-response-cost": "0.000123" });
  });

  it("does not retry a 429 inside the SDK (Notary's limiter owns retries)", async () => {
    const { f, seen } = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } }),
    );
    const transport = liteLlmTransport({ baseUrl: "https://p.example/v1", apiKey: KEY, fetch: f });
    const err = (await transport({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }).catch((e) => e)) as { status?: number };
    expect(err.status).toBe(429);
    expect(seen).toHaveLength(1);
  });

  it("lists models with GET <base>/v1/models", async () => {
    const { f, seen } = fakeFetch(
      () =>
        new Response(JSON.stringify({ object: "list", data: [{ id: "test-haiku", object: "model", created: 0, owned_by: "x" }, { id: "test-sonnet", object: "model", created: 0, owned_by: "x" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const ids = await liteLlmModelLister({ baseUrl: "https://p.example/v1", apiKey: KEY, fetch: f })();
    expect(ids).toEqual(["test-haiku", "test-sonnet"]);
    expect(seen[0]!.url).toBe("https://p.example/v1/models");
    expect(seen[0]!.method).toBe("GET");
  });
});
