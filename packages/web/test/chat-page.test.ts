// Notary Chat page: pure model (reducer, wording, citations, step cards, suggestions, auto-scroll),
// the markdown renderer, and static renders of MessageView.
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ChatCitation, ChatEvent, RunBundle } from "../../core/src/schema";
import { BundleIndexSchema } from "../../core/src/schema/bundle";
import { PublishedFiles, ReplaySource, memoryChatStore, validateBundle, worldKeyOf } from "../src/data";
import {
  EMPTY_TURN,
  FIXED_PROMPTS,
  INITIAL_FOLLOW,
  afterContentGrew,
  afterScroll,
  applyChatEvent,
  buildSuggestions,
  buildSuggestionCards,
  domainOf,
  citationHref,
  citationTarget,
  classifyStepData,
  costText,
  durationText,
  jumpToLatest,
  noteTag,
  reduceChatEvents,
  stepTitle,
  stopTurn,
  traceHref,
  turnSteps,
  unknownMarkers,
  workSummary,
} from "../src/pages/chat/model";
import { inlineText, parseInline, parseMarkdown, safeHref } from "../src/pages/chat/markdown";
import { MessageView } from "../src/pages/chat/MessageView";
import { chatPrefillPath } from "../src/components/shell/CommandPalette";
import { matchAppRoute, navRoutes, redirectTarget, redirects } from "../src/routes";

