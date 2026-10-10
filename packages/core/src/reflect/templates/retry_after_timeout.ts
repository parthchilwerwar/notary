/**
 * retry_after_timeout — repeat a write, then list to count duplicates (TDD step 3).
 *
 * The identical write is sent 2–3 times (never more than MAX_STEP_REPEAT = 3), as a client would
 * after a timeout or a 5xx, then the subject is read back. No timeout is forced: the retry is the
 * same request again, which is what a blind retry sends.
 *
 * Subjects:
 *   dodo.createRefund             full refund on a probe-reserved succeeded payment; count = the
 *                                 payment's refunds[] before (control) and after (treatment).
 *   dodo.createWalletLedgerEntry  keyed credit (same idempotency_key) on a fresh customer; count =
 *                                 ledger entries; control = a fresh customer's empty ledger.
 *   dodo.changeSubscriptionPlan   (statusOnError claim "409 when a pending plan change exists") a
 *                                 change-plan scheduled for the next billing date, sent again on a
 *                                 probe-reserved subscription (never one the queue references). The
 *                                 first send creates the pending change; every repeat must be refused.
 * Outcome:
 *   counts (refund, wallet): delta = after - before: single (1) | duplicate (>= 2) | none (0).
 *   change-plan: every repeat refused with the documented status -> single; any repeat 2xx (a second
 *     change stacked or replaced the pending one) -> duplicate; any other status -> other.
 * Predictions by class: honored -> single; idempotency_hazard -> duplicate.
 * Uninformative: a read failed, no write returned 2xx, or (change-plan) the first send was refused.
 * Instrument: the before (control) and after (treatment) readings must differ (refund/wallet: the
 * count; change-plan: the subscription's scheduled_change). Equal readings mean no write landed
 * where the read looks.
 *
 * DESIGN VARIANTS (each a distinct experiment, its own design fingerprint via `variant: k`):
 *   refund       v0 2 sends, read after 1 s | v1 3 sends | v2 2 sends, read after 3 s — each on its
 *                own probe-reserved payment;
 *   wallet       v0 500 x3 | v1 700 x2 | v2 900 x3 — each its own fresh customer and idempotency key;
 *   change-plan  v0 2 sends do_not_bill | v1 3 sends do_not_bill | v2 2 sends prorated_immediately —
 *                each on its own probe-reserved subscription and a fresh target plan.
 */
import {
  executeVariants,
  finishDesign,
  first,
  freshCustomerStep,
  informativeOutcome,
  is2xx,
  matchesOutcome,
  pick,
  predictionsFor,
  responseList,
} from "./common.js";
import type { ClassTable } from "./common.js";
import type { ProbeObservation, ProbeStep, ProbeTemplateModule } from "./types.js";

export const RETRY_TABLE: ClassTable = {
  honored: ["single"],
  idempotency_hazard: ["duplicate"],
};

/** Identical write attempts per probe (variant 0). Hard limit 3. */
export const RETRY_REPEAT = 2;
export const WALLET_RETRY_REPEAT = 3;
/** Wait before the read-back. */
export const RETRY_READ_DELAY_MS = 1000;

/** Per-variant designs (see the header). Every repeat is <= 3 (MAX_STEP_REPEAT). */
export const REFUND_RETRY_VARIANTS = [
  { repeat: RETRY_REPEAT, readDelayMs: RETRY_READ_DELAY_MS },
  { repeat: 3, readDelayMs: RETRY_READ_DELAY_MS },
  { repeat: RETRY_REPEAT, readDelayMs: 3 * RETRY_READ_DELAY_MS },
] as const;
export const WALLET_RETRY_VARIANTS = [
  { amount: 500, repeat: WALLET_RETRY_REPEAT },
  { amount: 700, repeat: 2 },
  { amount: 900, repeat: 3 },
] as const;
export const PLAN_RETRY_VARIANTS = [
  { repeat: 2, proration: "do_not_bill" },
  { repeat: 3, proration: "do_not_bill" },
  { repeat: 2, proration: "prorated_immediately" },
] as const;

/** The target plan a change-plan probe moves to: a fresh recurring test product (minor units). */
export const PROBE_PLAN_PRICE = 1500;

function countOf(body: unknown, field: "refunds" | "list"): number | null {
  if (field === "refunds") {
    const v = body !== null && typeof body === "object" ? (body as Record<string, unknown>).refunds : undefined;
    return Array.isArray(v) ? v.length : null;
  }
  const list = responseList(body);
  return list ? list.length : null;
}

