/**
 * Checker + recon tests. Every claim, exchange and cassette here is hand-built TEST DATA (ids like
 * "test-…", "pay_test_…"); none of it describes real tool behaviour. Nothing touches the network:
 * replay reads cassettes written to a temp dir, and the one live-mode test stubs fetch.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyBundle } from "../src/bundle/index.js";
import {
  anomalyId,
  argsFor,
  checkAll,
  checkClaim,
  observationsByOperation,
  parsePath,
  reconOnly,
  resolvePath,
  resolveRefs,
  runRecon,
} from "../src/checker/index.js";
import type { Observation } from "../src/checker/index.js";
import type { ContractEntry } from "../src/contracts/types.js";
import type { Claim, ExpectRule } from "../src/schema/index.js";
import {
  CRUSTDATA_BASE_URL,
  CreditLedger,
  DODO_TEST_BASE_URL,
  MissingCredentialError,
  Recorder,
  computeContentHash,
  saveCassette,
} from "../src/tools/index.js";
import type { Cassette, Exchange } from "../src/tools/index.js";

// ---------------------------------------------------------------------------------------------
// Test-data builders

function claim(id: string, expect: ExpectRule, param = "", operation = "test.op"): Claim {
  return {
    id,
    tool: "dodo",
    operation,
    param,
    docText: "[test] hand-built claim",
    expect,
    docUrl: "https://example.com/test-doc",
  };
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function ex(label: string, status: number, responseBody: unknown, more: Partial<Exchange> = {}): Exchange {
  return {
    id: `test.op#${label}#${more.occurrence ?? 0}`,
    tool: "dodo",
    op: "test.op",
    method: "GET",
    url: "https://test.example/items",
    requestHeaders: {},
    requestBody: null,
    status,
    responseHeaders: {},
    responseBody,
    latencyMs: 1,
    credits: null,
    recordedAt: new Date(T0).toISOString(),
    requestHash: `hash-${label}`,
    occurrence: 0,
    ...more,
  };
}

const at = (ms: number) => new Date(T0 + ms).toISOString();

// ---------------------------------------------------------------------------------------------

describe("path helper", () => {
  it("parses dotted paths with [] and [n]", () => {
    expect(parsePath("items[].amount")).toEqual([{ kind: "key", key: "items" }, { kind: "each" }, { kind: "key", key: "amount" }]);
    expect(parsePath("[].matches[0].x")).toEqual([
      { kind: "each" },
      { kind: "key", key: "matches" },
      { kind: "index", index: 0 },
      { kind: "key", key: "x" },
    ]);
    expect(parsePath("")).toEqual([]);
    expect(() => parsePath("a..b")).toThrow();
  });

  it("expands [] to concrete paths and reports misses", () => {
    const body = { items: [{ a: 1 }, { b: 2 }, { a: null }] };
    expect(resolvePath(body, "items[].a")).toEqual([
      { path: "items[0].a", found: true, value: 1 },
      { path: "items[1].a", found: false },
      { path: "items[2].a", found: true, value: null },
    ]);
    expect(resolvePath(body, "nope[].a")).toEqual([{ path: "nope[].a", found: false }]);
    expect(resolvePath({ items: [] }, "items[].a")).toEqual([]);
    expect(resolvePath(body, "items.1.b")).toEqual([{ path: "items[1].b", found: true, value: 2 }]);
  });
});

describe("rule: maxItems", () => {
  const c = claim("test-max", { kind: "maxItems", max: 2 }, "page_size");

  it("honored: list within max and request within max", () => {
    expect(checkClaim(c, [ex("ok", 200, { items: [1, 2] }, { url: "https://t.example/x?page_size=2" })])).toEqual([]);
  });

  it("honored: request above max was rejected (non-2xx is not inspected)", () => {
    expect(checkClaim(c, [ex("rej", 422, { error: "too big" }, { url: "https://t.example/x?page_size=3" })])).toEqual([]);
  });

  it("violated: list longer than max", () => {
    const [a, ...rest] = checkClaim(c, [ex("long", 200, [1, 2, 3])]);
    expect(rest).toEqual([]);
    expect(a?.observed).toEqual({ listKey: "", listLength: 3, status: 200 });
    expect(a?.expected).toEqual({ maxItems: 2 });
    expect(a?.exchangeId).toBe("hash-long");
  });

  it("violated: request above max got a 2xx (limit not visibly enforced)", () => {
    const out = checkClaim(c, [ex("above", 200, { data: [1, 2] }, { url: "https://t.example/x?page_size=3" })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.observed).toMatchObject({ param: "page_size", requested: 3, status: 200, listLength: 2 });
  });

  it("reads the requested size from an array param in the request body", () => {
    const c2 = claim("test-max-body", { kind: "maxItems", max: 2 }, "domains");
    const out = checkClaim(c2, [ex("arr", 200, [1], { method: "POST", requestBody: { domains: ["a", "b", "c"] } })]);
    expect(out.map((a) => (a.observed as { requested: number }).requested)).toEqual([3]);
  });
});

describe("rule: type", () => {
  it("honored, and missing values are not type violations", () => {
    const c = claim("test-type", { kind: "type", field: "items[].amount", type: "integer" });
    expect(checkClaim(c, [ex("ok", 200, { items: [{ amount: 5 }, {}] })])).toEqual([]);
  });

  it("violated: lists each offending concrete path", () => {
    const c = claim("test-type", { kind: "type", field: "items[].amount", type: "integer" });
    const [a] = checkClaim(c, [ex("bad", 200, { items: [{ amount: 5 }, { amount: "5.00" }, { amount: 1.5 }] })]);
    expect(a?.observed).toEqual({
      field: "items[].amount",
      mismatches: [
        { path: "items[1].amount", type: "string", value: "5.00" },
        { path: "items[2].amount", type: "number", value: 1.5 },
      ],
      count: 2,
      truncated: false,
    });
    expect(a?.expected).toEqual({ field: "items[].amount", type: "integer" });
  });

  it("supports unions and iso-datetime; ignores non-2xx; rejects unknown type names", () => {
    const u = claim("test-union", { kind: "type", field: "v", type: "string|null" });
    expect(checkClaim(u, [ex("n", 200, { v: null }), ex("s", 200, { v: "x" }), ex("e", 500, { v: 1 })])).toEqual([]);
    expect(checkClaim(u, [ex("num", 200, { v: 1 })])).toHaveLength(1);
    const d = claim("test-date", { kind: "type", field: "at", type: "iso-datetime" });
    expect(checkClaim(d, [ex("d1", 200, { at: "2026-01-01T00:00:00Z" }), ex("d2", 200, { at: "2026-01-01T00:00:00.123+05:30" })])).toEqual([]);
    expect(checkClaim(d, [ex("d3", 200, { at: "2026-01-01" })])).toHaveLength(1);
    expect(() => checkClaim(claim("test-x", { kind: "type", field: "v", type: "float" }), [ex("x", 200, { v: 1 })])).toThrow(/Unknown type/);
  });
});

describe("rule: unit", () => {
  const c = claim("test-unit", { kind: "unit", field: "amount", unit: "minor" }, "items[].amount");
  const req = (amount: number) => ({ method: "POST", requestBody: { items: [{ amount }] } });

  it("honored: echo equals what was sent", () => {
    expect(checkClaim(c, [ex("ok", 200, { amount: 500 }, req(500))])).toEqual([]);
  });

  it("violated: records both values and their ratio", () => {
    const [a] = checkClaim(c, [ex("x100", 200, { amount: 50000 }, req(500))]);
    expect(a?.observed).toEqual({ sentPath: "items[0].amount", sent: 500, echoedPath: "amount", echoed: 50000, ratio: 100 });
    expect(a?.expected).toEqual({ unit: "minor", echoed: 500 });
  });

  it("skips exchanges where sent and echoed values can't be paired", () => {
    const two = { method: "POST", requestBody: { items: [{ amount: 1 }, { amount: 2 }] } };
    expect(checkClaim(c, [ex("pair", 200, { amount: 3 }, two), ex("noecho", 200, {}, req(5)), ex("err", 400, { amount: 9 }, req(5))])).toEqual([]);
  });
});

describe("rule: statusOnError", () => {
  const c = claim("test-status", { kind: "statusOnError", status: 422 });
  it("honored: every deliberately invalid request got the documented status", () => {
    expect(checkClaim(c, [ex("a", 422, {}), ex("b", 0, null, { error: "timeout" })])).toEqual([]);
  });
  it("violated: a different status, including a 2xx", () => {
    const out = checkClaim(c, [ex("a", 200, {}), ex("b", 400, {})]);
    expect(out.map((a) => a.observed)).toEqual([{ status: 200 }, { status: 400 }]);
    expect(out[0]?.expected).toEqual({ status: 422 });
  });
});

describe("rule: idempotentOnRetry", () => {
  const c = claim("test-idem", { kind: "idempotentOnRetry" }, "refund_id");
  it("honored: retries of the same request return the same id", () => {
    expect(
      checkClaim(c, [
        ex("r", 200, { refund_id: "ref_test_1" }),
        ex("r", 200, { refund_id: "ref_test_1" }, { occurrence: 1 }),
        ex("other", 200, { refund_id: "ref_test_9" }),
      ]),
    ).toEqual([]);
  });
  it("violated: a retry created a second resource", () => {
    const out = checkClaim(c, [
      ex("r", 200, { refund_id: "ref_test_1" }),
      ex("r", 409, { error: "dup" }, { occurrence: 1 }),
      ex("r", 200, { refund_id: "ref_test_2" }, { occurrence: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.observed).toEqual({ idPath: "refund_id", id: "ref_test_2", occurrence: 2 });
    expect(out[0]?.expected).toEqual({ idPath: "refund_id", id: "ref_test_1" });
    expect(out[0]?.id).toBe(anomalyId("test-idem", { requestHash: "hash-r", occurrence: 2 }, "idempotentOnRetry"));
  });
});

describe("rule: errorOnUnknownParam", () => {
  const c = claim("test-unknown", { kind: "errorOnUnknownParam" }, "payment_id");
  it("honored: the unknown param was rejected", () => {
    expect(checkClaim(c, [ex("a", 400, {})])).toEqual([]);
  });
  it("violated: the unknown param was silently ignored", () => {
    const out = checkClaim(c, [ex("a", 200, { items: [] })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.observed).toEqual({ param: "payment_id", status: 200, ignored: true });
  });
});

describe("rule: fieldPresent", () => {
  const c = claim("test-field", { kind: "fieldPresent", field: "items[].customer.id" });
  it("honored: present everywhere (null counts as present); empty lists are vacuous", () => {
    expect(checkClaim(c, [ex("a", 200, { items: [{ customer: { id: null } }] }), ex("b", 200, { items: [] }), ex("c", 404, {})])).toEqual([]);
  });
  it("violated: lists the missing concrete paths", () => {
    const [a] = checkClaim(c, [ex("a", 200, { items: [{ customer: { id: 1 } }, { customer: {} }, {}] })]);
    expect(a?.observed).toEqual({ field: "items[].customer.id", missing: ["items[1].customer.id", "items[2].customer.id"], count: 2, truncated: false });
  });
});

describe("rule: consistentWithin", () => {
  const c = claim("test-consistency", { kind: "consistentWithin", ms: 1000 }, "refund_id");
  const write = ex("w", 200, { refund_id: "ref_test_7" }, { method: "POST", recordedAt: at(0) });

  it("honored: a read past the window contains the id; earlier reads may miss it", () => {
    const early = ex("r", 200, { items: [] }, { recordedAt: at(200) });
    const late = ex("r", 200, { items: [{ refund_id: "ref_test_7" }] }, { recordedAt: at(1500), occurrence: 1 });
    expect(checkClaim(c, [write, early, late])).toEqual([]);
  });

  it("violated: a read issued >= ms after the write lacks the id", () => {
    const late = ex("r", 200, { items: [{ refund_id: "ref_test_other" }] }, { recordedAt: at(1000) });
    const [a] = checkClaim(c, [write, late]);
    expect(a?.observed).toEqual({ id: "ref_test_7", readAfterMs: 1000, found: false, op: "test.op" });
    expect(a?.expected).toEqual({ id: "ref_test_7", visibleWithinMs: 1000 });
  });

  it("checks nothing when the write failed", () => {
    expect(checkClaim(c, [ex("w", 500, {}), ex("r", 200, { items: [] }, { recordedAt: at(5000) })])).toEqual([]);
  });
});

describe("checkAll: determinism and ordering", () => {
  const entries: ContractEntry[] = [
    { claim: claim("test-b", { kind: "statusOnError", status: 400 }), recon: [] },
    { claim: claim("test-a", { kind: "fieldPresent", field: "x" }), recon: [] },
  ];
  const observations: Observation[] = [
    { claimId: "test-b", exchange: ex("b1", 200, {}) },
    { claimId: "test-a", exchange: ex("a2", 200, {}) },
    { claimId: "test-b", exchange: ex("b0", 500, {}) },
    { claimId: "test-a", exchange: ex("a1", 200, { y: 1 }) },
    { claimId: "test-unknown", exchange: ex("u", 200, {}) },
  ];

  it("same input twice gives deep-equal, byte-identical output", () => {
    const one = checkAll(entries, observations);
    const two = checkAll(structuredClone(entries), structuredClone(observations));
    expect(two).toEqual(one);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one).toHaveLength(4);
    for (const a of one) expect(a.id).toMatch(/^anom-[0-9a-f]{12}$/);
  });

  it("orders by claimId, then exchange order; independent of entry order", () => {
    const out = checkAll(entries, observations);
    expect(out.map((a) => `${a.claimId}:${a.exchangeId}`)).toEqual([
      "test-a:hash-a2",
      "test-a:hash-a1",
      "test-b:hash-b1",
      "test-b:hash-b0",
    ]);
    expect(checkAll([...entries].reverse(), observations)).toEqual(out);
  });

  it("dedupes repeated observations and takes trace ids from the exchange when present", () => {
    const traced = { ...ex("t", 200, {}), traceId: "trace-test", spanId: "span-test" } as Exchange;
    const out = checkAll([entries[1]!], [
      { claimId: "test-a", exchange: traced },
      { claimId: "test-a", exchange: traced },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ traceId: "trace-test", spanId: "span-test" });
    expect(checkAll([entries[1]!], [{ claimId: "test-a", exchange: ex("u", 200, {}) }])[0]).toMatchObject({ traceId: "", spanId: "" });
  });

  it("associates queue traffic by operation, skipping rules that need crafted exchanges", () => {
    const e1: ContractEntry = { claim: claim("test-q1", { kind: "fieldPresent", field: "x" }, "", "dodo.listRefunds"), recon: [] };
    const e2: ContractEntry = { claim: claim("test-q2", { kind: "statusOnError", status: 400 }, "", "dodo.listRefunds"), recon: [] };
    const e3: ContractEntry = {
      claim: claim("test-q3", { kind: "fieldPresent", field: "x" }, "", "dodo.listRefunds"),
      recon: [{ op: "dodo.listRefunds", params: {}, note: "has recon: judged on recon observations only" }],
    };
    const traffic = [ex("q", 200, {}, { op: "dodo.listRefunds" }), ex("p", 200, {}, { op: "dodo.listPayments" })];
    expect(observationsByOperation([e1, e2, e3], traffic).map((o) => `${o.claimId}:${o.exchange.op}`)).toEqual(["test-q1:dodo.listRefunds"]);
  });
});

describe("recon refs and args", () => {
  it("resolves $from refs at any depth, with [] giving a list", () => {
    const bodies = [{ payment_id: "pay_test_1" }, { items: [{ id: "a" }, { id: "b" }] }];
    expect(resolveRefs({ payment_id: "$from:0:payment_id", nested: { ids: "$from:1:items[].id" }, keep: "$fromage" }, bodies)).toEqual({
      payment_id: "pay_test_1",
      nested: { ids: ["a", "b"] },
      keep: "$fromage",
    });
    expect(resolveRefs(["$from:1:items[1].id"], bodies)).toEqual(["b"]);
  });

  it("throws (unresolvable) when the earlier step has no 2xx body or the path is missing", () => {
    expect(() => resolveRefs("$from:0:x", [undefined])).toThrow(/no 2xx response/);
    expect(() => resolveRefs("$from:3:x", [])).toThrow(/no 2xx response/);
    expect(() => resolveRefs("$from:0:x", [{ y: 1 }])).toThrow(/path not found/);
  });

  it("maps id params to positional arguments", () => {
    expect(argsFor("dodo.getPayment", { payment_id: "pay_test_1" })).toEqual(["pay_test_1"]);
    expect(argsFor("dodo.createWalletLedgerEntry", { customer_id: "cus_test", amount: 5 })).toEqual(["cus_test", { amount: 5 }]);
    expect(argsFor("dodo.listRefunds", { page_size: 5 })).toEqual([{ page_size: 5 }]);
    expect(() => argsFor("dodo.getRefund", {})).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Recon over hand-built cassettes

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notary-recon-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const hasher = new Recorder({ mode: "replay" });

interface Rec {
  tool?: string;
  op: string;
  method: string;
  url: string;
  body?: unknown;
  status: number;
  response: unknown;
  recordedAt: string;
  occurrence?: number;
  credits?: number | null;
}

function cassette(name: string, tool: string, recs: Rec[]): Cassette {
  const exchanges: Exchange[] = recs.map((r) => {
    const requestHash = hasher.hashRequest(r.method, r.url, r.body);
    const occurrence = r.occurrence ?? 0;
    return {
      id: `${r.op}#${requestHash.slice(0, 12)}#${occurrence}`,
      tool: r.tool ?? tool,
      op: r.op,
      method: r.method,
      url: r.url,
      requestHeaders: {},
      requestBody: r.body === undefined ? null : r.body,
      status: r.status,
      responseHeaders: {},
      responseBody: r.response,
      latencyMs: 5,
      credits: r.credits ?? null,
      recordedAt: r.recordedAt,
      requestHash,
      occurrence,
    };
  });
  const c: Cassette = { name, tool, createdAt: at(0), exchanges, contentHash: computeContentHash(exchanges) };
  saveCassette(c, dir);
  return c;
}

const D = DODO_TEST_BASE_URL;

/** TEST claims and recon steps exercising the runner (not the real Dodo contract). */
const dodoEntries: ContractEntry[] = [
  {
    claim: claim("test-page-max", { kind: "maxItems", max: 2 }, "page_size", "dodo.listRefunds"),
    recon: [
      { op: "dodo.listRefunds", params: { page_size: 2 }, note: "at max" },
      { op: "dodo.listRefunds", params: { page_size: 3 }, note: "over max" },
    ],
  },
  {
    claim: claim("test-read-after-write", { kind: "consistentWithin", ms: 1000 }, "refund_id", "dodo.createRefund"),
    recon: [
      { op: "dodo.createRefund", params: { payment_id: "pay_test_1" }, note: "write" },
      { op: "dodo.getRefund", params: { refund_id: "$from:0:refund_id" }, delayMs: 60_000, note: "read back" },
    ],
  },
  {
    claim: claim("test-unresolved", { kind: "fieldPresent", field: "refunds" }, "", "dodo.getPayment"),
    recon: [
      { op: "dodo.getPayment", params: { payment_id: "pay_test_missing" }, note: "404" },
      { op: "dodo.getRefund", params: { refund_id: "$from:0:refunds[0].refund_id" }, note: "never runs" },
    ],
  },
  {
    claim: claim("test-retry", { kind: "idempotentOnRetry" }, "refund_id", "dodo.createRefund"),
    recon: [{ op: "dodo.createRefund", params: { payment_id: "pay_test_2" }, repeat: 10, note: "retry probe" }],
  },
];

