/**
 * Guard compiler, registry and guarded() tests. TEST DOUBLES ONLY (test/fakes.ts): no network, and
 * the beliefs/probes below are fixtures, not results.
 */
import { describe, expect, it } from "vitest";
import { BeliefStore, beliefIdFor } from "../src/beliefs/store.js";
import { claimById } from "../src/contracts/index.js";
import {
  GuardBlockedError,
  GuardRegistry,
  UnknownWriteOutcomeError,
  compileGuards,
  guarded,
  parseScope,
  isReadBackResult,
  wireRetirement,
  withGuardContext,
} from "../src/guards/index.js";
import type { GuardRunContext } from "../src/guards/index.js";
import type { Belief, DefectClass, Effect, Guard, Probe } from "../src/schema/index.js";
import { NotaryDb } from "../src/store/db.js";
import { listAll } from "../src/guards/readback.js";
import { collectGroundTruth } from "../src/queue/grader.js";
import { FakeDodo, T0, fakeProbe, fakeWorld, notarize, testManifest, unlearn } from "./fakes.js";

const now = () => new Date(T0);

function belief(claimId: string, over: Partial<Belief> = {}): Belief {
  return {
    id: beliefIdFor(claimId),
    claimId,
    tool: claimById(claimId)!.tool,
    class: "silent_truncation",
    statement: "fixture",
    alpha: 1,
    beta: 4,
    confidence: 0.0625,
    status: "notarized",
    evidence: [],
    updatedAt: T0,
    ...over,
  };
}

function compile(beliefs: Belief[], probes: Probe[] = []): Guard[] {
  return compileGuards({ beliefs, claimFor: claimById, probes, now });
}

function unitProbe(id: string, ratio: number, outcome = ratio === 100 ? "x100" : "div100"): Probe {
  return fakeProbe(id, "dodo.refund.amount-minor-units", {
    template: "unit_roundtrip",
    observed: { outcome, treatment: { sent: 100, echoed: 100 * ratio, ratio } },
  });
}

