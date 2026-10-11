// Notary Chat on the local API (C1). Contract: src/schema/chat.ts. All routes: localhost + the
// per-session token (session.ts), like /api/ask.
//
//   POST   /api/chat                 -> 201 { conversation }              (title "New conversation")
//   GET    /api/chat                 -> { conversations }                  newest first
//   GET    /api/chat/:id             -> { conversation, messages }         404 unknown
//   DELETE /api/chat/:id             -> 204                                404 unknown
//   POST   /api/chat/:id/messages {content}
//          -> text/event-stream: `event: <type>` + `data: <ChatEvent JSON>`, in order, ending with
//             exactly one `done` or `error`. Before the stream: 400 bad body, 404 unknown conversation,
//             409 a message is already being answered in it, 429 + Retry-After over NOTARY_ASK_RPM
//             (per session, shared limiter code with /api/ask; only accepted sends count).
//
// The first user message becomes the conversation's title (truncated). The user message is stored
// before the turn starts; the assistant message (answer text + every event as streamed) is stored when
// the turn ends — done, error, or stopped (client disconnect / abort = Stop: the in-flight model call
// and tool are cancelled, the partial message is kept with status "aborted" on the in-flight step and a
// "Stopped" error event). Storage: <runsDir>/chat.sqlite (runs/ is gitignored).
//
// No model configured (llmBlockedReason: NOTARY_MODEL_EXECUTOR + LITELLM_BASE_URL/LITELLM_API_KEY or
// AWS_REGION per NOTARY_LLM_PROVIDER): the stream carries one `error` naming the variable with a fix
// pointing to `pnpm notary doctor --llm`; nothing else is produced.
//
// Tracing: one trace per message — `notary.chat.message` (WORKFLOW root: sizes, steps, model calls,
// tokens, USD or usd_unknown, citations total/invalid, status) -> `notary.chat.tool` (TOOL, one per
// step: tool, step id, status, duration, credits) and `notary.llm` (CHAIN, opened by LlmClient, with
// the provider wrapper's LLM span under it). Never the message text, prompts, the token or a secret in
// attributes. Spans sink to <runsDir>/_chat/spans.jsonl (withSpanSink); a flush is started after every
// message and never awaited.
//
// Read-only by construction: the chat module (this file + src/chat/*) imports no approval, queue,
// guard, runs-starting, store or certify code (test/chat-safety.test.ts walks the import graph); the
// certificate, approvals and health readers are injected by server.ts.
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { scrubber, streamScrubber } from "../llm/client.js";
import { LlmClient } from "../llm/client.js";
import type { LlmLike } from "../llm/client.js";
import { llmBlockedReason, llmConfigIssues } from "../llm/config.js";
import { ChatEventSchema, ConversationDetailSchema, ConversationsListSchema, CreateConversationResponseSchema, SendMessageBodySchema } from "../schema/chat.js";
import type { ChatEvent } from "../schema/chat.js";
import { CreditLedger } from "../tools/ledger.js";
import type { CreateToolsOptions, Tools } from "../tools/index.js";
import { flushTracing, withSpan, withSpanSink } from "../trace/index.js";
import { runTurn } from "../chat/agent.js";
import type { TurnResult } from "../chat/agent.js";
import type { DocResult } from "../chat/docs.js";
import { ChatStore } from "../chat/store.js";
import type { ChatSources } from "../chat/tools.js";
import { ASK_RPM_ENV, SlidingWindowLimiter, askRpm, retryAfterSeconds } from "./ask-limit.js";
import { loadVerifiedBundles } from "./bundle-source.js";
import { requireLocalSession } from "./session.js";
import type { ApiSession } from "./session.js";

type Env = Record<string, string | undefined>;