function dodoCassette(): Cassette {
  const post = (body: unknown) => ({ op: "dodo.createRefund", method: "POST", url: `${D}/refunds`, body });
  return cassette("recon-dodo", "dodo", [
    { op: "dodo.listRefunds", method: "GET", url: `${D}/refunds?page_size=2`, status: 200, response: { items: [1, 2] }, recordedAt: at(0) },
    { op: "dodo.listRefunds", method: "GET", url: `${D}/refunds?page_size=3`, status: 200, response: { items: [1, 2] }, recordedAt: at(10) },
    { ...post({ payment_id: "pay_test_1" }), status: 200, response: { refund_id: "ref_test_1" }, recordedAt: at(100) },
    { op: "dodo.getRefund", method: "GET", url: `${D}/refunds/ref_test_1`, status: 404, response: { error: "not found" }, recordedAt: at(1200) },
    { op: "dodo.getPayment", method: "GET", url: `${D}/payments/pay_test_missing`, status: 404, response: { error: "nf" }, recordedAt: at(1300) },
    { ...post({ payment_id: "pay_test_2" }), status: 200, response: { refund_id: "ref_test_a" }, recordedAt: at(1400) },
    { ...post({ payment_id: "pay_test_2" }), status: 200, response: { refund_id: "ref_test_b" }, recordedAt: at(1500), occurrence: 1 },
    { ...post({ payment_id: "pay_test_2" }), status: 200, response: { refund_id: "ref_test_a" }, recordedAt: at(1600), occurrence: 2 },
  ]);
}

