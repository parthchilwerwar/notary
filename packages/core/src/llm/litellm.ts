/**
 * LiteLLM backend: an OpenAI-compatible proxy reached with the official `openai` client
 * (pinned 6.34.0, the line neatlogs' `wrapOpenAI` is tested against).
 *
 *   new OpenAI({ baseURL: <LITELLM_BASE_URL normalized to …/v1>, apiKey: LITELLM_API_KEY,
 *                maxRetries: 0, timeout, fetch })
 *     .chat.completions.create({ model, messages, max_tokens, temperature: 0 })
 *   → { choices: [{ message: { content }, finish_reason }], usage: { prompt_tokens, completion_tokens } }
 *
 * - `maxRetries: 0`: the SDK's own 429/5xx retries are off; Notary's limiter decides about retries,
 *   so a retried call can never be metered twice.
 * - Tracing: when neatlogs is on the client is wrapped with the SDK's `wrapOpenAI`, which emits the
 *   one LLM span per HTTP call (messages already secret-scrubbed by the caller). Notary's own
 *   `notary.llm` span stays a CHAIN with role / model / tokens / USD (DECISIONS #78).
 * - Response headers: the proxy reports its computed cost in `x-litellm-response-cost`. The neatlogs
 *   proxy returns a plain Promise (no `.withResponse()`), so headers are captured by a fetch wrapper
 *   keyed by a per-call request header that is stripped before the request leaves the process.
 * - The key is only handed to the SDK; it is never put in an error, span attribute or log line here,
 *   and callers scrub every error message with the env scrubber as a backstop.
 */
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { randomUUID } from "node:crypto";
import { tracingEnabled } from "../trace/index.js";

export type ChatRequest = ChatCompletionCreateParamsNonStreaming;
/** One chat completion and the response headers the caller cares about (lowercased names). */
export type ChatReply = { completion: ChatCompletion; headers?: Record<string, string> };
/** Sends one chat completion. Injectable so tests never reach a proxy. */
export type ChatTransport = (body: ChatRequest) => Promise<ChatReply>;
/** Lists the model ids the proxy offers (GET <base>/v1/models). Injectable for tests. */
export type ModelLister = () => Promise<string[]>;

/** Response headers kept from a chat completion. */
export const KEPT_RESPONSE_HEADERS = ["x-litellm-response-cost", "retry-after", "retry-after-ms", "x-ratelimit-reset"] as const;
/** Per-request correlation header (stripped by the fetch wrapper; never sent). */
const CALL_HEADER = "x-notary-call-id";
/** Per-request timeout. Long replies (the reflector may write up to 8000 tokens) need minutes. */
export const LITELLM_TIMEOUT_MS = 300_000;

type OpenAiClient = {
  chat: { completions: { create: (body: ChatRequest, opts?: { headers?: Record<string, string> }) => Promise<ChatCompletion> } };
  models: { list: () => Promise<{ data: { id: string }[] }> & AsyncIterable<{ id: string }> };
};

function pick(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_RESPONSE_HEADERS) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

/** A lazily built `openai` client for one proxy, plus the header side channel. */
function lazyClient(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch }) {
  let client: OpenAiClient | null = null;
  const captured = new Map<string, Record<string, string>>();
  const baseFetch = opts.fetch ?? globalThis.fetch;
  const capturingFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const id = headers.get(CALL_HEADER);
    if (id !== null) headers.delete(CALL_HEADER);
    const res = await baseFetch(input, { ...init, headers });
    if (id !== null) captured.set(id, pick(res.headers));
    return res;
  };
  const get = async (): Promise<OpenAiClient> => {
    if (client) return client;
    const { default: OpenAI } = await import("openai");
    let c = new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey,
      maxRetries: 0,
      timeout: LITELLM_TIMEOUT_MS,
      fetch: capturingFetch,
    }) as unknown as OpenAiClient;
    if (tracingEnabled()) {
      try {
        const { wrapOpenAI } = await import("neatlogs");
        c = wrapOpenAI(c);
      } catch {
        // tracing must never break the call
      }
    }
    client = c;
    return c;
  };
  return { get, captured };
}

/** Default LiteLLM transport: the real proxy through `openai`, created on the first call. */
export function liteLlmTransport(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): ChatTransport {
  const lazy = lazyClient(opts);
  return async (body) => {
    const client = await lazy.get();
    const id = randomUUID();
    try {
      const completion = await client.chat.completions.create(body, { headers: { [CALL_HEADER]: id } });
      return { completion, headers: lazy.captured.get(id) ?? {} };
    } finally {
      lazy.captured.delete(id);
    }
  };
}

/** Default model lister: GET <base>/v1/models with the key. */
export function liteLlmModelLister(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): ModelLister {
  const lazy = lazyClient(opts);
  return async () => {
    const client = await lazy.get();
    const ids: string[] = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  };
}

/**
 * Map an OpenAI `finish_reason` onto the Bedrock stop-reason vocabulary callers already branch on
 * ("max_tokens" marks a truncated reply), so both providers look the same downstream.
 */
export function stopReasonFromFinish(finish: string | null | undefined): string {
  switch (finish) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filtered";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return finish ? String(finish) : "unknown";
  }
}