const PUBLIC = new URL("../public/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, PUBLIC), "utf8"));
const fixtureIndex = BundleIndexSchema.parse(read("bundles/fixture/index.json"));
const bundles: RunBundle[] = fixtureIndex.map((e) => validateBundle(read(`bundles/fixture/${e.runId}.json`), e));
const guarded = bundles.find((b) => b.runId === "demo-run-guarded")!;

const STEP: ChatEvent = { type: "step_started", id: "s1", tool: "get_certificate", title: "Checking certificate dodo.refund.amount-minor-units", input: "cert-93e8d5ff6c3c99a5" };
const CERT_DATA = {
  kind: "certificate",
  id: "cert-93e8d5ff6c3c99a5",
  tool: "dodo",
  claimId: "dodo.refund.amount-minor-units",
  status: "active",
  verdict: "contradicts docs",
  scope: "as probed: dodo.createRefund",
  evidenceCount: 3,
};
const FINISH: ChatEvent = { type: "step_finished", id: "s1", status: "ok", durationMs: 12, costUsd: null, output: "Active", data: CERT_DATA };
const UNAVAILABLE: ChatEvent[] = [
  { type: "step_started", id: "s2", tool: "crustdata_lookup", title: "Looking up Acme Corp in Crustdata", input: "Acme Corp" },
  { type: "step_finished", id: "s2", status: "unavailable", durationMs: 0, costUsd: null, output: "Crustdata not connected", fix: "Crustdata not connected — set CRUSTDATA_API_KEY" },
];
const CITE: ChatCitation = { n: 1, type: "certificate", id: "cert-93e8d5ff6c3c99a5", label: "dodo.refund.amount-minor-units", stepId: "s1", valid: true };
const BAD: ChatCitation = { n: 2, type: "doc", id: "https://docs.example.com/x", label: "Docs", valid: false };
const turn: ChatEvent[] = [
  { type: "note", text: "Checking the certificate first.", source: "model" },
  STEP,
  FINISH,
  ...UNAVAILABLE,
  { type: "text_delta", text: "The certificate is **active** [1]. " },
  { type: "text_delta", text: "A flagged one [2] and a missing one [3]." },
  { type: "citations", items: [CITE, BAD] },
  { type: "done", costUsd: 0.0123, tokens: { input: 1200, output: 300 }, steps: 2, durationMs: 4200, mode: "live", traceId: "abc123" },
];

describe("event reducer", () => {
  it("builds steps, notes, text, citations and the done summary in order", () => {
    const view = reduceChatEvents(turn);
    expect(view.status).toBe("done");
    expect(view.items.map((i) => i.kind)).toEqual(["note", "step", "step"]);
    expect(turnSteps(view).map((s) => [s.id, s.state])).toEqual([
      ["s1", "ok"],
      ["s2", "unavailable"],
    ]);
    expect(view.steps.s2!.fix).toContain("CRUSTDATA_API_KEY");
    expect(view.text).toBe("The certificate is **active** [1]. A flagged one [2] and a missing one [3].");
    expect(view.citations).toEqual([CITE, BAD]);
    expect(workSummary(view, "live")).toBe("Checked 2 sources · 4.2s · $0.0123");
  });

  it("is working while steps stream, answering once text arrives, and ignores events after done", () => {
    let view = applyChatEvent(EMPTY_TURN, STEP);
    expect(view.status).toBe("working");
    expect(view.steps.s1!.state).toBe("running");
    view = applyChatEvent(view, FINISH);
    view = applyChatEvent(view, { type: "text_delta", text: "Hi" });
    expect(view.status).toBe("answering");
    const done = reduceChatEvents(turn);
    expect(applyChatEvent(done, { type: "text_delta", text: "late" })).toBe(done);
  });

  it("an error or Stop aborts running steps; a stored turn without done shows as stopped", () => {
    const err = reduceChatEvents([STEP, { type: "error", message: "boom", fix: "retry" }]);
    expect(err.status).toBe("error");
    expect(err.steps.s1!.state).toBe("aborted");
    expect(err.error).toEqual({ message: "boom", fix: "retry" });
    const stopped = stopTurn(reduceChatEvents([STEP]));
    expect(stopped.status).toBe("stopped");
    expect(stopped.steps.s1!.state).toBe("aborted");
    expect(reduceChatEvents([STEP], { finished: true }).status).toBe("stopped");
    expect(workSummary(stopped, "live")).toBe("Checked 1 source · 0ms · stopped");
  });

  it("words steps, durations and costs from data only", () => {
    expect(stepTitle({ tool: "fetch_doc", title: "", input: "docs.crustdata.com/enrich" })).toBe("Opening a docs page: docs.crustdata.com/enrich");
    expect(stepTitle({ tool: "fetch_doc", title: "Opening docs.crustdata.com/…", input: "x" })).toBe("Opening docs.crustdata.com/…");
    expect(durationText(420)).toBe("420ms");
    expect(durationText(4200)).toBe("4.2s");
    expect(costText(null, "live")).toBe("cost unknown");
    expect(costText(0.012, "live")).toBe("$0.012");
    expect(costText(null, "replay")).toBe("no model call");
    expect(noteTag("live")).toBe("Model said");
    expect(noteTag("replay")).toBe("Replay engine");
    const replayDone = reduceChatEvents([STEP, FINISH, { type: "citations", items: [] }, { type: "done", costUsd: null, tokens: { input: 0, output: 0 }, steps: 1, durationMs: 300, mode: "replay" }]);
    expect(workSummary(replayDone, "replay")).toBe("Checked 1 source · 300ms · no model call");
  });
});

describe("citations", () => {
  it("scroll to the producing step when it exists, else open the record", () => {
    const view = reduceChatEvents(turn);
    expect(citationTarget(CITE, view, "demo-run-guarded")).toEqual({
      kind: "step",
      stepId: "s1",
      href: "/app/certificates/cert-93e8d5ff6c3c99a5?run=demo-run-guarded",
    });
    expect(citationTarget({ ...CITE, stepId: undefined }, view)).toEqual({ kind: "link", href: "/app/certificates/cert-93e8d5ff6c3c99a5" });
    expect(citationTarget(BAD, view)).toEqual({ kind: "external", href: "https://docs.example.com/x" });
    expect(citationHref({ type: "run_event", id: "demo-run-guarded#3" })).toEqual({ href: "/app/run?run=demo-run-guarded&event=3", external: false });
    expect(citationHref({ type: "approval", id: "appr-1" }, "r")).toEqual({ href: "/app/approvals?run=r", external: false });
    expect(citationHref({ type: "doc", id: "javascript:alert(1)" })).toBeUndefined();
    expect(unknownMarkers(view.text, view.citations)).toEqual([3]);
  });

  it("links a trace only from a recorded URL, never a built one", () => {
    expect(traceHref("abc", {})).toBeUndefined();
    expect(traceHref("abc", { abc: "runs/x/spans.jsonl" })).toBeUndefined();
    expect(traceHref("abc", { abc: "https://app.neatlogs.com/t/abc" })).toBe("https://app.neatlogs.com/t/abc");
  });
});

describe("step data cards", () => {
  it("recognizes certificates, run events and fetched docs; tables and key-values otherwise", () => {
    expect(classifyStepData(CERT_DATA)).toMatchObject({ kind: "certificate", card: { id: CERT_DATA.id, status: "active", evidenceCount: 3 } });
    expect(classifyStepData({ runId: "r", events: [{ runId: "r", seq: 2, summary: "Held" }] })).toEqual({
      kind: "run_events",
      runId: "r",
      total: undefined,
      rows: [{ runId: "r", seq: 2, summary: "Held", type: undefined, at: undefined }],
    });
    expect(classifyStepData({ url: "https://docs.crustdata.com/x", title: "Enrich", passage: "headcount is an integer" })).toEqual({
      kind: "doc",
      url: "https://docs.crustdata.com/x",
      title: "Enrich",
      passage: "headcount is an integer",
    });
    expect(classifyStepData({ kind: "approvals", readOnly: true, total: 30, items: [{ id: "a", runId: "r" }] })).toMatchObject({
      kind: "table",
      columns: ["id", "runId"],
      total: 30,
      note: "Read-only in replay",
    });
    expect(classifyStepData({ name: "Acme", headcount: 120 })).toEqual({ kind: "kv", entries: [["name", "Acme"], ["headcount", 120]] });
    expect(classifyStepData(undefined)).toEqual({ kind: "none" });
  });
});

describe("suggested prompts", () => {
  it("builds two from data (first held decision, a real certificate) and adds the fixed examples", () => {
    const certs = read("certificates/fixture/default/dodo.json").certificates;
    const held = guarded.decisions.find((d) => d.status === "held")!;
    const s = buildSuggestions(guarded, certs);
    expect(s).toHaveLength(4);
    expect(s[0]).toBe(`Why was ${held.requestType.replaceAll("_", " ")} ${held.requestId} held?`);
    const active = certs.find((c: { status: string }) => c.status === "active");
    expect(s[1]).toBe(`What do we know about ${active.tool}'s ${active.claimId.slice(active.tool.length + 1)}?`);
    expect(s.slice(2)).toEqual([...FIXED_PROMPTS]);
    // No data → no invented prompt.
    expect(buildSuggestions(undefined, [])).toEqual([...FIXED_PROMPTS]);
  });

  it("cards describe each prompt from its own record (reason, verdict), never invented", () => {
    const certs = read("certificates/fixture/default/dodo.json").certificates;
    const held = guarded.decisions.find((d) => d.status === "held")!;
    const active = certs.find((c: { status: string }) => c.status === "active");
    const cards = buildSuggestionCards(guarded, certs);
    expect(cards.map((c) => c.prompt)).toEqual(buildSuggestions(guarded, certs));
    expect(cards[0]!.detail).toBe(held.evidencePack?.reason ?? cards[0]!.detail);
    expect(cards[0]!.detail.length).toBeGreaterThan(0);
    expect(cards[1]!.detail).toBe(`Certificate active, ${active.verdictKind.replaceAll("_", " ")}`);
    expect(cards.slice(2).every((c) => c.detail.length > 0)).toBe(true);
    expect(buildSuggestionCards(undefined, []).map((c) => c.prompt)).toEqual([...FIXED_PROMPTS]);
    expect(domainOf("https://www.docs.dodopayments.com/api/refunds")).toBe("docs.dodopayments.com");
    expect(domainOf("not a url")).toBe("");
  });
});

describe("auto-scroll", () => {
  const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 800 });
  it("follows until the user scrolls up, then offers Jump to latest", () => {
    let s = INITIAL_FOLLOW;
    s = afterScroll(s, at(1200), 1200);
    expect(s.follow).toBe(true);
    s = afterScroll(s, at(600), 1200);
    expect(s).toEqual({ follow: false, unseen: false });
    s = afterContentGrew(s);
    expect(s).toEqual({ follow: false, unseen: true });
    expect(afterScroll(s, at(1190), 600)).toEqual({ follow: true, unseen: false });
    expect(jumpToLatest()).toEqual({ follow: true, unseen: false });
    expect(afterContentGrew(INITIAL_FOLLOW)).toBe(INITIAL_FOLLOW);
  });
});

