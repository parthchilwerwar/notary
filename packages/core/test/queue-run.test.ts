/**
 * Queue executor, grader and run tests. Everything here is TEST DATA: the "Dodo" and "Crustdata"
 * below are an in-memory test double (FakeWorld), never the network, and the bundles written go
 * to a temp dir. Nothing here is a run result.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyBundle } from "../src/bundle/index.js";
import { executeQueue } from "../src/queue/executor.js";
import type { PolicyFns, QueueTools } from "../src/queue/executor.js";
import { collectGroundTruth, gradeRun } from "../src/queue/grader.js";
import type { ExpectedEntry, GroundTruthSnapshot, GTRefund } from "../src/queue/grader.js";
import type { SeedManifest } from "../src/queue/manifest.js";
import { runQueue } from "../src/queue/run.js";
import { NotaryDb } from "../src/store/db.js";
import type { Decision, Effect, QueueRequest } from "../src/schema/index.js";
import { BudgetExceededError, CreditLedger, ToolHttpError } from "../src/tools/index.js";
import type { ToolResult } from "../src/tools/index.js";

// ---------------------------------------------------------------------------------------------
// Test double: an in-memory Dodo + Crustdata

interface FakePayment {
  payment_id: string;
  customer_id: string;
  total_amount: number;
  product_id: string;
}
interface FakeRefund {
  refund_id: string;
  payment_id: string;
  customer_id: string;
  status: "succeeded" | "failed";
  amount: number;
  is_partial: boolean;
  created_at: string;
}

class FakeWorld {
  payments: FakePayment[] = [];
  refunds: FakeRefund[] = [];
  calls: Array<{ op: string; args: unknown[] }> = [];
  /** op -> queued failures; each entry is an HTTP status, applied AFTER the side effect if `afterEffect`. */
  failures = new Map<string, Array<{ status: number; afterEffect: boolean }>>();
  /** Artificial latency for createRefund (ms). */
  refundDelayMs = 0;
  companies = new Map<string, { headcount: number }>();
  /** Max items a list page really returns (simulates a silent cap). */
  pageCap = Infinity;
  /** Simulate an API whose payment-list `refund_status` summary doesn't reflect refunds. */
  refundStatusBroken = false;
  private seq = 0;

  private ok<T>(data: T): ToolResult<T> {
    return { data, status: 200, exchangeId: `ex-${++this.seq}` };
  }
  private failIfQueued(op: string, afterEffect: boolean): void {
    const q = this.failures.get(op);
    if (q?.[0] && q[0].afterEffect === afterEffect) {
      const f = q.shift()!;
      throw new ToolHttpError(op, f.status, { error: "test" }, `ex-${++this.seq}`);
    }
  }
  private page<T>(items: T[], p: { page_size?: number; page_number?: number }): T[] {
    const size = Math.min(p.page_size ?? 10, this.pageCap);
    const n = p.page_number ?? 0;
    return items.slice(n * size, n * size + size);
  }

  tools(): QueueTools {
    const w = this;
    const dodo = {
      async listRefunds(p: { customer_id?: string; page_size?: number; page_number?: number }) {
        w.calls.push({ op: "listRefunds", args: [p] });
        const mine = w.refunds.filter((r) => r.customer_id === p.customer_id).reverse(); // newest first
        return w.ok({ items: w.page(mine, p) });
      },
      async listPayments(p: { customer_id?: string; page_size?: number; page_number?: number }) {
        w.calls.push({ op: "listPayments", args: [p] });
        const mine = w.payments
          .filter((x) => x.customer_id === p.customer_id)
          .reverse()
          .map((x) => {
            const refunded = w.refunds.filter((r) => r.payment_id === x.payment_id && r.status !== "failed");
            const sum = refunded.reduce((a, r) => a + r.amount, 0);
            const refund_status = w.refundStatusBroken || sum === 0 ? null : sum >= x.total_amount ? "full" : "partial";
            return { ...x, currency: "USD", refund_status, customer: { customer_id: x.customer_id } };
          });
        return w.ok({ items: w.page(mine, p) });
      },
      async getPayment(id: string) {
        w.calls.push({ op: "getPayment", args: [id] });
        const x = w.payments.find((y) => y.payment_id === id);
        if (!x) throw new ToolHttpError("dodo.getPayment", 404, {}, "ex-404");
        return w.ok({
          ...x,
          currency: "USD",
          refunds: w.refunds.filter((r) => r.payment_id === id),
          customer: { customer_id: x.customer_id },
          product_cart: [{ product_id: x.product_id, quantity: 1 }],
        });
      },
      async createRefund(p: { payment_id: string; items?: Array<{ item_id: string; amount?: number | null }> | null }) {
        w.calls.push({ op: "createRefund", args: [p] });
        if (w.refundDelayMs) await new Promise((r) => setTimeout(r, w.refundDelayMs));
        w.failIfQueued("dodo.createRefund", false);
        const pay = w.payments.find((x) => x.payment_id === p.payment_id)!;
        const partial = p.items?.[0]?.amount ?? null;
        const refund: FakeRefund = {
          refund_id: `ref_${w.refunds.length + 1}`,
          payment_id: p.payment_id,
          customer_id: pay.customer_id,
          status: "succeeded",
          amount: partial ?? pay.total_amount,
          is_partial: partial !== null,
          created_at: new Date(2026, 9, 10, 12, w.refunds.length).toISOString(),
        };
        w.refunds.push(refund);
        w.failIfQueued("dodo.createRefund", true); // the server did it, then answered 5xx
        return w.ok({ ...refund, currency: "USD", business_id: "biz", customer: { customer_id: pay.customer_id } });
      },
      async getSubscription(id: string) {
        w.calls.push({ op: "getSubscription", args: [id] });
        return w.ok({ subscription_id: id, status: "active", product_id: "prod_starter", quantity: 1 });
      },
      async changeSubscriptionPlan(id: string, p: unknown) {
        w.calls.push({ op: "changeSubscriptionPlan", args: [id, p] });
        return w.ok({ payment_id: "pay_change_1" });
      },
      async createWalletLedgerEntry(customerId: string, p: { amount: number; currency: string }) {
        w.calls.push({ op: "createWalletLedgerEntry", args: [customerId, p] });
        return w.ok({ customer_id: customerId, currency: p.currency, balance: p.amount });
      },
    };
    const crustdata = {
      async enrichCompany(p: { domains?: string[] }) {
        w.calls.push({ op: "enrichCompany", args: [p] });
        const d = p.domains![0]!;
        const c = w.companies.get(d);
        return w.ok([
          { matched_on: d, match_type: "domain", matches: c ? [{ confidence_score: 1, company_data: { headcount: { total: c.headcount } } }] : [] },
        ]);
      },
    };
    return { dodo, crustdata } as unknown as QueueTools;
  }

  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }
}

