// Live Notary Chat: REST + SSE-over-POST against a local `notary serve` (contract:
// core/src/schema/chat.ts). Every endpoint needs the per-session token. Each streamed `data:` is
// parsed with ChatEventSchema; an invalid event becomes one `error` event and the rest of the
// stream is dropped (never rendered). Aborting the signal is the Stop button: the request is
// cancelled and sendMessage resolves quietly.
import {
  ChatEventSchema,
  ConversationDetailSchema,
  ConversationsListSchema,
  CreateConversationResponseSchema,
  SendMessageBodySchema,
} from "../../../core/src/schema";
import type { ChatConversation, ChatEvent, ConversationDetail } from "../../../core/src/schema";
import { globalFetch, type FetchImpl } from "./http";
import { apiRequest, LocalApiError, readToken, TOKEN_REQUIRED } from "./local-api";
import { SseParser } from "./chat-sse";
import type { ChatSource } from "./types";

export const CHAT_INVALID_EVENT =
  "The local API sent a chat event that does not match the shared schema. The rest of this answer is withheld.";
export const CHAT_STREAM_CLOSED = "The local API closed the stream before the answer finished.";
export const CHAT_MESSAGE_INVALID = "Type a question (at most 4000 characters).";

const invalid = (what: string) =>
  new Error(`The local API returned ${what} that does not match the shared chat schema. Data withheld.`);

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

export class LiveChat implements ChatSource {
  private readonly base: string;
  private readonly fetchImpl: FetchImpl;
  private readonly token: () => string | null;

  constructor(opts: { base: string; fetchImpl?: FetchImpl; token?: () => string | null }) {
    this.base = opts.base;
    this.fetchImpl = opts.fetchImpl ?? globalFetch;
    this.token = opts.token ?? readToken;
  }

  private request(path: string, init: RequestInit = {}) {
    return apiRequest(this.base, path, init, { auth: "required", token: this.token(), fetchImpl: this.fetchImpl });
  }

  async listConversations(signal?: AbortSignal): Promise<ChatConversation[]> {
    const r = ConversationsListSchema.safeParse((await this.request("/api/chat", { signal })).body);
    if (!r.success) throw invalid("a conversation list");
    return r.data.conversations;
  }

  async getConversation(id: string, signal?: AbortSignal): Promise<ConversationDetail> {
    const r = ConversationDetailSchema.safeParse((await this.request(`/api/chat/${encodeURIComponent(id)}`, { signal })).body);
    if (!r.success) throw invalid("a conversation");
    return r.data;
  }

  async createConversation(): Promise<ChatConversation> {
    const r = CreateConversationResponseSchema.safeParse((await this.request("/api/chat", { method: "POST", body: "{}" })).body);
    if (!r.success) throw invalid("a new conversation");
    return r.data.conversation;
  }

  async deleteConversation(id: string): Promise<void> {
    await this.request(`/api/chat/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async sendMessage(
    conversationId: string,
    content: string,
    onEvent: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = SendMessageBodySchema.safeParse({ content });
    if (!body.success) throw new Error(CHAT_MESSAGE_INVALID);
    const token = this.token();
    if (!token) throw new LocalApiError(401, TOKEN_REQUIRED);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/api/chat/${encodeURIComponent(conversationId)}/messages`, {
        method: "POST",
        body: JSON.stringify(body.data),
        signal,
        cache: "no-store",
        headers: { accept: "text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      if (isAbort(e) || signal?.aborted) return;
      throw e;
    }
    if (!response.ok) {
      let message = `Request failed (${response.status}).`;
      try {
        const raw = (await response.json()) as { error?: unknown };
        if (typeof raw?.error === "string") message = raw.error;
      } catch {
        if (response.status === 401) message = "The session token was rejected. Paste the token from the current `notary serve`.";
      }
      throw new LocalApiError(response.status, message);
    }
    if (!response.body) {
      onEvent({ type: "error", message: CHAT_STREAM_CLOSED });
      return;
    }
    await readChatStream(response.body, onEvent, signal);
  }
}

/**
 * Read a chat SSE body to the end: schema-checked events in order; stops after `done` or `error`;
 * an invalid event → one `error` event, then the stream is cancelled. Exported for tests.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let finished = false;
  const stop = () => {
    finished = true;
    void reader.cancel().catch(() => {});
  };
  const onAbort = () => stop();
  signal?.addEventListener("abort", onAbort);
  const handle = (data: string) => {
    if (finished) return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      raw = undefined;
    }
    const parsed = ChatEventSchema.safeParse(raw);
    if (!parsed.success) {
      onEvent({ type: "error", message: CHAT_INVALID_EVENT });
      stop();
      return;
    }
    onEvent(parsed.data);
    if (parsed.data.type === "done" || parsed.data.type === "error") stop();
  };
  try {
    while (!finished) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (isAbort(e) || signal?.aborted || finished) return;
        throw e;
      }
      if (chunk.done) {
        for (const m of parser.end()) handle(m.data);
        break;
      }
      for (const m of parser.push(decoder.decode(chunk.value, { stream: true }))) handle(m.data);
    }
    if (!finished && !signal?.aborted) onEvent({ type: "error", message: CHAT_STREAM_CLOSED });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