describe("runRecon (replay over a hand-built cassette)", () => {
  it("produces identical anomalies on two runs, with refs, skips and clamps recorded", async () => {
    const c = dodoCassette();
    const run = () => runRecon({ tool: "dodo", mode: "replay", cassetteDir: dir, entries: dodoEntries, env: {}, maxRepeat: 3, maxDelayMs: 5000 });
    const first = await run();
    const second = await run();
    expect(JSON.stringify(second.anomalies)).toBe(JSON.stringify(first.anomalies));
    expect(first.cassetteHash).toBe(c.contentHash);
    expect(first.stoppedReason).toBeUndefined();

    expect(first.anomalies.map((a) => a.claimId)).toEqual(["test-page-max", "test-retry"]);
    expect(first.anomalies[0]?.observed).toMatchObject({ requested: 3 });
    expect(first.anomalies[1]?.observed).toMatchObject({ id: "ref_test_b", occurrence: 1 });

    const step = (claimId: string, i: number) => first.steps.find((s) => s.claimId === claimId && s.stepIndex === i)!;
    // $from resolved: the read went to /refunds/ref_test_1 (a 404, so consistentWithin has no 2xx read to judge).
    expect(step("test-read-after-write", 1)).toMatchObject({ status: "ran", delayMs: 5000 });
    expect(step("test-read-after-write", 1).exchangeIds).toHaveLength(1);
    // Unresolvable ref: skipped with a reason, not a crash.
    expect(step("test-unresolved", 1)).toMatchObject({ status: "skipped" });
    expect(step("test-unresolved", 1).reason).toMatch(/unresolved ref .*step 0 has no 2xx response/);
    // repeat 10 clamped to 3 (a 4th call would be a cassette miss).
    expect(step("test-retry", 0)).toMatchObject({ status: "ran", repeat: 3 });
    expect(step("test-retry", 0).exchangeIds).toHaveLength(3);
    expect(first.observations).toHaveLength(8);
  });

  it("setup steps feed $from refs but their exchanges are not associated with the claim", async () => {
    cassette("recon-dodo", "dodo", [
      { op: "dodo.createCustomer", method: "POST", url: `${D}/customers`, body: { name: "test" }, status: 200, response: { customer_id: "cus_test_1" }, recordedAt: at(0) },
      { op: "dodo.listCustomerWallets", method: "GET", url: `${D}/customers/cus_test_1/wallets`, status: 400, response: { error: "bad" }, recordedAt: at(10) },
    ]);
    const entries: ContractEntry[] = [
      {
        claim: claim("test-setup", { kind: "statusOnError", status: 400 }, "", "dodo.listCustomerWallets"),
        recon: [
          { op: "dodo.createCustomer", params: { name: "test" }, setup: true, note: "setup: a 200 here must not trip statusOnError" },
          { op: "dodo.listCustomerWallets", params: { customer_id: "$from:0:customer_id" }, note: "the deliberately invalid call" },
        ],
      },
    ];
    const r = await runRecon({ tool: "dodo", mode: "replay", cassetteDir: dir, entries });
    expect(r.anomalies).toEqual([]);
    expect(r.observations.map((o) => o.exchange.op)).toEqual(["dodo.listCustomerWallets"]);
    expect(r.steps.map((s) => [s.setup, s.status, s.exchangeIds.length])).toEqual([
      [true, "ran", 1],
      [false, "ran", 1],
    ]);
  });

  it("stops cleanly on the credit budget and records why", async () => {
    const C = CRUSTDATA_BASE_URL;
    cassette("recon-crustdata", "crustdata", [
      { op: "crustdata.enrichCompany", method: "POST", url: `${C}/company/enrich`, body: { domains: ["a.test"] }, status: 200, response: [], recordedAt: at(0), credits: 2 },
    ]);
    const cEntry = (id: string, domain: string): ContractEntry => ({
      claim: { ...claim(id, { kind: "type", field: "[].matched_on", type: "string" }, "", "crustdata.enrichCompany"), tool: "crustdata" },
      recon: [{ op: "crustdata.enrichCompany", params: { domains: [domain] }, note: "enrich one" }],
    });
    const result = await runRecon({
      tool: "crustdata",
      mode: "replay",
      cassetteDir: dir,
      entries: [cEntry("test-c1", "a.test"), cEntry("test-c2", "b.test"), cEntry("test-c3", "c.test")],
      ledger: new CreditLedger({ budget: 3 }),
    });
    expect(result.creditsUsed).toBe(2);
    expect(result.stoppedReason).toMatch(/Credit budget exceeded.*stopped at test-c2 step 0/);
    expect(result.steps.map((s) => `${s.claimId}:${s.status}`)).toEqual(["test-c1:ran", "test-c2:failed"]);
  });

  it("reconOnly writes a valid notarize bundle with a deterministic runId and summary", async () => {
    dodoCassette();
    const runsDir = join(dir, "runs");
    const go = () => reconOnly({ tool: "dodo", replay: true, cassetteDir: dir, runsDir, entries: dodoEntries, ledger: new CreditLedger({ budget: 10 }) });
    const a = await go();
    const b = await go();
    expect(a.exitCode).toBe(0);
    expect(b.lines).toEqual(a.lines);
    expect(a.runId).toMatch(/^recon-dodo-replay-[0-9a-f]{12}$/);
    expect(a.lines.filter((l) => l.startsWith("anom-"))).toHaveLength(2);
    const { readFileSync } = await import("node:fs");
    const checked = verifyBundle(JSON.parse(readFileSync(a.bundlePath!, "utf8")));
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.bundle).toMatchObject({ kind: "notarize", variant: "notarize", mode: "replay", tool: "dodo", status: "completed" });
      expect(checked.bundle.anomalies).toEqual(a.recon!.anomalies);
    }
  });
});

