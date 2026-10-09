/**
 * Probe templates, selection score, commit-then-run, header_burst cap, budget stop, and the loop.
 * Every test double (fake IO, fake reflector) lives in this file; nothing here reaches a network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { contractEntryById } from "../src/contracts/index.js";
import type { CompleteRequest, CompleteResult, LlmLike } from "../src/llm/client.js";
import { runProbeLoop } from "../src/reflect/loop.js";
import { notarize } from "../src/reflect/notarize.js";
import { CommitOrderError, runProbe } from "../src/reflect/runner.js";
import { DEFAULT_PROBE_LAMBDA, lambdaFromEnv, rankDesigns, scoreDesign, separates } from "../src/reflect/score.js";
import {
  BurstCapError,
  BurstCounter,
  HEADER_BURST_MAX_REQUESTS_PER_RUN,
  MAX_STEP_REPEAT,
  SimplePaymentPool,
  TEMPLATES,
  boundarySweep,
  buildCostModel,
  executeVariants,
  headerBurst,
  isSkip,
  paginationCompleteness,
  retryAfterTimeout,
  typeEdge,
  unitRoundtrip,
  unknownParam,
  writeThenRead,
} from "../src/reflect/templates/index.js";
import type {
  PaymentPool,
  ProbeContext,
  ProbeDesign,
  ProbeIo,
  ProbeTemplateModule,
  Skip,
  TaggedExchange,
  Variant,
} from "../src/reflect/templates/index.js";
import { judge } from "../src/reflect/verdict.js";
import type { Anomaly, Claim, DefectClass, Hypothesis } from "../src/schema/index.js";
import { NotaryDb } from "../src/store/db.js";
import { BudgetExceededError, CreditLedger } from "../src/tools/index.js";
import type { Exchange } from "../src/tools/index.js";

// ---------------------------------------------------------------------------------------------
// Test doubles and builders

let exSeq = 0;
function ex(op: string, status: number, responseBody: unknown, over: Partial<Exchange> = {}): Exchange {
  exSeq += 1;
  return {
    id: `ex-${exSeq}`,
    tool: op.split(".")[0]!,
    op,
    method: "POST",
    url: `https://test.example/${op}`,
    requestHeaders: {},
    requestBody: undefined,
    status,
    responseHeaders: {},
    responseBody,
    latencyMs: 1,
    credits: null,
    recordedAt: "2026-10-10T10:00:00.000Z",
    requestHash: `h-${exSeq}`,
    occurrence: 0,
    ...over,
  };
}

function t(variant: Variant, tag: string, exchange: Exchange, step = 0): TaggedExchange {
  return { variant, step, tag, exchange };
}

function claimOf(id: string): Claim {
  const e = contractEntryById(id);
  if (!e) throw new Error(`no claim ${id}`);
  return e.claim;
}

function hyps(anomalyId: string, classes: DefectClass[]): Hypothesis[] {
  return classes.map((c) => ({ id: `hyp-${c}`, anomalyId, class: c, statement: `${c} explains it`, distinguishingTest: "unit_roundtrip" }));
}

function ctx(over: Partial<ProbeContext> = {}): ProbeContext {
  return {
    runId: "run-t",
    tag: "run-t-p1",
    costs: buildCostModel(),
    burst: new BurstCounter(),
    payments: new SimplePaymentPool(),
    ...over,
  };
}

function designOf(m: ProbeTemplateModule, claim: Claim, h: Hypothesis[], c: ProbeContext = ctx()): ProbeDesign {
  const d = m.design(claim, h, c);
  if (isSkip(d)) throw new Error(`unexpected skip: ${(d as Skip).skip}`);
  return d;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** Scripted ProbeIo: every call is logged with the commit state of `watch` at call time. */
class FakeIo implements ProbeIo {
  readonly log: Array<{ op: string; args: unknown[]; committed?: boolean; committedAt?: string; at: number }> = [];
  clock = Date.parse("2026-10-10T10:00:00.000Z");
  watch?: { db: NotaryDb; probeId: string };
  constructor(private readonly handler: (op: string, args: unknown[], n: number) => Reply) {}
  async call(op: string, args: unknown[]): Promise<Exchange[]> {
    this.clock += 10;
    const entry: (typeof this.log)[number] = { op, args, at: this.clock };
    if (this.watch) {
      entry.committed = this.watch.db.isCommitted(this.watch.probeId);
      const c = this.watch.db.committedAt(this.watch.probeId);
      if (c) entry.committedAt = c;
    }
    this.log.push(entry);
    const r = this.handler(op, args, this.log.length);
    const last = args[args.length - 1];
    return [
      ex(op, r.status, r.body ?? {}, {
        requestBody: last !== null && typeof last === "object" ? last : undefined,
        responseHeaders: r.headers ?? {},
        recordedAt: new Date(this.clock).toISOString(),
      }),
    ];
  }
  async sleep(ms: number): Promise<void> {
    this.clock += ms;
  }
}

