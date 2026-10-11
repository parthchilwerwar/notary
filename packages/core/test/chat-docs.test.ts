/**
 * fetch_doc for Notary Chat: the allowlist (derived from the contracts' doc URLs + the explicit
 * neatlogs / Entire / cfo.ai docs hosts), refusals before any I/O, redirects re-checked hop by hop
 * (off-allowlist never followed), text extraction, limits, and the per-conversation cache.
 * Fetch is a double only.
 */
import { describe, expect, it } from "vitest";
import { DOC_HOSTS, EXTRA_DOC_HOSTS, checkDocUrl, contractDocHosts, extractText, fetchDoc } from "../src/chat/docs.js";
import { allContracts } from "../src/contracts/index.js";
import { FINAL, act, events, makeApp, newConversation, scriptedLlm, send } from "./chat-helpers.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(routes: Record<string, () => Response>): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    return r();
  }) as unknown as typeof fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

const html = (title: string, body: string) =>
  new Response(`<!doctype html><html><head><title>${title}</title><style>.x{color:red}</style><script>alert("x")</script></head><body><nav>menu</nav><h1>${title}</h1><p>${body}</p><script>track()</script></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

describe("allowlist", () => {
  it("is derived from the contracts' docUrls plus the explicit docs hosts", () => {
    const derived = contractDocHosts();
    expect(derived).toEqual(expect.arrayContaining(["docs.crustdata.com", "docs.dodopayments.com"]));
    for (const e of allContracts) expect(DOC_HOSTS).toContain(new URL(e.claim.docUrl).hostname);
    for (const h of EXTRA_DOC_HOSTS) expect(DOC_HOSTS).toContain(h);
    expect(EXTRA_DOC_HOSTS).toEqual(["docs.neatlogs.com", "docs.entire.io", "docs.cfo.ai"]);
  });

  it("refuses anything else before any I/O", async () => {
    for (const [url, why] of [
      ["https://evil.example/docs", /not on the docs allowlist/],
      ["http://docs.crustdata.com/x", /only https/],
      ["https://user:pw@docs.crustdata.com/x", /credentials/],
      ["https://docs.crustdata.com:8443/x", /port/],
      ["https://docs.crustdata.com.evil.example/x", /not on the docs allowlist/],
      ["file:///etc/passwd", /only https/],
      ["not a url", /not a valid URL/],
    ] as const) {
      const c = checkDocUrl(url);
      expect(c.ok, url).toBe(false);
      if (!c.ok) expect(c.reason, url).toMatch(why);
      const f = fakeFetch({});
      const res = await fetchDoc(url, { fetch: f });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.kind).toBe("refused");
      expect(f.calls).toHaveLength(0);
    }
  });
});

describe("fetching", () => {
  it("extracts readable text: title, no scripts/styles/nav, entities decoded, whitespace collapsed", async () => {
    const f = fakeFetch({ "https://docs.dodopayments.com/refunds": () => html("Refunds &amp; disputes", "Refund   amounts are in <b>minor</b> units.&nbsp;See&#33;") });
    const res = await fetchDoc("https://docs.dodopayments.com/refunds", { fetch: f });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.title).toBe("Refunds & disputes");
    expect(res.text).toContain("Refund amounts are in minor units.");
    expect(res.text).toContain("See!");
    expect(res.text).not.toMatch(/alert|track\(\)|color:red|menu/);
    expect(f.calls[0]!.init.redirect).toBe("manual");
    expect(f.calls[0]!.init.method).toBe("GET");
  });

  it("follows a redirect that stays on the allowlist; refuses one that leaves it (not followed)", async () => {
    const on = fakeFetch({
      "https://docs.crustdata.com/old": () => new Response(null, { status: 301, headers: { location: "/new" } }),
      "https://docs.crustdata.com/new": () => html("New page", "moved here"),
    });
    const ok = await fetchDoc("https://docs.crustdata.com/old", { fetch: on });
    expect(ok.ok && ok.finalUrl).toBe("https://docs.crustdata.com/new");

    const off = fakeFetch({ "https://docs.crustdata.com/go": () => new Response(null, { status: 302, headers: { location: "https://evil.example/phish" } }) });
    const res = await fetchDoc("https://docs.crustdata.com/go", { fetch: off });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("refused");
      expect(res.reason).toMatch(/redirected off the allowlist, not followed/);
    }
    expect(off.calls.map((c) => c.url)).toEqual(["https://docs.crustdata.com/go"]);

    const http = fakeFetch({ "https://docs.crustdata.com/down": () => new Response(null, { status: 302, headers: { location: "http://docs.crustdata.com/plain" } }) });
    const r2 = await fetchDoc("https://docs.crustdata.com/down", { fetch: http });
    expect(r2.ok).toBe(false);
    expect(http.calls).toHaveLength(1);
  });

  it("caps redirects, size and time; non-text and HTTP errors are errors", async () => {
    let n = 0;
    const loop = fakeFetch({});
    const looping = (async (url: string, init: RequestInit) => {
      loop.calls.push({ url, init });
      return new Response(null, { status: 302, headers: { location: `/r${++n}` } });
    }) as unknown as typeof fetch;
    const r = await fetchDoc("https://docs.entire.io/a", { fetch: looping });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/more than 3 redirects/);
    expect(loop.calls).toHaveLength(4);

    const big = fakeFetch({ "https://docs.neatlogs.com/big": () => new Response("x".repeat(50_000), { headers: { "content-type": "text/plain" } }) });
    const b = await fetchDoc("https://docs.neatlogs.com/big", { fetch: big, maxBytes: 10_000, maxChars: 2_000 });
    expect(b.ok && b.truncated).toBe(true);
    expect(b.ok && b.text.length).toBeLessThanOrEqual(2_001);

    const slow = (async (_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const t = await fetchDoc("https://docs.neatlogs.com/slow", { fetch: slow, timeoutMs: 30 });
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.reason).toMatch(/timed out/);

    const pdf = fakeFetch({ "https://docs.crustdata.com/a.pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }) });
    const p = await fetchDoc("https://docs.crustdata.com/a.pdf", { fetch: pdf });
    expect(!p.ok && p.kind).toBe("error");

    const e500 = await fetchDoc("https://docs.crustdata.com/nope", { fetch: fakeFetch({}) });
    expect(!e500.ok && e500.reason).toMatch(/HTTP 404/);
  });

  it("extractText passes markdown through", () => {
    expect(extractText("# Title\n\n\n\nbody   text", "text/markdown").text).toBe("# Title\n\nbody text");
  });
});

describe("fetch_doc in a chat turn", () => {
  it("a refused URL is a step with status unavailable and a fix naming the allowlist; the model is told", async () => {
    const f = fakeFetch({});
    const llm = scriptedLlm([act("fetch_doc", { url: "https://evil.example/x" }), FINAL, "I could not read that page.\nCITATIONS: []"]);
    const { app, session } = makeApp({ chatOpts: { llm: () => llm, env: {}, fetch: f } });
    const id = await newConversation(app, session);
    const fin = events((await send(app, session, id, "read https://evil.example/x")).frames).find((e) => e.type === "step_finished");
    if (fin?.type !== "step_finished") throw new Error("no step");
    expect(fin.status).toBe("unavailable");
    expect(fin.output).toMatch(/Refused: evil\.example is not on the docs allowlist/);
    expect(fin.fix).toMatch(/allowlisted docs sites/);
    expect(f.calls).toHaveLength(0);
    expect(llm.calls[1]!.messages.at(-1)!.content).toMatch(/UNAVAILABLE: fetch_doc refused/);
  });

  it("doc citations must name a page this turn read; results are cached per conversation", async () => {
    const url = "https://docs.dodopayments.com/api-reference/refunds";
    const f = fakeFetch({ [url]: () => html("Create refund", "Amounts are in minor units.") });
    const reply = `Refund amounts are in minor units [1]. Another site says otherwise [2].\nCITATIONS: ${JSON.stringify([
      { n: 1, type: "doc", id: url, stepId: "s1" },
      { n: 2, type: "doc", id: "https://docs.crustdata.com/never-read", stepId: "s1" },
    ])}`;
    const llm = scriptedLlm([act("fetch_doc", { url }), FINAL, reply, act("fetch_doc", { url }), FINAL, reply]);
    const { app, session } = makeApp({ chatOpts: { llm: () => llm, env: {}, fetch: f } });
    const id = await newConversation(app, session);
    const ev = events((await send(app, session, id, "what unit are refund amounts in?")).frames);
    const cites = ev.find((e) => e.type === "citations");
    if (cites?.type !== "citations") throw new Error("no citations");
    expect(cites.items.map((c) => [c.n, c.type, c.valid, c.url])).toEqual([
      [1, "doc", true, url],
      [2, "doc", false, "https://docs.crustdata.com/never-read"],
    ]);
    const card = ev.find((e) => e.type === "step_finished");
    expect(card?.type === "step_finished" && card.data).toMatchObject({ url, title: "Create refund", passage: expect.stringContaining("Amounts are in minor units.") });
    const ev2 = events((await send(app, session, id, "and again?")).frames);
    const fin2 = ev2.find((e) => e.type === "step_finished");
    expect(fin2?.type === "step_finished" && fin2.output).toMatch(/\(cached\)/);
    expect(f.calls).toHaveLength(1);
  });

  it("the cache is per conversation", async () => {
    const url = "https://docs.dodopayments.com/api-reference/payments";
    const f = fakeFetch({ [url]: () => html("Payments", "Payments.") });
    const reply = `Payments [1].\nCITATIONS: ${JSON.stringify([{ n: 1, type: "doc", id: url }])}`;
    const llm = scriptedLlm([act("fetch_doc", { url }), FINAL, reply, act("fetch_doc", { url }), FINAL, reply]);
    const { app, session } = makeApp({ chatOpts: { llm: () => llm, env: {}, fetch: f } });
    await send(app, session, await newConversation(app, session), "payments?");
    const ev = events((await send(app, session, await newConversation(app, session), "payments?")).frames);
    const fin = ev.find((e) => e.type === "step_finished");
    expect(fin?.type === "step_finished" && fin.output).not.toMatch(/cached/);
    expect(f.calls).toHaveLength(2);
  });
});
