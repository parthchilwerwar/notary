// Notary Chat data layer: the deterministic replay engine (against the real published files) and
// the live chat client (mocked fetch, SSE over POST).
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatEventSchema, type ChatEvent } from "../../core/src/schema";
import {
  CHAT_INVALID_EVENT,
  CHAT_STREAM_CLOSED,
  LiveChat,
  LocalApiError,
  PublishedFiles,
  REPLAY_UNAVAILABLE,
  ReplaySource,
  SseParser,
  memoryChatStore,
  routeQuestion,
  sentences,
  sessionChatStore,
  worldKeyOf,
  type ChatStore,
} from "../src/data";

const PUBLIC = new URL("../public/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, PUBLIC), "utf8"));

function diskFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^\//, "");
    const file = new URL(path, PUBLIC);
    if (!existsSync(file)) return new Response("", { status: 404, statusText: "Not Found" });
    return new Response(readFileSync(file, "utf8"), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

let ids = 0;
function replay(store: ChatStore = memoryChatStore()) {
  return new ReplaySource({
    published: new PublishedFiles({ base: "/", fetchImpl: diskFetch() }),
    chat: { store, pace: "instant", now: () => 0, clock: () => new Date("2026-10-11T00:00:00.000Z"), newId: () => `id${++ids}` },
  });
}

async function ask(src: ReplaySource, runId: string, question: string, conversationId?: string) {
  src.chat.setContext({ runId });
  const id = conversationId ?? (await src.chat.createConversation()).id;
  const events: ChatEvent[] = [];
  await src.chat.sendMessage(id, question, (e) => events.push(e));
  return { id, events };
}

const text = (events: ChatEvent[]) => events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
const steps = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { type: "step_started" }> => e.type === "step_started");
const finished = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { type: "step_finished" }> => e.type === "step_finished");
const citations = (events: ChatEvent[]) => events.flatMap((e) => (e.type === "citations" ? e.items : []));

