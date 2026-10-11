/**
 * Notary Chat can never move money: the chat module reaches no approval-execution, queue-executor,
 * guarded-write, run-starting or store code (static import graph); its source calls no write op; its
 * tool clients refuse every op but the reads (wrap) and Dodo refuses every non-GET (recorder); obvious
 * money-moving requests are detected deterministically, get a real list_approvals step and an answer
 * pointing to the Approvals card. Crustdata/Dodo lookups run against transport doubles only.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVALS_PATH, MONEY_NOTICE, detectMoneyRequest } from "../src/chat/money.js";
import { CHAT_READ_OPS, CHAT_TOOLS, chatReadOnlyWrap } from "../src/chat/tools.js";
import { CreditLedger, RateLimitScope, ReadOnlyRequestError, VirtualClock, createTools, setRecorderTransport } from "../src/tools/index.js";
import type { ChatEvent } from "../src/schema/chat.js";
import { FINAL, act, events, makeApp, newConversation, scriptedLlm, send } from "./chat-helpers.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function importsOf(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
    if (/^\s*import\s+type\b/.test(m[0]) || /^\s*export\s+type\b/.test(m[0])) continue;
    out.push(m[1]!);
  }
  for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

function graph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [resolve(SRC, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const s of importsOf(readFileSync(file, "utf8"))) if (s.startsWith(".")) stack.push(resolve(dirname(file), s.replace(/\.js$/, ".ts")));
  }
  return [...seen].map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/")).sort();
}

// Approval execution, the queue executor and policy, guarded wrappers, run starters, the reflector /
// adversary, the Notary store and the certificate builder are all out of reach of the chat module.
const FORBIDDEN = [/^api\/approvals/, /^api\/runs/, /^api\/health/, /^api\/certificates/, /^queue\//, /^guards\//, /^reflect\//, /^adversary\//, /^store\//, /^certify\//, /^demo\//];
const WRITE_OPS = ["createRefund", "changeSubscriptionPlan", "createWalletLedgerEntry", "createPayment", "createCheckoutSession", "createCustomer", "createProduct"];

describe("static: the chat module can't reach a write path", () => {
  it("the detector sees what it should (no vacuous pass)", () => {
    const g = graph("api/chat.ts");
    expect(g).toEqual(expect.arrayContaining(["api/chat.ts", "chat/agent.ts", "chat/tools.ts", "chat/docs.ts", "chat/store.ts", "llm/client.ts", "tools/index.ts"]));
    expect(graph("api/approvals.ts").some((f) => FORBIDDEN.some((re) => re.test(f)))).toBe(true);
  });

  it("imports no approval-execution, queue-executor, guard, run-starting, store or certify code, transitively", () => {
    const bad = graph("api/chat.ts").filter((f) => FORBIDDEN.some((re) => re.test(f)));
    expect(bad).toEqual([]);
  });

  it("no chat source calls a write op; the only reachable tool-client ops are reads", () => {
    const files = [resolve(SRC, "api/chat.ts"), ...readdirSync(resolve(SRC, "chat")).map((f) => resolve(SRC, "chat", f))];
    for (const f of files) {
      const code = readFileSync(f, "utf8");
      for (const op of WRITE_OPS) expect(code, `${f} mentions ${op}`).not.toMatch(new RegExp(`\\b${op}\\b`));
    }
    expect([...CHAT_READ_OPS]).toEqual(["crustdata.enrichCompany", "dodo.getPayment", "dodo.getRefund", "dodo.getSubscription"]);
    expect(CHAT_TOOLS.map((t) => t.name).filter((n) => /refund|approve|reject|create|change|execute|write/.test(n))).toEqual([]);
  });
});

describe("runtime: read-only by construction", () => {
  const restores: (() => void)[] = [];
  afterEach(() => {
    for (const r of restores.splice(0)) r();
  });

  it("the chat wrap refuses every op but the allowed read, before any I/O", async () => {
    const sent: string[] = [];
    restores.push(setRecorderTransport({ fetch: async (url, init) => (sent.push(`${init.method} ${url}`), new Response("{}")), fixture: false, rateLimits: new RateLimitScope({ clock: new VirtualClock() }) }));
    const tools = createTools({
      mode: "live",
      env: { NOTARY_MODE: "test", DODO_PAYMENTS_API_KEY: "test-key-123456789" },
      wrap: chatReadOnlyWrap(["dodo.getPayment"]),
      ledger: new CreditLedger({ budget: 0 }),
    });
    await expect(tools.dodo.createRefund({ payment_id: "pay_1" } as never)).rejects.toThrow(/not allowed \(chat is read-only\)/);
    await expect(tools.dodo.changeSubscriptionPlan("sub_1", {} as never)).rejects.toThrow(/not allowed/);
    await expect(tools.dodo.createWalletLedgerEntry("cus_1", {} as never)).rejects.toThrow(/not allowed/);
    expect(sent).toEqual([]);
  });

  it("a GET-only recorder refuses a Dodo write even with no wrap at all", async () => {
    const sent: string[] = [];
    restores.push(setRecorderTransport({ fetch: async (url, init) => (sent.push(`${init.method} ${url}`), new Response("{}")), fixture: false, rateLimits: new RateLimitScope({ clock: new VirtualClock() }) }));
    const tools = createTools({ mode: "live", env: { NOTARY_MODE: "test", DODO_PAYMENTS_API_KEY: "test-key-123456789" }, allowedMethods: ["GET"], ledger: new CreditLedger({ budget: 0 }) });
    await expect(tools.dodo.createRefund({ payment_id: "pay_1" } as never)).rejects.toBeInstanceOf(ReadOnlyRequestError);
    expect(sent).toEqual([]);
  });

  it("dodo_lookup: test mode only, GET only, the read op only", async () => {
    const sent: { method: string; url: string }[] = [];
    restores.push(
      setRecorderTransport({
        fetch: async (url, init) => {
          sent.push({ method: String(init.method), url });
          return new Response(JSON.stringify({ payment_id: "pay_123", status: "succeeded", total_amount: 1500, currency: "USD" }), { status: 200, headers: { "content-type": "application/json" } });
        },
        fixture: false,
        rateLimits: new RateLimitScope({ clock: new VirtualClock() }),
      }),
    );
    const llm = scriptedLlm([act("dodo_lookup", { kind: "payments", id: "pay_123" }), FINAL, "It succeeded [1].\nCITATIONS: [{\"n\":1,\"type\":\"api_response\",\"id\":\"s1\"}]"]);
    const env = { NOTARY_MODE: "test", DODO_PAYMENTS_API_KEY: "dodo-test-key-abcdef123" };
    const { app, session } = makeApp({ chatOpts: { llm: () => llm, env } });
    const id = await newConversation(app, session);
    const ev = events((await send(app, session, id, "what is the status of pay_123?")).frames);
    const fin = ev.find((e) => e.type === "step_finished");
    if (fin?.type !== "step_finished") throw new Error("no step");
    expect(fin.status).toBe("ok");
    expect(fin.output).toContain("succeeded");
    expect(sent).toEqual([{ method: "GET", url: "https://test.dodopayments.com/payments/pay_123" }]);
    const cites = ev.find((e) => e.type === "citations");
    if (cites?.type !== "citations") throw new Error("no citations");
    expect(cites.items[0]).toMatchObject({ type: "api_response", id: "s1", valid: true });

    // Test-mode lock off -> unavailable, nothing sent.
    sent.length = 0;
    const llm2 = scriptedLlm([act("dodo_lookup", { kind: "refunds", id: "ref_1" }), FINAL, "Could not check.\nCITATIONS: []"]);
    const app2 = makeApp({ chatOpts: { llm: () => llm2, env: { DODO_PAYMENTS_API_KEY: "dodo-test-key-abcdef123" } } });
    const id2 = await newConversation(app2.app, app2.session);
    const ev2 = events((await send(app2.app, app2.session, id2, "what is the status of refund ref_1?")).frames);
    const fin2 = ev2.find((e) => e.type === "step_finished");
    if (fin2?.type !== "step_finished") throw new Error("no step");
    expect(fin2.status).toBe("unavailable");
    expect(fin2.fix).toMatch(/NOTARY_MODE=test/);
    expect(sent).toEqual([]);
  });

  it("crustdata_lookup: through the credit ledger, credits reported, only POST /company/enrich", async () => {
    const sent: { method: string; url: string }[] = [];
    restores.push(
      setRecorderTransport({
        fetch: async (url, init) => {
          sent.push({ method: String(init.method), url });
          const body = [{ matched_on: "acme.com", match_type: "domain", matches: [{ confidence_score: 1, company_data: { basic_info: { name: "Acme", primary_domain: "acme.com" }, headcount: { total: 42 } } }] }];
          return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-credits-used": "2" } });
        },
        fixture: false,
        rateLimits: new RateLimitScope({ clock: new VirtualClock() }),
      }),
    );
    const ledger = new CreditLedger({ budget: 10 });
    const llm = scriptedLlm([act("crustdata_lookup", { company: "https://www.acme.com/about" }), FINAL, "Acme has 42 people [1].\nCITATIONS: [{\"n\":1,\"type\":\"api_response\",\"id\":\"s1\"}]"]);
    const { app, session } = makeApp({ chatOpts: { llm: () => llm, env: { CRUSTDATA_API_KEY: "crust-test-key-123456" }, ledger } });
    const id = await newConversation(app, session);
    const ev = events((await send(app, session, id, "how big is acme?")).frames);
    const fin = ev.find((e) => e.type === "step_finished");
    if (fin?.type !== "step_finished") throw new Error("no step");
    expect(fin).toMatchObject({ status: "ok", credits: 2 });
    expect(fin.output).toContain("Acme");
    expect(ledger.total).toBe(2);
    expect(sent).toEqual([{ method: "POST", url: "https://api.crustdata.com/company/enrich" }]);

    // Over the credit budget -> error with a fix, no request.
    sent.length = 0;
    const tight = new CreditLedger({ budget: 1 });
    const llm2 = scriptedLlm([act("crustdata_lookup", { company: "acme.com" }), FINAL, "Could not.\nCITATIONS: []"]);
    const app2 = makeApp({ chatOpts: { llm: () => llm2, env: { CRUSTDATA_API_KEY: "crust-test-key-123456" }, ledger: tight } });
    const id2 = await newConversation(app2.app, app2.session);
    const fin2 = events((await send(app2.app, app2.session, id2, "acme?")).frames).find((e) => e.type === "step_finished");
    if (fin2?.type !== "step_finished") throw new Error("no step");
    expect(fin2.status).toBe("error");
    expect(fin2.fix).toMatch(/CRUSTDATA_CREDIT_BUDGET/);
    expect(sent).toEqual([]);
  });
});

describe("money-moving requests", () => {
  it("detects imperative requests, not questions about them", () => {
    for (const s of [
      "refund pay_123",
      "Please refund the customer $50",
      "can you approve the held refund?",
      "Approve it.",
      "go ahead and change the plan for sub_9 to Pro",
      "Thanks. Now cancel subscription sub_1",
      "credit the wallet 500 USD",
      "issue a refund for pay_7",
      "reject appr-0123456789abcdef",
    ]) {
      expect(detectMoneyRequest(s).moneyMoving, s).toBe(true);
    }
    for (const s of [
      "why was the refund held?",
      "what happens if I approve it?",
      "show me the refunds in the last run",
      "what is the refund policy?",
      "how many certificates are there?",
      "is the change plan endpoint idempotent?",
      "refund policy for enterprise customers",
    ]) {
      expect(detectMoneyRequest(s).moneyMoving, s).toBe(false);
    }
  });

  it("refused: a real list_approvals step, no write possible, and the answer points to the Approvals card", async () => {
    const sent: string[] = [];
    const restore = setRecorderTransport({ fetch: async (url, init) => (sent.push(`${init.method} ${url}`), new Response("{}")), fixture: false });
    try {
      const approvals = { testMode: true, pending: [{ id: "appr-0123456789abcdef", runId: "run-x", decisionId: "d1", requestId: "q1", action: "dodo.createRefund", amount: 5000, currency: "USD", reason: "missing belief", missingBeliefs: ["dodo:refund-unit"] }], decided: [] };
      // The model "forgets" the Approvals card: the code-written notice is appended.
      const llm = scriptedLlm([FINAL, "I can't do that myself; it is held because a belief is missing [1].\nCITATIONS: [{\"n\":1,\"type\":\"approval\",\"id\":\"appr-0123456789abcdef\",\"stepId\":\"s1\"}]"]);
      const { app, session } = makeApp({
        chatOpts: { llm: () => llm, env: { NOTARY_MODE: "test", DODO_PAYMENTS_API_KEY: "dodo-test-key-abcdef123" }, approvals: async () => approvals },
      });
      const id = await newConversation(app, session);
      const ev = events((await send(app, session, id, "refund pay_123 for $50 now")).frames);
      const step = ev.find((e): e is Extract<ChatEvent, { type: "step_started" }> => e.type === "step_started");
      expect(step).toMatchObject({ id: "s1", tool: "list_approvals" });
      const text = ev.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
      expect(text).toContain(APPROVALS_PATH);
      expect(text).toContain(MONEY_NOTICE);
      // The model was told it cannot act, in the same turn.
      const told = llm.calls[0]!.messages.map((m) => m.content).join("\n");
      expect(told).toMatch(/Chat cannot do that/);
      expect(llm.calls[0]!.system).toMatch(/cannot move money/);
      const cites = ev.find((e) => e.type === "citations");
      if (cites?.type !== "citations") throw new Error("no citations");
      expect(cites.items[0]).toMatchObject({ type: "approval", valid: true, stepId: "s1" });
      expect(sent).toEqual([]);
    } finally {
      restore();
    }
  });
});
