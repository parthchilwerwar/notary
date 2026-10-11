/**
 * TEST DOUBLES ONLY for the Notary Chat tests: a scripted model, an SSE reader and app helpers.
 * Nothing here touches the network and nothing here is a run result.
 */
import { createApp } from "../src/api/server.js";
import type { ApiOptions } from "../src/api/server.js";
import { createSession } from "../src/api/session.js";
import type { CreatedSession } from "../src/api/session.js";
import { ChatStore } from "../src/chat/store.js";
import type { CompleteRequest, CompleteResult, LlmLike } from "../src/llm/client.js";
import { ChatEventSchema } from "../src/schema/chat.js";
import type { ChatEvent } from "../src/schema/chat.js";

export const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
export const BASE = "http://127.0.0.1:8787";

export type Reply = string | ((req: CompleteRequest) => string | Promise<string>);

/** A scripted model: each call takes the next reply; streams it through onText in small pieces. */
export function scriptedLlm(replies: Reply[], opts: { usd?: number; priceSource?: CompleteResult["priceSource"] } = {}): LlmLike & { calls: { messages: { role: string; content: string }[]; system?: string }[] } {
  const queue = [...replies];
  const calls: { messages: { role: string; content: string }[]; system?: string }[] = [];
  return {
    calls,
    async complete(req) {
      calls.push({ messages: req.messages.map((m) => ({ role: m.role, content: m.content })), ...(req.system ? { system: req.system } : {}) });
      const next = queue.shift();
      if (next === undefined) throw new Error("scripted model: no reply left");
      const text = typeof next === "function" ? await next(req) : next;
      if (req.signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (req.onText) for (let i = 0; i < text.length; i += 7) req.onText(text.slice(i, i + 7));
      return { text, inputTokens: 10, outputTokens: 5, usd: opts.usd ?? 0.001, modelId: "test-model", stopReason: "end_turn", priceSource: opts.priceSource ?? "env" };
    },
  };
}

export const act = (tool: string, args: Record<string, unknown> = {}, note = `Calling ${tool}`) => JSON.stringify({ note, tool, args });
export const FINAL = JSON.stringify({ note: "I have enough to answer", final: true });

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