/** The contract order: steps/notes, then text, then exactly one citations and one done, last. */
function expectContractOrder(events: ChatEvent[]) {
  for (const e of events) expect(ChatEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
  const types = events.map((e) => e.type);
  expect(types.at(-1)).toBe("done");
  expect(types.at(-2)).toBe("citations");
  expect(types.filter((t) => t === "done")).toHaveLength(1);
  const firstText = types.indexOf("text_delta");
  expect(firstText).toBeGreaterThan(0);
  expect(types.slice(firstText, -2).every((t) => t === "text_delta")).toBe(true);
  // Every step that started finished, before the next one started.
  const open: string[] = [];
  for (const e of events) {
    if (e.type === "step_started") {
      expect(open).toEqual([]);
      open.push(e.id);
    }
    if (e.type === "step_finished") expect(open.pop()).toBe(e.id);
  }
  expect(open).toEqual([]);
  const done = events.at(-1) as Extract<ChatEvent, { type: "done" }>;
  expect(done).toMatchObject({ mode: "replay", costUsd: null, tokens: { input: 0, output: 0 } });
  expect(done.steps).toBe(steps(events).length);
  // Every [n] in the text has a citation; every citation is valid and names a step of this turn.
  const cites = citations(events);
  const markers = [...text(events).matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  for (const n of markers) expect(cites.some((c) => c.n === n), `[${n}]`).toBe(true);
  const stepIds = new Set(steps(events).map((s) => s.id));
  for (const c of cites) {
    expect(c.valid).toBe(true);
    expect(stepIds.has(c.stepId!)).toBe(true);
  }
}

const bundle = (id: string) => read(`bundles/fixture/${id}.json`);

describe("replay chat engine", () => {
  it("answers why a refund was held with steps, an explain-backed answer and valid citations", async () => {
    const { events } = await ask(replay(), "demo-run-guarded", "Why was refund q02 held?");
    expectContractOrder(events);
    expect(events[0]).toMatchObject({ type: "note", source: "replay" });
    expect(steps(events).map((s) => s.tool)).toEqual(expect.arrayContaining(["get_run_events", "get_approval"]));
    expect(finished(events).every((s) => s.status === "ok")).toBe(true);
    const answer = text(events);
    expect(answer).toContain("q02");
    expect(answer).toContain("why_held:demo-run-guarded:demo-run-guarded:q02");
    const kinds = new Set(citations(events).map((c) => c.type));
    expect(kinds.has("run_event")).toBe(true);
    expect(kinds.has("approval")).toBe(true);
    expect(citations(events).find((c) => c.type === "run_event")!.id).toMatch(/^demo-run-guarded#\d+$/);
  });

  it("emits live-only tools as unavailable steps with the variable to set, never as a blocking error", async () => {
    const { events } = await ask(replay(), "demo-run-guarded", "Look up Acme Corp in Crustdata");
    expectContractOrder(events);
    const lookup = steps(events).find((s) => s.tool === "crustdata_lookup")!;
    expect(lookup.title).toBe("Looking up Acme Corp in Crustdata");
    const done = finished(events).find((s) => s.id === lookup.id)!;
    expect(done.status).toBe("unavailable");
    expect(done.fix).toBe(REPLAY_UNAVAILABLE.crustdata_lookup);
    expect(done.fix).toContain("CRUSTDATA_API_KEY");
    expect(events.some((e) => e.type === "error")).toBe(false);
    // It still answers from the records: crustdata certificates of the same world.
    expect(steps(events).some((s) => s.tool === "search_certificates")).toBe(true);

    const dodo = await ask(replay(), "demo-run-guarded", "Look up pay_123 in Dodo");
    expect(finished(dodo.events).find((s) => s.status === "unavailable")!.fix).toContain("DODO_PAYMENTS_API_KEY");
    const doc = await ask(replay(), "demo-run-guarded", "Open https://docs.crustdata.com/enrich and summarize it");
    const docStep = steps(doc.events).find((s) => s.tool === "fetch_doc")!;
    expect(docStep.title).toBe("Opening docs.crustdata.com/enrich");
    expect(finished(doc.events).find((s) => s.id === docStep.id)!.status).toBe("unavailable");
    const health = await ask(replay(), "demo-run-guarded", "Which integrations are connected?");
    expect(finished(health.events)[0]).toMatchObject({ status: "ok", output: "Replay: no live integrations are connected" });
  });

  it("never mixes worlds: a change-api conversation only cites change-api records", async () => {
    const src = replay();
    const changeApi = await ask(src, "demo-change-api-run-guarded", "Which certificates were revoked?");
    expectContractOrder(changeApi.events);
    const defaultWorld = await ask(src, "demo-run-guarded", "Which certificates were revoked?");
    const certIds = (scenario: string) =>
      new Set(["dodo", "crustdata"].flatMap((t) => read(`certificates/fixture/${scenario}/${t}.json`).certificates.map((c: { id: string }) => c.id)));
    const changeCerts = certIds("change-api");
    const defaultCerts = certIds("default");
    expect([...changeCerts].some((id) => defaultCerts.has(id))).toBe(false);
    for (const c of citations(changeApi.events)) {
      if (c.type === "certificate") expect(changeCerts.has(c.id)).toBe(true);
      if (c.type === "run" || c.type === "run_event") expect(c.id.startsWith("demo-change-api")).toBe(true);
    }
    for (const c of citations(defaultWorld.events)) if (c.type === "certificate") expect(defaultCerts.has(c.id)).toBe(true);
    expect(text(changeApi.events)).toContain("fixture scenario change-api");
    expect(text(defaultWorld.events)).not.toContain("change-api");

    // Runs listed by any step belong to the conversation's world only.
    const runsTurn = await ask(src, "demo-run-guarded", "What runs are recorded?");
    const world = worldKeyOf(bundle("demo-run-guarded"));
    const listed = finished(runsTurn.events).flatMap((s) => ((s.data as { kind?: string; runs?: { runId: string }[] })?.kind === "runs" ? (s.data as { runs: { runId: string }[] }).runs : []));
    expect(listed.length).toBeGreaterThan(0);
    for (const r of listed) expect(worldKeyOf(bundle(r.runId))).toBe(world);
  });

  it("pins a conversation to the run it started with, even after the dashboard switches runs", async () => {
    const src = replay();
    src.chat.setContext({ runId: "demo-change-api-run-guarded" });
    const { id } = await src.chat.createConversation();
    src.chat.setContext({ runId: "demo-run-guarded" });
    const events: ChatEvent[] = [];
    await src.chat.sendMessage(id, "What runs are recorded?", (e) => events.push(e));
    for (const c of citations(events)) if (c.type === "run") expect(c.id.startsWith("demo-change-api")).toBe(true);
  });

  it("answers what the adversary rejected in the last run that recorded verdicts", async () => {
    const { events } = await ask(replay(), "demo-run-guarded", "What did the adversary reject in the last run?");
    expectContractOrder(events);
    const answer = text(events);
    expect(answer).toMatch(/demo-notarize-(dodo|crustdata)/);
    expect(answer).toContain("downgrade");
    expect(citations(events).some((c) => c.type === "run_event")).toBe(true);
  });

  it("resolves a follow-up (“that one”) against the previous turn's cited records", async () => {
    const src = replay();
    const first = await ask(src, "demo-change-api-run-guarded", "Which certificates were revoked?");
    const firstCert = citations(first.events).find((c) => c.type === "certificate")!;
    const follow = await ask(src, "demo-change-api-run-guarded", "Tell me more about that one", first.id);
    expectContractOrder(follow.events);
    const note = follow.events.find((e) => e.type === "note");
    expect(note && note.type === "note" && note.text).toContain(firstCert.id);
    expect(steps(follow.events).some((s) => s.tool === "get_certificate" && s.input === firstCert.id)).toBe(true);
    // Without a previous answer a pronoun matches nothing in particular.
    const fresh = await ask(src, "demo-change-api-run-guarded", "Tell me more about that one");
    expect(steps(fresh.events).every((s) => s.tool === "list_runs")).toBe(true);
  });

  it("persists conversations with their events, titles them from the first question, deletes them", async () => {
    const store = memoryChatStore();
    const src = replay(store);
    const { id, events } = await ask(src, "demo-run-guarded", "Why was refund q02 held?");
    const detail = await src.chat.getConversation(id);
    expect(detail.conversation.title).toBe("Why was refund q02 held?");
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[1]!.events).toEqual(events);
    expect(detail.messages[1]!.content).toBe(text(events));
    expect((await src.chat.listConversations()).map((c) => c.id)).toEqual([id]);
    await src.chat.deleteConversation(id);
    expect(await src.chat.listConversations()).toEqual([]);
  });

  it("stops at once when aborted and records only what was emitted", async () => {
    const src = replay();
    src.chat.setContext({ runId: "demo-run-guarded" });
    const { id } = await src.chat.createConversation();
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    await src.chat.sendMessage(id, "Why was refund q02 held?", (e) => {
      events.push(e);
      if (e.type === "step_started") controller.abort();
    }, controller.signal);
    expect(events.map((e) => e.type)).toEqual(["note", "step_started"]);
    const detail = await src.chat.getConversation(id);
    expect(detail.messages[1]!.events).toEqual(events);
  });

  it("session store survives a reload and falls back to memory when storage throws", () => {
    const backing = new Map<string, string>();
    const storage = { getItem: (k: string) => backing.get(k) ?? null, setItem: (k: string, v: string) => void backing.set(k, v) };
    const conv = { conversation: { id: "c1", title: "t", createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z" }, messages: [] };
    sessionChatStore("k", storage).save([conv]);
    expect(sessionChatStore("k", storage).load()).toEqual([conv]);
    backing.set("k", "{not json");
    expect(sessionChatStore("k", storage).load()).toEqual([]);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const s = sessionChatStore("k", broken);
    s.save([conv]);
    expect(s.load()).toEqual([conv]);
  });

  it("routes by keywords and ids", () => {
    const ctx = { runIds: ["demo-change-api-run-guarded", "demo-run-guarded"], claimIds: ["dodo.refund.amount-minor-units"] };
    expect(routeQuestion("Why was refund q02 held?", ctx).intents).toEqual([{ kind: "why_held", requestId: "q02", runId: undefined }]);
    expect(routeQuestion("What do we know about dodo's refund.amount-minor-units?", ctx).intents).toEqual([
      { kind: "certificate", certId: undefined, claimId: "dodo.refund.amount-minor-units", tool: "dodo" },
    ]);
    // A run id with "change" in it is not a "what changed" question.
    expect(routeQuestion("What happened in demo-change-api-run-guarded?", ctx).intents).toEqual([{ kind: "runs", runId: "demo-change-api-run-guarded" }]);
    expect(routeQuestion("What changed between naive and guarded?", ctx).intents[0]).toEqual({ kind: "run_diff" });
    expect(routeQuestion("Look up Acme Corp in Crustdata", ctx).intents).toEqual([
      { kind: "lookup", tool: "crustdata_lookup", subject: "Acme Corp" },
      { kind: "certificate", tool: "crustdata" },
    ]);
    expect(routeQuestion("hello there", ctx).intents).toEqual([]);
  });

  it("splits explain text into sentences without breaking numbers", () => {
    expect(sentences("P(holds)=0.6230 crossed back. Then it was retired at 2026-10-10T08:46:25.650Z. Done.")).toEqual([
      "P(holds)=0.6230 crossed back.",
      "Then it was retired at 2026-10-10T08:46:25.650Z.",
      "Done.",
    ]);
    // Code-built sentences can start with a claim id; quoted (model) text stays one piece.
    expect(sentences('Certified: 2 claims. dodo.refunds.amount-integer: matches. Review: "One. Two." Next.')).toEqual([
      "Certified: 2 claims.",
      "dodo.refunds.amount-integer: matches.",
      'Review: "One. Two."',
      "Next.",
    ]);
  });
});

// ---------------------------------------------------------------------------------------- live

const enc = new TextEncoder();
function sseBody(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}
const sse = (events: unknown[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const DONE = { type: "done", costUsd: 0.012, tokens: { input: 10, output: 20 }, steps: 1, durationMs: 420, mode: "live" };
const STEP = { type: "step_started", id: "s1", tool: "crustdata_lookup", title: "Looking up Acme Corp in Crustdata", input: "Acme Corp" };

function liveChat(response: () => Response | Promise<Response>, token: string | null = "tok") {
  const fetchImpl = vi.fn(async () => response()) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  return { chat: new LiveChat({ base: "http://localhost:8787", fetchImpl, token: () => token }), fetchImpl };
}

afterEach(() => vi.restoreAllMocks());

describe("live chat client", () => {
  it("POSTs the message with the token and parses SSE split at any byte", async () => {
    const whole = sse([STEP, { type: "text_delta", text: "Héllo [1]" }, DONE]);
    // Split into 3-byte chunks (inside JSON, inside a multi-byte character, inside "\n\n").
    const bytes = enc.encode(whole);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    });
    const { chat, fetchImpl } = liveChat(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const events: ChatEvent[] = [];
    await chat.sendMessage("c1", "Look up Acme Corp in Crustdata", (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(["step_started", "text_delta", "done"]);
    expect(events[1]).toEqual({ type: "text_delta", text: "Héllo [1]" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://localhost:8787/api/chat/c1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ content: "Look up Acme Corp in Crustdata" });
  });

  it("turns an invalid event into one error event and drops the rest of the stream", async () => {
    const { chat } = liveChat(() => new Response(sseBody([sse([STEP]), `data: {"type":"step_started","id":1}\n\n`, sse([DONE])])));
    const events: ChatEvent[] = [];
    await chat.sendMessage("c1", "q", (e) => events.push(e));
    expect(events).toEqual([STEP, { type: "error", message: CHAT_INVALID_EVENT }]);
  });

  it("reports a stream that closes before done", async () => {
    const { chat } = liveChat(() => new Response(sseBody([sse([STEP])])));
    const events: ChatEvent[] = [];
    await chat.sendMessage("c1", "q", (e) => events.push(e));
    expect(events.at(-1)).toEqual({ type: "error", message: CHAT_STREAM_CLOSED });
  });

  it("Stop aborts the request and resolves without an error event", async () => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controllerRef = c;
        c.enqueue(enc.encode(sse([STEP])));
      },
    });
    const { chat } = liveChat(() => new Response(body));
    const abort = new AbortController();
    const events: ChatEvent[] = [];
    const sending = chat.sendMessage("c1", "q", (e) => {
      events.push(e);
      if (e.type === "step_started") abort.abort();
    }, abort.signal);
    await sending;
    expect(events).toEqual([STEP]);
    expect(controllerRef).toBeDefined();
  });

  it("needs the session token and surfaces the server's error text", async () => {
    const { chat, fetchImpl } = liveChat(() => new Response("{}"), null);
    await expect(chat.sendMessage("c1", "q", () => {})).rejects.toBeInstanceOf(LocalApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
    const denied = liveChat(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json" } }));
    await expect(denied.chat.sendMessage("c1", "q", () => {})).rejects.toThrow("rate limited");
  });

  it("validates REST shapes", async () => {
    const conv = { id: "c1", title: "t", createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z" };
    const ok = liveChat(() => new Response(JSON.stringify({ conversations: [conv] }), { headers: { "content-type": "application/json" } }));
    expect(await ok.chat.listConversations()).toEqual([conv]);
    const bad = liveChat(() => new Response(JSON.stringify({ conversations: [{ id: 1 }] }), { headers: { "content-type": "application/json" } }));
    await expect(bad.chat.listConversations()).rejects.toThrow(/shared chat schema/);
  });

  it("SseParser handles CRLF, comments, multi-line data and a final message without a blank line", () => {
    const p = new SseParser();
    expect(p.push(": hi\r\nevent: note\r\ndata: a\r\ndata: b\r")).toEqual([]);
    expect(p.push("\n\r\n")).toEqual([{ event: "note", data: "a\nb" }]);
    expect(p.push("data: tail")).toEqual([]);
    expect(p.end()).toEqual([{ data: "tail" }]);
  });
});