/** Fake reflector: answers each call with the next scripted JSON reply (anomaly ids filled in). */
class FakeLlm implements LlmLike {
  readonly requests: CompleteRequest[] = [];
  constructor(private readonly replies: Array<(anomalyIds: string[]) => unknown>) {}
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.requests.push(req);
    const text = req.messages.map((m) => m.content).join("\n");
    const ids = [...new Set([...text.matchAll(/"anomalyId":\s*"([^"]+)"/g)].map((m) => m[1]!))];
    const reply = this.replies[this.requests.length - 1];
    if (!reply) throw new Error("FakeLlm: no scripted reply left");
    return { text: JSON.stringify(reply(ids)), inputTokens: 100, outputTokens: 50, usd: 0.001, modelId: "fake", stopReason: "end_turn" };
  }
}

function hypothesesReply(classes: Array<[DefectClass, string]>) {
  return (ids: string[]) => ({
    anomalies: ids.map((anomalyId) => ({
      anomalyId,
      hypotheses: classes.map(([cls, test]) => ({ class: cls, statement: `${cls} explains ${anomalyId}`, distinguishingTest: test })),
    })),
  });
}

const dbs: NotaryDb[] = [];
function freshDb(): NotaryDb {
  const db = new NotaryDb(":memory:");
  dbs.push(db);
  return db;
}
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

function anomalyFor(claim: Claim, id = "anom-1"): Anomaly {
  return { id, claimId: claim.id, tool: claim.tool, observed: {}, expected: {}, traceId: "", spanId: "" };
}

// ---------------------------------------------------------------------------------------------
// Templates

describe("templates: registry", () => {
  it("has one module per TDD template", () => {
    expect(TEMPLATES.map((m) => m.name).sort()).toEqual(
      ["boundary_sweep", "header_burst", "pagination_completeness", "retry_after_timeout", "type_edge", "unit_roundtrip", "unknown_param", "write_then_read"].sort(),
    );
  });

  it("every design carries a control variant with steps", () => {
    const pool = new SimplePaymentPool(["pay_a", "pay_b", "pay_c"]);
    const cases: Array<[ProbeTemplateModule, string]> = [
      [unitRoundtrip, "dodo.product.price-minor-units"],
      [boundarySweep, "dodo.refunds.page-size-max-100"],
      [paginationCompleteness, "dodo.payments.page-size-max-100"],
      [retryAfterTimeout, "dodo.wallet.idempotency-key-no-duplicate"],
      [writeThenRead, "dodo.payment.refunds-lists-issued-refund"],
      [unknownParam, "crustdata.identify.invalid-fields-400"],
      [typeEdge, "crustdata.enrich.headcount-total-integer"],
      [headerBurst, "crustdata.credits.balance-number"],
    ];
    for (const [m, id] of cases) {
      const claim = claimOf(id);
      expect(m.appliesTo(claim)).toBe(true);
      const d = designOf(m, claim, hyps("a", ["honored", "silent_coercion"]), ctx({ payments: pool }));
      expect(d.control.params.steps.length).toBeGreaterThan(0);
      expect(d.params.steps.length).toBeGreaterThan(0);
      expect(d.template).toBe(m.name);
    }
  });
});

describe("unit_roundtrip", () => {
  const claim = claimOf("dodo.product.price-minor-units");
  const h = hyps("a", ["honored", "unit_mismatch", "expiry"]);
  const d = designOf(unitRoundtrip, claim, h);

  it("predicts by class: honored -> equal, unit_mismatch -> x100|div100, unmodelled -> *", () => {
    expect(d.predictions["hyp-honored"]!.outcomes).toEqual(["equal"]);
    expect(d.predictions["hyp-unit_mismatch"]!.outcomes).toEqual(["div100", "x100"]);
    expect(d.predictions["hyp-expiry"]!.outcomes).toEqual(["*"]);
    expect(d.params.steps[0]!.params).toMatchObject({ price: { price: 1234 } });
    expect(d.control.params.steps[0]!.params).toMatchObject({ price: { price: 2468 } });
    expect(d).toMatchObject({ estCredits: 0, estCalls: 2 });
  });

  const exchangesFor = (tEcho: number, cEcho: number) => [
    t("control", "write", ex("dodo.createProduct", 200, { price: { price: cEcho } }, { requestBody: { price: { price: 2468 } } })),
    t("treatment", "write", ex("dodo.createProduct", 200, { price: { price: tEcho } }, { requestBody: { price: { price: 1234 } } })),
  ];

  it("observes echo == sent*100 as x100 and matches only unit_mismatch (plus the wildcard)", () => {
    const o = unitRoundtrip.observe(exchangesFor(123400, 246800), d, claim);
    expect(o.outcome).toBe("x100");
    expect(o.treatment).toMatchObject({ sent: 1234, echoed: 123400, ratio: 100 });
    expect(unitRoundtrip.matches(d.predictions["hyp-unit_mismatch"]!, o)).toBe(true);
    expect(unitRoundtrip.matches(d.predictions["hyp-honored"]!, o)).toBe(false);
    expect(unitRoundtrip.matches(d.predictions["hyp-expiry"]!, o)).toBe(true);
  });

  it("echo == sent is equal; a sent/100 echo is div100; anything else is other", () => {
    expect(unitRoundtrip.observe(exchangesFor(1234, 2468), d, claim).outcome).toBe("equal");
    expect(unitRoundtrip.observe(exchangesFor(12.34, 24.68), d, claim).outcome).toBe("div100");
    expect(unitRoundtrip.observe(exchangesFor(1230, 2468), d, claim).outcome).toBe("other");
  });

  it("identical control and treatment echoes fail the instrument check", () => {
    const o = unitRoundtrip.observe(exchangesFor(1234, 1234), d, claim);
    expect(judge(unitRoundtrip, d, o).verdict).toBe("invalid");
  });

  it("a failed write is uninformative", () => {
    const o = unitRoundtrip.observe(
      [t("control", "write", ex("dodo.createProduct", 200, { price: { price: 2468 } }, { requestBody: { price: { price: 2468 } } })), t("treatment", "write", ex("dodo.createProduct", 422, {}))],
      d,
      claim,
    );
    expect(o.outcome).toBeNull();
    expect(unitRoundtrip.informative(o)).toBe(false);
  });

  it("refund variant needs two probe-reserved payments", () => {
    const refund = claimOf("dodo.refund.amount-minor-units");
    expect(isSkip(unitRoundtrip.design(refund, h, ctx()))).toBe(true);
    const r = designOf(unitRoundtrip, refund, h, ctx({ payments: new SimplePaymentPool(["pay_1", "pay_2"]) }));
    expect(r.paymentIds).toEqual(["pay_1", "pay_2"]);
    expect(r.params.steps[1]!.params).toMatchObject({ payment_id: "pay_1", items: [{ amount: 100 }] });
  });

  it("wallet variant resolves $from refs through executeVariants", async () => {
    const wallet = claimOf("dodo.wallet.credit-amount-minor-units");
    const wd = designOf(unitRoundtrip, wallet, h);
    const io = new FakeIo((op, args) => {
      if (op === "dodo.createCustomer") return { status: 200, body: { customer_id: `cus_${(args[0] as { email: string }).email}` } };
      const p = args[1] as { amount: number };
      return { status: 200, body: { balance: p.amount } };
    });
    const exchanges = await executeVariants(io, wd);
    expect(io.log.map((l) => l.op)).toEqual(["dodo.createCustomer", "dodo.createWalletLedgerEntry", "dodo.createCustomer", "dodo.createWalletLedgerEntry"]);
    expect(io.log[1]!.args[0]).toMatch(/^cus_probe\+run-t-p1-c@/); // control first
    const o = unitRoundtrip.observe(exchanges, wd, wallet);
    expect(o.outcome).toBe("equal");
    // "equal" matches honored and the expiry wildcard: two rivals match -> inconclusive.
    expect(judge(unitRoundtrip, wd, o).verdict).toBe("inconclusive");
  });
});

describe("boundary_sweep", () => {
  const claim = claimOf("dodo.refunds.page-size-max-100");
  const h = hyps("a", ["honored", "silent_truncation", "silent_coercion", "undocumented_flag"]);
  const d = designOf(boundarySweep, claim, h);
  const items = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({ refund_id: `r${i}` })) });
  const run = (over: Reply, atMax = 100, one = 1) =>
    boundarySweep.observe(
      [
        t("control", "one", ex(claim.operation, 200, items(one))),
        t("control", "max", ex(claim.operation, 200, items(atMax))),
        t("treatment", "over", ex(claim.operation, over.status, over.body ?? {})),
      ],
      d,
      claim,
    );

  it("designs max+1 (treatment) against 1 and max (control)", () => {
    expect(d.params.steps.map((s) => s.params)).toEqual([{ page_size: 101 }]);
    expect(d.control.params.steps.map((s) => s.params)).toEqual([{ page_size: 1 }, { page_size: 100 }]);
  });

  it("classifies rejected / clamped / reduced / over_limit", () => {
    expect(run({ status: 422 }).outcome).toBe("rejected");
    expect(run({ status: 200, body: items(100) }).outcome).toBe("clamped");
    expect(run({ status: 200, body: items(10) }).outcome).toBe("reduced");
    expect(run({ status: 200, body: items(101) }).outcome).toBe("over_limit");
    const o = run({ status: 200, body: items(100) });
    expect(judge(boundarySweep, d, o)).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-silent_truncation" });
  });

  it("a sweep that saw nothing (data set smaller than max) is uninformative", () => {
    const o = run({ status: 200, body: items(7) }, 7);
    expect(o.outcome).toBeNull();
    expect(judge(boundarySweep, d, o).verdict).toBe("uninformative");
  });

  it("size 1 reading like size max+1 fails the instrument check", () => {
    const o = run({ status: 200, body: items(100) }, 100, 100);
    expect(judge(boundarySweep, d, o).verdict).toBe("invalid");
  });
});