describe("markdown", () => {
  it("parses paragraphs, lists, code, bold, italics, links and citation markers", () => {
    const blocks = parseMarkdown("Intro with **bold** and `code` [1][2].\n\n- one _two_\n- three\n\n1. first\n2. second\n\n```json\n{\"a\":1}\n```\n\n> quote");
    expect(blocks.map((b) => b.t)).toEqual(["p", "ul", "ol", "code", "quote"]);
    expect(blocks[0]).toEqual({
      t: "p",
      c: [
        { t: "text", v: "Intro with " },
        { t: "strong", c: [{ t: "text", v: "bold" }] },
        { t: "text", v: " and " },
        { t: "code", v: "code" },
        { t: "text", v: " " },
        { t: "cite", n: 1 },
        { t: "cite", n: 2 },
        { t: "text", v: "." },
      ],
    });
    expect(blocks[3]).toEqual({ t: "code", lang: "json", v: '{"a":1}' });
    expect(parseInline("snake_case_name stays")).toEqual([{ t: "text", v: "snake_case_name stays" }]);
    expect(inlineText(parseInline("see [docs](https://x.dev) [3]"))).toBe("see docs [3]");
  });

  it("never produces HTML or unsafe links; partial streams don't throw", () => {
    expect(parseInline("[x](javascript:alert(1))").some((n) => n.t === "link")).toBe(false);
    expect(safeHref("https://docs.crustdata.com/a")).toBe("https://docs.crustdata.com/a");
    expect(safeHref("/app/certificates/cert-1")).toBe("/app/certificates/cert-1");
    expect(safeHref("//evil.example")).toBeUndefined();
    expect(safeHref("data:text/html,x")).toBeUndefined();
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(MessageView, { view: { ...EMPTY_TURN, text: '<img src=x onerror="alert(1)"> **hi', status: "done" }, mode: "live", messageKey: "m" })),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(parseMarkdown("```\nunclosed").at(-1)).toEqual({ t: "code", v: "unclosed" });
  });
});