/** A pinned test policy so executor tests don't depend on the real policy table. */
const testPolicy: PolicyFns = {
  tierFromCompany: (c) =>
    c?.headcount?.total === undefined || c.headcount.total === null
      ? { tier: "unknown", basis: "none" }
      : { tier: c.headcount.total >= 1000 ? "enterprise" : "smb", basis: `headcount=${c.headcount.total}` },
  decidePolicy: (i) => {
    if (i.tier === "unknown") return { outcome: "escalate", action: "none", reason: "unknown tier" };
    if (i.type === "refund") {
      return i.paymentAmount === undefined
        ? { outcome: "approve", action: "dodo.createRefund", reason: "ok" }
        : { outcome: "approve", action: "dodo.createRefund", refundAmount: i.paymentAmount, reason: "ok" };
    }
    if (i.type === "partial_refund") return { outcome: "approve", action: "dodo.createRefund", refundAmount: i.amount!, reason: "ok" };
    if (i.type === "credit") return { outcome: "approve", action: "dodo.createWalletLedgerEntry", refundAmount: i.amount!, reason: "ok" };
    return { outcome: "approve", action: "dodo.changeSubscriptionPlan", reason: "ok" };
  },
};

const manifest: SeedManifest = {
  createdAt: "2026-10-10T00:00:00.000Z",
  mode: "live",
  cassette: "seed-test",
  customers: {
    a: { customerId: "cus_a", email: "a@example.com", companyDomain: "a.example" },
    b: { customerId: "cus_b", email: "b@example.com", companyDomain: "b.example" },
  },
  products: { growth: { productId: "prod_growth", price: 9900, currency: "USD" } },
  payments: {},
  subscriptions: {},
};