describe("pagination_completeness", () => {
  const claim = claimOf("dodo.payments.page-size-max-100");
  const h = hyps("a", ["honored", "silent_truncation", "mislabelled_semantics"]);
  const d = designOf(paginationCompleteness, claim, h);
  const page = (ids: string[]) => ({ items: ids.map((payment_id) => ({ payment_id })) });
  const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => `p${a + i}`);
  const run = (pages: string[][], all: string[]) =>
    paginationCompleteness.observe(
      [t("control", "all", ex(claim.operation, 200, page(all))), ...pages.map((p, i) => t("treatment", "page", ex(claim.operation, 200, page(p)), i))],
      d,
      claim,
    );

  it("walks 3 pages of 10 against one page of 30", () => {
    expect(d.params.steps.map((s) => s.params)).toEqual([0, 1, 2].map((n) => ({ page_size: 10, page_number: n })));
    expect(d.control.params.steps[0]!.params).toEqual({ page_size: 30, page_number: 0 });
  });

  it("same_set / overlap / mismatch", () => {
    expect(run([range(0, 10), range(10, 20), range(20, 30)], range(0, 30)).outcome).toBe("same_set");
    expect(run([range(0, 10), range(0, 10), range(10, 20)], range(0, 30)).outcome).toBe("overlap");
    expect(run([range(0, 10), range(11, 21), range(21, 30)], range(0, 30)).outcome).toBe("mismatch");
    const o = run([range(0, 10), range(0, 10), range(10, 20)], range(0, 30));
    expect(judge(paginationCompleteness, d, o)).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-mislabelled_semantics" });
  });

  it("a set that fits on one page is uninformative; a page_size that does nothing is invalid", () => {
    expect(run([range(0, 8), [], []], range(0, 8)).outcome).toBeNull();
    const ignored = run([range(0, 30), range(0, 30), range(0, 30)], range(0, 30));
    expect(judge(paginationCompleteness, d, ignored).verdict).toBe("invalid");
  });
});