describe("MessageView", () => {
  const render = (view: ReturnType<typeof reduceChatEvents>, mode: "live" | "replay" = "live") =>
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MessageView, { view, mode, messageKey: "m1", runId: "demo-run-guarded" })));

  it("while working: open work section, live region, spinner and the unavailable fix inline", () => {
    const html = render(reduceChatEvents([turn[0]!, STEP, ...UNAVAILABLE]));
    expect(html).toContain("Working… 2 steps");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="In progress"');
    expect(html).toContain('aria-label="Unavailable"');
    expect(html).toContain("Crustdata not connected — set CRUSTDATA_API_KEY");
    expect(html).toContain("Model said");
    expect(html).not.toMatch(/<ol[^>]*class="[^"]*chat-steps[^"]*"[^>]*hidden/);
  });

  it("finished: collapsed summary, citation chips, flagged citations, footer with cost/tokens and trace id as text", () => {
    const html = render(reduceChatEvents(turn));
    expect(html).toContain("Checked 2 sources · 4.2s · $0.0123");
    expect(html).toMatch(/<ol[^>]*class="[^"]*chat-steps[^"]*"[^>]*hidden/);
    expect(html).toContain('aria-label="Citation 1: dodo.refund.amount-minor-units. Show the step that produced it"');
    expect(html).toContain("citation 2, flagged");
    expect(html).toContain("citation 3, missing");
    expect(html).toContain("2 flagged");
    expect(html).toContain("1,500 tokens");
    expect(html).toContain('title="No trace link was recorded">abc123</code>');
    expect(html).not.toContain("View trace");
  });

  it("tags replay notes as the replay engine, never as model text", () => {
    const replayNote = { type: "note" as const, text: "Checking the certificate first.", source: "replay" as const };
    const html = render(reduceChatEvents([replayNote, STEP]), "replay");
    expect(html).toContain("Replay engine");
    expect(html).not.toContain("Model said");
    // The tag follows who wrote the note: a model-written note is "Model said" in any mode.
    expect(render(reduceChatEvents([turn[0]!, STEP]), "live")).toContain("Model said");
  });

  it("renders a real replay turn from the published files", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const file = new URL(String(input).replace(/^\//, ""), PUBLIC);
      return existsSync(file)
        ? new Response(readFileSync(file, "utf8"), { headers: { "content-type": "application/json" } })
        : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const src = new ReplaySource({ published: new PublishedFiles({ base: "/", fetchImpl }), chat: { store: memoryChatStore(), pace: "instant" } });
    src.chat.setContext({ runId: "demo-run-guarded" });
    const { id } = await src.chat.createConversation();
    const events: ChatEvent[] = [];
    await src.chat.sendMessage(id, "Why was refund q02 held?", (e) => events.push(e));
    const html = render(reduceChatEvents(events, { finished: true }), "replay");
    expect(html).toContain("no model call");
    expect(html).toContain("Answering from fixture scenario default");
    expect(html).toContain("chat-cite");
  });
});

describe("shell and routes", () => {
  it("Chat replaces Ask in the sidebar; /app/ask redirects to /app/chat", () => {
    expect(navRoutes().map((r) => r.title)).toContain("Chat");
    expect(navRoutes().map((r) => r.title)).not.toContain("Ask");
    expect(matchAppRoute("/app/chat")?.route.id).toBe("chat");
    expect(matchAppRoute("/app/ask")).toBeUndefined();
    const r = redirects.find((x) => x.from === "/app/ask")!;
    expect(redirectTarget(r, {}, "?run=demo-run-guarded")).toBe("/app/chat?run=demo-run-guarded");
  });

  it("the palette's Chat action prefills the question in the URL (not sent)", () => {
    expect(chatPrefillPath("  why was q02 held?  ", "demo-run-guarded")).toBe("/app/chat?run=demo-run-guarded&q=why+was+q02+held%3F");
  });

  it("keys every published bundle into exactly one world", () => {
    const keys = Object.fromEntries(bundles.map((b) => [b.runId, worldKeyOf(b)]));
    expect(keys["demo-run-guarded"]).toBe("fixture:default");
    expect(keys["demo-change-api-run-guarded"]).toBe("fixture:change-api");
    expect(worldKeyOf({ ...guarded, sample: false })).toBe("real");
  });
});