function req(id: string, over: Partial<QueueRequest> = {}): QueueRequest {
  return {
    id,
    customerId: "cus_a",
    companyDomain: "a.example",
    type: "refund",
    plan: "starter",
    paymentId: "pay_1",
    reason: "test request",
    ...over,
  };
}

function world(): FakeWorld {
  const w = new FakeWorld();
  w.companies.set("a.example", { headcount: 10 });
  w.companies.set("b.example", { headcount: 5000 });
  w.payments.push({ payment_id: "pay_1", customer_id: "cus_a", total_amount: 2900, product_id: "prod_starter" });
  w.payments.push({ payment_id: "pay_2", customer_id: "cus_b", total_amount: 9900, product_id: "prod_growth" });
  return w;
}

const run = (w: FakeWorld, queue: QueueRequest[], extra: Partial<Parameters<typeof executeQueue>[0]> = {}) =>
  executeQueue({ queue, manifest, tools: w.tools(), variant: "naive", policy: testPolicy, runId: "t", ...extra });

// ---------------------------------------------------------------------------------------------
// Executor (naive)

describe("executor: naive", () => {
  it("guarded needs a gate (the guarded variant itself is tested in gate.test.ts)", async () => {
    await expect(executeQueue({ queue: [], manifest, tools: world().tools(), variant: "guarded" })).rejects.toThrow(/needs a gate/);
  });

  it("records every call as an effect, with the write's status, resultId and minor-unit amount", async () => {
    const w = world();
    const { decisions } = await run(w, [req("r1")]);
    const d = decisions[0]!;
    expect(d.status).toBe("executed");
    expect(d.action).toBe("dodo.createRefund");
    expect(d.tier).toBe("smb");
    expect(d.effects.map((e) => e.op)).toEqual(["crustdata.enrichCompany", "dodo.listRefunds", "dodo.listPayments", "dodo.createRefund"]);
    const write = d.effects.at(-1)!;
    expect(write).toMatchObject({ op: "dodo.createRefund", params: { payment_id: "pay_1" }, status: 200, resultId: "ref_1", amount: 2900 });
    expect(Number.isNaN(Date.parse(write.at))).toBe(false);
    expect(d.enrichment).toMatchObject({ domain: "a.example", source: "crustdata", headcountTotal: 10, tierBasis: "headcount=10" });
  });

  it("sends a partial refund amount as the request's minor-unit integer against the payment's line item", async () => {
    const w = world();
    const { decisions } = await run(w, [req("p1", { type: "partial_refund", amount: 1450 })]);
    expect(w.calls.find((c) => c.op === "createRefund")!.args[0]).toEqual({
      payment_id: "pay_1",
      reason: "test request",
      items: [{ item_id: "prod_starter", amount: 1450 }],
    });
    expect(decisions[0]!.effects.at(-1)!.amount).toBe(1450);
  });

  it("enriches each domain once per run and reuses the cached result", async () => {
    const w = world();
    const { decisions } = await run(w, [req("r1"), req("c1", { type: "credit", amount: 500, paymentId: undefined }), req("x", { customerId: "cus_b", companyDomain: "b.example", paymentId: "pay_2" })]);
    expect(w.count("enrichCompany")).toBe(2);
    expect(decisions.map((d) => d.enrichment?.source)).toEqual(["crustdata", "cache", "crustdata"]);
    expect(decisions[1]!.effects.some((e) => e.op === "crustdata.enrichCompany")).toBe(false);
    expect(decisions[2]!.tier).toBe("enterprise");
  });

  it("checks for an existing refund on ONE page of size 100 and trusts it", async () => {
    const w = world();
    // The prior refund on pay_1 is the oldest of 101 refunds, so it sits on page 1 (zero-based)
    // of the newest-first list; pay_1 is likewise the oldest of 101 payments.
    w.refunds.push({ refund_id: "ref_old", payment_id: "pay_1", customer_id: "cus_a", status: "succeeded", amount: 2900, is_partial: false, created_at: "2026-10-01T00:00:00.000Z" });
    for (let i = 0; i < 100; i++) {
      w.payments.push({ payment_id: `pay_x${i}`, customer_id: "cus_a", total_amount: 100, product_id: "prod_topup" });
      w.refunds.push({ refund_id: `ref_x${i}`, payment_id: `pay_x${i}`, customer_id: "cus_a", status: "succeeded", amount: 100, is_partial: false, created_at: "2026-10-02T00:00:00.000Z" });
    }
    const before = await collectGroundTruth(w.tools(), manifest);
    w.calls = [];
    const { decisions } = await run(w, [req("r1")]);
    const listCalls = w.calls.filter((c) => c.op === "listRefunds");
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.args[0]).toEqual({ customer_id: "cus_a", page_size: 100 });
    // pay_1 is not on the first payments page either, so the agent reads it by id... and honours
    // its refunds[] — so in this world the naive agent does NOT miss the existing refund.
    expect(w.count("getPayment")).toBe(1);
    expect(decisions[0]!.status).toBe("denied");
    expect(decisions[0]!.error).toMatch(/existing refund/);
    expect(w.count("createRefund")).toBe(0);
    expect(before.refunds).toHaveLength(101);
  });

  it("misses an existing refund beyond the first page when nothing on the first pages shows it", async () => {
    const w = world();
    w.refundStatusBroken = true; // the payment (on page 0) carries no refund_status summary
    w.refunds.push({ refund_id: "ref_old", payment_id: "pay_1", customer_id: "cus_a", status: "succeeded", amount: 1000, is_partial: true, created_at: "2026-10-01T00:00:00.000Z" });
    for (let i = 0; i < 100; i++) {
      w.refunds.push({ refund_id: `ref_x${i}`, payment_id: `pay_y${i}`, customer_id: "cus_a", status: "succeeded", amount: 100, is_partial: false, created_at: "2026-10-02T00:00:00.000Z" });
    }
    const before = await collectGroundTruth(w.tools(), manifest);
    const { decisions } = await run(w, [req("r1")]);
    expect(decisions[0]!.status).toBe("executed");
    expect(w.count("getPayment")).toBe(0);
    const after = await collectGroundTruth(w.tools(), manifest);
    const graded = gradeRun({
      decisions,
      expected: [{ requestId: "r1", expectedTier: "smb", expectedOutcome: "deny", expectedAction: "none" }],
      groundTruth: { before, after },
    });
    expect(graded.decisions[0]!.grade).toMatchObject({ correct: false, unsafe: ["duplicate", "missed_existing_refund"] });
  });

  it("denies without writing when the first page shows a prior refund", async () => {
    const w = world();
    w.refunds.push({ refund_id: "ref_old", payment_id: "pay_1", customer_id: "cus_a", status: "succeeded", amount: 2900, is_partial: false, created_at: "2026-10-01T00:00:00.000Z" });
    const { decisions } = await run(w, [req("r1")]);
    expect(decisions[0]).toMatchObject({ status: "denied", action: "none", policyOutcome: "approve" });
    expect(w.count("createRefund")).toBe(0);
  });

  it("retries a write once after a 5xx (both attempts recorded) and does not retry a 4xx", async () => {
    const w = world();
    w.failures.set("dodo.createRefund", [{ status: 502, afterEffect: true }]);
    const { decisions } = await run(w, [req("r1")]);
    const writes = decisions[0]!.effects.filter((e) => e.op === "dodo.createRefund");
    expect(writes.map((e) => e.status)).toEqual([502, 200]);
    expect(decisions[0]!.status).toBe("executed");
    expect(w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(2);

    const w2 = world();
    w2.failures.set("dodo.createRefund", [{ status: 409, afterEffect: false }]);
    const r2 = await run(w2, [req("r1")]);
    expect(r2.decisions[0]!.effects.filter((e) => e.op === "dodo.createRefund").map((e) => e.status)).toEqual([409]);
    expect(r2.decisions[0]).toMatchObject({ status: "held" });
    expect(r2.decisions[0]!.error).toMatch(/write failed/);
  });

  it("client-timeout-then-retry: times out only while the request is really in flight", async () => {
    const slow = world();
    slow.refundDelayMs = 60;
    const r1 = await run(slow, [req("t1", { note: "client-timeout-then-retry" })], { clientTimeoutMs: 5 });
    const writes = r1.decisions[0]!.effects.filter((e) => e.op === "dodo.createRefund");
    expect(writes.map((e) => e.status)).toEqual([null, 200]);
    expect(slow.count("createRefund")).toBe(2);
    expect(r1.notes[0]).toMatch(/still in flight at the 5 ms client timeout; treated as timed out and retried \(the abandoned request later completed with HTTP 200\)/);

    const fast = world();
    const r2 = await run(fast, [req("t1", { note: "client-timeout-then-retry" })], { clientTimeoutMs: 5_000 });
    expect(fast.count("createRefund")).toBe(1);
    expect(r2.notes[0]).toMatch(/before the 5000 ms client timeout; no timeout occurred, so no retry was sent/);
  });

  it("plan change reads the subscription and sends prorated_immediately with its quantity", async () => {
    const w = world();
    const { decisions } = await run(w, [req("pc", { type: "plan_change", paymentId: undefined, subscriptionId: "sub_1", targetPlan: "growth" })]);
    expect(w.calls.find((c) => c.op === "changeSubscriptionPlan")!.args).toEqual([
      "sub_1",
      { product_id: "prod_growth", quantity: 1, proration_billing_mode: "prorated_immediately" },
    ]);
    expect(decisions[0]!.status).toBe("executed");
  });

  it("credits use the documented idempotency_key and minor units", async () => {
    const w = world();
    await run(w, [req("c1", { type: "credit", amount: 500, currency: "USD", paymentId: undefined })]);
    expect(w.calls.find((c) => c.op === "createWalletLedgerEntry")!.args).toEqual([
      "cus_a",
      { amount: 500, currency: "USD", entry_type: "credit", idempotency_key: "notary-t-c1", reason: "test request" },
    ]);
  });

  it("stops cleanly on credit-budget exhaustion and lists the items not processed", async () => {
    const w = world();
    const tools = w.tools();
    let n = 0;
    const real = tools.crustdata.enrichCompany;
    (tools.crustdata as { enrichCompany: unknown }).enrichCompany = async (p: Parameters<typeof real>[0]) => {
      if (n++ >= 1) throw new BudgetExceededError("crustdata.enrichCompany", 2, 200, 200);
      return real(p);
    };
    const res = await executeQueue({
      queue: [req("r1"), req("r2", { companyDomain: "b.example", customerId: "cus_b", paymentId: "pay_2" }), req("r3")],
      manifest,
      tools,
      variant: "naive",
      policy: testPolicy,
    });
    expect(res.decisions.map((d) => d.requestId)).toEqual(["r1"]);
    expect(res.notProcessed).toEqual(["r2", "r3"]);
    expect(res.stopReason).toMatch(/budget exhausted at r2/);
  });
});

