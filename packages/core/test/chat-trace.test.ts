/**
 * Notary Chat tracing and secrets: one trace per message (root WORKFLOW -> TOOL per step and the
 * LlmClient's notary.llm CHAIN per model call, the provider's LLM span under it), cost attributes,
 * the scoped local sink, the non-blocking flush, and no secret / session token / message text in
 * events, spans or stored messages. The model is a real LlmClient (LiteLLM provider) over a transport
 * double that streams like the real one and opens an LLM span like wrapOpenAI (no network).
 */
import { AGENTS } from "../src/schema/agents.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnswerSplitter, validateChatCitations } from "../src/chat/citations.js";
import { LlmClient, setLlmWarningSink } from "../src/llm/client.js";
import { collectStream } from "../src/llm/litellm.js";
import type { ChatCallOptions, ChatRequest, ChatReply } from "../src/llm/litellm.js";
import type { HealthResponse } from "../src/schema/api.js";
import { withSpan } from "../src/trace/index.js";
import type { SpanRecord } from "../src/trace/index.js";
import { FINAL, act, events, makeApp, newConversation, send, toToolCalls } from "./chat-helpers.js";
import type { ToolReply } from "./chat-helpers.js";

const PLANTED_ENV = "NOTARY_TEST_PLANTED_SECRET";
const PLANTED = "planted-chat-s3cret-9d2e71";
const LITELLM_KEY = "litellm-test-key-5b8c1f0a";
let root: string;
let prevSink: ReturnType<typeof setLlmWarningSink>;

beforeAll(() => {
  process.env[PLANTED_ENV] = PLANTED;
  process.env.LITELLM_API_KEY_CHAT_TEST = LITELLM_KEY;
  root = mkdtempSync(join(tmpdir(), "notary-chat-trace-"));
  prevSink = setLlmWarningSink(null);
});

afterAll(() => {
  delete process.env[PLANTED_ENV];
  delete process.env.LITELLM_API_KEY_CHAT_TEST;
  setLlmWarningSink(prevSink);
  rmSync(root, { recursive: true, force: true });
});

const ENV = {
  NOTARY_LLM_PROVIDER: "litellm",
  LITELLM_BASE_URL: "http://127.0.0.1:4000",
  LITELLM_API_KEY: LITELLM_KEY,
  NOTARY_MODEL_EXECUTOR: "test-executor",
  NOTARY_MODEL_CHAT: "test-chat",
  [PLANTED_ENV]: PLANTED,
};

/** A LiteLLM transport double: streams through onDelta in chunks and opens an LLM-kind span (like wrapOpenAI). */
function transport(replies: (string | ToolReply)[], opts: { stream?: boolean } = {}) {
  const queue = replies.filter((r) => r !== FINAL);
  let n = 0;
  const bodies: ChatRequest[] = [];
  const t = async (body: ChatRequest, o?: ChatCallOptions): Promise<ChatReply> =>
    await withSpan(
      "fake.provider.chat",
      { "llm.model_name": body.model },
      async () => {
        bodies.push(body);
        const next = queue.shift() ?? "";
        const reply: ToolReply = typeof next === "string" ? { text: next, toolCalls: [] } : next;
        const text = reply.text;
        const calls = toToolCalls(reply, ++n).map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } }));
        if (o?.onDelta && opts.stream !== false) for (let i = 0; i < text.length; i += 5) o.onDelta(text.slice(i, i + 5));
        return {
          completion: {
            id: "c1",
            object: "chat.completion",
            created: 0,
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: text, refusal: null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop", logprobs: null }],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          } as ChatReply["completion"],
          headers: {},
        };
      },
      { kind: "LLM" },
    );
  return Object.assign(t, { bodies });
}

function readSpans(path: string): SpanRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SpanRecord);
}

const health = async (): Promise<HealthResponse> => ({
  ok: true,
  service: "notary serve",
  integrations: [
    { name: "crustdata", state: "error", label: `error rejected key ${PLANTED}`, detail: `detail ${PLANTED}`, fix: `Set CRUSTDATA_API_KEY (was ${PLANTED})`, checkedAt: new Date().toISOString() },
  ],
});

let n = 0;
const sinkFile = () => join(root, `chat-${++n}.jsonl`);

