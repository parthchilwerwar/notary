/**
 * FIXTURE API for `notary demo --fixture`. A deterministic, in-process simulation of the parts of
 * Crustdata and Dodo Payments (test mode) that Notary calls. It is installed as the recorder's
 * transport (tools/recorder.ts `setRecorderTransport`), so createTools, the recorder, redaction, the
 * credit ledger, the checker, the probe templates and the queue executor all run unmodified on top
 * of it. NOTHING HERE IS A RESULT: every response is simulated, and every bundle the demo writes is
 * labelled `sample: true` with a FIXTURE DATA disclosure.
 *
 * World: built from SEED_PLAN (src/queue/seed-plan.ts) — its products, customers, every planned
 * payment (subscriptions, extra one-time payments, 105 bulk top-ups, the probe-only payments), one
 * subscription per customer plus the probe-only extra subscriptions, the pre-existing refund, the
 * probe-only refunded set and the seeded wallet credits — plus a Crustdata company table whose
 * headcounts map to the tiers in fixtures/queue/expected.json. State is in memory, so writes affect
 * later reads. Ids and timestamps come from counters, so the same calls give the same bytes.
 *
 * Only two hosts exist: https://api.crustdata.com and https://test.dodopayments.com. A request to any
 * other host is REFUSED (thrown, counted in `stats.refused`); nothing ever reaches the network.
 *
 * PLANTED FIXTURE QUIRKS (simulated behaviour chosen so the loop has something real to find and the
 * naive run can fail for honest reasons; they are NOT claims about the real APIs):
 *   Q1 GET /payments and GET /refunds accept page_size > 100 (documented max) and silently clamp it to
 *      100 instead of rejecting it.
 *   Q2 POST /customers/{id}/wallets/ledger-entries reads `amount` in MAJOR units: a credit of 1000
 *      adds 100000 minor units to the balance (the docs say smallest unit).
 *   Q3 The same endpoint ignores `idempotency_key`: repeating a keyed credit creates a new entry each
 *      time (the docs say the repeat is a no-op).
 *   Q4 POST /refunds reads a partial refund's `items[].amount` in MAJOR units and silently caps it at
 *      the line item's price, so any partial refund becomes a refund of the whole item.
 *   Q5 POST /refunds has no duplicate protection for full refunds: a retried full refund on a payment
 *      that is already refunded creates a second refund. Full refunds also answer slowly
 *      (`slowFullRefundMs`, default 500 ms), so a client with a 200 ms timeout gives up and retries.
 *   Q6 Crustdata enrich returns notion.so's `funding.total_investment_usd` as a formatted string
 *      ("$343M") instead of a number.
 * CONTROLS (the fixture honors the documented claim): customer without email -> 422; overdraft debit
 * -> 400; product price echoes in minor units; payment.refunds[] always present; wallet balances and
 * total_balance_usd are integers; change-plan with a pending change -> 409; identify with an
 * enrich-only field group -> 400; enrich/identify no-match -> 200 with empty matches; headcount,
 * employee range, dates and confidence scores have their documented types.
 */
import { DODO_TEST_HOST } from "../tools/recorder.js";
import type { FetchLike } from "../tools/recorder.js";
import { SEED_PLAN, plannedPayments, probeHandles, refundedPaymentHandles, seedEmail } from "../queue/seed-plan.js";
import type { SeedPlan } from "../queue/seed-plan.js";
import type { SeedManifest } from "../queue/manifest.js";

export const FIXTURE_HOSTS = { crustdata: "api.crustdata.com", dodo: DODO_TEST_HOST } as const;

export interface FixtureQuirk {
  id: string;
  tool: "crustdata" | "dodo";
  where: string;
  behaviour: string;
  /** Contract claims the quirk bears on. */
  claims: string[];
}

export const FIXTURE_QUIRKS: readonly FixtureQuirk[] = [
  {
    id: "Q1",
    tool: "dodo",
    where: "GET /payments, GET /refunds",
    behaviour: "page_size > 100 (documented max) is accepted and silently clamped to 100",
    claims: ["dodo.payments.page-size-max-100", "dodo.refunds.page-size-max-100"],
  },
  {
    id: "Q2",
    tool: "dodo",
    where: "POST /customers/{id}/wallets/ledger-entries",
    behaviour: "`amount` is read in MAJOR units: crediting 1000 adds 100000 minor units",
    claims: ["dodo.wallet.credit-amount-minor-units"],
  },
  {
    id: "Q3",
    tool: "dodo",
    where: "POST /customers/{id}/wallets/ledger-entries",
    behaviour: "`idempotency_key` is ignored: each repeat of a keyed credit creates a new entry",
    claims: ["dodo.wallet.idempotency-key-no-duplicate"],
  },
  {
    id: "Q4",
    tool: "dodo",
    where: "POST /refunds (partial)",
    behaviour: "`items[].amount` is read in MAJOR units and silently capped at the line price: every partial refund refunds the whole item",
    claims: ["dodo.refund.amount-minor-units"],
  },
  {
    id: "Q5",
    tool: "dodo",
    where: "POST /refunds (full)",
    behaviour: "no duplicate protection (a retried full refund creates a second refund), and full refunds answer slowly",
    claims: ["dodo.refund.full-retry-no-duplicate"],
  },
  {
    id: "Q6",
    tool: "crustdata",
    where: "POST /company/enrich",
    behaviour: 'notion.so funding.total_investment_usd comes back as the string "$343M"',
    claims: ["crustdata.enrich.funding-total-investment-number"],
  },
];

