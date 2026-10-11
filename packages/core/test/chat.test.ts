/**
 * Notary Chat API (POST/GET/DELETE /api/chat, POST /api/chat/:id/messages): persistence, token and
 * localhost rules, NOTARY_ASK_RPM, the SSE event contract, the agent loop (tools, missing keys,
 * citations, multi-turn history, malformed replies), Stop, and the keyless BLOCKED path.
 * Model and network are doubles only. Bundles are the synthetic sample re-flagged as real (test data,
 * never a run result).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSampleBundle, finalizeBundle, writeBundle } from "../src/bundle/index.js";
import { ChatStore, NEW_CONVERSATION_TITLE, titleFrom } from "../src/chat/store.js";
import { publishTimeline } from "../src/timeline/write.js";
import { ConversationDetailSchema, ConversationsListSchema } from "../src/schema/chat.js";
import type { ChatEvent } from "../src/schema/chat.js";
import type { RunBundle } from "../src/schema/index.js";
import { FINAL, LOOPBACK, act, events, makeApp, newConversation, req, scriptedLlm, send } from "./chat-helpers.js";

let root: string;
let realDir: string;
let real: RunBundle;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "notary-chat-"));
  realDir = join(root, "runs", "real-chat-run");
  real = finalizeBundle({ ...buildSampleBundle(7), runId: "real-chat-run", sample: false });
  await writeBundle(real, realDir);
  await publishTimeline(real, realDir, { expectSample: false });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const answer = (text: string, cites: unknown[]) => `${text}\nCITATIONS: ${JSON.stringify(cites)}`;

describe("persistence (sqlite store)", () => {
  it("CRUD over the API: create, list newest first, detail, delete", async () => {
    const llm = scriptedLlm([FINAL, answer("Hello. Nothing to look up.", [])]);
    const { app, session } = makeApp({ chatOpts: { llm: () => llm } });
    const a = await newConversation(app, session);
    const b = await newConversation(app, session);
    let list = ConversationsListSchema.parse(await (await app.fetch(req(session, "GET", "/api/chat"), LOOPBACK)).json());
    expect(list.conversations.map((c) => c.id)).toEqual([b, a]);
    expect(list.conversations[0]!.title).toBe(NEW_CONVERSATION_TITLE);

    // Sending to `a` makes it the newest and gives it the first message as title.
    const sent = await send(app, session, a, "hi there, what can you do?");
    expect(sent.res.status).toBe(200);
    list = ConversationsListSchema.parse(await (await app.fetch(req(session, "GET", "/api/chat"), LOOPBACK)).json());
    expect(list.conversations.map((c) => c.id)).toEqual([a, b]);
    expect(list.conversations[0]!.title).toBe("hi there, what can you do?");

    const detail = ConversationDetailSchema.parse(await (await app.fetch(req(session, "GET", `/api/chat/${a}`), LOOPBACK)).json());
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[1]!.content).toBe("Hello. Nothing to look up.");
    expect(detail.messages[1]!.events!.map((e) => e.type)).toEqual(events(sent.frames).map((e) => e.type));

    expect((await app.fetch(req(session, "DELETE", `/api/chat/${a}`), LOOPBACK)).status).toBe(204);
    expect((await app.fetch(req(session, "GET", `/api/chat/${a}`), LOOPBACK)).status).toBe(404);
    expect((await app.fetch(req(session, "DELETE", `/api/chat/${a}`), LOOPBACK)).status).toBe(404);
    expect((await app.fetch(req(session, "GET", "/api/chat/not-an-id"), LOOPBACK)).status).toBe(400);
  });

  it("titles are the first user message, truncated; rows survive a reopen of the file", () => {
    expect(titleFrom("  short   question ")).toBe("short question");
    const long = "why was the refund for the enterprise customer held when the policy said it should go through automatically";
    const t = titleFrom(long);
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith("…")).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "notary-chat-db-"));
    const file = join(dir, "chat.sqlite");
    const s1 = new ChatStore(file);
    const c = s1.createConversation();
    s1.addUserMessage(c.id, long);
    s1.addAssistantMessage(c.id, "answer", [{ type: "error", message: "x" }]);
    s1.close();
    const s2 = new ChatStore(file);
    expect(s2.getConversation(c.id)!.title).toBe(t);
    expect(s2.messages(c.id).map((m) => m.content)).toEqual([long, "answer"]);
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("token + localhost on every /api/chat route", () => {
  it("401 without the token, 403 from a non-loopback socket or Host", async () => {
    const { app, session } = makeApp();
    const id = await newConversation(app, session);
    const routes: [string, string, unknown?][] = [
      ["POST", "/api/chat"],
      ["GET", "/api/chat"],
      ["GET", `/api/chat/${id}`],
      ["DELETE", `/api/chat/${id}`],
      ["POST", `/api/chat/${id}/messages`, { content: "hi" }],
    ];
    for (const [method, path, body] of routes) {
      const noToken = new Request(`http://127.0.0.1:8787${path}`, { method, headers: { Host: "127.0.0.1:8787", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect((await app.fetch(noToken, LOOPBACK)).status, `${method} ${path} no token`).toBe(401);
      expect((await app.fetch(req(session, method, path, body), { incoming: { socket: { remoteAddress: "10.0.0.5" } } })).status, `${method} ${path} remote`).toBe(403);
      const badHost = req(session, method, path, body);
      badHost.headers.set("Host", "evil.example");
      expect((await app.fetch(badHost, LOOPBACK)).status, `${method} ${path} host`).toBe(403);
    }
    // Nothing was created or sent by the refused requests.
    const list = ConversationsListSchema.parse(await (await app.fetch(req(session, "GET", "/api/chat"), LOOPBACK)).json());
    expect(list.conversations).toHaveLength(1);
  });

  it("400 on a bad body, 404 on an unknown conversation", async () => {
    const { app, session } = makeApp({ chatOpts: { llm: () => scriptedLlm([]) } });
    const id = await newConversation(app, session);
    expect((await app.fetch(req(session, "POST", `/api/chat/${id}/messages`, { content: "" }), LOOPBACK)).status).toBe(400);
    expect((await app.fetch(req(session, "POST", `/api/chat/${id}/messages`, { text: "hi" }), LOOPBACK)).status).toBe(400);
    expect((await app.fetch(req(session, "POST", `/api/chat/conv-00000000-0000-0000-0000-000000000000/messages`, { content: "hi" }), LOOPBACK)).status).toBe(404);
  });
});

describe("NOTARY_ASK_RPM applies to message sends", () => {
  it("429 + Retry-After over the limit, no model call, nothing stored", async () => {
    let t = 1_000_000;
    const llm = scriptedLlm([FINAL, answer("One.", [])]);
    const { app, session, store } = makeApp({ chatOpts: { llm: () => llm, env: { NOTARY_ASK_RPM: "1" }, now: () => t } });
    const id = await newConversation(app, session);
    expect((await send(app, session, id, "first")).res.status).toBe(200);
    const second = await send(app, session, id, "second");
    expect(second.res.status).toBe(429);
    expect(Number(second.res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(second.text).toContain("NOTARY_ASK_RPM");
    expect(llm.calls).toHaveLength(2);
    expect(store.messages(id).map((m) => m.content)).toEqual(["first", "One."]);
    t += 61_000;
    // Listing and creating are not rate limited.
    expect((await app.fetch(req(session, "GET", "/api/chat"), LOOPBACK)).status).toBe(200);
  });
});

describe("no model configured", () => {
  it("the stream carries one error naming the variable and pointing to doctor --llm; nothing fake", async () => {
    const env = { NOTARY_LLM_PROVIDER: "litellm", LITELLM_BASE_URL: "http://127.0.0.1:4000", NOTARY_MODEL_EXECUTOR: "claude-haiku" };
    const { app, session, store } = makeApp({ chatOpts: { env } });
    const id = await newConversation(app, session);
    const { res, frames } = await send(app, session, id, "what certificates exist?");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(frames).toHaveLength(1);
    const e = frames[0]!.data;
    expect(e.type).toBe("error");
    if (e.type !== "error") throw new Error("unreachable");
    expect(e.message).toContain("LITELLM_API_KEY");
    expect(e.fix).toContain("LITELLM_API_KEY");
    expect(e.fix).toContain("pnpm notary doctor --llm");
    const msgs = store.messages(id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.content).toBe("");
    expect(msgs[1]!.events).toEqual([e]);
  });
});

describe("SSE contract and the agent loop", () => {
  const opts = (llm: ReturnType<typeof scriptedLlm>, extra: Record<string, unknown> = {}) => ({
    bundleDirs: [realDir],
    chatOpts: { llm: () => llm, env: {}, ...extra },
  });

  it("events arrive in order, each `event:` equals its type, every one parses with ChatEventSchema; done is last", async () => {
    const llm = scriptedLlm([
      act("list_runs", {}, "First I will list the real runs on this server"),
      act("get_run_events", { runId: real.runId, filter: "decision" }, "Now the decision events of that run"),
      FINAL,
      answer(`There is one real run, ${real.runId} [1], and it has decision events [2].`, [
        { n: 1, type: "run", id: real.runId, stepId: "s1" },
        { n: 2, type: "api_response", id: "s2" },
      ]),
    ]);
    const { app, session } = makeApp(opts(llm));
    const id = await newConversation(app, session);
    const { frames } = await send(app, session, id, "what runs are there?");
    for (const f of frames) expect(f.event).toBe(f.data.type);
    const types = frames.map((f) => f.event);
    expect(types.slice(0, 6)).toEqual(["note", "step_started", "step_finished", "note", "step_started", "step_finished"]);
    expect(types.filter((t) => t === "text_delta").length).toBeGreaterThan(1);
    const firstText = types.indexOf("text_delta");
    expect(types.slice(firstText, -2).every((t) => t === "text_delta")).toBe(true);
    expect(types.slice(-2)).toEqual(["citations", "done"]);

    const ev = events(frames);
    const s1 = ev.find((e): e is Extract<ChatEvent, { type: "step_started" }> => e.type === "step_started")!;
    expect(s1).toMatchObject({ id: "s1", tool: "list_runs" });
    const f1 = ev.find((e): e is Extract<ChatEvent, { type: "step_finished" }> => e.type === "step_finished" && e.id === "s1")!;
    expect(f1.status).toBe("ok");
    expect(f1.output).toContain("1 real run");
    // Step-card shapes the UI recognizes: runs table, run-event rows { events: [{ seq, summary, runId }] }.
    expect((f1.data as { runs: unknown[] }).runs).toHaveLength(1);
    const f2 = ev.find((e): e is Extract<ChatEvent, { type: "step_finished" }> => e.type === "step_finished" && e.id === "s2")!;
    const rows = (f2.data as { events: { seq: number; summary: string; runId: string }[] }).events;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatchObject({ runId: real.runId, seq: expect.any(Number), summary: expect.any(String) });
    const text = ev.filter((e) => e.type === "text_delta").map((e) => (e.type === "text_delta" ? e.text : "")).join("");
    expect(text).toContain(`[1]`);
    expect(text).not.toContain("CITATIONS");
    const cites = ev.find((e) => e.type === "citations");
    if (cites?.type !== "citations") throw new Error("no citations");
    expect(cites.items.map((c) => [c.n, c.type, c.valid, c.stepId])).toEqual([
      [1, "run", true, "s1"],
      [2, "api_response", true, "s2"],
    ]);
    const done = ev[ev.length - 1]!;
    if (done.type !== "done") throw new Error("not done");
    expect(done).toMatchObject({ mode: "live", steps: 2, tokens: { input: 40, output: 20 } });
    expect(done.costUsd).toBeCloseTo(0.004, 9);
    expect(done.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("a missing key: step `unavailable` + fix, the model is told it could not check", async () => {
    const llm = scriptedLlm([
      act("crustdata_lookup", { company: "acme.com" }, "Looking up Acme in Crustdata"),
      FINAL,
      answer("I could not check Acme in Crustdata: it is not connected.", []),
    ]);
    const { app, session } = makeApp(opts(llm));
    const id = await newConversation(app, session);
    const { frames } = await send(app, session, id, "how many employees does acme.com have?");
    const fin = events(frames).find((e) => e.type === "step_finished");
    if (fin?.type !== "step_finished") throw new Error("no step");
    expect(fin.status).toBe("unavailable");
    expect(fin.fix).toBe("Not connected — set CRUSTDATA_API_KEY in .env");
    // The model's next call saw the UNAVAILABLE result.
    const told = llm.calls[1]!.messages[llm.calls[1]!.messages.length - 1]!.content;
    expect(told).toContain("UNAVAILABLE");
    expect(told).toContain("CRUSTDATA_API_KEY");
    expect(told).toMatch(/could not check/i);
  });

  it("citations are validated against this turn's step outputs: a fake one is flagged, an unlisted marker too, extras dropped", async () => {
    const llm = scriptedLlm([
      act("list_runs"),
      FINAL,
      answer(`Run ${real.runId} exists [1]. It holds certificate cert-00000000deadbeef [2]. And a run nobody listed [3]. Unsourced [4].`, [
        { n: 1, type: "run", id: real.runId, stepId: "s1" },
        { n: 2, type: "certificate", id: "cert-00000000deadbeef", stepId: "s1" },
        { n: 3, type: "run", id: "run-that-does-not-exist", stepId: "s1" },
        { n: 9, type: "run", id: real.runId },
      ]),
    ]);
    const { app, session, store } = makeApp(opts(llm));
    const id = await newConversation(app, session);
    const { frames } = await send(app, session, id, "what's in the runs?");
    const cites = events(frames).find((e) => e.type === "citations");
    if (cites?.type !== "citations") throw new Error("no citations");
    expect(cites.items.map((c) => [c.n, c.valid])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ]);
    expect(cites.items[1]!.label).toContain("not in this turn's step outputs");
    expect(cites.items.find((c) => c.n === 9)).toBeUndefined();
    // Stored exactly as streamed (a reload shows the same flags).
    const stored = store.messages(id)[1]!.events!.find((e) => e.type === "citations");
    expect(stored).toEqual(cites);
  });

  it("a citation from an earlier turn is not valid in this one", async () => {
    const llm = scriptedLlm([
      act("list_runs"),
      FINAL,
      answer(`There is ${real.runId} [1].`, [{ n: 1, type: "run", id: real.runId, stepId: "s1" }]),
      FINAL,
      answer(`As before, ${real.runId} [1].`, [{ n: 1, type: "run", id: real.runId, stepId: "s1" }]),
    ]);
    const { app, session } = makeApp(opts(llm));
    const id = await newConversation(app, session);
    await send(app, session, id, "list the runs");
    const { frames } = await send(app, session, id, "and again?");
    const cites = events(frames).find((e) => e.type === "citations");
    if (cites?.type !== "citations") throw new Error("no citations");
    expect(cites.items[0]!.valid).toBe(false);
  });

  it("multi-turn: the full history (earlier questions, answers and their steps) goes to the model", async () => {
    const llm = scriptedLlm([
      act("list_runs"),
      FINAL,
      answer(`The real run is ${real.runId} [1].`, [{ n: 1, type: "run", id: real.runId, stepId: "s1" }]),
      act("get_run", { id: real.runId }, "Opening the run named in my last answer"),
      FINAL,
      answer(`It is ${real.status} [1].`, [{ n: 1, type: "run", id: real.runId, stepId: "s1" }]),
    ]);
    const { app, session } = makeApp(opts(llm));
    const id = await newConversation(app, session);
    await send(app, session, id, "which runs exist?");
    const { frames } = await send(app, session, id, "what is the status of that one?");
    const second = llm.calls[3]!.messages;
    expect(second[0]).toEqual({ role: "user", content: "which runs exist?" });
    expect(second[1]!.role).toBe("assistant");
    expect(second[1]!.content).toContain(`The real run is ${real.runId} [1].`);
    expect(second[1]!.content).toContain("list_runs");
    expect(second[2]).toEqual({ role: "user", content: "what is the status of that one?" });
    const cites = events(frames).find((e) => e.type === "citations");
    if (cites?.type !== "citations") throw new Error("no citations");
    expect(cites.items[0]!.valid).toBe(true);
  });

  it("a malformed action gets one retry; a second malformed reply ends with an error event (steps kept)", async () => {
    const ok = scriptedLlm(["sure! let me look", act("list_runs"), FINAL, answer("Done [1].", [{ n: 1, type: "api_response", id: "s1" }])]);
    let app = makeApp(opts(ok));
    let id = await newConversation(app.app, app.session);
    let r = await send(app.app, app.session, id, "runs?");
    expect(events(r.frames).at(-1)!.type).toBe("done");
    expect(ok.calls[1]!.messages.at(-1)!.content).toContain("not a valid action");

    const bad = scriptedLlm([act("list_runs"), "nope", JSON.stringify({ tool: "refund_everything", args: {} })]);
    app = makeApp(opts(bad));
    id = await newConversation(app.app, app.session);
    r = await send(app.app, app.session, id, "runs?");
    const ev = events(r.frames);
    expect(ev.map((e) => e.type)).toEqual(["note", "step_started", "step_finished", "error"]);
    const err = ev.at(-1)!;
    if (err.type !== "error") throw new Error("unreachable");
    expect(err.message).toMatch(/not a valid action twice/);
    expect(err.fix).toBeTruthy();
    expect(app.store.messages(id)[1]!.events).toEqual(ev);
  });

  it("bounded: at most 8 tool steps per turn, then the answer", async () => {
    const replies = Array.from({ length: 12 }, (_, i) => act("get_run_events", { runId: real.runId, filter: `w${i}` }));
    const llm = scriptedLlm([...replies.slice(0, 8), answer("Enough [1].", [{ n: 1, type: "api_response", id: "s8" }])]);
    const { app, session } = makeApp(opts(llm));
    const id = await newConversation(app, session);
    const { frames } = await send(app, session, id, "dig");
    const ev = events(frames);
    expect(ev.filter((e) => e.type === "step_started")).toHaveLength(8);
    expect(llm.calls).toHaveLength(9);
    expect(ev.at(-1)!.type).toBe("done");
  });

  it("notes are model-written, at most ~20 words, source model", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const llm = scriptedLlm([act("list_runs", {}, long), FINAL, answer("ok [1]", [{ n: 1, type: "api_response", id: "s1" }])]);
    const { app, session } = makeApp(opts(llm));
    const id = await newConversation(app, session);
    const note = events((await send(app, session, id, "x")).frames).find((e) => e.type === "note");
    if (note?.type !== "note") throw new Error("no note");
    expect(note.source).toBe("model");
    expect(note.text.split(" ").length).toBeLessThanOrEqual(20);
  });

  it("a model failure (USD cap) becomes an error event with a fix", async () => {
    const llm = {
      async complete() {
        const { UsdCapExceededError } = await import("../src/llm/budget.js");
        throw new UsdCapExceededError("executor", 0.01, 0.01, 0.002);
      },
    };
    const { app, session } = makeApp({ chatOpts: { llm: () => llm, env: {} } });
    const id = await newConversation(app, session);
    const ev = events((await send(app, session, id, "x")).frames);
    expect(ev).toHaveLength(1);
    const e = ev[0]!;
    if (e.type !== "error") throw new Error("unreachable");
    expect(e.message).toMatch(/NOTARY_MAX_USD/);
    expect(e.fix).toMatch(/NOTARY_MAX_USD/);
  });

  it("refuses a second concurrent message in the same conversation (409)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const llm = scriptedLlm([
      async () => {
        await gate;
        return FINAL;
      },
      answer("ok", []),
    ]);
    const { app, session } = makeApp(opts(llm));
    const id = await newConversation(app, session);
    const first = app.fetch(req(session, "POST", `/api/chat/${id}/messages`, { content: "a" }), LOOPBACK);
    const firstRes = await first;
    const body = firstRes.text();
    await new Promise((r) => setTimeout(r, 20));
    const second = await app.fetch(req(session, "POST", `/api/chat/${id}/messages`, { content: "b" }), LOOPBACK);
    expect(second.status).toBe(409);
    release();
    await body;
  });
});

describe("Stop: client abort mid-stream", () => {
  it("aborts the in-flight tool, stops the loop and stores the partial message with an aborted step", async () => {
    let fetchSawAbort = false;
    let fetchCalled!: () => void;
    const fetchStarted = new Promise<void>((r) => (fetchCalled = r));
    const hangingFetch = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        fetchCalled();
        init.signal!.addEventListener("abort", () => {
          fetchSawAbort = true;
          rej(init.signal!.reason);
        });
      })) as unknown as typeof fetch;
    const llm = scriptedLlm([act("fetch_doc", { url: "https://docs.dodopayments.com/api-reference/refunds/create-refund" }, "Reading the Dodo refund docs"), FINAL, answer("never", [])]);
    const { app, session, store } = makeApp({ chatOpts: { llm: () => llm, env: {}, fetch: hangingFetch } });
    const id = await newConversation(app, session);
    const ac = new AbortController();
    const res = await app.fetch(req(session, "POST", `/api/chat/${id}/messages`, { content: "what do the docs say about refunds?" }, { signal: ac.signal }), LOOPBACK);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("event: step_started")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    await fetchStarted;
    ac.abort();
    await reader.cancel().catch(() => undefined);

    let msgs = store.messages(id);
    for (let i = 0; i < 100 && msgs.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
      msgs = store.messages(id);
    }
    expect(fetchSawAbort).toBe(true);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const ev = msgs[1]!.events!;
    expect(ev.map((e) => e.type)).toEqual(["note", "step_started", "step_finished", "error"]);
    const fin = ev[2]!;
    if (fin.type !== "step_finished") throw new Error("unreachable");
    expect(fin.status).toBe("aborted");
    const err = ev[3]!;
    if (err.type !== "error") throw new Error("unreachable");
    expect(err.message).toMatch(/Stopped/);
    // No orphaned work: the model was not called again after the stop.
    await new Promise((r) => setTimeout(r, 50));
    expect(llm.calls).toHaveLength(1);
    // The conversation accepts a new message afterwards.
    const llm2Reply = await send(app, session, id, "ok, never mind");
    expect(llm2Reply.res.status).toBe(200);
  });

  it("a stop during the streamed answer cancels the model call and keeps the partial text", async () => {
    let modelSawAbort = false;
    let call = 0;
    const llm = {
      async complete(r: import("../src/llm/client.js").CompleteRequest) {
        call += 1;
        if (call === 1) return { text: FINAL, inputTokens: 1, outputTokens: 1, usd: 0, modelId: "m", stopReason: "end_turn" };
        r.onText?.("Partial answer so far");
        await new Promise<void>((resolve) => r.signal!.addEventListener("abort", () => resolve(), { once: true }));
        modelSawAbort = true;
        throw new DOMException("aborted", "AbortError");
      },
    };
    const { app, session, store } = makeApp({ chatOpts: { llm: () => llm, env: {} } });
    const id = await newConversation(app, session);
    const ac = new AbortController();
    const res = await app.fetch(req(session, "POST", `/api/chat/${id}/messages`, { content: "explain" }, { signal: ac.signal }), LOOPBACK);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("event: text_delta")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    ac.abort();
    await reader.cancel().catch(() => undefined);
    let msgs = store.messages(id);
    for (let i = 0; i < 100 && msgs.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
      msgs = store.messages(id);
    }
    expect(modelSawAbort).toBe(true);
    expect(msgs[1]!.content).toBe("Partial answer so far");
    const types = msgs[1]!.events!.map((e) => e.type);
    expect(types.at(-1)).toBe("error");
    expect(types).not.toContain("done");
    expect(types).not.toContain("citations");
  });
});