describe("one trace per message", () => {
  it("root WORKFLOW -> AGENT loop -> TOOL step + notary.llm per model call (provider LLM span beneath); done.traceId is the root's", async () => {
    const spansPath = sinkFile();
    const t = transport([act("get_health", {}, "Checking what is connected"), FINAL, 'Crustdata is not connected [1].\nCITATIONS: [{"n":1,"type":"api_response","id":"s1"}]']);
    const env = { ...ENV, NOTARY_PRICE_CHAT_IN: "1", NOTARY_PRICE_CHAT_OUT: "5" };
    let flushes = 0;
    const { app, session } = makeApp({
      chatOpts: { env, llm: () => new LlmClient({ env, chatTransport: t }), spansPath, health, flush: () => ((flushes += 1), new Promise(() => {})) },
    });
    const id = await newConversation(app, session);
    const question = "which integrations are connected right now?";
    const { frames } = await send(app, session, id, question);
    const ev = events(frames);
    const done = ev.at(-1)!;
    if (done.type !== "done") throw new Error(`not done: ${JSON.stringify(ev.at(-1))}`);
    expect(flushes).toBe(1); // started, never awaited (the promise above never settles)

    const spans = readSpans(spansPath);
    const rootSpan = spans.find((s) => s.name === "notary.chat.message")!;
    expect(rootSpan).toMatchObject({ kind: "WORKFLOW", status: "ok" });
    expect(rootSpan.parentSpanId).toBeUndefined();
    expect(done.traceId).toBe(rootSpan.traceId);
    for (const s of spans) expect(s.traceId).toBe(rootSpan.traceId);

    const agent = spans.find((s) => s.name === "notary.chat.agent")!;
    expect(agent).toMatchObject({ kind: "AGENT", parentSpanId: rootSpan.spanId });
    expect(agent.attrs).toMatchObject({ "notary.agent_id": "chat", "notary.chat.steps": 1, "notary.chat.model_calls": 2 });
    const tools = spans.filter((s) => s.name === "notary.chat.tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ kind: "TOOL", parentSpanId: agent.spanId });
    expect(tools[0]!.attrs).toMatchObject({ "notary.tool": "get_health", "notary.chat.tool": "get_health", "notary.chat.step_id": "s1", "notary.chat.status": "ok", "notary.recordIds": "s1", "notary.agent_id": "chat" });

    const llms = spans.filter((s) => s.name === "notary.llm");
    expect(llms).toHaveLength(2);
    for (const l of llms) {
      expect(l).toMatchObject({ kind: "CHAIN", parentSpanId: agent.spanId });
      expect(l.attrs["llm.usd"]).toBeGreaterThan(0);
    }
    // P2: every span of the turn names the agent (AGENTS.chat), model calls included (own role: chat).
    for (const s of [rootSpan, agent, ...tools, ...llms]) expect(s.attrs["notary.agent"]).toBe(AGENTS.chat.name);
    for (const l of llms) expect(l.attrs["notary.role"]).toBe("chat");
    const provider = spans.filter((s) => s.name === "fake.provider.chat");
    expect(provider).toHaveLength(2);
    // The provider got real function tools and, on the second call, the tool call + its tool result.
    expect(t.bodies[0]!.tools!.map((x) => (x as { function: { name: string } }).function.name)).toContain("get_health");
    expect(t.bodies[0]!.tool_choice).toBe("auto");
    const second = t.bodies[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ type: "function", function: { name: "get_health" } }] });
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1_0" });
    for (const p of provider) expect(llms.map((l) => l.spanId)).toContain(p.parentSpanId);

    // Cost attributes on the root, equal to done.
    expect(rootSpan.attrs["notary.chat.usd"]).toBeCloseTo(done.costUsd!, 9);
    expect(done.costUsd).toBeGreaterThan(0);
    expect(rootSpan.attrs).toMatchObject({ "notary.chat.steps": 1, "notary.chat.model_calls": 2, "notary.chat.input_tokens": 40, "notary.chat.output_tokens": 16, "notary.chat.status": "done" });
    expect(done.tokens).toEqual({ input: 40, output: 16 });
    expect(ev.filter((e) => e.type === "text_delta").length).toBeGreaterThan(0);

    // No question text, prompt, token or secret in any attribute.
    const attrs = JSON.stringify(spans.map((s) => s.attrs));
    expect(attrs).not.toContain(question);
    expect(attrs).not.toContain("which integrations");
    expect(attrs).not.toContain(session.token);
    expect(attrs).not.toContain(PLANTED);
    expect(attrs).not.toContain(LITELLM_KEY);
  });

  it("unknown price -> done.costUsd null and usd_unknown on the root", async () => {
    const spansPath = sinkFile();
    const t = transport([FINAL, "Hello.\nCITATIONS: []"], { stream: false });
    const { app, session } = makeApp({ chatOpts: { env: ENV, llm: () => new LlmClient({ env: ENV, chatTransport: t }), spansPath } });
    const id = await newConversation(app, session);
    const ev = events((await send(app, session, id, "hi")).frames);
    const done = ev.at(-1)!;
    if (done.type !== "done") throw new Error("not done");
    expect(done.costUsd).toBeNull();
    const rootSpan = readSpans(spansPath).find((s) => s.name === "notary.chat.message")!;
    expect(rootSpan.attrs["notary.chat.usd_unknown"]).toBe(true);
    // A non-streaming reply is still delivered as text_delta events.
    expect(ev.filter((e) => e.type === "text_delta").map((e) => (e.type === "text_delta" ? e.text : "")).join("")).toBe("Hello.");
  });

  it("a rate-limited send is one short root span", async () => {
    const spansPath = sinkFile();
    const t = transport([FINAL, "ok\nCITATIONS: []"]);
    const { app, session } = makeApp({ chatOpts: { env: { ...ENV, NOTARY_ASK_RPM: "1" }, llm: () => new LlmClient({ env: ENV, chatTransport: t }), spansPath } });
    const id = await newConversation(app, session);
    await send(app, session, id, "one");
    expect((await send(app, session, id, "two")).res.status).toBe(429);
    const roots = readSpans(spansPath).filter((s) => s.name === "notary.chat.message");
    expect(roots).toHaveLength(2);
    expect(roots[1]!.attrs["notary.chat.rate_limited"]).toBe(true);
    expect(roots[1]!.attrs["notary.agent"]).toBe("Notary Chat");
  });
});