describe("retry_after_timeout", () => {
  const claim = claimOf("dodo.wallet.idempotency-key-no-duplicate");
  const h = hyps("a", ["honored", "idempotency_hazard"]);
  const d = designOf(retryAfterTimeout, claim, h);
  const list = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({ id: `e${i}` })) });
  const run = (before: number, after: number, writeStatus = 200) =>
    retryAfterTimeout.observe(
      [
        t("control", "count", ex("dodo.listWalletLedgerEntries", 200, list(before))),
        t("treatment", "write", ex("dodo.createWalletLedgerEntry", writeStatus, {})),
        t("treatment", "write", ex("dodo.createWalletLedgerEntry", writeStatus, {})),
        t("treatment", "count", ex("dodo.listWalletLedgerEntries", 200, list(after))),
      ],
      d,
      claim,
    );

  it("repeats the identical keyed write at most 3 times", () => {
    const write = d.params.steps.find((s) => s.tag === "write")!;
    expect(write.repeat).toBeLessThanOrEqual(MAX_STEP_REPEAT);
    expect(write.params).toMatchObject({ idempotency_key: "notary-probe-run-t-p1" });
    for (const m of [d.params, d.control.params]) for (const s of m.steps) expect(s.repeat ?? 1).toBeLessThanOrEqual(3);
  });

  it("single vs duplicate", () => {
    expect(judge(retryAfterTimeout, d, run(0, 1))).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-honored" });
    expect(judge(retryAfterTimeout, d, run(0, 3))).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-idempotency_hazard" });
  });

  it("no write landing (before == after) is invalid; no 2xx write is uninformative", () => {
    expect(judge(retryAfterTimeout, d, run(0, 0)).verdict).toBe("invalid");
    expect(judge(retryAfterTimeout, d, run(0, 0, 500)).verdict).toBe("uninformative");
  });

  it("refund retries need a probe-reserved payment", () => {
    const refund = claimOf("dodo.refund.full-retry-no-duplicate");
    expect(isSkip(retryAfterTimeout.design(refund, h, ctx()))).toBe(true);
    const r = designOf(retryAfterTimeout, refund, h, ctx({ payments: new SimplePaymentPool(["pay_9"]) }));
    expect(r.params.steps[0]).toMatchObject({ op: "dodo.createRefund", repeat: 2, params: { payment_id: "pay_9" } });
  });
});

describe("write_then_read", () => {
  const claim = claimOf("dodo.payment.refunds-lists-issued-refund");
  const h = hyps("a", ["honored", "eventual_consistency", "mislabelled_semantics"]);
  const d = designOf(writeThenRead, claim, h, ctx({ payments: new SimplePaymentPool(["pay_1"]) }));
  const pay = (has: boolean) => ({ payment_id: "pay_1", refunds: has ? [{ refund_id: "ref_1" }] : [] });
  const run = (seen: [boolean, boolean, boolean], directStatus = 200) =>
    writeThenRead.observe(
      [
        t("control", "before", ex("dodo.getPayment", 200, pay(false))),
        t("treatment", "write", ex("dodo.createRefund", 200, { refund_id: "ref_1" })),
        t("treatment", "read_now", ex("dodo.getPayment", 200, pay(seen[0]))),
        t("treatment", "read_window", ex("dodo.getPayment", 200, pay(seen[1]))),
        t("treatment", "read_late", ex("dodo.getPayment", 200, pay(seen[2]))),
        t("treatment", "direct", ex("dodo.getRefund", directStatus, { refund_id: "ref_1" })),
      ],
      d,
      claim,
    );

  it("reads now, at ~ms and at ~3ms, then directly by id", () => {
    expect(d.params.steps.map((s) => s.tag)).toEqual(["write", "read_now", "read_window", "read_late", "direct"]);
    expect(d.params.steps[2]!.delayMs).toBe(1000);
    expect(d.params.steps[4]!.params).toEqual({ refund_id: "$from:0:refund_id" });
  });

  it("within / after / never", () => {
    expect(judge(writeThenRead, d, run([false, true, true]))).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-honored" });
    expect(judge(writeThenRead, d, run([false, false, true]))).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-eventual_consistency" });
    expect(judge(writeThenRead, d, run([false, false, false]))).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-mislabelled_semantics" });
  });

  it("never visible AND not readable by id means the write never landed: invalid", () => {
    expect(judge(writeThenRead, d, run([false, false, false], 404)).verdict).toBe("invalid");
  });
});