describe("guard compiler", () => {
  it("unit_mismatch -> transform scaled by 1/observed ratio from the cited unit_roundtrip probes", () => {
    const probes = [unitProbe("u1", 100), unitProbe("u2", 100)];
    const b = belief("dodo.refund.amount-minor-units", {
      class: "unit_mismatch",
      evidence: probes.map((p) => ({ probeId: p.id, traceId: p.traceId })),
    });
    const [g, ...rest] = compile([b], probes);
    expect(rest).toEqual([]);
    expect(g).toMatchObject({
      beliefId: b.id,
      operation: "dodo.createRefund",
      kind: "transform",
      class: "unit_mismatch",
      active: true,
      compiledAt: T0,
      rule: { param: "items[].amount", scale: 0.01, observedRatio: 100, probeIds: ["u1", "u2"], requireInteger: true },
    });
    expect(g!.id).toMatch(/^grd-[0-9a-f]{12}$/);
  });

  it("unit_mismatch with no recorded ratio, or disagreeing ratios, compiles to block", () => {
    const none = compile([belief("dodo.refund.amount-minor-units", { class: "unit_mismatch" })]);
    expect(none).toMatchObject([{ kind: "block", operation: "dodo.createRefund" }]);
    expect(none[0]!.reason).toMatch(/no safe transform/);
    const probes = [unitProbe("u1", 100), unitProbe("u2", 0.01)];
    const mixed = compile(
      [belief("dodo.refund.amount-minor-units", { class: "unit_mismatch", evidence: probes.map((p) => ({ probeId: p.id, traceId: p.traceId })) })],
      probes,
    );
    expect(mixed).toMatchObject([{ kind: "block" }]);
    expect(mixed[0]!.reason).toMatch(/inconsistent/);
  });

  it("idempotency_hazard -> retry_policy (+ precheck where one can refuse the write)", () => {
    const refund = compile([belief("dodo.refund.full-retry-no-duplicate", { class: "idempotency_hazard" })]);
    expect(refund.map((g) => [g.operation, g.kind]).sort()).toEqual([
      ["dodo.createRefund", "precheck"],
      ["dodo.createRefund", "retry_policy"],
    ]);
    expect(refund.find((g) => g.kind === "retry_policy")!.rule).toMatchObject({ blindRetries: 0, onUnknownOutcome: "read_back" });
    expect(refund.find((g) => g.kind === "precheck")!.rule).toMatchObject({ check: "existing_refund", source: "listRefunds_full" });

    const plan = compile([belief("dodo.subscription.change-plan-pending-409", { class: "idempotency_hazard" })]);
    expect(plan.map((g) => g.kind).sort()).toEqual(["precheck", "retry_policy"]);
    expect(plan.find((g) => g.kind === "precheck")!.rule).toMatchObject({ check: "pending_plan_change" });

    const wallet = compile([belief("dodo.wallet.idempotency-key-no-duplicate", { class: "idempotency_hazard" })]);
    expect(wallet.map((g) => [g.operation, g.kind])).toEqual([["dodo.createWalletLedgerEntry", "retry_policy"]]);
  });

  it("silent_truncation -> paginate_fully on list ops, block elsewhere", () => {
    expect(compile([belief("dodo.refunds.page-size-max-100")])).toMatchObject([
      { operation: "dodo.listRefunds", kind: "paginate_fully", rule: { pageSize: 100, stopOn: "empty_page" } },
    ]);
    expect(compile([belief("crustdata.identify.max-25-identifiers")])).toMatchObject([{ operation: "crustdata.identifyCompany", kind: "block" }]);
  });

  it("refund-existence claims -> existing-refund precheck on createRefund; undocumented_flag -> require_param", () => {
    expect(compile([belief("dodo.payment.refunds-lists-issued-refund", { class: "eventual_consistency" })])).toMatchObject([
      { operation: "dodo.createRefund", kind: "precheck", rule: { check: "existing_refund" } },
    ]);
    expect(compile([belief("crustdata.enrich.default-fields-basic-info", { class: "undocumented_flag" })])).toMatchObject([
      { operation: "crustdata.enrichCompany", kind: "require_param", rule: { param: "fields", default: ["basic_info", "headcount", "funding"] } },
    ]);
    expect(compile([belief("dodo.refunds.page-size-max-100", { class: "undocumented_flag" })])).toMatchObject([
      { operation: "dodo.listRefunds", kind: "require_param", rule: { param: "page_size" } },
    ]);
  });

  it("classes without a safe transform compile to block with the reason", () => {
    for (const cls of ["silent_coercion", "mislabelled_semantics", "rate_limit"] as DefectClass[]) {
      const [g] = compile([belief("crustdata.enrich.headcount-total-integer", { class: cls })]);
      expect(g).toMatchObject({ kind: "block", operation: "crustdata.enrichCompany", class: cls });
      expect(g!.reason).toContain(cls);
    }
  });

  it("an adversary-narrowed scope compiles into rule.scope; an unparseable scope compiles to block", () => {
    const probes = [unitProbe("u1", 100)];
    const narrowed = (scope: string | undefined, reason = "evidence covers USD payments only") =>
      belief("dodo.refund.amount-minor-units", {
        class: "unit_mismatch",
        evidence: [{ probeId: "u1", traceId: "t" }],
        adversary: { verdict: "narrow", reason, model: "test-model", ...(scope === undefined ? {} : { scope }) },
      });
    const [g, ...rest] = compile([narrowed("USD only")], probes);
    expect(rest).toEqual([]);
    expect(g).toMatchObject({ kind: "transform", rule: { scale: 0.01, scope: { currency: ["USD"] } } });
    expect(g!.reason).toMatch(/narrowed scope: currency USD/);
    expect(compile([narrowed("only EUR and GBP refunds")], probes)[0]!.rule.scope).toEqual({ currency: ["EUR", "GBP"] });
    // Unscoped and scoped compile to different guard ids.
    expect(compile([narrowed("USD only")], probes)[0]!.id).not.toBe(compile([narrowed("EUR only")], probes)[0]!.id);

    // Not machine-checkable -> block, with the scope in the reason (the store's fallback: no scope, use the reason).
    for (const b of [narrowed("customers created before 2024"), narrowed(undefined, "only observed on one API key")]) {
      const gs = compile([b], probes);
      expect(gs).toHaveLength(1);
      expect(gs[0]).toMatchObject({ kind: "block", operation: "dodo.createRefund" });
      expect(gs[0]!.reason).toMatch(/not a machine-checkable scope/);
    }
    // "<condition>: <rationale>" parses only when the rationale can't narrow further.
    expect(parseScope("USD only: dodo.createWalletLedgerEntry was probed with USD amounts; other currencies are untested")).toEqual({ currency: ["USD"] });
    for (const s of ["USD only: for card payments", "USD only: amounts under 1000", "USD only: EUR was never probed", "usd only", "all currencies"]) {
      expect(parseScope(s), s).toBeNull();
    }
    // An upheld belief is unscoped, as before.
    expect(compile([belief("dodo.refund.amount-minor-units", { class: "unit_mismatch", evidence: [{ probeId: "u1", traceId: "t" }] })], probes)[0]!.rule.scope).toBeUndefined();
  });

  it("honored beliefs and non-notarized beliefs compile no guard", () => {
    expect(compile([belief("dodo.refunds.page-size-max-100", { class: "honored", alpha: 4, beta: 1, confidence: 0.94 })])).toEqual([]);
    for (const status of ["hypothesis", "candidate", "refuted", "abstained", "unlearned"] as const) {
      expect(compile([belief("dodo.refunds.page-size-max-100", { status })])).toEqual([]);
    }
  });

  it("is deterministic: same beliefs and probes give the same guard ids", () => {
    const bs = [belief("dodo.refunds.page-size-max-100"), belief("dodo.refund.full-retry-no-duplicate", { class: "idempotency_hazard" })];
    const a = compile(bs).map((g) => g.id);
    const b = compileGuards({ beliefs: [...bs].reverse(), claimFor: claimById, probes: [], now: () => new Date("2027-01-01T00:00:00.000Z") }).map((g) => g.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe("guard registry", () => {
  it("persists to SQLite, lists active guards per op in kind order, and syncs (retiring guards no longer compiled)", () => {
    const db = new NotaryDb(":memory:");
    const reg = new GuardRegistry(db, { now });
    const guards = compile([belief("dodo.refund.full-retry-no-duplicate", { class: "idempotency_hazard" }), belief("dodo.refunds.page-size-max-100")]);
    reg.sync(guards);
    expect(reg.active("dodo.createRefund").map((g) => g.kind)).toEqual(["precheck", "retry_policy"]);
    const reloaded = new GuardRegistry(db, { now });
    expect(reloaded.all()).toEqual(reg.all());
    const { retired } = reloaded.sync(guards.filter((g) => g.operation === "dodo.listRefunds"));
    expect(retired.map((g) => g.kind).sort()).toEqual(["precheck", "retry_policy"]);
    expect(reloaded.active("dodo.createRefund")).toEqual([]);
    expect(reloaded.get(retired[0]!.id)).toMatchObject({ active: false, retiredAt: T0 });
    db.close();
  });

  it("retires a belief's guards when the REAL BeliefStore un-learns it (onUnlearn wired)", () => {
    const db = new NotaryDb(":memory:");
    const store = new BeliefStore(db, { now });
    const reg = new GuardRegistry(db, { now });
    const retired: Guard[] = [];
    wireRetirement(store, reg, (g) => retired.push(...g));
    const b = notarize(store, "dodo.refund.full-retry-no-duplicate", "idempotency_hazard");
    expect(b).toMatchObject({ status: "notarized", class: "idempotency_hazard" });
    reg.sync(compileGuards({ beliefs: store.list(), claimFor: claimById, probes: [], now }));
    expect(reg.active("dodo.createRefund")).toHaveLength(2);

    expect(unlearn(store, "dodo.refund.full-retry-no-duplicate").status).toBe("unlearned");
    expect(reg.active("dodo.createRefund")).toEqual([]);
    expect(retired).toHaveLength(2);
    expect(reg.all().every((g) => !g.active && g.retiredAt === T0)).toBe(true);
    // An unlearned belief compiles nothing, so a later sync keeps them retired.
    reg.sync(compileGuards({ beliefs: store.list(), claimFor: claimById, probes: [], now }));
    expect(reg.all().every((g) => !g.active)).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------------------------

function ctx(): GuardRunContext {
  return { guardsApplied: [], effects: [] as Effect[], now };
}

function setup(beliefs: Belief[], probes: Probe[] = [], w: FakeDodo = fakeWorld()) {
  const reg = GuardRegistry.fromGuards(compile(beliefs, probes));
  const tools = w.tools(guarded(reg));
  return { reg, tools, w };
}

describe("guarded()", () => {
  it("passes calls straight through when no guard is active for the op", async () => {
    const { tools, w } = setup([]);
    const c = ctx();
    await withGuardContext(c, () => tools.dodo.createRefund({ payment_id: "pay_1" }));
    expect(w.refunds).toHaveLength(1);
    expect(c.guardsApplied).toEqual([]);
  });

  it("block refuses before the raw method is called and records the firing", async () => {
    const { tools, w, reg } = setup([belief("dodo.refund.amount-minor-units", { class: "unit_mismatch" })]);
    const c = ctx();
    await expect(withGuardContext(c, () => tools.dodo.createRefund({ payment_id: "pay_1" }))).rejects.toBeInstanceOf(GuardBlockedError);
    expect(w.count("createRefund")).toBe(0);
    expect(c.guardsApplied).toEqual([reg.active("dodo.createRefund")[0]!.id]);
  });

  it("transform scales the amount; a non-integer result is refused; a full refund (no amount) is untouched", async () => {
    const probes = [unitProbe("u1", 100)];
    const b = belief("dodo.refund.amount-minor-units", { class: "unit_mismatch", evidence: [{ probeId: "u1", traceId: "t" }] });
    const { tools, w, reg } = setup([b], probes);
    const c = ctx();
    await withGuardContext(c, () => tools.dodo.createRefund({ payment_id: "pay_1", items: [{ item_id: "prod_starter", amount: 1200 }] }));
    expect((w.calls.find((x) => x.op === "createRefund")!.args[0] as { items: Array<{ amount: number }> }).items[0]!.amount).toBe(12);
    expect(c.guardsApplied).toEqual([reg.all()[0]!.id]);

    await expect(tools.dodo.createRefund({ payment_id: "pay_3", items: [{ item_id: "prod_starter", amount: 1250 }] })).rejects.toThrow(/not an integer/);
    const c2 = ctx();
    await withGuardContext(c2, () => tools.dodo.createRefund({ payment_id: "pay_3" }));
    expect(c2.guardsApplied).toEqual([]);
  });

  it("require_param adds a known default and refuses when there is none", async () => {
    const { tools, w } = setup([belief("crustdata.enrich.default-fields-basic-info", { class: "undocumented_flag" })]);
    const c = ctx();
    await withGuardContext(c, () => tools.crustdata.enrichCompany({ domains: ["a.example"] } as never));
    expect(w.calls.find((x) => x.op === "enrichCompany")!.args[0]).toEqual({ domains: ["a.example"], fields: ["basic_info", "headcount", "funding"] });
    expect(c.guardsApplied).toHaveLength(1);

    const reg = GuardRegistry.fromGuards(compile([belief("dodo.refunds.page-size-max-100", { class: "undocumented_flag" })]));
    const t2 = fakeWorld().tools(guarded(reg));
    await expect(t2.dodo.listRefunds({ customer_id: "cus_a" })).rejects.toThrow(/required param page_size is missing/);
  });

  it("precheck lists refunds completely (an existing refund on page 2 refuses) and records its reads", async () => {
    const w = fakeWorld();
    w.pageCap = 100;
    w.addRefund("pay_1"); // oldest: lands on the LAST page of the newest-first listing
    for (let i = 0; i < 150; i++) {
      w.payments.push({ payment_id: `pay_x${i}`, customer_id: "cus_a", total_amount: 100, product_id: "p" });
      w.addRefund(`pay_x${i}`);
    }
    w.refunds.find((r) => r.payment_id === "pay_1")!.status = "succeeded";
    // Hide it from the payment's own refunds[] (the eventual-consistency case the precheck exists for).
    const methods = w.methods();
    const getPayment = methods["dodo.getPayment"]!;
    methods["dodo.getPayment"] = async (id: string) => {
      const r = (await getPayment(id)) as { data: { refunds: unknown[] } };
      return { ...r, data: { ...r.data, refunds: [] } };
    };
    const reg = GuardRegistry.fromGuards(compile([belief("dodo.payment.refunds-lists-issued-refund", { class: "eventual_consistency" })]));
    const wrap = guarded(reg);
    wrap("dodo.getPayment", methods["dodo.getPayment"]!);
    wrap("dodo.listRefunds", methods["dodo.listRefunds"]!);
    const create = wrap("dodo.createRefund", methods["dodo.createRefund"]!);
    const c = ctx();
    await expect(withGuardContext(c, () => create({ payment_id: "pay_1" }))).rejects.toThrow(/existing refund ref_1/);
    expect(w.count("createRefund")).toBe(0);
    const pages = c.effects.filter((e) => e.op === "dodo.listRefunds").map((e) => e.params.page_number);
    expect(pages).toEqual([0, 1, 2]); // to an EMPTY page, not the first short one
    expect(c.guardsApplied).toHaveLength(1);

    // No refund on pay_3 -> the write goes through.
    await withGuardContext(ctx(), () => create({ payment_id: "pay_3" }));
    expect(w.count("createRefund")).toBe(1);
  });

  it("precheck refuses a plan change when one is already scheduled", async () => {
    const w = fakeWorld();
    w.subs.get("sub_1")!.scheduled_change = { product_id: "prod_growth", effective_at: "next" };
    const { tools } = setup([belief("dodo.subscription.change-plan-pending-409", { class: "idempotency_hazard" })], [], w);
    await expect(tools.dodo.changeSubscriptionPlan("sub_1", { product_id: "prod_growth", quantity: 1, proration_billing_mode: "prorated_immediately" })).rejects.toThrow(
      /already has a scheduled change/,
    );
    expect(w.count("changeSubscriptionPlan")).toBe(0);
  });

  it("paginate_fully returns every item and refuses when page_number stops advancing", async () => {
    const w = fakeWorld();
    w.pageCap = 100;
    for (let i = 0; i < 250; i++) {
      w.payments.push({ payment_id: `pay_y${i}`, customer_id: "cus_b", total_amount: 100, product_id: "p" });
      w.addRefund(`pay_y${i}`);
    }
    const { tools } = setup([belief("dodo.refunds.page-size-max-100")], [], w);
    const c = ctx();
    const res = await withGuardContext(c, () => tools.dodo.listRefunds({ customer_id: "cus_b", page_size: 10 }));
    expect(res.data.items).toHaveLength(250);
    expect(c.guardsApplied).toHaveLength(1);
    w.stuckPages = true;
    await expect(tools.dodo.listRefunds({ customer_id: "cus_b" })).rejects.toThrow(/page_number not advancing/);
  });

  it("paginate_fully serves both caller styles over >100 items behind a silent page cap", async () => {
    const w = fakeWorld();
    w.pageCap = 40; // asked for 100, silently given 40
    for (let i = 0; i < 230; i++) {
      w.payments.push({ payment_id: `pay_z${i}`, customer_id: "cus_b", total_amount: 100, product_id: "p" });
      w.addRefund(`pay_z${i}`);
    }
    const { tools } = setup([belief("dodo.refunds.page-size-max-100")], [], w);

    // "Read one page" caller: page 0 (or no page_number) is the whole, proven-complete list.
    const one = await tools.dodo.listRefunds({ customer_id: "cus_b", page_size: 100 });
    expect(one.data.items).toHaveLength(230);
    const zero = await tools.dodo.listRefunds({ customer_id: "cus_b", page_size: 100, page_number: 0 });
    expect(zero.data.items).toHaveLength(230);

    // "Page until empty" caller (the executor's and read-back's listAll): page 1 is empty, so it
    // stops complete instead of seeing page 0's items again and reporting pagination stuck.
    const later = await tools.dodo.listRefunds({ customer_id: "cus_b", page_size: 100, page_number: 1 });
    expect(later.data.items).toEqual([]);
    const all = await listAll(
      async (page_number, page_size) => (await tools.dodo.listRefunds({ customer_id: "cus_b", page_size, page_number })).data,
      (r) => r.refund_id,
    );
    expect(all).toMatchObject({ complete: true });
    expect(all.items).toHaveLength(230);
    expect(new Set(all.items.map((r) => r.refund_id)).size).toBe(230);

    // The grader reading ground truth through the same guarded tools.
    const gt = await collectGroundTruth(tools, { ...testManifest, customers: { b: testManifest.customers.b! } });
    expect(gt.complete).toBe(true);
    expect(gt.problems).toEqual([]);
    expect(gt.refunds).toHaveLength(230);
  });

  it("retry_policy: a 5xx whose write landed is read back, not retried", async () => {
    const w = fakeWorld().fault("dodo.createRefund", { http: 502, after: true });
    const { tools } = setup([belief("dodo.refund.full-retry-no-duplicate", { class: "idempotency_hazard" })], [], w);
    const c = ctx();
    const res = await withGuardContext(c, () => tools.dodo.createRefund({ payment_id: "pay_1" }));
    expect(isReadBackResult(res)).toBe(true);
    expect(w.count("createRefund")).toBe(1);
    expect(w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(1);
    expect(c.guardsApplied).toHaveLength(2); // precheck + retry_policy
  });

  it("retry_policy: a timeout that provably did not land is retried once", async () => {
    const w = fakeWorld().fault("dodo.createRefund", { network: true, after: false });
    const { tools } = setup([belief("dodo.refund.full-retry-no-duplicate", { class: "idempotency_hazard" })], [], w);
    const c = ctx();
    const res = await withGuardContext(c, () => tools.dodo.createRefund({ payment_id: "pay_1" }));
    expect(isReadBackResult(res)).toBe(false);
    expect(w.count("createRefund")).toBe(2);
    expect(w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(1);
    expect(c.effects.some((e) => e.op === "dodo.createRefund" && e.status === null)).toBe(true); // the failed attempt is visible
  });

  it("retry_policy: an unprovable outcome is never retried", async () => {
    const w = fakeWorld().fault("dodo.createRefund", { http: 503, after: false });
    w.addRefund("pay_3"); // something on page 0, so a stuck page "adds nothing new"
    const reg = GuardRegistry.fromGuards(compile([belief("dodo.refund.full-retry-no-duplicate", { class: "idempotency_hazard" })]));
    const wrap = guarded(reg);
    const m = w.methods();
    wrap("dodo.getPayment", m["dodo.getPayment"]!);
    wrap("dodo.listRefunds", m["dodo.listRefunds"]!);
    // The listing breaks while the write is out: the read-back cannot prove anything.
    const create = wrap("dodo.createRefund", async (p: unknown) => {
      w.stuckPages = true;
      return m["dodo.createRefund"]!(p);
    });
    await expect(create({ payment_id: "pay_1" })).rejects.toBeInstanceOf(UnknownWriteOutcomeError);
    expect(w.count("createRefund")).toBe(1);
    expect(w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(0);
  });

  it("a narrowed guard applies inside its scope and blocks outside it (behavior unverified there)", async () => {
    const probes = [unitProbe("u1", 100)];
    const adversary = { verdict: "narrow" as const, reason: "USD evidence only", scope: "USD only", model: "test-model" };
    const refundBelief = belief("dodo.refund.amount-minor-units", { class: "unit_mismatch", evidence: [{ probeId: "u1", traceId: "t" }], adversary });
    const w = fakeWorld();
    w.payments.push({ payment_id: "pay_eur", customer_id: "cus_a", total_amount: 5000, product_id: "prod_starter" });
    const methods = w.methods();
    const getPayment = methods["dodo.getPayment"]!;
    methods["dodo.getPayment"] = async (id: string) => {
      const r = (await getPayment(id)) as { data: Record<string, unknown> };
      return id === "pay_eur" ? { ...r, data: { ...r.data, currency: "EUR" } } : r;
    };
    const reg = GuardRegistry.fromGuards(compile([refundBelief], probes));
    const wrap = guarded(reg);
    wrap("dodo.getPayment", methods["dodo.getPayment"]!);
    const create = wrap("dodo.createRefund", methods["dodo.createRefund"]!);

    // In scope (USD payment): the transform applies, and the currency read is on the decision.
    const c = ctx();
    await withGuardContext(c, () => create({ payment_id: "pay_1", items: [{ item_id: "prod_starter", amount: 1200 }] }));
    expect((w.calls.find((x) => x.op === "createRefund")!.args[0] as { items: Array<{ amount: number }> }).items[0]!.amount).toBe(12);
    expect(c.effects.map((e) => e.op)).toEqual(["dodo.getPayment"]);

    // Out of scope (EUR payment): refused before the write, not silently transformed or skipped.
    const c2 = ctx();
    await expect(withGuardContext(c2, () => create({ payment_id: "pay_eur", items: [{ item_id: "prod_starter", amount: 1200 }] }))).rejects.toThrow(
      /outside the narrowed scope \(currency USD\).*EUR.*unverified/,
    );
    expect(w.count("createRefund")).toBe(1);
    expect(c2.guardsApplied).toEqual([reg.all()[0]!.id]);

    // Wallet credit: the currency is on the request itself.
    const creditBelief = belief("dodo.wallet.credit-amount-minor-units", {
      class: "unit_mismatch",
      evidence: [{ probeId: "u2", traceId: "t" }],
      adversary,
    });
    const { tools, w: w2 } = setup([creditBelief], [unitProbe("u2", 100)]);
    await tools.dodo.createWalletLedgerEntry("cus_a", { amount: 5000, currency: "USD", entry_type: "credit" });
    expect(w2.ledger.get("cus_a")![0]!.amount).toBe(50);
    await expect(tools.dodo.createWalletLedgerEntry("cus_a", { amount: 5000, currency: "INR", entry_type: "credit" })).rejects.toThrow(/outside the narrowed scope/);
    expect(w2.ledger.get("cus_a")).toHaveLength(1);
  });

  it("a narrowed guard blocks when the call's currency can't be determined", async () => {
    const adversary = { verdict: "narrow" as const, reason: "USD only", scope: "USD only", model: "test-model" };
    const { tools, w } = setup([belief("dodo.refunds.page-size-max-100", { adversary })]);
    await expect(tools.dodo.listRefunds({ customer_id: "cus_a", page_size: 100 })).rejects.toThrow(/cannot tell whether .* is inside the narrowed scope/);
    expect(w.count("listRefunds")).toBe(0);
  });

  it("an unparseable narrowed scope blocks the op outright", async () => {
    const adversary = { verdict: "narrow" as const, reason: "x", scope: "only on weekdays", model: "test-model" };
    const { tools, w } = setup([belief("dodo.refunds.page-size-max-100", { adversary })]);
    await expect(tools.dodo.listRefunds({ customer_id: "cus_a", page_size: 100 })).rejects.toThrow(/not a machine-checkable scope/);
    expect(w.count("listRefunds")).toBe(0);
  });

  it("a retired guard stops applying at once", async () => {
    const { tools, w, reg } = setup([belief("dodo.refund.amount-minor-units", { class: "unit_mismatch" })]);
    await expect(tools.dodo.createRefund({ payment_id: "pay_1" })).rejects.toBeInstanceOf(GuardBlockedError);
    reg.retireForBelief(beliefIdFor("dodo.refund.amount-minor-units"), T0);
    await tools.dodo.createRefund({ payment_id: "pay_1" });
    expect(w.count("createRefund")).toBe(1);
  });
});
