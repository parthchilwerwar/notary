/**
 * TEST DOUBLES ONLY for the Notary Chat tests: a scripted model, an SSE reader and app helpers.
 * Nothing here touches the network and nothing here is a run result.
 */
import { createApp } from "../src/api/server.js";
import type { ApiOptions } from "../src/api/server.js";
import { createSession } from "../src/api/session.js";
import type { CreatedSession } from "../src/api/session.js";
import { ChatStore } from "../src/chat/store.js";
import type { CompleteResult, ToolCall, ToolCompleteRequest, ToolCompleteResult, ToolLlmLike } from "../src/llm/client.js";
import { ChatEventSchema } from "../src/schema/chat.js";
import type { ChatEvent } from "../src/schema/chat.js";

export const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
export const BASE = "http://127.0.0.1:8787";

/** A scripted tool-calling reply: optional text plus native tool calls (args as an object, or raw JSON text). */
export type ToolReply = { text: string; toolCalls: { name: string; args: Record<string, unknown> | string }[] };
export type Reply = string | ToolReply | ((req: ToolCompleteRequest) => string | ToolReply | Promise<string | ToolReply>);

/** One native tool call, as the model would make it (`note` is the text it writes next to the call). */
export const act = (tool: string, args: Record<string, unknown> = {}, note = `Calling ${tool}`): ToolReply => ({ text: note, toolCalls: [{ name: tool, args }] });
/** A tool call with raw argument text (invalid JSON, unknown tools). */
export const rawCall = (tool: string, argumentsText: string, note = ""): ToolReply => ({ text: note, toolCalls: [{ name: tool, args: argumentsText }] });
/**
 * Readability marker kept from the JSON-protocol era: "the model is done calling tools". The double
 * skips it, so the reply after it is the same model call's answer (a reply with no tool calls).
 */
export const FINAL = "\u0000FINAL";

/** Turn a scripted reply into native tool calls with unique ids. */
export function toToolCalls(reply: ToolReply, callNo: number): ToolCall[] {
  return reply.toolCalls.map((c, i) => ({ id: `call_${callNo}_${i}`, name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) }));
}

export type RecordedCall = { messages: { role: string; content: string; toolCalls?: string[] }[]; system?: string; toolChoice?: unknown; tools: string[] };

/** A scripted tool-calling model: each call takes the next reply (FINAL markers skipped). */
export function scriptedLlm(replies: Reply[], opts: { usd?: number; priceSource?: CompleteResult["priceSource"] } = {}): ToolLlmLike & { calls: RecordedCall[] } {
  const queue = [...replies];
  const calls: RecordedCall[] = [];
  const take = async (req: ToolCompleteRequest): Promise<string | ToolReply | undefined> => {
    const next = queue.shift();
    return typeof next === "function" ? await next(req) : next;
  };
  return {
    calls,
    async completeTools(req): Promise<ToolCompleteResult> {
      calls.push({
        messages: req.messages.map((m) => ({ role: m.role, content: m.content, ...(m.role === "assistant" && m.toolCalls?.length ? { toolCalls: m.toolCalls.map((t) => t.name) } : {}) })),
        ...(req.system ? { system: req.system } : {}),
        toolChoice: req.toolChoice,
        tools: req.tools.map((t) => t.name),
      });
      let next = await take(req);
      if (next === FINAL) next = await take(req);
      if (next === undefined) throw new Error("scripted model: no reply left");
      if (req.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const base = { inputTokens: 10, outputTokens: 5, usd: opts.usd ?? 0.001, modelId: "test-model", priceSource: opts.priceSource ?? ("env" as const) };
      if (typeof next === "string") return { ...base, text: next, toolCalls: [], stopReason: "end_turn" };
      return { ...base, text: next.text, toolCalls: toToolCalls(next, calls.length), stopReason: "tool_use" };
    },
  };
}

export function makeApp(opts: Omit<ApiOptions, "session"> & { chatOpts?: NonNullable<ApiOptions["chat"]> } = {}): { app: ReturnType<typeof createApp>; session: CreatedSession; store: ChatStore } {
  const session = createSession();
  const store = new ChatStore(":memory:");
  const { chatOpts, ...rest } = opts;
  const app = createApp({
    bundleDirs: [],
    runsDir: null,
    ...rest,
    session,
    chat: { flush: () => Promise.resolve(true), store, ...chatOpts },
  });
  return { app, session, store };
}

export function req(session: CreatedSession, method: string, path: string, body?: unknown, extra: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.token}`, Host: "127.0.0.1:8787", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...extra,
  });
}

export interface SseFrame {
  event: string;
  data: ChatEvent;
}

/** Parse an SSE body into frames; every data line must be a valid ChatEvent whose type equals the event name. */
export function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split(/\n\n/)) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length) continue;
    const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
    const data = lines
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!event || !data) continue;
    frames.push({ event, data: ChatEventSchema.parse(JSON.parse(data)) });
  }
  return frames;
}

export async function newConversation(app: ReturnType<typeof createApp>, session: CreatedSession): Promise<string> {
  const res = await app.fetch(req(session, "POST", "/api/chat"), LOOPBACK);
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return ((await res.json()) as { conversation: { id: string } }).conversation.id;
}

export async function send(app: ReturnType<typeof createApp>, session: CreatedSession, id: string, content: string): Promise<{ res: Response; frames: SseFrame[]; text: string }> {
  const res = await app.fetch(req(session, "POST", `/api/chat/${id}/messages`, { content }), LOOPBACK);
  const text = await res.text();
  return { res, text, frames: res.headers.get("content-type")?.includes("text/event-stream") ? parseSse(text) : [] };
}

export const events = (frames: SseFrame[]) => frames.map((f) => f.data);