export const FIXTURE_CONTROLS: readonly string[] = [
  "customer without email -> 422",
  "overdraft debit -> 400",
  "product price echoed in minor units",
  "payment.refunds[] always present",
  "wallet balances / total_balance_usd are integers",
  "change-plan with a pending change -> 409",
  "identify with an enrich-only field group -> 400",
  "enrich / identify no-match -> 200 with empty matches",
  "headcount, employee range, dates and confidence scores have their documented types",
];

// ---------------------------------------------------------------------------------------------
// Crustdata company table (simulated values; headcounts chosen to land in the expected tiers)

export interface FixtureCompany {
  id: number;
  name: string;
  headcount: number;
  fundingUsd: number | string | null;
  lastRound: string | null;
  lastFundraiseDate: string | null;
  yearFounded: number;
}

export const FIXTURE_COMPANIES: Readonly<Record<string, FixtureCompany>> = {
  // seeded queue domains (fixtures/queue/seeded.json)
  "plausible.io": { id: 900001, name: "Plausible Analytics", headcount: 14, fundingUsd: null, lastRound: null, lastFundraiseDate: null, yearFounded: 2019 },
  "buttondown.com": { id: 900002, name: "Buttondown", headcount: 6, fundingUsd: null, lastRound: null, lastFundraiseDate: null, yearFounded: 2017 },
  "usefathom.com": { id: 900003, name: "Fathom Analytics", headcount: 12, fundingUsd: null, lastRound: null, lastFundraiseDate: null, yearFounded: 2018 },
  "sentry.io": { id: 900004, name: "Sentry", headcount: 380, fundingUsd: 217_000_000, lastRound: "series_e", lastFundraiseDate: "2022-05-24", yearFounded: 2012 },
  "supabase.com": { id: 900005, name: "Supabase", headcount: 210, fundingUsd: 196_000_000, lastRound: "series_d", lastFundraiseDate: "2025-04-22", yearFounded: 2020 },
  "retool.com": { id: 900006, name: "Retool", headcount: 420, fundingUsd: 141_000_000, lastRound: "series_c", lastFundraiseDate: "2022-07-26", yearFounded: 2017 },
  "zapier.com": { id: 900007, name: "Zapier", headcount: 812, fundingUsd: 1_400_000, lastRound: "seed", lastFundraiseDate: "2014-01-01", yearFounded: 2011 },
  "shopify.com": { id: 900008, name: "Shopify", headcount: 8300, fundingUsd: 122_000_000, lastRound: "ipo", lastFundraiseDate: "2015-05-21", yearFounded: 2006 },
  "microsoft.com": { id: 900009, name: "Microsoft", headcount: 221_000, fundingUsd: 1_000_000, lastRound: "ipo", lastFundraiseDate: "1986-03-13", yearFounded: 1975 },
  "salesforce.com": { id: 900010, name: "Salesforce", headcount: 72_682, fundingUsd: 65_000_000, lastRound: "ipo", lastFundraiseDate: "2004-06-23", yearFounded: 1999 },
  "atlassian.com": { id: 900011, name: "Atlassian", headcount: 12_157, fundingUsd: 210_000_000, lastRound: "ipo", lastFundraiseDate: "2015-12-10", yearFounded: 2002 },
  // recon domains (src/contracts/crustdata.ts TIER_DOMAINS)
  "stripe.com": { id: 900012, name: "Stripe", headcount: 8500, fundingUsd: 9_400_000_000, lastRound: "series_i", lastFundraiseDate: "2023-03-15", yearFounded: 2010 },
  // PLANTED FIXTURE QUIRK Q6: a formatted string where the docs promise a number.
  "notion.so": { id: 900013, name: "Notion", headcount: 1003, fundingUsd: "$343M", lastRound: "series_c", lastFundraiseDate: "2021-10-08", yearFounded: 2013 },
};

function employeeRange(n: number): string {
  const bands: Array<[number, number, string]> = [
    [1, 10, "1-10"],
    [11, 50, "11-50"],
    [51, 200, "51-200"],
    [201, 500, "201-500"],
    [501, 1000, "501-1000"],
    [1001, 5000, "1001-5000"],
    [5001, 10000, "5001-10000"],
  ];
  for (const [lo, hi, label] of bands) if (n >= lo && n <= hi) return label;
  return "10001+";
}

// ---------------------------------------------------------------------------------------------
// Dodo world

const BUSINESS_ID = "biz_fx_demo";
const CURRENCY = "USD";
/** Documented max page size (Dodo list endpoints). */
const DOC_MAX_PAGE = 100;
/** Simulated EUR -> USD rate for total_balance_usd (integer result). */
const EUR_TO_USD = 1.08;

