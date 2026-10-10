/**
 * Seed the Dodo TEST-MODE world that fixtures/queue/seeded.json refers to, recording every
 * exchange into the "seed-dodo" cassette, then write fixtures/seed/manifest.json.
 *
 *   pnpm --filter @notary/core seed:dodo --plan     print what would be created; no network, no keys
 *   pnpm --filter @notary/core seed:dodo            live seed (needs DODO_PAYMENTS_API_KEY, NOTARY_MODE=test)
 *   ... --force                                     overwrite an existing manifest
 *   ... --wait-minutes <n>                          how long to wait for the human checkouts (default 30)
 *
 * How payments get created (Dodo docs, read Oct 10 2026; nothing below is confirmed on the wire):
 * - The testing guide documents no API-only way to complete a payment: test payments are completed
 *   on a hosted checkout with a test card (4242 4242 4242 4242, 06/32, CVV 123). So each customer
 *   completes ONE subscription checkout in a browser; the script prints the URLs and polls
 *   listPayments until each succeeds.
 * - Every other payment (add-ons, onboarding, the 105 top-ups for the >1-page customer) is created
 *   headlessly with POST /checkouts {confirm: true, payment_method_id, customer: {customer_id}}.
 *   The docs say payment_method_id is "Only allowed when confirm is true" and needs an existing
 *   customer; GET /payments/{id} returns the `payment_method_id` saved by the first checkout.
 *   Whether a confirm:true session charges without customer action is NOT stated; if it doesn't,
 *   the script stops with the API's own answer and writes no manifest.
 * - The documented alternative for many charges is an on-demand subscription (mandate_only) plus
 *   POST /subscriptions/{id}/charge. That op is not in createTools' surface (src/tools), so it is
 *   not used here.
 *
 * Test-mode lock: all calls go through createTools(), which refuses to start unless
 * NOTARY_MODE=test and the base URL is https://test.dodopayments.com.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MANIFEST_PATH } from "../src/queue/manifest.js";
import type { SeedManifest } from "../src/queue/manifest.js";
import {
  DODO_MAX_PAGE_SIZE,
  SEED_PLAN,
  plannedPayments,
  probeHandles,
  probeSeedCost,
  refundedPaymentHandles,
  seedEmail,
  seedSteps,
  subscriptionPaymentHandle,
} from "../src/queue/seed-plan.js";
import type { SeedPlan } from "../src/queue/seed-plan.js";
import { MissingCredentialError, TestModeLockError, createTools } from "../src/tools/index.js";
import type { DodoTools, Payment, PaymentListItem } from "../src/tools/index.js";

export { SEED_PLAN };

const CASSETTE = "seed-dodo";
/** Stay under Dodo's documented 240 requests/min sustained limit. */
const MIN_MS_BETWEEN_CALLS = 300;

interface Args {
  plan: boolean;
  force: boolean;
  waitMinutes: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { plan: false, force: false, waitMinutes: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--plan") args.plan = true;
    else if (a === "--force") args.force = true;
    else if (a === "--wait-minutes") args.waitMinutes = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.waitMinutes) || args.waitMinutes <= 0) throw new Error("--wait-minutes must be a positive number");
  return args;
}