/** Directory under runs/ holding serve's chat spans (a leading "_" can never be a run id). */
export const CHAT_SPANS_DIR = "_chat";
export const CHAT_DB_FILE = "chat.sqlite";
const CONVERSATION_ID = /^conv-[0-9a-f-]{36}$/;
/** fetch_doc results kept per conversation. */
const DOC_CACHE_PER_CONVERSATION = 32;

export interface ChatOptions extends ChatSources {
  session: ApiSession;
  /** runs/ ; null: no local runs (the store is then in memory unless dbPath is given). */
  runsDir: string | null;
  /** The bundle directories serve loads (read per tool call). */
  bundleDirs: () => string[];
  env?: Env;
  /** SQLite file; default <runsDir>/chat.sqlite, ":memory:" when runsDir is null. */
  dbPath?: string;
  /** Test seam: an already-open store. */
  store?: ChatStore;
  /** Test seam: the model for one turn. Default: a fresh LlmClient per message (NOTARY_MAX_USD per message). */
  llm?: () => LlmLike;
  /** fetch_doc transport (test seam). */
  fetch?: typeof fetch;
  /** Test seam: build the Crustdata/Dodo tool clients (default createTools). */
  makeTools?: (opts: CreateToolsOptions) => Tools;
  /** Crustdata credit ledger shared by every chat in this server; default from CRUSTDATA_CREDIT_BUDGET. */
  ledger?: CreditLedger;
  /** Span sink for chat spans; undefined = the process-wide sink. createApp passes <runsDir>/_chat/spans.jsonl. */
  spansPath?: string | null;
  /** Started (never awaited) after every message. Default flushTracing. */
  flush?: () => Promise<unknown>;
  /** Messages per minute per session; default NOTARY_ASK_RPM, else 10. */
  rpm?: number;
  now?: () => number;
  maxSteps?: number;
}

function startFlush(flush: () => Promise<unknown>): void {
  try {
    void Promise.resolve(flush()).catch(() => undefined);
  } catch {
    // an export problem never reaches the response
  }
}

async function readBody(c: Context): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, error: "body must be JSON" };
  }
  const parsed = SendMessageBodySchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: `invalid message: ${parsed.error.issues[0]?.message ?? "invalid"} (content: 1-4000 characters)` };
  return { ok: true, content: parsed.data.content };
}

/** The `error` event for a missing/invalid model configuration, or null when the executor can be called. */
export function chatBlockedEvent(env: Env): Extract<ChatEvent, { type: "error" }> | null {
  const reason = llmBlockedReason(env, "executor");
  if (!reason) return null;
  const variable = llmConfigIssues(env, "executor")[0]?.variable;
  return {
    type: "error",
    message: reason,
    fix: variable
      ? `Set ${variable} in .env (see .env.example), restart \`pnpm notary serve\`, then run \`pnpm notary doctor --llm\``
      : "Fix the model settings in .env, restart `pnpm notary serve`, then run `pnpm notary doctor --llm`",
  };
}

