/**
 * What scripts/seed-dodo.ts creates in Dodo test mode. Pure data plus helpers: no I/O, so tests
 * and `seed:dodo --plan` can check it without a network or keys.
 *
 * Handles (the keys below) are what fixtures/queue/seeded.json refers to ("cust:<h>", "pay:<h>",
 * "sub:<h>", "prod:<h>"); the seed manifest maps them to real Dodo ids after a live seed.
 *
 * Every amount is integer minor units (cents; currency USD).
 */
import type { Plan } from "./policy.js";

export interface PlannedProduct {
  name: string;
  kind: "recurring" | "one_time";
  /** Minor units. */
  price: number;
}

export interface PlannedCustomer {
  name: string;
  companyDomain: string;
  /** The plan the customer subscribes to (a product handle). */
  plan: Plan;
  /** Extra one-time payments: payment handle -> product handle. Charged headlessly (see the script). */
  extraPayments?: Record<string, string>;
  /** Seed a wallet with a starting credit of this many minor units (makes a ledger entry to find later). */
  walletCredit?: number;
}

export interface SeedPlan {
  currency: "USD";
  billingCountry: "US";
  products: Record<string, PlannedProduct>;
  customers: Record<string, PlannedCustomer>;
  /** One customer gets more payments than a single page (page_size max 100) can hold. */
  bulk: { customer: string; product: string; count: number; handlePrefix: string };
  /** Refunds created during seeding, so a queue request can hit an already-refunded payment. */
  existingRefunds: string[];
  /**
   * PROBE-ONLY resources (DECISIONS #42, #81): a customer that fixtures/queue/seeded.json never
   * references, so probes can refund, list and change plans without touching anything the graded
   * queue reads. Its subscription checkout is one of the hosted (human) checkouts; everything else
   * is headless. See `probeHandles()` for the derived handles.
   */
  probe: {
    /** Customer handle (also listed in `customers`, so it gets its own hosted subscription checkout). */
    customer: string;
    /** One-time product the probe payments buy (priced well above 100x any refund-probe amount). */
    product: string;
    /** Payments fully refunded during seeding: the refund-list probes need a set larger than a page (>= 30). */
    refunded: number;
    /** Payments left succeeded and unrefunded: refund probes (unit_roundtrip, retry_after_timeout, write_then_read) consume them. */
    open: number;
    /** Extra subscriptions (headless, on the customer's plan) so each change-plan probe variant has a fresh one. */
    extraSubscriptions: number;
  };
}

/** Dodo's documented page_size maximum on list endpoints (docs/ENDPOINTS.md). */
export const DODO_MAX_PAGE_SIZE = 100;

export const SEED_PLAN: SeedPlan = {
  currency: "USD",
  billingCountry: "US",
  products: {
    starter: { name: "Notary Seed - Starter (monthly)", kind: "recurring", price: 2_900 },
    growth: { name: "Notary Seed - Growth (monthly)", kind: "recurring", price: 9_900 },
    scale: { name: "Notary Seed - Scale (monthly)", kind: "recurring", price: 49_900 },
    addon: { name: "Notary Seed - Add-on pack", kind: "one_time", price: 1_999 },
    onboarding: { name: "Notary Seed - Onboarding package", kind: "one_time", price: 15_000 },
    topup: { name: "Notary Seed - Usage top-up", kind: "one_time", price: 100 },
    "probe-item": { name: "Notary Seed - Probe-only item (never in the queue)", kind: "one_time", price: 25_000 },
  },
  customers: {
    "ent-microsoft": { name: "Seed Microsoft", companyDomain: "microsoft.com", plan: "scale", walletCredit: 500 },
    "ent-salesforce": { name: "Seed Salesforce", companyDomain: "salesforce.com", plan: "scale" },
    "ent-shopify": { name: "Seed Shopify", companyDomain: "shopify.com", plan: "growth", walletCredit: 500 },
    "ent-atlassian": { name: "Seed Atlassian", companyDomain: "atlassian.com", plan: "growth" },
    "mid-retool": { name: "Seed Retool", companyDomain: "retool.com", plan: "growth" },
    "mid-supabase": { name: "Seed Supabase", companyDomain: "supabase.com", plan: "growth", walletCredit: 500 },
    "mid-sentry": {
      name: "Seed Sentry",
      companyDomain: "sentry.io",
      plan: "scale",
      extraPayments: { "mid-sentry-onboarding": "onboarding" },
    },
    "mid-zapier": { name: "Seed Zapier", companyDomain: "zapier.com", plan: "growth" },
    "smb-plausible": { name: "Seed Plausible", companyDomain: "plausible.io", plan: "starter" },
    "smb-buttondown": {
      name: "Seed Buttondown",
      companyDomain: "buttondown.com",
      plan: "starter",
      extraPayments: { "smb-buttondown-addon": "addon" },
      walletCredit: 500,
    },
    "smb-fathom": {
      name: "Seed Fathom",
      companyDomain: "usefathom.com",
      plan: "growth",
      extraPayments: { "smb-fathom-addon": "addon" },
      walletCredit: 500,
    },
    // PROBE-ONLY: never referenced by fixtures/queue/seeded.json (asserted in test/verification.test.ts).
    "probe-only": { name: "Seed Probe-only (Notary probes, never in the queue)", companyDomain: "notary-probe-only.invalid", plan: "starter" },
  },
  bulk: { customer: "mid-retool", product: "topup", count: 105, handlePrefix: "mid-retool-topup-" },
  existingRefunds: ["mid-retool-topup-001"],
  probe: { customer: "probe-only", product: "probe-item", refunded: 30, open: 15, extraSubscriptions: 2 },
};