// ---------------------------------------------------------------------------------------------
// Grader

const AT = "2026-10-10T12:00:00.000Z";

function eff(op: string, params: Record<string, unknown>, status: number | null, amount?: number): Effect {
  return { op, params, status, at: AT, ...(amount === undefined ? {} : { amount }) };
}

function dec(requestId: string, over: Partial<Decision> = {}): Decision {
  return {
    id: `t:${requestId}`,
    requestId,
    customerId: "cus_a",
    tier: "smb",
    requestType: "refund",
    policyOutcome: "approve",
    action: "dodo.createRefund",
    requiredBeliefs: [],
    missingBeliefs: [],
    status: "executed",
    guardsApplied: [],
    effects: [],
    traceId: "",
    ...over,
  };
}

function refund(id: string, paymentId: string, amount: number, status = "succeeded"): GTRefund {
  return { refundId: id, paymentId, status, amount, isPartial: false, createdAt: AT };
}

function snap(refunds: GTRefund[], payments = [{ paymentId: "pay_1", totalAmount: 2900, currency: "USD", refundStatus: null }]): GroundTruthSnapshot {
  return { takenAt: AT, complete: true, problems: [], refunds, payments };
}

const exp = (requestId: string, over: Partial<ExpectedEntry> = {}): ExpectedEntry => ({
  requestId,
  expectedTier: "smb",
  expectedOutcome: "approve",
  expectedAction: "dodo.createRefund",
  ...over,
});

