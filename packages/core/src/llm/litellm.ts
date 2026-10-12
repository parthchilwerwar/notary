/**
 * LiteLLM backend: an OpenAI-compatible proxy reached with the official `openai` client
 * (pinned 6.34.0, the line neatlogs' `wrapOpenAI` is tested against).
 *
 *   new OpenAI({ baseURL: <LITELLM_BASE_URL normalized to …/v1>, apiKey: LITELLM_API_KEY,
 *                maxRetries: 0, timeout, fetch })
 *     .chat.completions.create({ model, messages, max_tokens, temperature: 0 })
 *   → { choices: [{ message: { content }, finish_reason }], usage: { prompt_tokens, completion_tokens } }
 *
 * Tool calling (Notary Chat): the same call with `tools: [{type:"function", function:{name,
 * description, parameters}}]` and `tool_choice`; the reply's `message.tool_calls` carry
 * `{id, type:"function", function:{name, arguments}}` (finish_reason "tool_calls" → stop reason
 * "tool_use"). Results go back as `{role:"tool", tool_call_id, content}` after the assistant message
 * that holds the calls. Streamed replies assemble tool-call deltas by `index` (collectStream).
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
/**
 * Per-call options: `signal` cancels the HTTP request; `onDelta` asks for a streamed reply
 * (`stream: true`, `stream_options.include_usage`), each text delta passed on as it arrives. The
 * reply is still returned whole (a completion assembled from the chunks), so pricing, usage and
 * stop reasons are identical to the non-streamed path.
 */
export type ChatCallOptions = { signal?: AbortSignal; onDelta?: (delta: string) => void };
/** Sends one chat completion. Injectable so tests never reach a proxy. */
export type ChatTransport = (body: ChatRequest, opts?: ChatCallOptions) => Promise<ChatReply>;
/** Lists the model ids the proxy offers (GET <base>/v1/models). Injectable for tests. */
export type ModelLister = () => Promise<string[]>;

/** Response headers kept from a chat completion. */
export const KEPT_RESPONSE_HEADERS = ["x-litellm-response-cost", "retry-after", "retry-after-ms", "x-ratelimit-reset"] as const;
/** Per-request correlation header (stripped by the fetch wrapper; never sent). */
const CALL_HEADER = "x-notary-call-id";
/** Per-request timeout. Long replies (the reflector may write up to 8000 tokens) need minutes. */
export const LITELLM_TIMEOUT_MS = 300_000;

type CreateOpts = { headers?: Record<string, string>; signal?: AbortSignal };
/** One streamed chunk (the fields Notary reads). */
type StreamChunk = {
  id?: string;
  model?: string;
  created?: number;
  choices?: {
    delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[] | null };
    finish_reason?: string | null;
  }[];
  usage?: ChatCompletion["usage"] | null;
};
type OpenAiClient = {
  chat: { completions: { create: (body: ChatRequest | Record<string, unknown>, opts?: CreateOpts) => Promise<ChatCompletion | AsyncIterable<StreamChunk>> } };
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
  return async (body, opts) => {
    const client = await lazy.get();
    const id = randomUUID();
    const reqOpts: CreateOpts = { headers: { [CALL_HEADER]: id }, ...(opts?.signal ? { signal: opts.signal } : {}) };
    try {
      if (!opts?.onDelta) {
        const completion = (await client.chat.completions.create(body, reqOpts)) as ChatCompletion;
        return { completion, headers: lazy.captured.get(id) ?? {} };
      }
      const stream = (await client.chat.completions.create({ ...body, stream: true, stream_options: { include_usage: true } }, reqOpts)) as AsyncIterable<StreamChunk>;
      const completion = await collectStream(stream, opts.onDelta, body.model);
      return { completion, headers: lazy.captured.get(id) ?? {} };
    } finally {
      lazy.captured.delete(id);
    }
  };
}

/** Read a streamed chat completion, passing each text delta on, and assemble the whole completion. */
export async function collectStream(stream: AsyncIterable<StreamChunk>, onDelta: (delta: string) => void, model: string): Promise<ChatCompletion> {
  let text = "";
  let finish: string | null = null;
  let usage: ChatCompletion["usage"] | undefined;
  let id = "";
  let created = 0;
  let modelId = model;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const chunk of stream) {
    if (chunk.id) id = chunk.id;
    if (chunk.created) created = chunk.created;
    if (chunk.model) modelId = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      text += delta;
      onDelta(delta);
    }
    for (const tc of choice?.delta?.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const cur = calls.get(i) ?? { id: "", name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(i, cur);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } }));
  return {
    id,
    object: "chat.completion",
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text, refusal: null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: (finish ?? "stop") as "stop",
        logprobs: null,
      },
    ],
    ...(usage ? { usage } : {}),
  } as ChatCompletion;
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