describe("unknown_param", () => {
  const claim = claimOf("crustdata.identify.invalid-fields-400");
  const h = hyps("a", ["honored", "silent_coercion", "undocumented_flag"]);
  const d = designOf(unknownParam, claim, h);
  const run = (status: number, body: unknown, control: Reply = { status: 200, body: [{ matches: [] }] }) =>
    unknownParam.observe(
      [t("control", "probe", ex(claim.operation, control.status, control.body)), t("treatment", "probe", ex(claim.operation, status, body))],
      d,
      claim,
    );

  it("treatment carries the invalid param; control is the same request without it", () => {
    expect(d.params.steps[0]!.params).toHaveProperty("fields");
    expect(d.control.params.steps[0]!.params).not.toHaveProperty("fields");
    expect(d.control.params.steps[0]!.params).toHaveProperty("domains");
  });

  it("rejected / ignored / applied; a failed baseline is uninformative", () => {
    expect(judge(unknownParam, d, run(400, {}))).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-honored" });
    expect(judge(unknownParam, d, run(200, [{ matches: [] }]))).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-silent_coercion" });
    expect(judge(unknownParam, d, run(200, [{ matches: [{ headcount: 1 }] }]))).toMatchObject({ winningHypothesisId: "hyp-undocumented_flag" });
    expect(judge(unknownParam, d, run(400, {}, { status: 500 })).verdict).toBe("uninformative");
  });
});

describe("type_edge", () => {
  const claim = claimOf("crustdata.enrich.headcount-total-integer");
  const h = hyps("a", ["honored", "silent_coercion", "mislabelled_semantics"]);
  const d = designOf(typeEdge, claim, h);
  const body = (v: unknown) => [{ matches: [{ company_data: { headcount: { total: v } } }] }];
  const run = (tv: unknown, cv: unknown) =>
    typeEdge.observe([t("control", "read", ex(claim.operation, 200, body(cv))), t("treatment", "read", ex(claim.operation, 200, body(tv)))], d, claim);

  it("splits the recon's two domains and prices enrich per identifier", () => {
    expect(d.params.steps[0]!.params).toMatchObject({ domains: ["stripe.com"] });
    expect(d.control.params.steps[0]!.params).toMatchObject({ domains: ["notion.so"] });
    expect(d).toMatchObject({ estCredits: 4, estCalls: 2 });
  });

  it("doc_type / numeric_string / float / other_type", () => {
    expect(run(8000, 900).outcome).toBe("doc_type");
    expect(run("8000", 900).outcome).toBe("numeric_string");
    expect(run(8000.5, 900).outcome).toBe("float");
    expect(run({ n: 1 }, 900).outcome).toBe("other_type");
    expect(judge(typeEdge, d, run("8000", 900))).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-silent_coercion" });
  });

  it("null-only reads are uninformative; identical values are invalid", () => {
    expect(judge(typeEdge, d, run(null, null)).verdict).toBe("uninformative");
    expect(judge(typeEdge, d, run(8000, 8000)).verdict).toBe("invalid");
  });
});