describe("runRecon (live mode, stubbed fetch)", () => {
  const FAKE_DODO_KEY = ["test", "dodo", "key", "z".repeat(16)].join("_");
  const env = () => ({ NOTARY_MODE: "test", DODO_BASE_URL: DODO_TEST_BASE_URL, DODO_PAYMENTS_API_KEY: FAKE_DODO_KEY });

  it("clamps delays, records the recon-<tool> cassette, and waits only in live mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    const sleeps: number[] = [];
    const entries: ContractEntry[] = [
      {
        claim: claim("test-live", { kind: "maxItems", max: 5 }, "page_size", "dodo.listRefunds"),
        recon: [{ op: "dodo.listRefunds", params: { page_size: 1 }, delayMs: 999_999, repeat: 2, note: "slow read" }],
      },
    ];
    const result = await runRecon({
      tool: "dodo",
      mode: "live",
      cassetteDir: dir,
      entries,
      env: env(),
      maxDelayMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([250]);
    expect(result.observations).toHaveLength(2);
    expect(existsSync(join(dir, "recon-dodo.json"))).toBe(true);

    // Replaying the cassette just recorded gives the same anomalies and never sleeps.
    const replaySleeps: number[] = [];
    const replay = await runRecon({ tool: "dodo", mode: "replay", cassetteDir: dir, entries, sleep: async (ms) => void replaySleeps.push(ms) });
    expect(replay.anomalies).toEqual(result.anomalies);
    expect(replaySleeps).toEqual([]);
  });

  it("propagates a missing credential as BLOCKED (reconOnly exits 3)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const noKey = { NOTARY_MODE: "test", DODO_BASE_URL: DODO_TEST_BASE_URL };
    const entries: ContractEntry[] = [
      { claim: claim("test-blocked", { kind: "fieldPresent", field: "items" }), recon: [{ op: "dodo.listRefunds", params: {}, note: "x" }] },
    ];
    await expect(runRecon({ tool: "dodo", mode: "live", cassetteDir: dir, entries, env: noKey })).rejects.toBeInstanceOf(MissingCredentialError);
    const r = await reconOnly({ tool: "dodo", cassetteDir: dir, runsDir: join(dir, "runs"), entries, env: noKey });
    expect(r).toMatchObject({ exitCode: 3, status: "blocked", lines: ["BLOCKED: DODO_PAYMENTS_API_KEY not set"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("real contracts are checkable", () => {
  it("every claim's rule evaluates without throwing and every $from ref points at an earlier step", async () => {
    const { allContracts } = await import("../src/contracts/index.js");
    expect(allContracts.length).toBeGreaterThan(0);
    for (const entry of allContracts) {
      const probe = ex(`contract-${entry.claim.id}`, 200, {}, { method: "POST", requestBody: {} });
      expect(() => checkClaim(entry.claim, [probe]), entry.claim.id).not.toThrow();
      entry.recon.forEach((step, i) => {
        for (const m of JSON.stringify(step.params).matchAll(/\$from:(\d+):/g)) {
          expect(Number(m[1]), `${entry.claim.id} step ${i}`).toBeLessThan(i);
        }
      });
    }
  });
});