interface FxCustomer {
  customer_id: string;
  name: string;
  email: string;
  phone_number: string | null;
  created_at: string;
}
interface FxProduct {
  product_id: string;
  name: string;
  tax_category: string;
  is_recurring: boolean;
  price: Record<string, unknown> & { price: number; currency: string };
  created_at: string;
}
interface FxPayment {
  payment_id: string;
  customer_id: string;
  product_id: string;
  quantity: number;
  total_amount: number;
  currency: string;
  status: string;
  created_at: string;
  payment_link: string | null;
}
interface FxRefund {
  refund_id: string;
  payment_id: string;
  customer_id: string;
  amount: number;
  currency: string;
  status: "succeeded";
  is_partial: boolean;
  reason: string | null;
  created_at: string;
}
interface FxSubscription {
  subscription_id: string;
  customer_id: string;
  product_id: string;
  quantity: number;
  status: string;
  created_at: string;
  scheduled_change: { product_id: string; effective_at: string } | null;
}
interface FxWallet {
  customer_id: string;
  currency: string;
  balance: number;
  created_at: string;
  updated_at: string;
}
interface FxLedgerEntry {
  id: string;
  customer_id: string;
  currency: string;
  amount: number;
  is_credit: boolean;
  event_type: string;
  before_balance: number;
  after_balance: number;
  reason: string | null;
  created_at: string;
}

class HttpAnswer {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
}

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => new HttpAnswer(status, body, headers);
const fail = (status: number, code: string, message: string) => answer(status, { code, message });

/** The simulated Dodo test-mode account plus Crustdata credit balance. */
export class FixtureWorld {
  readonly plan: SeedPlan;
  private clock = 0;
  private counters = new Map<string, number>();
  customers = new Map<string, FxCustomer>();
  products = new Map<string, FxProduct>();
  payments = new Map<string, FxPayment>();
  refunds: FxRefund[] = [];
  subscriptions = new Map<string, FxSubscription>();
  wallets: FxWallet[] = [];
  ledger: FxLedgerEntry[] = [];
  crustdataCreditsUsed = 0;
  /** Handle -> id maps for the seed manifest. */
  readonly handles = {
    customers: new Map<string, string>(),
    products: new Map<string, string>(),
    payments: new Map<string, string>(),
    subscriptions: new Map<string, string>(),
  };

  constructor(plan: SeedPlan = SEED_PLAN) {
    this.plan = plan;
    this.seed();
  }