describe("header_burst", () => {
  const claim = claimOf("crustdata.credits.balance-number");
  const h = hyps("a", ["honored", "rate_limit"]);

  it("predicts limited only for rate_limit and bursts a free read", () => {
    const d = designOf(headerBurst, claim, h);
    expect(d.predictions["hyp-rate_limit"]!.outcomes).toEqual(["limited"]);
    expect(d.predictions["hyp-honored"]!.outcomes).toEqual(["not_limited"]);
    expect(d.params.steps.every((s) => s.op === "crustdata.getCreditBalance")).toBe(true);
    expect(d).toMatchObject({ estCredits: 0, estCalls: 6 });
  });

  it("classifies limited / not_limited from executed exchanges", async () => {
    const c = ctx();
    const d = designOf(headerBurst, claim, h, c);
    const io = new FakeIo((_op, _a, n) => (n >= 4 ? { status: 429 } : { status: 200, body: { account: { credits: 5 } } }));
    const o = headerBurst.observe(await headerBurst.execute(io, d, c), d, claim);
    expect(o.outcome).toBe("limited");
    expect(judge(headerBurst, d, o)).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-rate_limit" });
    const c2 = ctx();
    const d2 = designOf(headerBurst, claim, h, c2);
    const o2 = headerBurst.observe(await headerBurst.execute(new FakeIo(() => ({ status: 200 })), d2, c2), d2, claim);
    expect(o2.outcome).toBe("not_limited");
  });

  it("the per-run cap (10) holds across probes; request 11 is never sent", async () => {
    const burst = new BurstCounter();
    const io = new FakeIo(() => ({ status: 200 }));
    const d1 = designOf(headerBurst, claim, h, ctx({ burst }));
    await headerBurst.execute(io, d1, ctx({ burst }));
    expect(burst.count).toBe(6);
    const d2 = designOf(headerBurst, claim, h, ctx({ burst }));
    expect(d2.estCalls).toBe(4); // shrinks to what's left
    await headerBurst.execute(io, d2, ctx({ burst }));
    expect(burst.count).toBe(HEADER_BURST_MAX_REQUESTS_PER_RUN);
    expect(isSkip(headerBurst.design(claim, h, ctx({ burst })))).toBe(true);
    // Even a stale design can't push past the cap.
    await expect(headerBurst.execute(io, d1, ctx({ burst }))).rejects.toBeInstanceOf(BurstCapError);
    expect(io.log).toHaveLength(HEADER_BURST_MAX_REQUESTS_PER_RUN);
    expect(new BurstCounter(50).max).toBe(HEADER_BURST_MAX_REQUESTS_PER_RUN);
  });
});

// ---------------------------------------------------------------------------------------------
// Score

function fakeDesign(name: ProbeDesign["template"], outcomes: string[][], estCredits: number, estCalls: number): ProbeDesign {
  const predictions = Object.fromEntries(outcomes.map((o, i) => [`h${i}`, { class: "honored" as DefectClass, outcomes: o }]));
  return { template: name, params: { steps: [] }, control: { params: { steps: [] } }, predictions, estCredits, estCalls };
}

describe("score", () => {
  it("separates = hypothesis pairs whose predictions differ; wildcards separate nothing", () => {
    expect(separates(fakeDesign("type_edge", [["a"], ["b"], ["c"]], 0, 1).predictions)).toBe(3);
    expect(separates(fakeDesign("type_edge", [["a"], ["a"], ["b"]], 0, 1).predictions)).toBe(2);
    expect(separates(fakeDesign("type_edge", [["a"], ["*"], ["b"]], 0, 1).predictions)).toBe(1);
    expect(separates(fakeDesign("type_edge", [["b", "a"], ["a", "b"]], 0, 1).predictions)).toBe(0);
  });

  it("score = separated / (credits + λ·calls)", () => {
    const s = scoreDesign(fakeDesign("type_edge", [["a"], ["b"], ["c"]], 4, 2), 1);
    expect(s).toMatchObject({ separates: 3, cost: 6, score: 0.5 });
    expect(scoreDesign(fakeDesign("type_edge", [["a"], ["a"]], 0, 0), 1).score).toBe(0);
    expect(scoreDesign(fakeDesign("type_edge", [["a"], ["b"]], 0, 3), 0).score).toBe(Number.POSITIVE_INFINITY);
  });

  it("cheaper wins at equal separation; λ can flip credits vs calls", () => {
    const enrich = fakeDesign("type_edge", [["a"], ["b"]], 4, 1); // credits-heavy
    const chatty = fakeDesign("header_burst", [["a"], ["b"]], 0, 6); // call-heavy
    expect(rankDesigns([chatty, enrich], 1).map((s) => s.design.template)).toEqual(["type_edge", "header_burst"]);
    expect(rankDesigns([enrich, chatty], 0.5).map((s) => s.design.template)).toEqual(["header_burst", "type_edge"]);
    // more separation beats lower cost when the ratio says so
    const sharp = fakeDesign("unit_roundtrip", [["a"], ["b"], ["c"]], 4, 1);
    expect(rankDesigns([enrich, sharp], 1)[0]!.design.template).toBe("unit_roundtrip");
  });

  it("drops designs that separate nothing and breaks ties deterministically", () => {
    const a = fakeDesign("unknown_param", [["a"], ["b"]], 0, 2);
    const b = fakeDesign("boundary_sweep", [["a"], ["b"]], 0, 2);
    const none = fakeDesign("type_edge", [["*"], ["b"]], 0, 1);
    expect(rankDesigns([a, none, b], 1).map((s) => s.design.template)).toEqual(["boundary_sweep", "unknown_param"]);
    expect(rankDesigns([b, a], 1).map((s) => s.design.template)).toEqual(["boundary_sweep", "unknown_param"]);
  });

  it("λ comes from NOTARY_PROBE_LAMBDA, default 1, invalid values fall back", () => {
    expect(DEFAULT_PROBE_LAMBDA).toBe(1);
    expect(lambdaFromEnv({})).toBe(1);
    expect(lambdaFromEnv({ NOTARY_PROBE_LAMBDA: "0.25" })).toBe(0.25);
    expect(lambdaFromEnv({ NOTARY_PROBE_LAMBDA: "-1" })).toBe(1);
    expect(lambdaFromEnv({ NOTARY_PROBE_LAMBDA: "abc" })).toBe(1);
  });

  it("cost model: ledger-observed cost, then claim.costCredits, then list price; enrich per identifier", () => {
    const claims = [claimOf("crustdata.enrich.headcount-total-integer"), claimOf("crustdata.identify.invalid-fields-400")];
    const m = buildCostModel({ claims });
    expect(m.creditsPerCall("crustdata.enrichCompany", { domains: ["a", "b", "c"] })).toBe(6);
    expect(m.creditsPerCall("crustdata.enrichCompany", { domains: ["a"], fields: ["technographics"] })).toBe(4);
    expect(m.creditsPerCall("crustdata.identifyCompany", {})).toBe(0);
    expect(m.creditsPerCall("dodo.createRefund", {})).toBe(0);
    const seen = buildCostModel({
      claims,
      ledger: { budget: 100, total: 0.06, reserved: 0, remaining: 99.94, byEndpoint: { "crustdata.identifyCompany": 0.06 }, calls: { "crustdata.identifyCompany": 2 } },
    });
    expect(seen.creditsPerCall("crustdata.identifyCompany", {})).toBeCloseTo(0.03);
  });
});

