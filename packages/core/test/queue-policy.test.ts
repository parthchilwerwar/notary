/**
 * Policy, seed plan, manifest refs and the seeded queue fixtures. Pure: no network, no keys.
 * The manifest used here is built in memory from TEST DATA and never written to fixtures/.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { QueueRequestSchema, TierSchema } from "../src/schema/index.js";
import {
  CREDIT_CAP_MINOR,
  ENTERPRISE_MIN_EMPLOYEES,
  PLANS,
  POLICY_TABLE,
  REQUEST_TYPES,
  SMB_MAX_EMPLOYEES_EXCLUSIVE,
  TIERS,
  decidePolicy,
  parseEmployeeRange,
  partialShare,
  tierFromCompany,
} from "../src/queue/policy.js";
import { MANIFEST_MISSING_MESSAGE, loadManifest, parseRef, resolveEntry, resolveRef } from "../src/queue/manifest.js";
import type { SeedManifest } from "../src/queue/manifest.js";
import {
  DODO_MAX_PAGE_SIZE,
  SEED_PLAN,
  plannedHandles,
  plannedPaymentAmount,
  plannedPayments,
  seedSteps,
} from "../src/queue/seed-plan.js";

const fixture = (rel: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/queue/${rel}`, import.meta.url)), "utf8"));

const queue = z.array(QueueRequestSchema).parse(fixture("seeded.json"));
const ExpectedSchema = z.array(
  z.object({
    requestId: z.string(),
    expectedTier: TierSchema,
    expectedOutcome: z.enum(["approve", "partial", "deny", "escalate"]),
    expectedAction: z.enum(["dodo.createRefund", "dodo.changeSubscriptionPlan", "dodo.createWalletLedgerEntry", "none"]),
    expectedAmount: z.number().int().nonnegative().optional(),
    tierSource: z.string().startsWith("public knowledge: "),
  }),
);
const expected = ExpectedSchema.parse(fixture("expected.json"));

describe("policy table", () => {
  it("has an outcome for every tier x plan x request type", () => {
    for (const tier of TIERS) {
      for (const plan of PLANS) {
        for (const type of REQUEST_TYPES) {
          const rule = POLICY_TABLE[tier][plan][type];
          expect(["approve", "partial", "deny", "escalate"], `${tier}/${plan}/${type}`).toContain(rule.outcome);
          expect(rule.why.length).toBeGreaterThan(0);
        }
      }
    }
    // Totality also means no extra keys the loops above would miss.
    expect(Object.keys(POLICY_TABLE).sort()).toEqual([...TIERS].sort());
  });

  it("never uses `partial` for a plan change", () => {
    for (const tier of TIERS) for (const plan of PLANS) expect(POLICY_TABLE[tier][plan].plan_change.outcome).not.toBe("partial");
  });

  it("covers all four outcomes", () => {
    const seen = new Set<string>();
    for (const tier of TIERS) for (const plan of PLANS) for (const type of REQUEST_TYPES) seen.add(POLICY_TABLE[tier][plan][type].outcome);
    expect([...seen].sort()).toEqual(["approve", "deny", "escalate", "partial"]);
  });
});

describe("tierFromCompany", () => {
  it("returns unknown for null, undefined and empty data", () => {
    expect(tierFromCompany(null).tier).toBe("unknown");
    expect(tierFromCompany(undefined).tier).toBe("unknown");
    expect(tierFromCompany({}).tier).toBe("unknown");
    expect(tierFromCompany({ headcount: { total: null } }).tier).toBe("unknown");
  });

  it("applies the headcount thresholds at the boundaries", () => {
    const t = (n: number) => tierFromCompany({ headcount: { total: n } }).tier;
    expect(t(0)).toBe("smb");
    expect(t(SMB_MAX_EMPLOYEES_EXCLUSIVE - 1)).toBe("smb"); // 49
    expect(t(SMB_MAX_EMPLOYEES_EXCLUSIVE)).toBe("mid_market"); // 50
    expect(t(ENTERPRISE_MIN_EMPLOYEES - 1)).toBe("mid_market"); // 999
    expect(t(ENTERPRISE_MIN_EMPLOYEES)).toBe("enterprise"); // 1000
    expect(tierFromCompany({ headcount: { total: 1000 } }).basis).toBe("headcount.total=1000");
  });

  it("prefers headcount.total over ranges and funding", () => {
    const res = tierFromCompany({
      headcount: { total: 40 },
      basic_info: { employee_count_range: "1001-5000" },
      funding: { total_investment_usd: 2_000_000_000 },
    });
    expect(res.tier).toBe("smb");
  });

  it("falls back to market_intel, then employee_count_range, by floored midpoint", () => {
    expect(tierFromCompany({ market_intel: { num_employees_min: 501, num_employees_max: 1000 } }).tier).toBe("mid_market"); // 750
    expect(tierFromCompany({ market_intel: { num_employees_min: 1001, num_employees_max: 5000 } }).tier).toBe("enterprise");
    expect(tierFromCompany({ basic_info: { employee_count_range: "11-50" } }).tier).toBe("smb"); // 30
    expect(tierFromCompany({ basic_info: { employee_count_range: "51-200" } }).tier).toBe("mid_market");
    expect(tierFromCompany({ basic_info: { employee_count_range: "10,001+" } }).tier).toBe("enterprise");
    expect(tierFromCompany({ basic_info: { employee_count_range: "unknown" } }).tier).toBe("unknown");
  });

  it("uses funding only without any headcount field", () => {
    expect(tierFromCompany({ funding: { total_investment_usd: 600_000_000 } }).tier).toBe("enterprise");
    expect(tierFromCompany({ funding: { total_investment_usd: 20_000_000 } }).tier).toBe("mid_market");
    expect(tierFromCompany({ funding: { total_investment_usd: 3_000_000 } }).tier).toBe("smb");
    expect(tierFromCompany({ funding: { total_investment_usd: 0 } }).tier).toBe("unknown");
  });

  it("parses employee ranges", () => {
    expect(parseEmployeeRange("51-200")).toEqual({ lo: 51, hi: 200 });
    expect(parseEmployeeRange("10001+")).toEqual({ lo: 10001, hi: 10001 });
    expect(parseEmployeeRange("200-51")).toBeNull();
    expect(parseEmployeeRange("lots")).toBeNull();
  });
});

describe("decidePolicy", () => {
  it("floors a partial share to the minor unit", () => {
    expect(partialShare(1999)).toBe(999);
    expect(partialShare(1)).toBe(0);
    expect(partialShare(9900)).toBe(4950);
    expect(decidePolicy({ tier: "smb", plan: "growth", type: "refund", paymentAmount: 1999 })).toMatchObject({
      outcome: "partial",
      action: "dodo.createRefund",
      refundAmount: 999,
    });
  });

  it("escalates a partial without a base amount", () => {
    expect(decidePolicy({ tier: "smb", plan: "growth", type: "refund" })).toMatchObject({ outcome: "escalate", action: "none" });
  });

  it("refunds the payment total on a full refund, and escalates when the asked amount differs", () => {
    expect(decidePolicy({ tier: "smb", plan: "starter", type: "refund", paymentAmount: 2900 }).refundAmount).toBe(2900);
    expect(decidePolicy({ tier: "smb", plan: "starter", type: "refund", amount: 19, paymentAmount: 1999 })).toMatchObject({
      outcome: "escalate",
      action: "none",
    });
  });

  it("denies a partial refund larger than the payment and escalates one with no amount", () => {
    expect(decidePolicy({ tier: "smb", plan: "starter", type: "partial_refund", amount: 5000, paymentAmount: 2900 }).outcome).toBe("deny");
    expect(decidePolicy({ tier: "smb", plan: "starter", type: "partial_refund", paymentAmount: 2900 }).outcome).toBe("escalate");
  });

  it("escalates credits over the tier cap", () => {
    const cap = CREDIT_CAP_MINOR.mid_market;
    expect(decidePolicy({ tier: "mid_market", plan: "growth", type: "credit", amount: cap }).outcome).toBe("approve");
    expect(decidePolicy({ tier: "mid_market", plan: "growth", type: "credit", amount: cap + 1 }).outcome).toBe("escalate");
  });

  it("escalates an unknown plan", () => {
    expect(decidePolicy({ tier: "enterprise", plan: "platinum", type: "refund" })).toMatchObject({ outcome: "escalate", action: "none" });
  });
});

describe("seed plan", () => {
  it("gives one customer more payments than a page holds", () => {
    const bulk = plannedPayments().filter((p) => p.customer === SEED_PLAN.bulk.customer);
    expect(bulk.length).toBeGreaterThan(DODO_MAX_PAGE_SIZE);
  });

  it("has a payment whose amount is not a whole number of dollars, and refunds one before the run", () => {
    expect(plannedPayments().some((p) => p.amount % 100 !== 0)).toBe(true);
    for (const h of SEED_PLAN.existingRefunds) expect(plannedHandles().payments.has(h)).toBe(true);
  });

  it("lists human checkouts once per customer and every other payment as headless", () => {
    const steps = seedSteps();
    expect(steps.filter((s) => s.kind === "human")).toHaveLength(Object.keys(SEED_PLAN.customers).length);
    const headless = plannedPayments().filter((p) => p.via === "headless").length;
    expect(steps.filter((s) => s.op === "dodo.createCheckoutSession" && s.handle.startsWith("pay:"))).toHaveLength(headless);
  });
});

describe("seeded queue", () => {
  it("parses as QueueRequests, about 20, with unique ids", () => {
    expect(queue.length).toBeGreaterThanOrEqual(18);
    expect(queue.length).toBeLessThanOrEqual(22);
    expect(new Set(queue.map((q) => q.id)).size).toBe(queue.length);
  });

  it("resolves every handle against the seed plan", () => {
    const h = plannedHandles();
    for (const q of queue) {
      const cust = parseRef(q.customerId);
      expect(cust.kind, q.id).toBe("cust");
      expect(h.customers.has(cust.handle), `${q.id} ${q.customerId}`).toBe(true);
      expect(SEED_PLAN.customers[cust.handle]!.companyDomain, q.id).toBe(q.companyDomain);
      expect(SEED_PLAN.customers[cust.handle]!.plan, q.id).toBe(q.plan);
      if (q.paymentId) {
        const pay = parseRef(q.paymentId);
        expect(pay.kind).toBe("pay");
        expect(h.payments.get(pay.handle)?.customer, `${q.id} ${q.paymentId}`).toBe(cust.handle);
      }
      if (q.subscriptionId) {
        const sub = parseRef(q.subscriptionId);
        expect(sub.kind).toBe("sub");
        expect(h.subscriptions.has(sub.handle) && sub.handle === cust.handle, `${q.id} ${q.subscriptionId}`).toBe(true);
      }
      if (q.targetPlan) expect(h.products.has(q.targetPlan), q.id).toBe(true);
      if (q.type === "refund" || q.type === "partial_refund") expect(q.paymentId, q.id).toBeDefined();
      if (q.type === "plan_change") expect(q.subscriptionId && q.targetPlan, q.id).toBeTruthy();
    }
  });

  it("includes the designed trap cases", () => {
    expect(queue.filter((q) => q.note === "client-timeout-then-retry")).toHaveLength(1);
    expect(queue.some((q) => q.paymentId === `pay:${SEED_PLAN.existingRefunds[0]}`)).toBe(true);
    expect(queue.some((q) => q.amount === 1999 && q.reason.includes("$19.99"))).toBe(true);
    expect(queue.filter((q) => q.note?.startsWith("tier-boundary"))).toHaveLength(1);
    for (const type of REQUEST_TYPES) expect(queue.some((q) => q.type === type), type).toBe(true);
  });
});

describe("expected.json", () => {
  it("has exactly one entry per queue request", () => {
    expect(expected.map((e) => e.requestId).sort()).toEqual(queue.map((q) => q.id).sort());
  });

  it("matches decidePolicy re-derived from the expected tier (catches table/fixture drift)", () => {
    for (const e of expected) {
      const q = queue.find((x) => x.id === e.requestId)!;
      const paymentAmount = q.paymentId ? plannedPaymentAmount(parseRef(q.paymentId).handle) : undefined;
      const d = decidePolicy({
        tier: e.expectedTier,
        plan: q.plan,
        type: q.type,
        ...(q.amount === undefined ? {} : { amount: q.amount }),
        ...(paymentAmount === undefined ? {} : { paymentAmount }),
      });
      expect({ id: e.requestId, outcome: d.outcome, action: d.action, amount: d.refundAmount }).toEqual({
        id: e.requestId,
        outcome: e.expectedOutcome,
        action: e.expectedAction,
        amount: e.expectedAmount,
      });
    }
  });

  it("covers approve, partial, deny and escalate", () => {
    expect(new Set(expected.map((e) => e.expectedOutcome))).toEqual(new Set(["approve", "partial", "deny", "escalate"]));
  });
});

describe("seed manifest refs", () => {
  // TEST DATA: an in-memory manifest with made-up ids; never written to fixtures/.
  const manifest: SeedManifest = {
    createdAt: "2026-10-10T00:00:00.000Z",
    mode: "replay",
    cassette: "test",
    customers: { a: { customerId: "cus_test_a", email: "a@example.com", companyDomain: "example.com" } },
    products: { growth: { productId: "pdt_test_g", price: 9900, currency: "USD" } },
    payments: { "a-growth": { paymentId: "pay_test_1", customerHandle: "a", amount: 9900, currency: "USD", status: "succeeded" } },
    subscriptions: { a: { subscriptionId: "sub_test_a", customerHandle: "a", productHandle: "growth" } },
  };

  it("resolves known handles of each kind", () => {
    expect(resolveRef(manifest, "cust:a")).toBe("cus_test_a");
    expect(resolveRef(manifest, "pay:a-growth")).toBe("pay_test_1");
    expect(resolveRef(manifest, "sub:a")).toBe("sub_test_a");
    expect(resolveRef(manifest, "prod:growth")).toBe("pdt_test_g");
    expect(resolveEntry(manifest, "pay:a-growth")).toMatchObject({ kind: "pay", entry: { amount: 9900 } });
  });

  it("throws on unknown handles and malformed refs", () => {
    expect(() => resolveRef(manifest, "cust:nobody")).toThrow(/Unknown seed handle "cust:nobody"/);
    expect(() => resolveRef(manifest, "pay:missing")).toThrow(/Unknown seed handle/);
    expect(() => resolveRef(manifest, "sub:zzz")).toThrow(/Unknown seed handle/);
    expect(() => resolveRef(manifest, "prod:zzz")).toThrow(/Unknown seed handle/);
    expect(() => resolveRef(manifest, "cus_test_a")).toThrow(/Not a seed ref/);
    expect(() => resolveRef(manifest, "inv:a")).toThrow(/Not a seed ref/);
  });

  it("loadManifest reports BLOCKED when the file is absent and validates when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "notary-manifest-"));
    try {
      expect(() => loadManifest(join(dir, "manifest.json"))).toThrow(MANIFEST_MISSING_MESSAGE);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
      expect(loadManifest(join(dir, "manifest.json")).customers.a?.customerId).toBe("cus_test_a");
      writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...manifest, payments: { x: { paymentId: "p", amount: 19.99 } } }));
      expect(() => loadManifest(join(dir, "bad.json"))).toThrow(/Invalid seed manifest/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