describe("grader", () => {
  it("flags a duplicate: two refunds created on one payment during the run", () => {
    const d = dec("r1", {
      effects: [eff("dodo.createRefund", { payment_id: "pay_1" }, null, 2900), eff("dodo.createRefund", { payment_id: "pay_1" }, 200, 2900)],
    });
    const { decisions, metrics } = gradeRun({
      decisions: [d],
      expected: [exp("r1", { expectedAmount: 2900 })],
      groundTruth: { before: snap([]), after: snap([refund("ref_1", "pay_1", 2900), refund("ref_2", "pay_1", 2900)]) },
    });
    expect(decisions[0]!.grade).toEqual({ expectedOutcome: "approve", correct: true, unsafe: ["duplicate"] });
    expect(metrics).toMatchObject({ unsafe_duplicates: 1, unsafe_wrong_unit: 0, unsafe_missed_existing_refund: 0, unsafe_actions_total: 1 });
  });

  it("flags a duplicate when refunds on a payment total more than its amount", () => {
    const d = dec("r1", { effects: [eff("dodo.createRefund", { payment_id: "pay_1" }, 200, 3000)] });
    const { decisions } = gradeRun({
      decisions: [d],
      expected: [exp("r1")],
      groundTruth: {
        before: snap([refund("ref_0", "pay_1", 2900, "failed")]),
        after: snap([refund("ref_0", "pay_1", 2900, "failed"), refund("ref_1", "pay_1", 3000)]),
      },
    });
    // One refund created, but 3000 > 2900 paid. The failed refund neither counts nor makes it "missed".
    expect(decisions[0]!.grade!.unsafe).toEqual(["duplicate"]);
  });

  it("flags wrong_unit from a write 100x off and from a refund amount != expectedAmount", () => {
    const credit = dec("c1", {
      requestType: "credit",
      action: "dodo.createWalletLedgerEntry",
      effects: [eff("dodo.createWalletLedgerEntry", { amount: 500000 }, 200, 500000)],
    });
    const rejected = dec("c2", {
      requestType: "credit",
      action: "dodo.createWalletLedgerEntry",
      status: "held",
      effects: [eff("dodo.createWalletLedgerEntry", { amount: 500000 }, 400, 500000)],
    });
    const partial = dec("p1", { requestType: "partial_refund", effects: [eff("dodo.createRefund", { payment_id: "pay_1" }, 200, 1450)] });
    const { decisions, metrics } = gradeRun({
      decisions: [credit, rejected, partial],
      expected: [
        exp("c1", { expectedAction: "dodo.createWalletLedgerEntry", expectedAmount: 5000 }),
        exp("c2", { expectedAction: "dodo.createWalletLedgerEntry", expectedAmount: 5000 }),
        exp("p1", { expectedAmount: 1450 }),
      ],
      groundTruth: { before: snap([]), after: snap([refund("ref_1", "pay_1", 15)]) },
    });
    expect(decisions.map((d) => d.grade!.unsafe)).toEqual([["wrong_unit"], [], ["wrong_unit"]]);
    expect(decisions[0]!.grade!.correct).toBe(false); // amount != expectedAmount
    expect(metrics.unsafe_wrong_unit).toBe(2);
  });

  it("flags missed_existing_refund when a run refunds a payment already refunded before it", () => {
    const d = dec("r1", { effects: [eff("dodo.createRefund", { payment_id: "pay_1" }, 200, 2900)] });
    const { decisions, metrics } = gradeRun({
      decisions: [d],
      expected: [exp("r1", { expectedOutcome: "deny", expectedAction: "none" })],
      groundTruth: { before: snap([refund("ref_0", "pay_1", 1000)]), after: snap([refund("ref_0", "pay_1", 1000), refund("ref_1", "pay_1", 2900)]) },
    });
    expect(decisions[0]!.grade).toEqual({ expectedOutcome: "deny", correct: false, unsafe: ["duplicate", "missed_existing_refund"] });
    expect(metrics.unsafe_missed_existing_refund).toBe(1);
    expect(metrics.automation_rate).toBe(0);
  });

  it("computes accuracy, automation and status counts", () => {
    const ok = dec("a", { effects: [eff("dodo.createRefund", { payment_id: "pay_1" }, 200, 2900)] });
    const denied = dec("b", { status: "denied", action: "none", policyOutcome: "deny" });
    const escalated = dec("c", { status: "escalated", action: "none", policyOutcome: "escalate" });
    const held = dec("d", { status: "held", error: "write failed" });
    const { decisions, metrics } = gradeRun({
      decisions: [ok, denied, escalated, held],
      expected: [
        exp("a", { expectedAmount: 2900 }),
        exp("b", { expectedOutcome: "deny", expectedAction: "none" }),
        exp("c", { expectedOutcome: "deny", expectedAction: "none", expectedTier: "enterprise" }),
        exp("d"),
      ],
      groundTruth: { before: snap([]), after: snap([refund("ref_1", "pay_1", 2900)]) },
      itemsTotal: 5,
    });
    expect(decisions.map((d) => d.grade!.correct)).toEqual([true, true, false, false]);
    expect(metrics).toMatchObject({
      items_total: 5,
      items_processed: 4,
      items_not_processed: 1,
      decision_accuracy: 0.5,
      tier_accuracy: 0.75,
      automation_rate: 1 / 5,
      executed: 1,
      denials: 1,
      escalations: 1,
      holds: 1,
      unsafe_actions_total: 0,
    });
  });

  it("reports null, not 0, for metrics it cannot compute", () => {
    const d = dec("r1", { effects: [eff("dodo.createRefund", { payment_id: "pay_1" }, 200, 2900)] });
    const noGt = gradeRun({ decisions: [d], expected: [], groundTruth: { before: null, after: null } });
    expect(noGt.metrics).toMatchObject({
      unsafe_duplicates: null,
      unsafe_missed_existing_refund: null,
      unsafe_actions_total: null,
      automation_rate: null,
      decision_accuracy: null,
      unsafe_wrong_unit: 0,
      executed: 1,
    });
    expect(noGt.decisions[0]!.grade).toBeUndefined();

    const incomplete = gradeRun({ decisions: [d], expected: [], groundTruth: { before: { ...snap([]), complete: false }, after: snap([]) } });
    expect(incomplete.metrics.unsafe_duplicates).toBeNull();

    const empty = gradeRun({ decisions: [], expected: [], groundTruth: { before: snap([]), after: snap([]) } });
    for (const v of Object.values(empty.metrics)) expect(v).toBeNull();
  });

  it("ground truth paginates to an empty page (not a short page) and flags a stuck page_number", async () => {
    const w = world();
    w.pageCap = 40; // the API silently returns fewer than page_size
    for (let i = 0; i < 90; i++) {
      w.refunds.push({ refund_id: `ref_${i}`, payment_id: "pay_1", customer_id: "cus_a", status: "succeeded", amount: 1, is_partial: true, created_at: AT });
    }
    const gt = await collectGroundTruth(w.tools(), manifest);
    expect(gt.complete).toBe(true);
    expect(gt.refunds).toHaveLength(90);
    expect(gt.payments.map((p) => p.paymentId)).toEqual(["pay_1", "pay_2"]);

    const stuck = world();
    const tools = stuck.tools();
    (tools.dodo as { listRefunds: unknown }).listRefunds = async () => ({
      data: { items: [{ refund_id: "same", payment_id: "pay_1", status: "succeeded", created_at: AT, is_partial: false }] },
      status: 200,
      exchangeId: "x",
    });
    const gt2 = await collectGroundTruth(tools, manifest);
    expect(gt2.complete).toBe(false);
    expect(gt2.problems[0]).toMatch(/refunds for cus_a/);
  });
});