/** Handles of the probe-only resources a plan creates. */
export interface ProbeHandles {
  customer: string;
  /** Payments fully refunded during seeding (refund-list probes). */
  refundedPayments: string[];
  /** Succeeded, unrefunded payments reserved for refund probes. */
  openPayments: string[];
  /** Subscription handles: the customer's own (handle = customer) plus the extra headless ones. */
  subscriptions: string[];
  /** Payment handles of the extra subscriptions (headless recurring checkouts; subscription handle = payment handle). */
  extraSubscriptionPayments: string[];
}

const pad3 = (i: number): string => String(i).padStart(3, "0");

export function probeHandles(plan: SeedPlan = SEED_PLAN): ProbeHandles {
  const c = plan.probe.customer;
  const range = (n: number, kind: string) => Array.from({ length: n }, (_, i) => `${c}-${kind}-${pad3(i + 1)}`);
  const extra = range(plan.probe.extraSubscriptions, "sub");
  return {
    customer: c,
    refundedPayments: range(plan.probe.refunded, "refunded"),
    openPayments: range(plan.probe.open, "open"),
    subscriptions: [c, ...extra],
    extraSubscriptionPayments: extra,
  };
}

/** Every payment handle the seed refunds (the queue's pre-existing refund + the probe-only refunds). */
export function refundedPaymentHandles(plan: SeedPlan = SEED_PLAN): string[] {
  return [...plan.existingRefunds, ...probeHandles(plan).refundedPayments];
}

/** Company domains of the customers the seeded queue can reference (the probe-only customer excluded), sorted. */
export function queueCompanyDomains(plan: SeedPlan = SEED_PLAN): string[] {
  return Object.entries(plan.customers)
    .filter(([h]) => h !== plan.probe.customer)
    .map(([, c]) => c.companyDomain)
    .sort();
}

/** Test-only email for a seeded customer (example.com is reserved; no real person). */
export function seedEmail(customerHandle: string): string {
  return `notary-seed+${customerHandle}@example.com`;
}

/** The subscription payment handle for a customer: "<customer>-<plan>". */
export function subscriptionPaymentHandle(customerHandle: string, plan: string): string {
  return `${customerHandle}-${plan}`;
}

export function bulkPaymentHandle(plan: SeedPlan, i: number): string {
  return `${plan.bulk.handlePrefix}${String(i).padStart(3, "0")}`;
}

export interface PlannedPayment {
  handle: string;
  customer: string;
  product: string;
  amount: number;
  /** checkout: a human completes a hosted checkout once; headless: charged with the saved payment method. */
  via: "checkout" | "headless";
}

/** Every payment the seed creates, in creation order. */
export function plannedPayments(plan: SeedPlan = SEED_PLAN): PlannedPayment[] {
  const out: PlannedPayment[] = [];
  const price = (product: string): number => {
    const p = plan.products[product];
    if (!p) throw new Error(`Seed plan: unknown product handle "${product}"`);
    return p.price;
  };
  for (const [customer, c] of Object.entries(plan.customers)) {
    out.push({ handle: subscriptionPaymentHandle(customer, c.plan), customer, product: c.plan, amount: price(c.plan), via: "checkout" });
  }
  for (const [customer, c] of Object.entries(plan.customers)) {
    for (const [handle, product] of Object.entries(c.extraPayments ?? {})) {
      out.push({ handle, customer, product, amount: price(product), via: "headless" });
    }
  }
  for (let i = 1; i <= plan.bulk.count; i++) {
    out.push({ handle: bulkPaymentHandle(plan, i), customer: plan.bulk.customer, product: plan.bulk.product, amount: price(plan.bulk.product), via: "headless" });
  }
  // PROBE-ONLY payments (never referenced by the queue): the refunded set, the open set, extra subscriptions.
  const probe = probeHandles(plan);
  const probeCustomer = plan.customers[probe.customer];
  if (!probeCustomer) throw new Error(`Seed plan: probe customer "${probe.customer}" is not in customers`);
  for (const handle of [...probe.refundedPayments, ...probe.openPayments]) {
    out.push({ handle, customer: probe.customer, product: plan.probe.product, amount: price(plan.probe.product), via: "headless" });
  }
  for (const handle of probe.extraSubscriptionPayments) {
    out.push({ handle, customer: probe.customer, product: probeCustomer.plan, amount: price(probeCustomer.plan), via: "headless" });
  }
  return out;
}

