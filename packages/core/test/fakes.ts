/**
 * TEST DOUBLES ONLY. An in-memory "Dodo" + "Crustdata" for the guard, gate and resume tests, plus
 * helpers that drive the real BeliefStore lifecycle to `notarized`. Nothing here touches the network
 * and nothing here is a run result.
 */
import { BeliefStore, beliefIdFor } from "../src/beliefs/store.js";
import { claimById } from "../src/contracts/index.js";
import type { PolicyFns, QueueTools } from "../src/queue/executor.js";
import type { SeedManifest } from "../src/queue/manifest.js";
import type { Belief, DefectClass, Hypothesis, Probe, QueueRequest } from "../src/schema/index.js";
import { CreditLedger, ToolHttpError, ToolNetworkError } from "../src/tools/index.js";
import type { ToolResult, Tools, Wrap } from "../src/tools/index.js";

export interface FakeRefund {
  refund_id: string;
  payment_id: string;
  customer_id: string;
  status: "succeeded" | "failed" | "pending";
  amount: number;
  is_partial: boolean;
  created_at: string;
}

/** What the next call of an op does instead of (or after) its normal effect. */
export type Fault =
  | { http: number; after: boolean } // answer with this status, before or after doing the work
  | { network: true; after: boolean } // no answer (timeout), before or after doing the work
  | { crash: "before" | "after" }; // the AGENT crashes (a non-tool Error), before or after the work landed

export class SimulatedCrash extends Error {
  constructor(op: string) {
    super(`simulated crash during ${op}`);
    this.name = "SimulatedCrash";
  }
}

export class FakeDodo {
  payments: Array<{ payment_id: string; customer_id: string; total_amount: number; product_id: string }> = [];
  refunds: FakeRefund[] = [];
  ledger = new Map<string, Array<{ id: string; amount: number; is_credit: boolean; event_type: string; before_balance: number; after_balance: number }>>();
  subs = new Map<string, { subscription_id: string; product_id: string; quantity: number; scheduled_change: { product_id: string; effective_at: string } | null }>();
  companies = new Map<string, number>();
  calls: Array<{ op: string; args: unknown[] }> = [];
  faults = new Map<string, Fault[]>();
  /** Max items one list page really returns (a silent cap below the requested page_size). */
  pageCap = Infinity;
  /** page_number is ignored (always page 0): pagination never advances. */
  stuckPages = false;
  private seq = 0;

  fault(op: string, f: Fault): this {
    const q = this.faults.get(op) ?? [];
    q.push(f);
    this.faults.set(op, q);
    return this;
  }

  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  private ok<T>(data: T): ToolResult<T> {
    return { data, status: 200, exchangeId: `ex-${++this.seq}` };
  }

  private page<T>(items: T[], p: { page_size?: number; page_number?: number } = {}): T[] {
    const size = Math.min(p.page_size ?? 10, this.pageCap);
    const n = this.stuckPages ? 0 : (p.page_number ?? 0);
    return items.slice(n * size, n * size + size);
  }

  /** Run `work` honoring the next queued fault for `op`. */
  private async faulty<T>(op: string, work: () => T): Promise<ToolResult<T>> {
    const f = this.faults.get(op)?.shift();
    if (!f) return this.ok(work());
    if ("crash" in f) {
      if (f.crash === "after") work();
      throw new SimulatedCrash(op);
    }
    if (f.after) work();
    if ("network" in f) throw new ToolNetworkError(op, `ex-${++this.seq}`, "timeout");
    throw new ToolHttpError(op, f.http, { error: "fake" }, `ex-${++this.seq}`);
  }

  addRefund(paymentId: string, amount?: number, status: FakeRefund["status"] = "succeeded"): FakeRefund {
    const pay = this.payments.find((x) => x.payment_id === paymentId)!;
    const r: FakeRefund = {
      refund_id: `ref_${this.refunds.length + 1}`,
      payment_id: paymentId,
      customer_id: pay.customer_id,
      status,
      amount: amount ?? pay.total_amount,
      is_partial: amount !== undefined && amount < pay.total_amount,
      created_at: new Date(Date.UTC(2026, 9, 10, 12, this.refunds.length)).toISOString(),
    };
    this.refunds.push(r);
    return r;
  }