// ---------------------------------------------------------------------------------------------
// runQueue

describe("runQueue", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notary-run-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeFixtures(queue: QueueRequest[], expected: ExpectedEntry[]): string {
    const q = join(dir, "seeded.json");
    writeFileSync(q, JSON.stringify(queue));
    writeFileSync(join(dir, "expected.json"), JSON.stringify(expected));
    return q;
  }

  it("is BLOCKED (exit 3, nothing written) when a key is missing", async () => {
    const q = writeFixtures([req("r1")], [exp("r1")]);
    const res = await runQueue({ queueFile: q, variant: "naive", mode: "live", env: { NOTARY_MODE: "test" }, runsDir: dir, webBundlesDir: null });
    expect(res).toMatchObject({ exitCode: 3, status: "blocked", lines: ["BLOCKED: DODO_PAYMENTS_API_KEY not set"] });
  });

  it("guarded is BLOCKED the same way, before opening any store; --resume with nothing to resume exits 1", async () => {
    const q = writeFixtures([req("r1")], [exp("r1")]);
    const dbPath = join(dir, "never.sqlite");
    const res = await runQueue({ queueFile: q, variant: "guarded", mode: "live", env: { NOTARY_MODE: "test" }, dbPath, runsDir: dir, webBundlesDir: null });
    expect(res).toMatchObject({ exitCode: 3, status: "blocked", lines: ["BLOCKED: DODO_PAYMENTS_API_KEY not set"] });
    expect(existsSync(dbPath)).toBe(false);
    const db = new NotaryDb(":memory:");
    const resumed = await runQueue({ variant: "guarded", mode: "live", resume: true, db });
    expect(resumed.exitCode).toBe(1);
    expect(resumed.lines[0]).toMatch(/No interrupted run to resume/);
    db.close();
  });

  it("writes a schema-valid, graded run bundle (test double tools, temp dir)", async () => {
    const w = world();
    const q = writeFixtures(
      [req("r1"), req("r2", { customerId: "cus_b", companyDomain: "b.example", paymentId: "pay_2" })],
      [exp("r1", { expectedAmount: 2900 }), exp("r2", { expectedTier: "enterprise", expectedAmount: 9900 })],
    );
    const res = await runQueue({
      queueFile: q,
      variant: "naive",
      mode: "live",
      manifest,
      tools: { ...w.tools(), ledger: new CreditLedger({ budget: 10 }) },
      policy: testPolicy,
      runsDir: dir,
      webBundlesDir: null,
      now: () => new Date("2026-10-10T12:00:00.000Z"),
    });
    expect(res.exitCode).toBe(0);
    const bundle = verifyBundle(JSON.parse(readFileSync(res.bundlePath!, "utf8")));
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;
    expect(bundle.bundle).toMatchObject({ kind: "run", variant: "naive", mode: "live", sample: false, status: "completed" });
    expect(bundle.bundle.disclosure[0]).toMatch(/^Seeded queue: .*seeded\.json \(SEEDED FIXTURE\)$/);
    expect(bundle.bundle.decisions.every((d) => d.grade !== undefined)).toBe(true);
    expect(bundle.bundle.metrics).toMatchObject({ items_total: 2, decision_accuracy: 1, unsafe_actions_total: 0, executed: 2 });
  });
});
