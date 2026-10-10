/**
 * Tool layer tests. Every exchange here is hand-built TEST DATA served by a stubbed fetch; nothing
 * touches the network. Fake secrets are assembled at runtime so the secret scanner never sees a
 * key-shaped literal in this file.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_OPS,
  BudgetExceededError,
  CassetteMissError,
  CreditLedger,
  DODO_TEST_BASE_URL,
  MissingCredentialError,
  Recorder,
  TestModeLockError,
  ToolHttpError,
  createTools,
  isBlocked,
  listCassettes,
  loadCassette,
} from "../src/tools/index.js";
import type { Cassette, Wrap } from "../src/tools/index.js";

const FAKE_DODO_KEY = ["test", "dodo", "key", "x".repeat(16)].join("_");
const FAKE_CRUST_KEY = ["fake", "crust", "y".repeat(20)].join("-");

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

let dir: string;
const liveEnv = () => ({
  NOTARY_MODE: "test",
  DODO_BASE_URL: DODO_TEST_BASE_URL,
  DODO_PAYMENTS_API_KEY: FAKE_DODO_KEY,
  CRUSTDATA_API_KEY: FAKE_CRUST_KEY,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notary-cassettes-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("recorder: record then replay", () => {
  it("replays identical requests in recorded occurrence order, without the network or env", async () => {
    const pages = [
      { items: [{ refund_id: "ref_1", payment_id: "pay_1", status: "pending", created_at: "t", is_partial: false }] },
      { items: [{ refund_id: "ref_1", payment_id: "pay_1", status: "succeeded", created_at: "t", is_partial: false }] },
    ];
    const fetchMock = vi.fn(async () => jsonResponse(pages.shift()));
    vi.stubGlobal("fetch", fetchMock);

    const live = createTools({ mode: "live", cassette: "occ", cassetteDir: dir, env: liveEnv() });
    const a = await live.dodo.listRefunds({ customer_id: "cus_1" });
    const b = await live.dodo.listRefunds({ customer_id: "cus_1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a.exchangeId).not.toBe(b.exchangeId);
    expect(live.ledger.snapshot().calls["dodo.listRefunds"]).toBe(2);

    expect(listCassettes(dir)).toEqual(["occ"]);
    const cassette = loadCassette("occ", { dir });
    expect(cassette.exchanges.map((e) => e.occurrence)).toEqual([0, 1]);
    expect(cassette.exchanges[0]!.requestHash).toBe(cassette.exchanges[1]!.requestHash);

    fetchMock.mockClear();
    const replay = createTools({ mode: "replay", cassette: "occ", cassetteDir: dir });
    const r1 = await replay.dodo.listRefunds({ customer_id: "cus_1" });
    const r2 = await replay.dodo.listRefunds({ customer_id: "cus_1" });
    expect(r1.data.items[0]!.status).toBe("pending");
    expect(r2.data.items[0]!.status).toBe("succeeded");
    expect([r1.exchangeId, r2.exchangeId]).toEqual([a.exchangeId, b.exchangeId]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws CassetteMissError on an unrecorded request or an extra occurrence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ payment_id: "pay_1", refunds: [] })));
    const live = createTools({ mode: "live", cassette: "miss", cassetteDir: dir, env: liveEnv() });
    await live.dodo.getPayment("pay_1");

    const replay = createTools({ mode: "replay", cassette: "miss", cassetteDir: dir });
    await expect(replay.dodo.getPayment("pay_2")).rejects.toBeInstanceOf(CassetteMissError);
    await replay.dodo.getPayment("pay_1");
    await expect(replay.dodo.getPayment("pay_1")).rejects.toBeInstanceOf(CassetteMissError);
  });

  it("serves from several cassettes and keeps HTTP errors as ToolHttpError", async () => {
    const mk = (name: string, op: string, url: string, status: number, body: unknown): Cassette => {
      const rec = new Recorder({ mode: "replay" });
      const requestHash = rec.hashRequest("GET", url, undefined);
      const ex = {
        id: `${op}#x#0`, tool: "dodo", op, method: "GET", url, requestHeaders: {}, requestBody: null, status,
        responseHeaders: {}, responseBody: body, latencyMs: 1, credits: null, recordedAt: "t", requestHash, occurrence: 0,
      };
      return { name, tool: "dodo", createdAt: "t", exchanges: [ex], contentHash: "" };
    };
    const tools = createTools({
      mode: "replay",
      cassettes: [
        mk("a", "dodo.getRefund", `${DODO_TEST_BASE_URL}/refunds/ref_1`, 200, { refund_id: "ref_1" }),
        mk("b", "dodo.getSubscription", `${DODO_TEST_BASE_URL}/subscriptions/sub_1`, 404, { code: "NOT_FOUND" }),
      ],
    });
    expect((await tools.dodo.getRefund("ref_1")).data.refund_id).toBe("ref_1");
    const err = await tools.dodo.getSubscription("sub_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolHttpError);
    expect((err as ToolHttpError).status).toBe(404);
  });

  it("rejects a cassette whose content hash doesn't match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ items: [] })));
    const live = createTools({ mode: "live", cassette: "tamper", cassetteDir: dir, env: liveEnv() });
    await live.dodo.listCustomers();
    const file = join(dir, "tamper.json");
    const text = readFileSync(file, "utf8").replace('"items": []', '"items": [1]');
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, text);
    expect(() => loadCassette("tamper", { dir })).toThrow(/content hash mismatch/);
  });
});

describe("recorder: redaction", () => {
  it("strips auth headers, cookies, secret env values and emails before writing", async () => {
    const email = "jane.doe@example.com";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            customer_id: "cus_1",
            name: "Jane",
            email,
            phone_number: "+15550001111",
            note: `contact ${email} key ${FAKE_DODO_KEY}`,
            client_secret: "cs_whatever_value",
          },
          200,
          { "set-cookie": "session=abcdef123456", "x-request-id": "req_1" },
        ),
      ),
    );
    const live = createTools({ mode: "live", cassette: "redact", cassetteDir: dir, env: liveEnv() });
    const res = await live.dodo.createCustomer({ name: "Jane", email, phone_number: "+15550001111", metadata: { k: FAKE_DODO_KEY } });

    const text = readFileSync(join(dir, "redact.json"), "utf8");
    expect(text).not.toContain(FAKE_DODO_KEY);
    expect(text).not.toContain(email);
    expect(text).not.toContain("+15550001111");
    expect(text).not.toContain("abcdef123456");
    expect(text).not.toContain("cs_whatever_value");

    const ex = loadCassette("redact", { dir }).exchanges[0]!;
    expect(ex.requestHeaders.authorization).toBe("[REDACTED]");
    expect(ex.responseHeaders["set-cookie"]).toBe("[REDACTED]");
    expect(ex.responseHeaders["x-request-id"]).toBe("req_1");
    expect(ex.requestBody).toEqual({
      name: "Jane",
      email: "[REDACTED_EMAIL]",
      phone_number: "[REDACTED_PHONE]",
      metadata: { k: "[REDACTED:DODO_PAYMENTS_API_KEY]" },
    });
    const body = ex.responseBody as Record<string, unknown>;
    expect(body.customer_id).toBe("cus_1");
    expect(body.note).toBe("contact [REDACTED_EMAIL] key [REDACTED:DODO_PAYMENTS_API_KEY]");
    // Callers see the same redacted body in live mode as in replay.
    expect(res.data.email).toBe("[REDACTED_EMAIL]");
  });

  it("masks email query params in recorded URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ items: [] })));
    const live = createTools({ mode: "live", cassette: "q", cassetteDir: dir, env: liveEnv() });
    await live.dodo.listCustomers({ email: "a.b@example.org", page_size: 100 });
    const ex = loadCassette("q", { dir }).exchanges[0]!;
    expect(ex.url).toBe(`${DODO_TEST_BASE_URL}/customers?email=[REDACTED_EMAIL]&page_size=100`);
  });
});

describe("credit ledger", () => {
  it("blocks a reservation that would exceed the budget, before the call", () => {
    const ledger = new CreditLedger({ budget: 5 });
    ledger.reserve("crustdata.enrichCompany", 2);
    ledger.settle("crustdata.enrichCompany", 2);
    expect(() => ledger.reserve("crustdata.enrichCompany", 4)).toThrow(BudgetExceededError);
    ledger.reserve("crustdata.enrichCompany", 3);
    expect(ledger.snapshot()).toMatchObject({ budget: 5, total: 2, reserved: 3, remaining: 0 });
  });

  it("P9 AUDIT-21 (evidence for won't-fix): an overshoot is bounded — once a charge exceeds the budget, every later call is refused, even a free one", () => {
    const ledger = new CreditLedger({ budget: 5 });
    ledger.reserve("crustdata.enrichCompany", 4);
    ledger.settle("crustdata.enrichCompany", 7); // X-Credits-Used came back above the estimate
    expect(ledger.snapshot()).toMatchObject({ total: 7, remaining: -2 });
    expect(() => ledger.reserve("crustdata.identifyCompany", 0)).toThrow(BudgetExceededError);
    expect(() => ledger.reserve("crustdata.enrichCompany", 1)).toThrow(BudgetExceededError);
  });

  it("reads the budget from CRUSTDATA_CREDIT_BUDGET, defaulting to 200", () => {
    expect(new CreditLedger({ env: {} }).budget).toBe(200);
    expect(new CreditLedger({ env: { CRUSTDATA_CREDIT_BUDGET: "50" } }).budget).toBe(50);
  });

  it("Crustdata refuses an over-budget call without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tools = createTools({ mode: "live", env: liveEnv(), ledger: new CreditLedger({ budget: 3 }) });
    await expect(tools.crustdata.enrichCompany({ domains: ["a.com", "b.com"], fields: ["headcount"] })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settles actual credits from X-Credits-Used", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([{ matched_on: "a.com", match_type: "domain", matches: [] }], 200, { "x-credits-used": "0.5" })),
    );
    const tools = createTools({ mode: "live", env: liveEnv(), cassette: "cd", cassetteDir: dir });
    await tools.crustdata.enrichCompany({ domains: ["a.com"], fields: ["headcount", "funding"] });
    expect(tools.ledger.snapshot()).toMatchObject({ total: 0.5, reserved: 0, byEndpoint: { "crustdata.enrichCompany": 0.5 } });
    const ex = loadCassette("cd", { dir }).exchanges[0]!;
    expect(ex.credits).toBe(0.5);
    expect(ex.requestHeaders["x-api-version"]).toBe("2025-11-01");

    const replay = createTools({ mode: "replay", cassette: "cd", cassetteDir: dir });
    await replay.crustdata.enrichCompany({ domains: ["a.com"], fields: ["headcount", "funding"] });
    expect(replay.ledger.snapshot().total).toBe(0.5);
  });
});

describe("Dodo test-mode lock", () => {
  it("refuses to start in live mode without NOTARY_MODE=test", () => {
    const env = { ...liveEnv(), NOTARY_MODE: "" };
    expect(() => createTools({ mode: "live", env })).toThrow(TestModeLockError);
    expect(() => createTools({ mode: "live", env: { ...liveEnv(), NOTARY_MODE: "live" } })).toThrow(TestModeLockError);
  });

  it("refuses a non-test base URL", () => {
    expect(() => createTools({ mode: "live", env: { ...liveEnv(), DODO_BASE_URL: "https://live.dodopayments.com" } })).toThrow(
      TestModeLockError,
    );
    expect(() => createTools({ mode: "live", env: liveEnv(), dodoBaseUrl: "https://example.com" })).toThrow(TestModeLockError);
    expect(() => createTools({ mode: "replay", dodoBaseUrl: "https://live.dodopayments.com" })).toThrow(TestModeLockError);
  });

  it("accepts the documented test URL (trailing slash allowed)", () => {
    expect(() => createTools({ mode: "live", env: { ...liveEnv(), DODO_BASE_URL: `${DODO_TEST_BASE_URL}/` } })).not.toThrow();
  });
});

describe("missing credentials", () => {
  it("live mode with no keys throws MissingCredentialError before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tools = createTools({ mode: "live", env: { NOTARY_MODE: "test", CRUSTDATA_API_KEY: "  " } });

    const e1 = await tools.crustdata.identifyCompany({ domains: ["a.com"] }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(MissingCredentialError);
    expect((e1 as Error).message).toBe("BLOCKED: CRUSTDATA_API_KEY not set");
    expect(isBlocked(e1)).toBe(true);

    const e2 = await tools.dodo.listRefunds().catch((e: unknown) => e);
    expect((e2 as Error).message).toBe("BLOCKED: DODO_PAYMENTS_API_KEY not set");
    expect(isBlocked(e2)).toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tools.ledger.snapshot()).toMatchObject({ total: 0, reserved: 0, calls: {} });
    expect(isBlocked(new Error("other"))).toBe(false);
  });
});

describe("createTools surface", () => {
  it("routes every client method through wrap with its op name", async () => {
    const seen: string[] = [];
    const sentinel = vi.fn(async () => "wrapped");
    const wrap: Wrap = ((op: string) => {
      seen.push(op);
      return sentinel;
    }) as unknown as Wrap;
    const tools = createTools({ mode: "replay", wrap });

    expect(seen.sort()).toEqual([
      "crustdata.enrichCompany",
      "crustdata.getCreditBalance",
      "crustdata.identifyCompany",
      "dodo.changeSubscriptionPlan",
      "dodo.createCheckoutSession",
      "dodo.createCustomer",
      "dodo.createPayment",
      "dodo.createProduct",
      "dodo.createRefund",
      "dodo.createWalletLedgerEntry",
      "dodo.getPayment",
      "dodo.getRefund",
      "dodo.getSubscription",
      "dodo.listCustomerWallets",
      "dodo.listCustomers",
      "dodo.listPayments",
      "dodo.listRefunds",
      "dodo.listWalletLedgerEntries",
    ]);
    expect([...ALL_OPS].sort()).toEqual(seen);
    expect(Object.keys(tools.crustdata).length + Object.keys(tools.dodo).length).toBe(seen.length);
    expect(await tools.dodo.createRefund({ payment_id: "pay_1" })).toBe("wrapped");
    expect(Object.isFrozen(tools.dodo)).toBe(true);
  });

  it("replay mode needs no environment variables", () => {
    expect(() => createTools({ mode: "replay", env: {} })).not.toThrow();
  });
});

describe("raw clients stay private", () => {
  it("no file in src/ outside src/tools imports tools/crustdata or tools/dodo", () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        const rel = relative(srcDir, full).split(sep).join("/");
        if (entry.isDirectory()) {
          if (rel !== "tools") walk(full);
        } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) {
          const text = readFileSync(full, "utf8");
          if (/(from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*tools\/(crustdata|dodo)(\.[jt]s)?["']/.test(text)) {
            offenders.push(rel);
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  /**
   * Stand-in for the `entire graph` caller check (Entire CLI not installed, DECISIONS #27): since the
   * raw clients are only reachable through createTools(), every createTools() CALL in src/ must pass
   * a `wrap`. The only exceptions are the measurement paths, which must see the raw tool behavior the
   * guards would otherwise hide (recon sweep, probe loop). The queue (money) path has no exception.
   */
  it("every createTools() call outside src/tools passes a wrap (measurement paths excepted)", () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const MEASUREMENT = new Set(["checker/recon.ts", "reflect/notarize.ts"]);
    const calls: Array<{ at: string; rel: string; wrapped: boolean }> = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        const rel = relative(srcDir, full).split(sep).join("/");
        if (entry.isDirectory()) {
          if (rel !== "tools") walk(full);
          continue;
        }
        if (!/\.(ts|mts)$/.test(entry.name)) continue;
        // The coverage checker names createTools() in report strings; its AST check (test/coverage.test.ts)
        // supersedes this regex scan and covers its own file.
        if (rel === "guards/coverage.ts") continue;
        // Blank out comments (keeping offsets and newlines) so prose mentioning createTools() is ignored.
        const text = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
        for (const m of text.matchAll(/\bcreateTools\s*\(/g)) {
          let depth = 0;
          let end = m.index + m[0].length - 1;
          for (; end < text.length; end++) {
            if (text[end] === "(") depth++;
            else if (text[end] === ")" && --depth === 0) break;
          }
          const args = text.slice(m.index + m[0].length, end);
          const line = text.slice(0, m.index).split("\n").length;
          calls.push({ at: `${rel}:${line}`, rel, wrapped: /\bwrap\b/.test(args) });
        }
      }
    };
    walk(srcDir);
    const unguarded = calls.filter((c) => !c.wrapped && !MEASUREMENT.has(c.rel)).map((c) => c.at);
    expect(unguarded).toEqual([]);
    const queueCalls = calls.filter((c) => c.rel.startsWith("queue/"));
    expect(queueCalls.length).toBeGreaterThanOrEqual(2);
    expect(queueCalls.every((c) => c.wrapped)).toBe(true);
  });
});