export function mountChat(app: Hono, opts: ChatOptions): { store: () => ChatStore } {
  const env = opts.env ?? process.env;
  const clean = scrubber(env);
  // Opened on the first chat request, so a server (or test) that never chats never creates or locks the file.
  let opened: ChatStore | undefined = opts.store;
  const getStore = (): ChatStore => (opened ??= new ChatStore(opts.dbPath ?? (opts.runsDir === null ? ":memory:" : join(opts.runsDir, CHAT_DB_FILE))));
  const limit = askRpm(env, opts.rpm);
  if (limit.problem) console.warn(`notary serve: ${limit.problem}`);
  const limiter = new SlidingWindowLimiter({ limit: limit.rpm, ...(opts.now ? { now: opts.now } : {}) });
  const ledger = opts.ledger ?? new CreditLedger({ env: env as NodeJS.ProcessEnv });
  const docCaches = new Map<string, Map<string, DocResult>>();
  const busy = new Set<string>();
  const guard = requireLocalSession(opts.session);

  const docCache = (id: string): Map<string, DocResult> => {
    let m = docCaches.get(id);
    if (!m) {
      m = new Map();
      docCaches.set(id, m);
    }
    while (m.size > DOC_CACHE_PER_CONVERSATION) m.delete(m.keys().next().value!);
    return m;
  };

  /** Scrub every string of an event (secret env values) and validate it against the contract. */
  const scrubEvent = (e: ChatEvent): ChatEvent => ChatEventSchema.parse(JSON.parse(clean(JSON.stringify(e))));

  const traced = <T>(fn: () => Promise<T>): Promise<T> => (opts.spansPath === undefined ? fn() : withSpanSink(opts.spansPath, fn));

  app.post("/api/chat", guard, (c) => c.json(CreateConversationResponseSchema.parse({ conversation: getStore().createConversation() }), 201));

  app.get("/api/chat", guard, (c) => c.json(ConversationsListSchema.parse({ conversations: getStore().listConversations() })));

  app.get("/api/chat/:id", guard, (c) => {
    const id = c.req.param("id");
    if (!CONVERSATION_ID.test(id)) return c.json({ error: "invalid conversation id" }, 400);
    const conversation = getStore().getConversation(id);
    if (!conversation) return c.json({ error: `unknown conversation ${id}` }, 404);
    return c.json(ConversationDetailSchema.parse({ conversation, messages: getStore().messages(id) }));
  });

  app.delete("/api/chat/:id", guard, (c) => {
    const id = c.req.param("id");
    if (!CONVERSATION_ID.test(id)) return c.json({ error: "invalid conversation id" }, 400);
    if (busy.has(id)) return c.json({ error: "a message is being answered in this conversation; stop it first" }, 409);
    if (!getStore().deleteConversation(id)) return c.json({ error: `unknown conversation ${id}` }, 404);
    docCaches.delete(id);
    return c.body(null, 204);
  });

  app.post("/api/chat/:id/messages", guard, async (c) => {
    const id = c.req.param("id");
    if (!CONVERSATION_ID.test(id)) return c.json({ error: "invalid conversation id" }, 400);
    const body = await readBody(c);
    if (!body.ok) return c.json({ error: body.error }, 400);
    if (!getStore().getConversation(id)) return c.json({ error: `unknown conversation ${id}` }, 404);
    if (busy.has(id)) return c.json({ error: "a message is already being answered in this conversation" }, 409);
    const gate = limiter.take();
    if (!gate.ok) {
      const retryAfterS = retryAfterSeconds(gate.retryAfterMs);
      await traced(() =>
        withSpan(
          "notary.chat.message",
          { "notary.chat.rate_limited": true, "notary.chat.rpm": limit.rpm, "notary.chat.retry_after_s": retryAfterS, "notary.chat.content_chars": body.content.length },
          () => ({ rateLimited: true }),
          { kind: "WORKFLOW" },
        ),
      ).finally(() => startFlush(opts.flush ?? flushTracing));
      c.header("Retry-After", String(retryAfterS));
      return c.json({ error: `rate limited: at most ${limit.rpm} chat messages per minute (${ASK_RPM_ENV})` }, 429);
    }

    busy.add(id);
    const history = getStore().messages(id);
    // A secret env value typed into the chat is never stored or sent on (the model prompt is scrubbed again by LlmClient).
    const content = clean(body.content);
    getStore().addUserMessage(id, content);

    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      const reqSignal = c.req.raw.signal;
      if (reqSignal.aborted) ac.abort();
      else reqSignal.addEventListener("abort", () => ac.abort(), { once: true });

      const events: ChatEvent[] = [];
      let chain: Promise<unknown> = Promise.resolve();
      const emit = (e: ChatEvent): void => {
        const ev = scrubEvent(e);
        events.push(ev);
        chain = chain.then(async () => {
          if (stream.aborted || stream.closed) return;
          try {
            await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
          } catch {
            // client went away; the turn notices through the abort signal
          }
        });
      };

      let turn: TurnResult | undefined;
      try {
        const blocked = opts.llm ? null : chatBlockedEvent(env);
        let llm: LlmLike | null = null;
        let configError: Extract<ChatEvent, { type: "error" }> | null = blocked;
        if (!configError) {
          try {
            llm = opts.llm ? opts.llm() : new LlmClient({ env });
          } catch (err) {
            configError = { type: "error", message: `Model configuration is invalid: ${err instanceof Error ? err.message : String(err)}`, fix: "Fix the model settings in .env, restart `pnpm notary serve`, then run `pnpm notary doctor --llm`" };
          }
        }
        let traceId: string | undefined;
        let setRoot: ((k: string, v: string | number | boolean) => void) | undefined;
        await traced(() =>
          withSpan(
            "notary.chat.message",
            { "notary.chat.content_chars": body.content.length, "notary.chat.history_messages": history.length, "notary.chat.model_configured": configError === null },
            async (): Promise<{ status: string }> => {
              if (configError || !llm) {
                emit(configError!);
                setRoot?.("notary.chat.status", "error");
                setRoot?.("notary.chat.blocked", true);
                return { status: "error" };
              }
              turn = await runTurn(
                { history, content },
                {
                  llm,
                  emit,
                  signal: ac.signal,
                  clean,
                  streamClean: () => streamScrubber(env),
                  traceId: () => traceId,
                  ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
                  tools: {
                    env,
                    loadBundles: () => loadVerifiedBundles(opts.bundleDirs()),
                    runsDir: opts.runsDir,
                    docCache: docCache(id),
                    ledger,
                    maxUsd: llm instanceof LlmClient ? llm.maxUsd : null,
                    ...(opts.fetch ? { fetch: opts.fetch } : {}),
                    ...(opts.makeTools ? { makeTools: opts.makeTools } : {}),
                    ...(opts.certificates ? { certificates: opts.certificates } : {}),
                    ...(opts.approvals ? { approvals: opts.approvals } : {}),
                    ...(opts.health ? { health: opts.health } : {}),
                  },
                },
              );
              const t = turn;
              setRoot?.("notary.chat.status", t.status);
              setRoot?.("notary.chat.steps", t.steps);
              setRoot?.("notary.chat.model_calls", t.modelCalls);
              setRoot?.("notary.chat.input_tokens", t.tokens.input);
              setRoot?.("notary.chat.output_tokens", t.tokens.output);
              if (t.costUsd === null) setRoot?.("notary.chat.usd_unknown", true);
              else setRoot?.("notary.chat.usd", t.costUsd);
              setRoot?.("notary.chat.citations", t.citations.total);
              setRoot?.("notary.chat.citations_invalid", t.citations.invalid);
              setRoot?.("notary.chat.money_request", t.moneyRequest);
              setRoot?.("notary.chat.answer_chars", t.content.length);
              if (t.error) setRoot?.("notary.chat.reason", t.error.slice(0, 200));
              return { status: t.status };
            },
            {
              kind: "WORKFLOW",
              onSpan: (ids, set) => {
                traceId = ids.traceId;
                setRoot = set;
              },
            },
          ),
        );
      } catch (err) {
        if (!events.some((e) => e.type === "done" || e.type === "error")) {
          emit({ type: "error", message: `Chat failed: ${clean(err instanceof Error ? err.message : String(err))}`, fix: "See the `notary serve` terminal" });
        }
      } finally {
        try {
          getStore().addAssistantMessage(id, turn?.content ?? "", events);
        } catch (err) {
          console.warn(`notary serve: could not store the chat answer: ${clean(err instanceof Error ? err.message : String(err))}`);
        }
        busy.delete(id);
        startFlush(opts.flush ?? flushTracing);
        await chain;
      }
    });
  });

  return { store: getStore };
}