export function formatPlan(plan: SeedPlan = SEED_PLAN): string {
  const steps = seedSteps(plan);
  const payments = plannedPayments(plan);
  const bulkCount = payments.filter((p) => p.customer === plan.bulk.customer).length;
  const lines: string[] = [];
  lines.push(`Seed plan (Dodo TEST mode, cassette "${CASSETTE}", currency ${plan.currency}, amounts in minor units)`);
  lines.push("");
  for (const s of steps) lines.push(`${s.kind === "human" ? "HUMAN" : "  api"}  ${s.op.padEnd(30)} ${s.handle.padEnd(32)} ${s.detail}`);
  lines.push("");
  lines.push(`products ${Object.keys(plan.products).length}, customers ${Object.keys(plan.customers).length}, payments ${payments.length}`);
  lines.push(
    `bulk customer cust:${plan.bulk.customer}: ${bulkCount} payments > page_size max ${DODO_MAX_PAGE_SIZE}` +
      ` (needs ${Math.ceil(bulkCount / DODO_MAX_PAGE_SIZE)} pages)`,
  );
  lines.push(`pre-existing refunds: ${plan.existingRefunds.map((h) => `pay:${h}`).join(", ")}`);
  const probe = probeHandles(plan);
  const cost = probeSeedCost(plan);
  lines.push(
    `PROBE-ONLY customer cust:${cost.customer} (never referenced by fixtures/queue/seeded.json): ${cost.payments} payments` +
      ` (${cost.humanCheckouts} hosted checkout, ${cost.headlessPayments} headless), ${cost.refunds} refunds, ${cost.subscriptions} subscriptions`,
  );
  lines.push(
    `  added cost (Dodo TEST mode, no real money): ${cost.chargedMinor} ${plan.currency} minor units charged, ${cost.refundedMinor} refunded by the seed;` +
      ` ${probe.openPayments.length} open payments left for refund probes, ${probe.refundedPayments.length} refunded for refund-list probes`,
  );
  lines.push(`write calls ${steps.filter((s) => s.kind === "api" && !s.op.startsWith("dodo.list") && !s.op.startsWith("dodo.get")).length},` +
    ` human checkouts ${steps.filter((s) => s.kind === "human").length} (plus polling reads)`);
  lines.push(`manifest -> ${DEFAULT_MANIFEST_PATH}`);
  return lines.join("\n");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function loadRootEnv(): void {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

class Throttle {
  private last = 0;
  async wait(): Promise<void> {
    const gap = Date.now() - this.last;
    if (gap < MIN_MS_BETWEEN_CALLS) await sleep(MIN_MS_BETWEEN_CALLS - gap);
    this.last = Date.now();
  }
}

/** Every payment of a customer, paging until an EMPTY page (a short page is not proof of the end). */
async function allPayments(dodo: DodoTools, throttle: Throttle, customerId: string) {
  const out: PaymentListItem[] = [];
  for (let page = 0; ; page++) {
    await throttle.wait();
    const { data } = await dodo.listPayments({ customer_id: customerId, page_size: DODO_MAX_PAGE_SIZE, page_number: page });
    if (data.items.length === 0) break;
    out.push(...data.items);
    if (page > 50) throw new Error("listPayments: more than 50 pages; refusing to continue");
  }
  return out;
}

async function seed(plan: SeedPlan, waitMinutes: number): Promise<SeedManifest> {
  const tools = createTools({ mode: "live", cassette: CASSETTE }); // TestModeLockError unless test mode
  const dodo = tools.dodo;
  const throttle = new Throttle();
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    await throttle.wait();
    return fn();
  };

  const manifest: SeedManifest = {
    createdAt: new Date().toISOString(),
    mode: "live",
    cassette: CASSETTE,
    customers: {},
    products: {},
    payments: {},
    subscriptions: {},
    wallets: {},
  };

  // 1. Products
  for (const [h, p] of Object.entries(plan.products)) {
    const price =
      p.kind === "recurring"
        ? {
            type: "recurring_price" as const,
            price: p.price,
            currency: plan.currency,
            discount_bps: 0,
            purchasing_power_parity: false,
            payment_frequency_count: 1,
            payment_frequency_interval: "Month" as const,
            subscription_period_count: 1,
            subscription_period_interval: "Year" as const,
          }
        : { type: "one_time_price" as const, price: p.price, currency: plan.currency, discount_bps: 0, purchasing_power_parity: false };
    const { data } = await call(() =>
      dodo.createProduct({ name: p.name, tax_category: "saas", price, metadata: { notary_seed: true, handle: h } }),
    );
    manifest.products[h] = { productId: data.product_id, price: p.price, currency: plan.currency };
    console.log(`product  prod:${h} -> ${data.product_id}`);
  }

  // 2. Customers
  for (const [h, c] of Object.entries(plan.customers)) {
    const email = seedEmail(h);
    const { data } = await call(() =>
      dodo.createCustomer({ name: c.name, email, metadata: { notary_seed: true, handle: h, company_domain: c.companyDomain } }),
    );
    manifest.customers[h] = { customerId: data.customer_id, email, companyDomain: c.companyDomain };
    console.log(`customer cust:${h} -> ${data.customer_id}`);
  }

  // 3. One hosted subscription checkout per customer (a human completes each with a test card)
  const sessions: Record<string, { sessionId: string; url: string }> = {};
  for (const [h, c] of Object.entries(plan.customers)) {
    const { data } = await call(() =>
      dodo.createCheckoutSession({
        product_cart: [{ product_id: manifest.products[c.plan]!.productId, quantity: 1 }],
        customer: { customer_id: manifest.customers[h]!.customerId },
        billing_address: { country: plan.billingCountry },
        metadata: { notary_seed: true, handle: subscriptionPaymentHandle(h, c.plan) },
      }),
    );
    if (!data.checkout_url) throw new Error(`createCheckoutSession for ${h} returned no checkout_url: ${JSON.stringify(data)}`);
    sessions[h] = { sessionId: data.session_id, url: data.checkout_url };
  }
  console.log("\nHUMAN STEP: open each URL and pay with Dodo test card 4242 4242 4242 4242, expiry 06/32, CVV 123.");
  for (const [h, s] of Object.entries(sessions)) console.log(`  ${h.padEnd(16)} ${s.url}`);
  console.log(`Waiting up to ${waitMinutes} min for all ${Object.keys(sessions).length} checkouts...\n`);

  // 4. Poll until each customer's subscription payment has succeeded
  const firstPayment: Record<string, Payment> = {};
  const deadline = Date.now() + waitMinutes * 60_000;
  while (Object.keys(firstPayment).length < Object.keys(sessions).length) {
    if (Date.now() > deadline) {
      const missing = Object.keys(sessions).filter((h) => !firstPayment[h]);
      throw new Error(`Timed out waiting for checkouts: ${missing.join(", ")}. No manifest written.`);
    }
    for (const h of Object.keys(sessions)) {
      if (firstPayment[h]) continue;
      const items = await allPayments(dodo, throttle, manifest.customers[h]!.customerId);
      for (const item of items) {
        if (item.status !== "succeeded") continue;
        const { data: payment } = await call(() => dodo.getPayment(item.payment_id));
        if (payment.checkout_session_id === sessions[h]!.sessionId || items.length === 1) {
          firstPayment[h] = payment;
          console.log(`paid     cust:${h} payment ${payment.payment_id} status ${payment.status}`);
          break;
        }
      }
    }
    if (Object.keys(firstPayment).length < Object.keys(sessions).length) await sleep(10_000);
  }

  // Record subscription payments + subscriptions
  for (const [h, c] of Object.entries(plan.customers)) {
    const p = firstPayment[h]!;
    manifest.payments[subscriptionPaymentHandle(h, c.plan)] = {
      paymentId: p.payment_id,
      customerHandle: h,
      amount: p.total_amount,
      currency: p.currency,
      status: String(p.status),
    };
    const subscriptionId = typeof p.subscription_id === "string" ? p.subscription_id : null;
    if (!subscriptionId) throw new Error(`Payment ${p.payment_id} for ${h} carries no subscription_id; cannot seed sub:${h}`);
    manifest.subscriptions[h] = { subscriptionId, customerHandle: h, productHandle: c.plan };
  }

  // 5. Headless payments with the saved payment method (add-ons, onboarding, bulk top-ups, probe-only payments)
  const extraSubs = new Set(probeHandles(plan).extraSubscriptionPayments);
  for (const p of plannedPayments(plan).filter((x) => x.via === "headless")) {
    const first = firstPayment[p.customer]!;
    const paymentMethodId = typeof first.payment_method_id === "string" ? first.payment_method_id : null;
    if (!paymentMethodId) {
      throw new Error(
        `Payment ${first.payment_id} (${p.customer}) has no payment_method_id, so headless confirm:true checkouts are impossible. ` +
          "No manifest written. Alternative: on-demand subscription + POST /subscriptions/{id}/charge (op not in src/tools).",
      );
    }
    const { data } = await call(() =>
      dodo.createCheckoutSession({
        product_cart: [{ product_id: manifest.products[p.product]!.productId, quantity: 1 }],
        customer: { customer_id: manifest.customers[p.customer]!.customerId },
        billing_address: { country: plan.billingCountry },
        confirm: true,
        payment_method_id: paymentMethodId,
        metadata: { notary_seed: true, handle: p.handle },
      }),
    );
    if (!data.payment_id) throw new Error(`confirm:true checkout for ${p.handle} returned no payment_id: ${JSON.stringify(data)}`);
    let payment: Payment | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await call(() => dodo.getPayment(data.payment_id!));
      payment = res.data;
      if (payment.status === "succeeded" || payment.status === "failed" || payment.status === "cancelled") break;
      await sleep(2_000);
    }
    if (payment?.status !== "succeeded") {
      throw new Error(`Headless payment ${data.payment_id} (${p.handle}) ended as ${payment?.status ?? "unknown"}; no manifest written`);
    }
    manifest.payments[p.handle] = {
      paymentId: payment.payment_id,
      customerHandle: p.customer,
      amount: payment.total_amount,
      currency: payment.currency,
      status: String(payment.status),
    };
    console.log(`paid     pay:${p.handle} -> ${payment.payment_id} (${payment.total_amount})`);
    // PROBE-ONLY extra subscriptions: a headless checkout of a recurring product. Whether Dodo turns it
    // into a subscription is not documented; if no subscription_id comes back, the change-plan probes
    // simply have fewer subscriptions (they skip with a reason). The queue never uses these.
    if (extraSubs.has(p.handle)) {
      const subscriptionId = typeof payment.subscription_id === "string" ? payment.subscription_id : null;
      if (subscriptionId) manifest.subscriptions[p.handle] = { subscriptionId, customerHandle: p.customer, productHandle: p.product };
      else console.warn(`warning: probe-only payment ${p.handle} carries no subscription_id; not recorded as a subscription`);
    }
  }

  // 6. Verify subscriptions
  for (const [h, s] of Object.entries(manifest.subscriptions)) {
    const { data } = await call(() => dodo.getSubscription(s.subscriptionId));
    console.log(`sub      sub:${h} -> ${data.subscription_id} status ${data.status}`);
  }

  // 7. Pre-existing refunds (the queue's trap case) and the probe-only refunded set (refund-list probes)
  for (const h of refundedPaymentHandles(plan)) {
    const pay = manifest.payments[h];
    if (!pay) throw new Error(`existingRefunds: no seeded payment ${h}`);
    const { data } = await call(() =>
      dodo.createRefund({
        payment_id: pay.paymentId,
        reason: plan.existingRefunds.includes(h) ? "Notary seed: pre-existing refund (seeded fixture)" : "Notary seed: probe-only refund (refund-list probes)",
      }),
    );
    console.log(`refund   pay:${h} -> ${data.refund_id} status ${data.status}`);
  }

  // 8. Wallet credits
  for (const [h, c] of Object.entries(plan.customers)) {
    if (!c.walletCredit) continue;
    await call(() =>
      dodo.createWalletLedgerEntry(manifest.customers[h]!.customerId, {
        amount: c.walletCredit!,
        currency: plan.currency,
        entry_type: "credit",
        idempotency_key: `notary-seed-${h}`,
        reason: "Notary seed: starting wallet credit (seeded fixture)",
      }),
    );
    manifest.wallets![h] = { currency: plan.currency, seededCredit: c.walletCredit };
    console.log(`wallet   cust:${h} +${c.walletCredit}`);
  }

  return manifest;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.plan) {
    console.log(formatPlan(SEED_PLAN));
    return 0;
  }
  if (existsSync(DEFAULT_MANIFEST_PATH) && !args.force) {
    console.error(`A seed manifest already exists at ${DEFAULT_MANIFEST_PATH}. Re-run with --force to seed again.`);
    return 1;
  }
  loadRootEnv();
  if (!process.env.DODO_PAYMENTS_API_KEY?.trim()) {
    console.error("BLOCKED: DODO_PAYMENTS_API_KEY is not set (Dodo test-mode key). Nothing was sent; no manifest written.");
    return 2;
  }
  try {
    const manifest = await seed(SEED_PLAN, args.waitMinutes);
    mkdirSync(dirname(DEFAULT_MANIFEST_PATH), { recursive: true });
    writeFileSync(DEFAULT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`\nmanifest written: ${DEFAULT_MANIFEST_PATH}`);
    return 0;
  } catch (err) {
    if (err instanceof TestModeLockError || err instanceof MissingCredentialError) {
      console.error(`BLOCKED: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