describe("secrets never leave", () => {
  it("not in events, spans, stored messages or prompts — even when a tool output carries one", async () => {
    const spansPath = sinkFile();
    const t = transport([act("get_health"), FINAL, `Status: error rejected key ${PLANTED} [1].\nCITATIONS: [{"n":1,"type":"api_response","id":"s1"}]`]);
    const { app, session, store } = makeApp({ chatOpts: { env: ENV, llm: () => new LlmClient({ env: ENV, chatTransport: t }), spansPath, health } });
    const id = await newConversation(app, session);
    const { text } = await send(app, session, id, `is my key ${PLANTED} working?`);
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain(LITELLM_KEY);
    expect(text).toContain("[REDACTED]");
    expect(readFileSync(spansPath, "utf8")).not.toContain(PLANTED);
    expect(readFileSync(spansPath, "utf8")).not.toContain(session.token);
    const stored = JSON.stringify(store.messages(id));
    expect(stored).not.toContain(PLANTED);
    // Prompts sent to the provider are scrubbed too (LlmClient backstop).
    expect(JSON.stringify(t.bodies)).not.toContain(PLANTED);
    expect(JSON.stringify(t.bodies)).not.toContain(session.token);
  });
});

describe("streaming plumbing", () => {
  it("collectStream passes deltas on and assembles the completion with usage", async () => {
    async function* chunks() {
      yield { id: "x", model: "m", choices: [{ delta: { content: "Hel" } }] };
      yield { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] };
      yield { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
    }
    const seen: string[] = [];
    const c = await collectStream(chunks(), (d) => seen.push(d), "m");
    expect(seen).toEqual(["Hel", "lo"]);
    expect(c.choices[0]!.message.content).toBe("Hello");
    expect(c.choices[0]!.finish_reason).toBe("stop");
    expect(c.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2 });
  });

  it("an aborted LlmClient call rejects before any request and records no usage", async () => {
    const t = transport(["never"]);
    const llm = new LlmClient({ env: ENV, chatTransport: t });
    const ac = new AbortController();
    ac.abort();
    await expect(llm.complete({ role: "executor", messages: [{ role: "user", content: "x" }], signal: ac.signal })).rejects.toThrow();
    expect(t.bodies).toHaveLength(0);
    expect(llm.meter.snapshot().executor.calls).toBe(0);
  });

  it("AnswerSplitter strips the CITATIONS line even when the sentinel is split across deltas", () => {
    const s = new AnswerSplitter();
    let shown = "";
    for (const d of ["The answer [1] is", " here.\nCITA", "TIONS: [{\"n\":1,", "\"type\":\"run\",\"id\":\"r\"}]"]) shown += s.push(d);
    const end = s.end();
    shown += end.text;
    expect(shown).toBe("The answer [1] is here.\n");
    expect(end.block).toContain('"type":"run"');
    const v = validateChatCitations(shown, end.block, [{ id: "s1", status: "ok", citables: [{ type: "run", id: "r", label: "Run r" }] }]);
    expect(v.items).toEqual([{ n: 1, type: "run", id: "r", label: "Run r", stepId: "s1", valid: true }]);

    const plain = new AnswerSplitter();
    expect(plain.push("No citations at all, CITATIONS: mid-line stays") + plain.end().text).toBe("No citations at all, CITATIONS: mid-line stays");
  });
});