  /** The tool methods, by op name (`dodo.<method>`, `crustdata.<method>`). */
  methods(): Record<string, (...args: any[]) => Promise<unknown>> {
    const w = this;
    const log = (op: string, args: unknown[]) => w.calls.push({ op, args });
    return {
      "dodo.listRefunds": async (p: { customer_id?: string; page_size?: number; page_number?: number }) => {
        log("listRefunds", [p]);
        const mine = w.refunds.filter((r) => r.customer_id === p.customer_id).reverse();
        return w.ok({ items: w.page(mine, p) });
      },
      "dodo.listPayments": async (p: { customer_id?: string; page_size?: number; page_number?: number }) => {
        log("listPayments", [p]);
        const mine = w.payments
          .filter((x) => x.customer_id === p.customer_id)
          .reverse()
          .map((x) => ({ ...x, currency: "USD", refund_status: null, customer: { customer_id: x.customer_id } }));
        return w.ok({ items: w.page(mine, p) });
      },
      "dodo.getPayment": async (id: string) => {
        log("getPayment", [id]);
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
      "dodo.getRefund": async (id: string) => {
        log("getRefund", [id]);
        const r = w.refunds.find((x) => x.refund_id === id);
        if (!r) throw new ToolHttpError("dodo.getRefund", 404, {}, "ex-404");
        return w.ok({ ...r, currency: "USD", business_id: "biz", customer: { customer_id: r.customer_id } });
      },
      "dodo.createRefund": async (p: { payment_id: string; items?: Array<{ item_id: string; amount?: number | null }> | null }) => {
        log("createRefund", [p]);
        const res = await w.faulty("dodo.createRefund", () => {
          const partial = p.items?.[0]?.amount ?? undefined;
          return w.addRefund(p.payment_id, partial ?? undefined);
        });
        const r = res.data;
        return { ...res, data: { ...r, currency: "USD", business_id: "biz", customer: { customer_id: r.customer_id } } };
      },
      "dodo.getSubscription": async (id: string) => {
        log("getSubscription", [id]);
        const s = w.subs.get(id);
        if (!s) throw new ToolHttpError("dodo.getSubscription", 404, {}, "ex-404");
        return w.ok({ ...s, status: "active", currency: "USD", recurring_pre_tax_amount: 2900, next_billing_date: "", previous_billing_date: "" });
      },
      "dodo.changeSubscriptionPlan": async (id: string, p: { product_id: string; effective_at?: string }) => {
        log("changeSubscriptionPlan", [id, p]);
        return w.faulty("dodo.changeSubscriptionPlan", () => {
          const s = w.subs.get(id)!;
          if (p.effective_at === "next_billing_date") s.scheduled_change = { product_id: p.product_id, effective_at: "next" };
          else s.product_id = p.product_id;
          return { payment_id: null };
        });
      },
      "dodo.createWalletLedgerEntry": async (customerId: string, p: { amount: number; currency: string }) => {
        log("createWalletLedgerEntry", [customerId, p]);
        return w.faulty("dodo.createWalletLedgerEntry", () => {
          const list = w.ledger.get(customerId) ?? [];
          const before = list.reduce((a, e) => a + (e.is_credit ? e.amount : -e.amount), 0);
          list.push({ id: `led_${customerId}_${list.length + 1}`, amount: p.amount, is_credit: true, event_type: "credit", before_balance: before, after_balance: before + p.amount });
          w.ledger.set(customerId, list);
          return { customer_id: customerId, currency: p.currency, balance: before + p.amount };
        });
      },
      "dodo.listWalletLedgerEntries": async (customerId: string, p: { page_size?: number; page_number?: number } = {}) => {
        log("listWalletLedgerEntries", [customerId, p]);
        return w.ok({ items: w.page([...(w.ledger.get(customerId) ?? [])].reverse(), p) });
      },
      "crustdata.enrichCompany": async (p: { domains?: string[] }) => {
        log("enrichCompany", [p]);
        const d = p.domains![0]!;
        const h = w.companies.get(d);
        return w.ok([
          { matched_on: d, match_type: "domain", matches: h === undefined ? [] : [{ confidence_score: 1, company_data: { headcount: { total: h } } }] },
        ]);
      },
    };
  }

  /** Tools shaped like createTools() output, every method passed through `wrap(op, fn)`. */
  tools(wrap: Wrap = (_op, fn) => fn): QueueTools & Pick<Tools, "ledger"> {
    const m = this.methods();
    const dodo: Record<string, unknown> = {};
    const crustdata: Record<string, unknown> = {};
    for (const [op, fn] of Object.entries(m)) {
      const [tool, method] = op.split(".") as [string, string];
      (tool === "dodo" ? dodo : crustdata)[method] = wrap(op, fn);
    }
    return { dodo, crustdata, ledger: new CreditLedger({ budget: 100 }) } as unknown as QueueTools & Pick<Tools, "ledger">;
  }
}

/** A world with two customers, one payment each, one subscription. */
export function fakeWorld(): FakeDodo {
  const w = new FakeDodo();
  w.companies.set("a.example", 10);
  w.companies.set("b.example", 5000);
  w.payments.push({ payment_id: "pay_1", customer_id: "cus_a", total_amount: 2900, product_id: "prod_starter" });
  w.payments.push({ payment_id: "pay_2", customer_id: "cus_b", total_amount: 9900, product_id: "prod_growth" });
  w.payments.push({ payment_id: "pay_3", customer_id: "cus_a", total_amount: 4900, product_id: "prod_starter" });
  w.subs.set("sub_1", { subscription_id: "sub_1", product_id: "prod_starter", quantity: 1, scheduled_change: null });
  return w;
}

export const testManifest: SeedManifest = {
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

/** A pinned policy so these tests don't depend on the real policy table. */
export const testPolicy: PolicyFns = {
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

export function req(id: string, over: Partial<QueueRequest> = {}): QueueRequest {
  return { id, customerId: "cus_a", companyDomain: "a.example", type: "refund", plan: "starter", paymentId: "pay_1", reason: "test request", ...over };
}

export const T0 = "2026-10-10T12:00:00.000Z";

export function fakeProbe(id: string, claimId: string, over: Partial<Probe> = {}): Probe {
  return {
    id,
    tool: claimById(claimId)?.tool ?? "dodo",
    claimId,
    hypothesisIds: ["h-v", "h-ok"],
    template: "boundary_sweep",
    params: {},
    prediction: { "h-v": "x", "h-ok": "y" },
    predictionHash: "a".repeat(64),
    committedAt: T0,
    costCredits: 0,
    calls: 1,
    traceId: `trace-${id}`,
    spanId: `span-${id}`,
    ...over,
  };
}

const hyp = (id: string, cls: DefectClass): Hypothesis => ({ id, anomalyId: "an-1", class: cls, statement: "test hypothesis", distinguishingTest: "boundary_sweep" });

/** Mark every cited piece of a belief's evidence as having passed the FR-10 check (tests only). */
export function passEvidence(store: BeliefStore, beliefId: string): void {
  store.applyEvidenceCheck(beliefId, store.get(beliefId)!.evidence.map((e) => ({ probeId: e.probeId, valid: true, reason: "test: evidence check passed" })));
}

/**
 * Drive the REAL BeliefStore to `notarized` for a claim: three confirmed probes with distinct design
 * fingerprints (variant 0/1/2) on one side, then an adversary uphold.
 */
export function notarize(store: BeliefStore, claimId: string, cls: DefectClass, probes?: Probe[]): Belief {
  const claim = claimById(claimId);
  if (!claim) throw new Error(`no claim ${claimId}`);
  const id = beliefIdFor(claimId);
  store.ensure(claim);
  const winner = cls === "honored" ? hyp("h-ok", "honored") : hyp("h-v", cls);
  const hyps = new Map([[winner.id, winner]]);
  const ps = probes ?? [0, 1, 2].map((k) => fakeProbe(`p-${claimId}-${k}`, claimId, { params: { variant: k } }));
  for (const p of ps) store.applyProbe(id, p, { verdict: "confirmed", winningHypothesisId: winner.id, reason: "test" }, hyps);
  const b = store.get(id)!;
  if (b.status !== "candidate") throw new Error(`expected candidate, got ${b.status}`);
  passEvidence(store, id);
  return store.applyAdversary(id, { verdict: "uphold", reason: "test uphold", model: "test-model" });
}

/** Push a notarized belief back over 0.5 against its side (honored confirmations on a violated belief). */
export function unlearn(store: BeliefStore, claimId: string): Belief {
  const id = beliefIdFor(claimId);
  const ok = new Map([["h-ok", hyp("h-ok", "honored")]]);
  for (let k = 0; k < 6 && store.get(id)!.status === "notarized"; k++) {
    store.applyProbe(id, fakeProbe(`p-${claimId}-back-${k}`, claimId, { params: { variant: 10 + k } }), { verdict: "confirmed", winningHypothesisId: "h-ok", reason: "drift" }, ok);
  }
  return store.get(id)!;
}