  /** Deterministic, strictly increasing timestamps (one simulated second per created object). */
  tick(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + this.clock * 1000).toISOString();
  }

  nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  }

  private seed(): void {
    const plan = this.plan;
    for (const [h, p] of Object.entries(plan.products)) {
      const id = `prod_fx_${h}`;
      this.handles.products.set(h, id);
      this.products.set(id, {
        product_id: id,
        name: p.name,
        tax_category: "saas",
        is_recurring: p.kind === "recurring",
        price:
          p.kind === "recurring"
            ? {
                type: "recurring_price",
                price: p.price,
                currency: plan.currency,
                payment_frequency_count: 1,
                payment_frequency_interval: "Month",
                subscription_period_count: 1,
                subscription_period_interval: "Month",
                discount_bps: 0,
                purchasing_power_parity: false,
              }
            : { type: "one_time_price", price: p.price, currency: plan.currency, discount_bps: 0, purchasing_power_parity: false },
        created_at: this.tick(),
      });
    }
    for (const [h, c] of Object.entries(plan.customers)) {
      const id = `cus_fx_${h}`;
      this.handles.customers.set(h, id);
      this.customers.set(id, { customer_id: id, name: c.name, email: seedEmail(h), phone_number: null, created_at: this.tick() });
    }
    for (const p of plannedPayments(plan)) {
      const id = `pay_fx_${p.handle}`;
      this.handles.payments.set(p.handle, id);
      this.payments.set(id, {
        payment_id: id,
        customer_id: this.handles.customers.get(p.customer)!,
        product_id: this.handles.products.get(p.product)!,
        quantity: 1,
        total_amount: p.amount,
        currency: plan.currency,
        status: "succeeded",
        created_at: this.tick(),
        payment_link: null,
      });
    }
    const probe = probeHandles(plan);
    const subscriptionsToSeed: Array<[handle: string, customer: string, plan: string]> = [
      ...Object.entries(plan.customers).map(([h, c]) => [h, h, c.plan] as [string, string, string]),
      ...probe.extraSubscriptionPayments.map((h) => [h, probe.customer, plan.customers[probe.customer]!.plan] as [string, string, string]),
    ];
    for (const [h, customer, product] of subscriptionsToSeed) {
      const id = `sub_fx_${h}`;
      this.handles.subscriptions.set(h, id);
      this.subscriptions.set(id, {
        subscription_id: id,
        customer_id: this.handles.customers.get(customer)!,
        product_id: this.handles.products.get(product)!,
        quantity: 1,
        status: "active",
        created_at: this.tick(),
        scheduled_change: null,
      });
    }
    // The queue's pre-existing refund first, then the probe-only refunded set (same order as the live seed).
    for (const h of refundedPaymentHandles(plan)) {
      const pay = this.payments.get(this.handles.payments.get(h)!)!;
      this.addRefund(pay, pay.total_amount, plan.existingRefunds.includes(h) ? "seed: pre-existing full refund" : "seed: probe-only refund");
    }
    for (const [h, c] of Object.entries(plan.customers)) {
      // The live seed credits through the same API, so the seeded balance shows quirk Q2 too.
      if (c.walletCredit) this.credit(this.handles.customers.get(h)!, c.walletCredit, plan.currency, "seed: starting credit");
    }
  }

  /** The seed manifest a live seed would have written (handles -> fixture ids). */
  seedManifest(): SeedManifest {
    const plan = this.plan;
    const customers: SeedManifest["customers"] = {};
    for (const [h, c] of Object.entries(plan.customers)) {
      customers[h] = { customerId: this.handles.customers.get(h)!, email: seedEmail(h), companyDomain: c.companyDomain };
    }
    const products: SeedManifest["products"] = {};
    for (const [h, p] of Object.entries(plan.products)) products[h] = { productId: this.handles.products.get(h)!, price: p.price, currency: plan.currency };
    const payments: SeedManifest["payments"] = {};
    for (const p of plannedPayments(plan)) {
      payments[p.handle] = { paymentId: this.handles.payments.get(p.handle)!, customerHandle: p.customer, amount: p.amount, currency: plan.currency, status: "succeeded" };
    }
    const subscriptions: SeedManifest["subscriptions"] = {};
    for (const [h, c] of Object.entries(plan.customers)) {
      subscriptions[h] = { subscriptionId: this.handles.subscriptions.get(h)!, customerHandle: h, productHandle: c.plan };
    }
    const probe = probeHandles(plan);
    for (const h of probe.extraSubscriptionPayments) {
      subscriptions[h] = { subscriptionId: this.handles.subscriptions.get(h)!, customerHandle: probe.customer, productHandle: plan.customers[probe.customer]!.plan };
    }
    const wallets: NonNullable<SeedManifest["wallets"]> = {};
    for (const [h, c] of Object.entries(plan.customers)) if (c.walletCredit) wallets[h] = { currency: plan.currency, seededCredit: c.walletCredit };
    return {
      createdAt: new Date(Date.UTC(2026, 8, 1)).toISOString(),
      mode: "live",
      cassette: "demo-fixture-seed",
      customers,
      products,
      payments,
      subscriptions,
      wallets,
    };
  }

  // ---- state helpers ------------------------------------------------------------------------

  addRefund(pay: FxPayment, amount: number, reason: string | null): FxRefund {
    const r: FxRefund = {
      refund_id: this.nextId("rfd_fx"),
      payment_id: pay.payment_id,
      customer_id: pay.customer_id,
      amount,
      currency: pay.currency,
      status: "succeeded",
      is_partial: amount < pay.total_amount,
      reason,
      created_at: this.tick(),
    };
    this.refunds.push(r);
    return r;
  }

  wallet(customerId: string, currency: string): FxWallet {
    let w = this.wallets.find((x) => x.customer_id === customerId && x.currency === currency);
    if (!w) {
      const at = this.tick();
      w = { customer_id: customerId, currency, balance: 0, created_at: at, updated_at: at };
      this.wallets.push(w);
    }
    return w;
  }

  /** A wallet credit as the fixture API applies it (PLANTED QUIRK Q2: amount read in major units). */
  credit(customerId: string, amount: number, currency: string, reason: string | null): FxWallet {
    const w = this.wallet(customerId, currency);
    const delta = amount * 100;
    const before = w.balance;
    w.balance += delta;
    w.updated_at = this.tick();
    this.ledger.push({
      id: this.nextId("wle_fx"),
      customer_id: customerId,
      currency,
      amount: delta,
      is_credit: true,
      event_type: "manual_credit",
      before_balance: before,
      after_balance: w.balance,
      reason,
      created_at: w.updated_at,
    });
    return w;
  }

  refundedTotal(paymentId: string): number {
    return this.refunds.filter((r) => r.payment_id === paymentId).reduce((s, r) => s + r.amount, 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Request plumbing

function paging(q: URLSearchParams, quirkClamp: boolean): { size: number; page: number } | HttpAnswer {
  const rawSize = q.get("page_size");
  const rawPage = q.get("page_number");
  const size = rawSize === null ? 10 : Number(rawSize);
  const page = rawPage === null ? 0 : Number(rawPage);
  if (!Number.isInteger(size) || size < 1) return fail(422, "INVALID_REQUEST", "page_size must be a positive integer");
  if (!Number.isInteger(page) || page < 0) return fail(422, "INVALID_REQUEST", "page_number must be a non-negative integer");
  if (size > DOC_MAX_PAGE) {
    // PLANTED FIXTURE QUIRK Q1 (payments, refunds): silently clamp instead of rejecting.
    if (quirkClamp) return { size: DOC_MAX_PAGE, page };
    return fail(422, "INVALID_REQUEST", `page_size must be at most ${DOC_MAX_PAGE}`);
  }
  return { size, page };
}

function pageOf<T>(items: T[], p: { size: number; page: number }): T[] {
  return items.slice(p.page * p.size, p.page * p.size + p.size);
}

const newestFirst = <T extends { created_at: string }>(a: T, b: T): number => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export interface FixtureTransportStats {
  /** Requests served by the fixture (both hosts). */
  served: number;
  /** Requests to any other host: refused, never sent anywhere. */
  refused: string[];
  /** Fixture-host requests to a route the fixture does not simulate (answered 404). */
  unknownRoutes: string[];
  byHost: Record<string, number>;
}

export class FixtureTransportRefusal extends Error {
  constructor(url: string) {
    super(`fixture transport refused a non-fixture call: ${url} (notary demo --fixture never reaches the network)`);
    this.name = "FixtureTransportRefusal";
  }
}

export interface FixtureApiOptions {
  /** Delay before a full refund answers (PLANTED QUIRK Q5). Must exceed the executor's 200 ms client timeout. */
  slowFullRefundMs?: number;
}

/**
 * The fixture API as a fetch-compatible transport. `world()` is read per request, so the demo can
 * re-seed between runs.
 */
export class FixtureApi {
  readonly stats: FixtureTransportStats = { served: 0, refused: [], unknownRoutes: [], byHost: {} };
  private readonly slowFullRefundMs: number;

  constructor(
    private readonly world: () => FixtureWorld,
    opts: FixtureApiOptions = {},
  ) {
    this.slowFullRefundMs = opts.slowFullRefundMs ?? 500;
  }

  readonly fetch: FetchLike = async (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      this.stats.refused.push(String(input));
      throw new FixtureTransportRefusal(String(input));
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== FIXTURE_HOSTS.crustdata && host !== FIXTURE_HOSTS.dodo)) {
      this.stats.refused.push(`${url.protocol}//${host}${url.pathname}`);
      throw new FixtureTransportRefusal(`${url.protocol}//${host}${url.pathname}`);
    }
    this.stats.served += 1;
    this.stats.byHost[host] = (this.stats.byHost[host] ?? 0) + 1;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let body: unknown = undefined;
    if (typeof init.body === "string" && init.body.length) {
      try {
        body = JSON.parse(init.body);
      } catch {
        return this.respond(answer(400, { code: "INVALID_JSON", message: "body is not JSON" }));
      }
    }
    if (!(headers.get("authorization") ?? "").startsWith("Bearer ")) {
      return this.respond(answer(401, { code: "UNAUTHORIZED", message: "missing bearer token" }));
    }
    const out = host === FIXTURE_HOSTS.crustdata ? this.crustdata(method, url, body) : await this.dodo(method, url, body);
    if (out.status === 404 && isRecord(out.body) && out.body.code === "FIXTURE_ROUTE_UNKNOWN") this.stats.unknownRoutes.push(`${method} ${url.pathname}`);
    return this.respond(out);
  };

  private respond(a: HttpAnswer): Response {
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json", ...a.headers } });
  }

  // ---- Crustdata ----------------------------------------------------------------------------

  private crustdata(method: string, url: URL, body: unknown): HttpAnswer {
    const w = this.world();
    const path = url.pathname;
    if (method === "GET" && path === "/account/credits") {
      return answer(200, { account: { credits: 10_000 - w.crustdataCreditsUsed + 0.5, recurring_credits: 10_000, recurring_credits_frequency: "monthly" } }, { "x-credits-used": "0" });
    }
    if (method === "POST" && (path === "/company/enrich" || path === "/company/identify")) {
      const enrich = path === "/company/enrich";
      if (!isRecord(body)) return answer(400, { error: "Body must be a JSON object" });
      const domains = body.domains;
      if (!Array.isArray(domains) || domains.length === 0 || !domains.every((d) => typeof d === "string")) {
        return answer(400, { error: "The fixture simulates domain identifiers only" });
      }
      if (!enrich && domains.length > 25) return answer(400, { error: "domains may contain 1 to 25 values" });
      const allowed = enrich ? new Set(["basic_info", "headcount", "funding", "hiring", "people", "technographics"]) : new Set(["crustdata_company_id", "basic_info", "social_profiles"]);
      const fields = Array.isArray(body.fields) ? (body.fields as unknown[]).map(String) : ["basic_info"];
      if (fields.some((f) => !allowed.has(f))) return answer(400, { error: "Invalid fields" });
      let charged = 0;
      const results = (domains as string[]).map((d) => {
        const key = d.trim().toLowerCase();
        const c = FIXTURE_COMPANIES[key];
        if (!c) return { matched_on: d, match_type: "domain", matches: [] };
        if (enrich) charged += 2 + (fields.includes("technographics") ? 2 : 0);
        const data: Record<string, unknown> = { crustdata_company_id: c.id };
        if (fields.includes("basic_info")) {
          data.basic_info = { name: c.name, primary_domain: key, website: `https://${key}`, employee_count_range: employeeRange(c.headcount), year_founded: c.yearFounded };
        }
        if (enrich && fields.includes("headcount")) data.headcount = { total: c.headcount };
        if (enrich && fields.includes("funding")) {
          data.funding = { total_investment_usd: c.fundingUsd, last_round_type: c.lastRound, last_fundraise_date: c.lastFundraiseDate };
        }
        return { matched_on: d, match_type: "domain", matches: [{ confidence_score: 1, company_data: data }] };
      });
      w.crustdataCreditsUsed += charged;
      return answer(200, results, { "x-credits-used": String(charged) });
    }
    return fail(404, "FIXTURE_ROUTE_UNKNOWN", `${method} ${path} is not simulated`);
  }

  // ---- Dodo -----------------------------------------------------------------------------------

  private async dodo(method: string, url: URL, body: unknown): Promise<HttpAnswer> {
    const w = this.world();
    const path = url.pathname.replace(/\/+$/, "");
    const q = url.searchParams;
    let m: RegExpExecArray | null;

    // customers
    if (path === "/customers" && method === "POST") return this.createCustomer(w, body);
    if (path === "/customers" && method === "GET") {
      const p = paging(q, false);
      if (p instanceof HttpAnswer) return p;
      const email = q.get("email");
      const name = q.get("name");
      const items = [...w.customers.values()]
        .filter((c) => (email === null || c.email === email) && (name === null || c.name === name))
        .sort(newestFirst)
        .map((c) => this.customerOut(c));
      return answer(200, { items: pageOf(items, p) });
    }
    if ((m = /^\/customers\/([^/]+)\/wallets$/.exec(path)) && method === "GET") {
      const cid = decodeURIComponent(m[1]!);
      if (!w.customers.has(cid)) return fail(404, "NOT_FOUND", "customer not found");
      const items = w.wallets.filter((x) => x.customer_id === cid).map((x) => ({ ...x }));
      const total = items.reduce((s, x) => s + (x.currency === "USD" ? x.balance : x.currency === "EUR" ? Math.floor(x.balance * EUR_TO_USD) : 0), 0);
      return answer(200, { items, total_balance_usd: total });
    }
    if ((m = /^\/customers\/([^/]+)\/wallets\/ledger-entries$/.exec(path))) {
      const cid = decodeURIComponent(m[1]!);
      if (!w.customers.has(cid)) return fail(404, "NOT_FOUND", "customer not found");
      if (method === "POST") return this.ledgerEntry(w, cid, body);
      if (method === "GET") {
        const p = paging(q, false);
        if (p instanceof HttpAnswer) return p;
        const currency = q.get("currency");
        const items = w.ledger.filter((e) => e.customer_id === cid && (currency === null || e.currency === currency)).sort(newestFirst).map((e) => ({ ...e }));
        return answer(200, { items: pageOf(items, p) });
      }
    }

    // products
    if (path === "/products" && method === "POST") return this.createProduct(w, body);

    // payments
    if (path === "/payments" && method === "POST") return this.createPayment(w, body);
    if (path === "/checkouts" && method === "POST") {
      return answer(200, { session_id: w.nextId("cks_fx"), checkout_url: "https://checkout.fixture.invalid/session", payment_id: null });
    }
    if (path === "/payments" && method === "GET") {
      const p = paging(q, true);
      if (p instanceof HttpAnswer) return p;
      const cid = q.get("customer_id");
      const status = q.get("status");
      const items = [...w.payments.values()]
        .filter((x) => (cid === null || x.customer_id === cid) && (status === null || x.status === status))
        .sort(newestFirst)
        .map((x) => this.paymentListItem(w, x));
      return answer(200, { items: pageOf(items, p) });
    }
    if ((m = /^\/payments\/([^/]+)$/.exec(path)) && method === "GET") {
      const pay = w.payments.get(decodeURIComponent(m[1]!));
      if (!pay) return fail(404, "NOT_FOUND", "payment not found");
      return answer(200, this.paymentOut(w, pay));
    }

    // refunds
    if (path === "/refunds" && method === "POST") return this.createRefund(w, body);
    if (path === "/refunds" && method === "GET") {
      const p = paging(q, true);
      if (p instanceof HttpAnswer) return p;
      const cid = q.get("customer_id");
      const status = q.get("status");
      const items = w.refunds
        .filter((r) => (cid === null || r.customer_id === cid) && (status === null || r.status === status))
        .sort(newestFirst)
        .map((r) => this.refundListItem(r));
      return answer(200, { items: pageOf(items, p) });
    }
    if ((m = /^\/refunds\/([^/]+)$/.exec(path)) && method === "GET") {
      const r = w.refunds.find((x) => x.refund_id === decodeURIComponent(m![1]!));
      if (!r) return fail(404, "NOT_FOUND", "refund not found");
      return answer(200, this.refundOut(w, r));
    }

    // subscriptions
    if ((m = /^\/subscriptions\/([^/]+)$/.exec(path)) && method === "GET") {
      const s = w.subscriptions.get(decodeURIComponent(m[1]!));
      if (!s) return fail(404, "NOT_FOUND", "subscription not found");
      return answer(200, this.subscriptionOut(w, s));
    }
    if ((m = /^\/subscriptions\/([^/]+)\/change-plan$/.exec(path)) && method === "POST") {
      const s = w.subscriptions.get(decodeURIComponent(m[1]!));
      if (!s) return fail(404, "NOT_FOUND", "subscription not found");
      return this.changePlan(w, s, body);
    }

    return fail(404, "FIXTURE_ROUTE_UNKNOWN", `${method} ${path} is not simulated`);
  }

  private customerOut(c: FxCustomer): Record<string, unknown> {
    return { customer_id: c.customer_id, business_id: BUSINESS_ID, name: c.name, email: c.email, phone_number: c.phone_number, created_at: c.created_at };
  }

  private createCustomer(w: FixtureWorld, body: unknown): HttpAnswer {
    if (!isRecord(body) || typeof body.name !== "string" || !body.name.trim()) return fail(422, "INVALID_REQUEST", "name is required");
    if (typeof body.email !== "string" || !body.email.includes("@")) return fail(422, "INVALID_REQUEST", "email is required"); // control
    const c: FxCustomer = { customer_id: w.nextId("cus_fx_n"), name: body.name, email: body.email, phone_number: null, created_at: w.tick() };
    w.customers.set(c.customer_id, c);
    return answer(200, this.customerOut(c));
  }

  private createProduct(w: FixtureWorld, body: unknown): HttpAnswer {
    if (!isRecord(body) || typeof body.name !== "string" || typeof body.tax_category !== "string" || !isRecord(body.price)) {
      return fail(422, "INVALID_REQUEST", "name, tax_category and price are required");
    }
    const price = body.price;
    if (!isPositiveInt(price.price) || typeof price.currency !== "string") return fail(422, "INVALID_REQUEST", "price.price must be a positive integer (smallest unit)");
    const p: FxProduct = {
      product_id: w.nextId("prod_fx_n"),
      name: body.name,
      tax_category: body.tax_category,
      is_recurring: price.type === "recurring_price",
      price: { ...price, price: price.price, currency: price.currency }, // control: echoed in minor units
      created_at: w.tick(),
    };
    w.products.set(p.product_id, p);
    return answer(200, { product_id: p.product_id, business_id: BUSINESS_ID, name: p.name, tax_category: p.tax_category, is_recurring: p.is_recurring, price: p.price, created_at: p.created_at });
  }

  private createPayment(w: FixtureWorld, body: unknown): HttpAnswer {
    if (!isRecord(body) || !Array.isArray(body.product_cart) || body.product_cart.length === 0 || !isRecord(body.customer)) {
      return fail(422, "INVALID_REQUEST", "product_cart and customer are required");
    }
    const line = body.product_cart[0] as Record<string, unknown>;
    const product = typeof line?.product_id === "string" ? w.products.get(line.product_id) : undefined;
    if (!product) return fail(422, "INVALID_REQUEST", "unknown product");
    const quantity = isPositiveInt(line.quantity) ? line.quantity : 1;
    let customerId: string;
    if (typeof body.customer.customer_id === "string") {
      if (!w.customers.has(body.customer.customer_id)) return fail(404, "NOT_FOUND", "customer not found");
      customerId = body.customer.customer_id;
    } else if (typeof body.customer.email === "string") {
      const name = typeof body.customer.name === "string" ? body.customer.name : body.customer.email;
      const c: FxCustomer = { customer_id: w.nextId("cus_fx_n"), name, email: body.customer.email, phone_number: null, created_at: w.tick() };
      w.customers.set(c.customer_id, c);
      customerId = c.customer_id;
    } else return fail(422, "INVALID_REQUEST", "customer needs customer_id or email");
    const id = w.nextId("pay_fx_n");
    const pay: FxPayment = {
      payment_id: id,
      customer_id: customerId,
      product_id: product.product_id,
      quantity,
      total_amount: product.price.price * quantity,
      currency: product.price.currency,
      status: "requires_payment_method",
      created_at: w.tick(),
      payment_link: body.payment_link === true ? `https://checkout.fixture.invalid/${id}` : null,
    };
    w.payments.set(id, pay);
    const c = w.customers.get(customerId)!;
    return answer(200, { payment_id: id, total_amount: pay.total_amount, payment_link: pay.payment_link, customer: { customer_id: c.customer_id, name: c.name, email: c.email }, metadata: {} });
  }

  private refundListItem(r: FxRefund): Record<string, unknown> {
    return {
      refund_id: r.refund_id,
      payment_id: r.payment_id,
      business_id: BUSINESS_ID,
      status: r.status,
      created_at: r.created_at,
      is_partial: r.is_partial,
      amount: r.amount,
      currency: r.currency,
      reason: r.reason,
    };
  }

  private refundOut(w: FixtureWorld, r: FxRefund): Record<string, unknown> {
    const c = w.customers.get(r.customer_id);
    return { ...this.refundListItem(r), customer: { customer_id: r.customer_id, name: c?.name ?? null, email: c?.email ?? null } };
  }

  private refundStatus(w: FixtureWorld, pay: FxPayment): "full" | "partial" | null {
    const refunded = w.refundedTotal(pay.payment_id);
    if (refunded <= 0) return null;
    return refunded >= pay.total_amount ? "full" : "partial";
  }

  private paymentListItem(w: FixtureWorld, pay: FxPayment): Record<string, unknown> {
    const c = w.customers.get(pay.customer_id);
    return {
      payment_id: pay.payment_id,
      total_amount: pay.total_amount,
      currency: pay.currency,
      status: pay.status,
      created_at: pay.created_at,
      refund_status: this.refundStatus(w, pay),
      customer: { customer_id: pay.customer_id, name: c?.name ?? null, email: c?.email ?? null },
    };
  }

  private paymentOut(w: FixtureWorld, pay: FxPayment): Record<string, unknown> {
    const c = w.customers.get(pay.customer_id);
    return {
      payment_id: pay.payment_id,
      business_id: BUSINESS_ID,
      status: pay.status,
      total_amount: pay.total_amount,
      currency: pay.currency,
      created_at: pay.created_at,
      payment_link: pay.payment_link,
      customer: { customer_id: pay.customer_id, name: c?.name ?? null, email: c?.email ?? null },
      product_cart: [{ product_id: pay.product_id, quantity: pay.quantity }],
      // Control: refunds[] is always present.
      refunds: w.refunds.filter((r) => r.payment_id === pay.payment_id).sort(newestFirst).map((r) => this.refundListItem(r)),
      metadata: {},
    };
  }

  private async createRefund(w: FixtureWorld, body: unknown): Promise<HttpAnswer> {
    if (!isRecord(body) || typeof body.payment_id !== "string") return fail(422, "INVALID_REQUEST", "payment_id is required");
    const pay = w.payments.get(body.payment_id);
    if (!pay) return fail(404, "NOT_FOUND", "payment not found");
    if (pay.status !== "succeeded") return fail(400, "PAYMENT_NOT_SUCCEEDED", "only succeeded payments can be refunded");
    const reason = typeof body.reason === "string" ? body.reason : null;
    const items = Array.isArray(body.items) ? (body.items as unknown[]) : [];
    if (items.length > 0) {
      const item = items[0];
      if (!isRecord(item) || item.item_id !== pay.product_id) return fail(422, "INVALID_REQUEST", "items[0].item_id must be a product on the payment");
      const linePrice = Math.floor(pay.total_amount / pay.quantity);
      let amount = linePrice;
      if (item.amount !== undefined && item.amount !== null) {
        if (!isPositiveInt(item.amount)) return fail(422, "INVALID_REQUEST", "items[].amount must be a positive integer");
        // PLANTED FIXTURE QUIRK Q4: read in MAJOR units, silently capped at the line price.
        amount = Math.min(item.amount * 100, linePrice);
      }
      const r = w.addRefund(pay, amount, reason);
      return answer(200, this.refundOut(w, r));
    }
    // PLANTED FIXTURE QUIRK Q5: slow, and no check that the payment is already refunded.
    if (this.slowFullRefundMs > 0) await new Promise((res) => setTimeout(res, this.slowFullRefundMs));
    const r = w.addRefund(pay, pay.total_amount, reason);
    return answer(200, this.refundOut(w, r));
  }

  private subscriptionOut(w: FixtureWorld, s: FxSubscription): Record<string, unknown> {
    const product = w.products.get(s.product_id);
    return {
      subscription_id: s.subscription_id,
      customer: { customer_id: s.customer_id },
      status: s.status,
      product_id: s.product_id,
      quantity: s.quantity,
      recurring_pre_tax_amount: product?.price.price ?? 0,
      currency: product?.price.currency ?? CURRENCY,
      created_at: s.created_at,
      previous_billing_date: "2026-09-01T00:00:00.000Z",
      next_billing_date: "2026-11-01T00:00:00.000Z",
      scheduled_change: s.scheduled_change,
    };
  }

  private changePlan(w: FixtureWorld, s: FxSubscription, body: unknown): HttpAnswer {
    if (!isRecord(body) || typeof body.product_id !== "string" || typeof body.proration_billing_mode !== "string") {
      return fail(422, "INVALID_REQUEST", "product_id, quantity and proration_billing_mode are required");
    }
    if (!w.products.has(body.product_id)) return fail(404, "NOT_FOUND", "product not found");
    if (s.scheduled_change) return fail(409, "PendingPlanChangeExists", "A pending plan change already exists for this subscription"); // control
    if (body.effective_at === "next_billing_date") {
      s.scheduled_change = { product_id: body.product_id, effective_at: "2026-11-01T00:00:00.000Z" };
    } else {
      s.product_id = body.product_id;
      if (isPositiveInt(body.quantity)) s.quantity = body.quantity;
    }
    return answer(200, { payment_id: null, payment_link: null });
  }

  private ledgerEntry(w: FixtureWorld, cid: string, body: unknown): HttpAnswer {
    if (!isRecord(body)) return fail(422, "INVALID_REQUEST", "body required");
    if (!isPositiveInt(body.amount)) return fail(422, "INVALID_REQUEST", "amount must be a positive integer");
    if (typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency)) return fail(422, "INVALID_REQUEST", "currency must be an ISO code");
    if (body.entry_type !== "credit" && body.entry_type !== "debit") return fail(422, "INVALID_REQUEST", "entry_type must be credit or debit");
    const reason = typeof body.reason === "string" ? body.reason : null;
    // PLANTED FIXTURE QUIRK Q3: idempotency_key is accepted but ignored (no dedup).
    if (body.entry_type === "debit") {
      const wal = w.wallet(cid, body.currency);
      const delta = body.amount * 100; // Q2 applies to debits too
      if (delta > wal.balance) return fail(400, "INSUFFICIENT_BALANCE", "A debit larger than the balance is refused"); // control
      const before = wal.balance;
      wal.balance -= delta;
      wal.updated_at = w.tick();
      w.ledger.push({ id: w.nextId("wle_fx"), customer_id: cid, currency: body.currency, amount: delta, is_credit: false, event_type: "manual_debit", before_balance: before, after_balance: wal.balance, reason, created_at: wal.updated_at });
      return answer(200, { ...wal });
    }
    const wal = w.credit(cid, body.amount, body.currency, reason); // Q2
    return answer(200, { ...wal });
  }
}