// ---------------------------------------------------------------------------------------------
// Commit-then-run, budget

describe("runner: commit, then run", () => {
  const claim = claimOf("dodo.product.price-minor-units");
  const h = hyps("anom-1", ["honored", "unit_mismatch"]);

  it("commits the prediction to SQLite before the first HTTP call and records the verdict after", async () => {
    const db = freshDb();
    const io = new FakeIo((_op, args) => {
      const p = args[0] as { price: { price: number } };
      return { status: 200, body: { price: { price: p.price.price * 100 } } };
    });
    io.watch = { db, probeId: "run-t-p001" };
    const c = ctx();
    const design = designOf(unitRoundtrip, claim, h, c);
    const clock = { t: Date.parse("2026-10-10T09:59:59.000Z") };
    const res = await runProbe({
      io,
      db,
      runId: "run-t",
      probeId: "run-t-p001",
      claim,
      template: unitRoundtrip,
      design,
      ctx: c,
      ledger: new CreditLedger({ budget: 10 }),
      now: () => new Date((clock.t += 1)),
    });
    expect(io.log.length).toBe(2);
    for (const call of io.log) {
      expect(call.committed).toBe(true);
      expect(Date.parse(call.committedAt!)).toBeLessThan(call.at);
    }
    expect(res.verdict).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-unit_mismatch" });
    const [stored] = db.loadProbes("run-t");
    expect(stored).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-unit_mismatch", predictionHash: res.probe.predictionHash, calls: 2 });
    expect(stored!.prediction).toEqual(design.predictions);
    expect(Date.parse(stored!.committedAt)).toBeLessThan(Date.parse(stored!.ranAt!));
  });

  it("refuses to let a template call before the commit exists", async () => {
    const db = freshDb();
    const realCommit = db.commitProbe.bind(db);
    db.commitProbe = (p) => {
      const hash = realCommit({ ...p, id: "some-other-id" }); // row lands under another id
      return hash;
    };
    const io = new FakeIo(() => ({ status: 200 }));
    const c = ctx();
    await expect(
      runProbe({ io, db, runId: "run-t", probeId: "run-t-p001", claim, template: unitRoundtrip, design: designOf(unitRoundtrip, claim, h, c), ctx: c, ledger: new CreditLedger({ budget: 10 }) }),
    ).rejects.toThrow();
    expect(io.log).toHaveLength(0);
    expect(new CommitOrderError("p", "op").name).toBe("CommitOrderError");
  });

  it("budget: a probe whose estimate exceeds the remaining credits is never committed or sent", async () => {
    const db = freshDb();
    const enrich = claimOf("crustdata.enrich.headcount-total-integer");
    const c = ctx({ costs: buildCostModel({ claims: [enrich] }) });
    const design = designOf(typeEdge, enrich, hyps("anom-1", ["honored", "silent_coercion"]), c);
    const io = new FakeIo(() => ({ status: 200 }));
    await expect(
      runProbe({ io, db, runId: "run-t", probeId: "run-t-p001", claim: enrich, template: typeEdge, design, ctx: c, ledger: new CreditLedger({ budget: 3 }) }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(io.log).toHaveLength(0);
    expect(db.loadProbes("run-t")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The loop

describe("runProbeLoop", () => {
  const claim = claimOf("dodo.product.price-minor-units");
  const echo = (f: (n: number) => number) =>
    new FakeIo((_op, args) => {
      const p = args[0] as { price: { price: number } };
      return { status: 200, body: { price: { price: f(p.price.price) } } };
    });

  it("one batched propose call, a probe per anomaly, verdict recorded", async () => {
    const db = freshDb();
    const llm = new FakeLlm([hypothesesReply([["honored", "unit_roundtrip"], ["unit_mismatch", "unit_roundtrip"]])]);
    const res = await runProbeLoop({
      tool: "dodo",
      anomalies: [anomalyFor(claim, "anom-1"), anomalyFor(claim, "anom-2")],
      claims: [claim],
      tools: echo((n) => n * 100),
      llm,
      db,
      runId: "loop-1",
      ledger: new CreditLedger({ budget: 10 }),
    });
    expect(llm.requests).toHaveLength(1);
    expect(res.hypotheses).toHaveLength(4);
    expect(res.probes).toHaveLength(2);
    expect(res.probes.every((p) => p.verdict === "confirmed" && p.template === "unit_roundtrip")).toBe(true);
    const winners = res.probes.map((p) => res.hypotheses.find((h) => h.id === p.winningHypothesisId)!.class);
    expect(winners).toEqual(["unit_mismatch", "unit_mismatch"]);
    expect(res.usage).toMatchObject({ calls: 1, inputTokens: 100 });
    expect(db.loadProbes("loop-1").map((p) => p.id)).toEqual(res.probes.map((p) => p.id));
  });

  it("all rivals refuted -> re-propose once with the probe as evidence, then probe the new rivals", async () => {
    const db = freshDb();
    const llm = new FakeLlm([
      hypothesesReply([["honored", "unit_roundtrip"], ["unit_mismatch", "unit_roundtrip"]]),
      hypothesesReply([["silent_coercion", "type_edge"], ["honored", "type_edge"]]),
    ]);
    const res = await runProbeLoop({
      tool: "dodo",
      anomalies: [anomalyFor(claim)],
      claims: [claim],
      tools: echo((n) => n + 1),
      llm,
      db,
      runId: "loop-2",
      ledger: new CreditLedger({ budget: 10 }),
    });
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages[0]!.content).toContain("REFUTED");
    expect(res.probes.map((p) => p.verdict)).toEqual(["refuted", "confirmed"]);
    expect(res.hypotheses.find((h) => h.id === res.probes[1]!.winningHypothesisId)!.class).toBe("silent_coercion");
    expect(res.abstained).toEqual([]);
    expect(db.loadHypotheses("loop-2")).toHaveLength(4);
  });

  it("re-proposed rivals refuted too -> abstain (no third proposal)", async () => {
    const db = freshDb();
    const llm = new FakeLlm([
      hypothesesReply([["honored", "unit_roundtrip"], ["unit_mismatch", "unit_roundtrip"]]),
      hypothesesReply([["honored", "type_edge"], ["unit_mismatch", "type_edge"]]),
    ]);
    const res = await runProbeLoop({
      tool: "dodo",
      anomalies: [anomalyFor(claim)],
      claims: [claim],
      tools: echo((n) => n + 1),
      llm,
      db,
      runId: "loop-3",
      ledger: new CreditLedger({ budget: 10 }),
    });
    expect(llm.requests).toHaveLength(2);
    expect(res.probes.map((p) => p.verdict)).toEqual(["refuted", "refuted"]);
    expect(res.abstained).toEqual(["anom-1"]);
  });

  it("stops cleanly when the credit budget can't cover the best probe", async () => {
    const db = freshDb();
    const enrich = claimOf("crustdata.enrich.headcount-total-integer");
    const io = new FakeIo(() => ({ status: 200 }));
    const res = await runProbeLoop({
      tool: "crustdata",
      anomalies: [anomalyFor(enrich)],
      claims: [enrich],
      tools: io,
      llm: new FakeLlm([hypothesesReply([["honored", "type_edge"], ["silent_coercion", "type_edge"]])]),
      db,
      runId: "loop-4",
      ledger: new CreditLedger({ budget: 2 }),
    });
    expect(res.stoppedReason).toMatch(/Credit budget exceeded/);
    expect(res.probes).toEqual([]);
    expect(io.log).toHaveLength(0);
  });

  it("anomalies with no designable probe are reported as skipped, with the reason", async () => {
    const db = freshDb();
    const refund = claimOf("dodo.refund.amount-minor-units");
    const res = await runProbeLoop({
      tool: "dodo",
      anomalies: [anomalyFor(refund)],
      claims: [refund],
      tools: new FakeIo(() => ({ status: 200 })),
      llm: new FakeLlm([hypothesesReply([["honored", "unit_roundtrip"], ["unit_mismatch", "unit_roundtrip"]])]),
      db,
      runId: "loop-5",
      ledger: new CreditLedger({ budget: 10 }),
      payments: new SimplePaymentPool([]) as PaymentPool,
    });
    expect(res.probes).toEqual([]);
    expect(res.skipped[0]!.reason).toMatch(/probe-reserved/);
  });
});

describe("notarize CLI flow", () => {
  it("reports every missing credential as BLOCKED (exit 3) before any call", async () => {
    const r = await notarize({ tool: "crustdata", env: {}, dbPath: ":memory:" });
    expect(r.exitCode).toBe(3);
    expect(r.status).toBe("blocked");
    expect(r.lines).toEqual(["BLOCKED: CRUSTDATA_API_KEY not set", "BLOCKED: NOTARY_MODEL_REFLECTOR not set", "BLOCKED: AWS_REGION not set"]);
  });
});