export interface PlannedHandles {
  customers: Set<string>;
  products: Set<string>;
  payments: Map<string, PlannedPayment>;
  /** Subscription handle = customer handle. */
  subscriptions: Set<string>;
}

export function plannedHandles(plan: SeedPlan = SEED_PLAN): PlannedHandles {
  return {
    customers: new Set(Object.keys(plan.customers)),
    products: new Set(Object.keys(plan.products)),
    payments: new Map(plannedPayments(plan).map((p) => [p.handle, p])),
    subscriptions: new Set([...Object.keys(plan.customers), ...probeHandles(plan).extraSubscriptionPayments]),
  };
}

/** Planned amount (minor units) of a payment handle; throws on an unknown handle. */
export function plannedPaymentAmount(handle: string, plan: SeedPlan = SEED_PLAN): number {
  const p = plannedHandles(plan).payments.get(handle);
  if (!p) throw new Error(`Seed plan: unknown payment handle "${handle}"`);
  return p.amount;
}

export interface SeedStep {
  op: string;
  handle: string;
  detail: string;
  /** human: needs a person to finish a hosted checkout with a Dodo test card. */
  kind: "api" | "human";
}

/** What the probe-only resources add to a seed (all Dodo TEST mode; amounts in minor units). */
export interface ProbeSeedCost {
  customer: string;
  humanCheckouts: number;
  headlessPayments: number;
  payments: number;
  refunds: number;
  subscriptions: number;
  /** Sum of the probe-only payments' amounts (test mode: no real money moves). */
  chargedMinor: number;
  /** Sum of the probe-only refunds the seed itself issues. */
  refundedMinor: number;
}

export function probeSeedCost(plan: SeedPlan = SEED_PLAN): ProbeSeedCost {
  const h = probeHandles(plan);
  const payments = plannedPayments(plan).filter((p) => p.customer === h.customer);
  const refunded = new Set(h.refundedPayments);
  return {
    customer: h.customer,
    humanCheckouts: payments.filter((p) => p.via === "checkout").length,
    headlessPayments: payments.filter((p) => p.via === "headless").length,
    payments: payments.length,
    refunds: h.refundedPayments.length,
    subscriptions: h.subscriptions.length,
    chargedMinor: payments.reduce((s, p) => s + p.amount, 0),
    refundedMinor: payments.filter((p) => refunded.has(p.handle)).reduce((s, p) => s + p.amount, 0),
  };
}

/** The ordered list of actions the live seed performs (what `--plan` prints). */
export function seedSteps(plan: SeedPlan = SEED_PLAN): SeedStep[] {
  const steps: SeedStep[] = [];
  for (const [h, p] of Object.entries(plan.products)) {
    steps.push({ op: "dodo.createProduct", handle: `prod:${h}`, detail: `${p.kind} ${p.price} ${plan.currency} minor units`, kind: "api" });
  }
  for (const [h, c] of Object.entries(plan.customers)) {
    steps.push({ op: "dodo.createCustomer", handle: `cust:${h}`, detail: `${c.name} (${c.companyDomain}) <${seedEmail(h)}>`, kind: "api" });
  }
  for (const [h, c] of Object.entries(plan.customers)) {
    steps.push({ op: "dodo.createCheckoutSession", handle: `sub:${h}`, detail: `subscribe to prod:${c.plan}; returns checkout_url`, kind: "api" });
    steps.push({
      op: "(browser)",
      handle: `pay:${subscriptionPaymentHandle(h, c.plan)}`,
      detail: "complete the hosted checkout with test card 4242 4242 4242 4242, 06/32, CVV 123",
      kind: "human",
    });
  }
  for (const [h] of Object.entries(plan.customers)) {
    steps.push({ op: "dodo.listPayments", handle: `cust:${h}`, detail: "poll until the subscription payment succeeds", kind: "api" });
  }
  for (const p of plannedPayments(plan).filter((x) => x.via === "headless")) {
    steps.push({
      op: "dodo.createCheckoutSession",
      handle: `pay:${p.handle}`,
      detail: `confirm:true + saved payment_method_id; prod:${p.product} ${p.amount} minor units`,
      kind: "api",
    });
  }
  for (const h of Object.keys(plan.customers)) {
    steps.push({ op: "dodo.getSubscription", handle: `sub:${h}`, detail: "verify status and product", kind: "api" });
  }
  for (const h of plan.existingRefunds) {
    steps.push({ op: "dodo.createRefund", handle: `pay:${h}`, detail: "pre-existing full refund (lands on a later page of listPayments)", kind: "api" });
  }
  for (const h of probeHandles(plan).refundedPayments) {
    steps.push({ op: "dodo.createRefund", handle: `pay:${h}`, detail: "PROBE-ONLY full refund (refund-list probes need a set larger than one page)", kind: "api" });
  }
  for (const [h, c] of Object.entries(plan.customers)) {
    if (c.walletCredit) {
      steps.push({
        op: "dodo.createWalletLedgerEntry",
        handle: `cust:${h}`,
        detail: `credit ${c.walletCredit} ${plan.currency} minor units, idempotency_key notary-seed-${h}`,
        kind: "api",
      });
    }
  }
  return steps;
}