function scheduledChange(body: unknown): unknown {
  if (body === null || typeof body !== "object") return undefined;
  const v = (body as Record<string, unknown>).scheduled_change;
  return v === undefined ? null : v;
}

export const retryAfterTimeout: ProbeTemplateModule = {
  name: "retry_after_timeout",
  classTable: RETRY_TABLE,
  variants: 3,

  appliesTo(claim) {
    if (claim.operation === "dodo.createRefund") return claim.expect.kind === "idempotentOnRetry";
    if (claim.operation === "dodo.createWalletLedgerEntry") {
      return claim.expect.kind === "idempotentOnRetry" || (claim.expect.kind === "maxItems" && claim.param === "");
    }
    if (claim.operation === "dodo.changeSubscriptionPlan") return claim.expect.kind === "statusOnError";
    return false;
  },

  design(claim, hypotheses, ctx) {
    if (!retryAfterTimeout.appliesTo(claim)) {
      return { skip: "retry_after_timeout needs a retry claim on dodo.createRefund, a keyed wallet credit, or a change-plan refusal" };
    }
    const k = ctx.variant ?? 0;
    const stamp = k > 0 ? { variant: k } : {};
    let treatment: ProbeStep[];
    let control: ProbeStep[];
    let paymentIds: string[] | undefined;
    let subscriptionIds: string[] | undefined;
    let countField: "refunds" | "list" | "plan";
    let extra: Record<string, unknown> = {};
    if (claim.operation === "dodo.createRefund") {
      const v = REFUND_RETRY_VARIANTS[k];
      if (!v) return { skip: `retry_after_timeout: no variant ${k}` };
      const pool = ctx.payments.available();
      if (pool.length < 1) return { skip: "retry_after_timeout on refunds needs a probe-reserved succeeded payment (seed manifest)" };
      const paymentId = pool[0]!;
      paymentIds = [paymentId];
      countField = "refunds";
      control = [{ op: "dodo.getPayment", params: { payment_id: paymentId }, tag: "count", note: "Count refunds before" }];
      treatment = [
        {
          op: "dodo.createRefund",
          params: { payment_id: paymentId, reason: `notary probe retry ${ctx.tag}` },
          repeat: v.repeat,
          tag: "write",
          note: `Send the identical full refund ${v.repeat} times`,
        },
        { op: "dodo.getPayment", params: { payment_id: paymentId }, delayMs: v.readDelayMs, tag: "count", note: `Count refunds after ~${v.readDelayMs} ms` },
      ];
    } else if (claim.operation === "dodo.changeSubscriptionPlan") {
      const v = PLAN_RETRY_VARIANTS[k];
      if (!v) return { skip: `retry_after_timeout: no variant ${k}` };
      const pool = ctx.subscriptions?.available() ?? [];
      if (pool.length < 1) {
        return { skip: "retry_after_timeout on change-plan needs a probe-reserved active subscription the queue never references (seed manifest)" };
      }
      const subscriptionId = pool[0]!;
      subscriptionIds = [subscriptionId];
      countField = "plan";
      extra = { refusalStatus: claim.expect.kind === "statusOnError" ? claim.expect.status : 409 };
      const read = { op: "dodo.getSubscription", params: { subscription_id: subscriptionId } };
      control = [{ ...read, tag: "count", note: "Subscription before (no pending change)" }];
      treatment = [
        {
          op: "dodo.createProduct",
          params: {
            name: `Notary probe plan ${ctx.tag}`,
            tax_category: "saas",
            price: {
              type: "recurring_price",
              price: PROBE_PLAN_PRICE,
              currency: "USD",
              discount_bps: 0,
              purchasing_power_parity: false,
              payment_frequency_count: 1,
              payment_frequency_interval: "Month",
              subscription_period_count: 1,
              subscription_period_interval: "Year",
            },
          },
          setup: true,
          note: "Create a fresh recurring test product to change to",
        },
        {
          op: "dodo.changeSubscriptionPlan",
          params: {
            subscription_id: subscriptionId,
            product_id: "$from:0:product_id",
            quantity: 1,
            proration_billing_mode: v.proration,
            effective_at: "next_billing_date",
          },
          repeat: v.repeat,
          tag: "write",
          note: `Schedule a plan change for the next billing date, then send it again (${v.repeat} sends)`,
        },
        { ...read, delayMs: RETRY_READ_DELAY_MS, tag: "count", note: "Subscription after (one pending change)" },
      ];
    } else {
      const v = WALLET_RETRY_VARIANTS[k];
      if (!v) return { skip: `retry_after_timeout: no variant ${k}` };
      countField = "list";
      control = [
        freshCustomerStep(`${ctx.tag}-c`),
        { op: "dodo.listWalletLedgerEntries", params: { customer_id: "$from:0:customer_id", currency: "USD" }, tag: "count", note: "Empty ledger baseline" },
      ];
      treatment = [
        freshCustomerStep(`${ctx.tag}-t`),
        {
          op: "dodo.createWalletLedgerEntry",
          params: {
            customer_id: "$from:0:customer_id",
            amount: v.amount,
            currency: "USD",
            entry_type: "credit",
            idempotency_key: `notary-probe-${ctx.tag}`,
            reason: `notary probe retry ${ctx.tag}`,
          },
          repeat: v.repeat,
          tag: "write",
          note: `Send the identical keyed credit of ${v.amount} ${v.repeat} times`,
        },
        {
          op: "dodo.listWalletLedgerEntries",
          params: { customer_id: "$from:0:customer_id", currency: "USD" },
          delayMs: RETRY_READ_DELAY_MS,
          tag: "count",
          note: "Count ledger entries after",
        },
      ];
    }
    return finishDesign(
      {
        template: "retry_after_timeout",
        params: { steps: treatment, countField, ...extra, ...stamp },
        control: { params: { steps: control } },
        predictions: predictionsFor(hypotheses, RETRY_TABLE),
        ...(paymentIds ? { paymentIds } : {}),
        ...(subscriptionIds ? { subscriptionIds } : {}),
      },
      ctx.costs,
    );
  },

  execute(io, design) {
    return executeVariants(io, design);
  },

  observe(exchanges, design): ProbeObservation {
    const beforeEx = first(exchanges, "control", "count");
    const afterEx = first(exchanges, "treatment", "count");
    const writes = pick(exchanges, "treatment", "write");
    const writes2xx = writes.filter((w) => is2xx(w)).length;
    const statuses = writes.map((w) => w.status);
    if (design.params.countField === "plan") {
      const refusal = Number(design.params.refusalStatus ?? 409);
      const before = is2xx(beforeEx) ? scheduledChange(beforeEx!.responseBody) : undefined;
      const after = is2xx(afterEx) ? scheduledChange(afterEx!.responseBody) : undefined;
      const repeats = writes.slice(1);
      let outcome: string | null = null;
      let note: string | undefined;
      if (before === undefined || after === undefined) note = "a subscription read failed";
      else if (before !== null) note = "the subscription already had a pending change before the probe";
      else if (!is2xx(writes[0])) note = `the first change-plan was not accepted (status ${writes[0]?.status ?? "none"}): no pending change to collide with`;
      else if (repeats.length === 0) note = "no repeated change-plan was sent";
      else if (repeats.some((w) => is2xx(w))) outcome = "duplicate";
      else if (repeats.every((w) => w.status === refusal)) outcome = "single";
      else outcome = "other";
      return {
        outcome,
        treatment: { writes: writes.length, writes2xx, statuses, refusalStatus: refusal, after: after ?? null },
        control: { before: before ?? null },
        instrument: outcome === null ? null : { treatment: after, control: before },
        ...(note ? { note } : {}),
      };
    }
    const field = design.params.countField === "refunds" ? "refunds" : "list";
    const before = is2xx(beforeEx) ? countOf(beforeEx!.responseBody, field) : null;
    const after = is2xx(afterEx) ? countOf(afterEx!.responseBody, field) : null;
    let outcome: string | null = null;
    let note: string | undefined;
    if (before === null || after === null) note = "a count read failed";
    else if (writes2xx === 0) note = "no write returned 2xx";
    else {
      const delta = after - before;
      outcome = delta >= 2 ? "duplicate" : delta === 1 ? "single" : "none";
    }
    return {
      outcome,
      treatment: { writes: writes.length, writes2xx, statuses, after },
      control: { before },
      instrument: outcome === null ? null : { treatment: after, control: before },
      ...(note ? { note } : {}),
    };
  },

  matches: matchesOutcome,
  informative: informativeOutcome,
};
