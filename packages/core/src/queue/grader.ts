/**
 * Deterministic grader (TDD "Replay, seeded queue and evaluation"). No LLM, no model output:
 * it compares Decisions (produced by plain code) with fixtures/queue/expected.json and with
 * Dodo state read back through the tools before and after the run.
 *
 * Unsafe money actions, per decision:
 * - duplicate: a payment the decision refunded has more than one non-failed refund created during
 *   this run, or its non-failed refunds total more than the payment amount.
 * - wrong_unit: a write whose amount is 100x off the expected minor-unit amount (expectedAmount,
 *   else the request amount); for refunds, also any refund created during this run on the
 *   decision's payment whose amount differs from expectedAmount.
 * - missed_existing_refund: a refund created during this run on a payment that already had a
 *   non-failed refund before the run started.
 *
 * Ground truth = full pagination of refunds and payments per seeded customer, read until an
 * EMPTY page (not a short page) so a silently capped page size can't truncate it.
 *
 * Metrics that can't be computed are null, never 0.
 */
import { z } from "zod";
import { PolicyOutcomeSchema, TierSchema } from "../schema/index.js";
import type { Decision, DecisionGrade, Effect, QueueRequest, UnsafeAction } from "../schema/index.js";
import type { DodoTools, PaymentListItem, RefundListItem } from "../tools/index.js";
import type { SeedManifest } from "./manifest.js";

// ---------------------------------------------------------------------------------------------
// Expected outcomes (fixtures/queue/expected.json)

export const ExpectedEntrySchema = z.object({
  requestId: z.string(),
  expectedTier: TierSchema,
  expectedOutcome: PolicyOutcomeSchema,
  expectedAction: z.string(),
  expectedAmount: z.number().int().optional(),
});
export const ExpectedFileSchema = z.array(ExpectedEntrySchema);
export type ExpectedEntry = z.infer<typeof ExpectedEntrySchema>;

/** Ops that move money or change billing state. Everything else is a read. */
export const WRITE_OPS: ReadonlySet<string> = new Set([
  "dodo.createRefund",
  "dodo.changeSubscriptionPlan",
  "dodo.createWalletLedgerEntry",
]);

export function isWriteEffect(e: Effect): boolean {
  return WRITE_OPS.has(e.op);
}

// ---------------------------------------------------------------------------------------------
// Ground truth

export interface GTRefund {
  refundId: string;
  paymentId: string;
  status: string;
  /** Minor units; null when the API didn't say. */
  amount: number | null;
  isPartial: boolean;
  createdAt: string;
}

export interface GTPayment {
  paymentId: string;
  totalAmount: number;
  currency: string;
  refundStatus: string | null;
}

export interface GroundTruthSnapshot {
  takenAt: string;
  /** False when any listing hit the page cap without reaching an empty page. */
  complete: boolean;
  problems: string[];
  refunds: GTRefund[];
  payments: GTPayment[];
}

export interface GroundTruth {
  before: GroundTruthSnapshot | null;
  after: GroundTruthSnapshot | null;
}

const GT_PAGE_SIZE = 100;
const GT_MAX_PAGES = 200;

/** Customer ids from the manifest (a record keyed by handle, or an array). */
export function manifestCustomerIds(manifest: SeedManifest): string[] {
  const raw = (manifest as unknown as { customers?: unknown }).customers;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  const ids = new Set<string>();
  for (const c of list) {
    const id = (c as { customerId?: unknown } | null)?.customerId;
    if (typeof id === "string" && id) ids.add(id);
  }
  return [...ids].sort();
}

async function paginateAll<T>(
  fetchPage: (pageNumber: number) => Promise<{ items: T[] }>,
  key: (item: T) => string,
): Promise<{ items: T[]; complete: boolean }> {
  const seen = new Map<string, T>();
  for (let page = 0; page < GT_MAX_PAGES; page++) {
    const { items } = await fetchPage(page);
    if (!Array.isArray(items) || items.length === 0) return { items: [...seen.values()], complete: true };
    let added = 0;
    for (const item of items) {
      const k = key(item);
      if (!seen.has(k)) {
        seen.set(k, item);
        added++;
      }
    }
    // A page with nothing new means page_number stopped advancing (e.g. a capped offset).
    if (added === 0) return { items: [...seen.values()], complete: false };
  }
  return { items: [...seen.values()], complete: false };
}

/**
 * Read Dodo state for every seeded customer by fully paginating refunds and payments.
 * Called once before and once after the run.
 */
export async function collectGroundTruth(
  tools: { dodo: Pick<DodoTools, "listRefunds" | "listPayments"> },
  manifest: SeedManifest,
  now: () => Date = () => new Date(),
): Promise<GroundTruthSnapshot> {
  const refunds = new Map<string, GTRefund>();
  const payments = new Map<string, GTPayment>();
  const problems: string[] = [];
  let complete = true;

  for (const customerId of manifestCustomerIds(manifest)) {
    const r = await paginateAll<RefundListItem>(
      async (page_number) =>
        (await tools.dodo.listRefunds({ customer_id: customerId, page_size: GT_PAGE_SIZE, page_number })).data,
      (x) => x.refund_id,
    );
    if (!r.complete) {
      complete = false;
      problems.push(`refunds for ${customerId}: pagination did not reach an empty page`);
    }
    for (const x of r.items) {
      refunds.set(x.refund_id, {
        refundId: x.refund_id,
        paymentId: x.payment_id,
        status: x.status,
        amount: typeof x.amount === "number" ? x.amount : null,
        isPartial: x.is_partial === true,
        createdAt: x.created_at,
      });
    }

    const p = await paginateAll<PaymentListItem>(
      async (page_number) =>
        (await tools.dodo.listPayments({ customer_id: customerId, page_size: GT_PAGE_SIZE, page_number })).data,
      (x) => x.payment_id,
    );
    if (!p.complete) {
      complete = false;
      problems.push(`payments for ${customerId}: pagination did not reach an empty page`);
    }
    for (const x of p.items) {
      payments.set(x.payment_id, {
        paymentId: x.payment_id,
        totalAmount: x.total_amount,
        currency: x.currency,
        refundStatus: x.refund_status ?? null,
      });
    }
  }

  const byId = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  return { takenAt: now().toISOString(), complete, problems, refunds: byId(refunds), payments: byId(payments) };
}

// ---------------------------------------------------------------------------------------------
// Grading

export interface GradeRunInput {
  decisions: Decision[];
  expected: ExpectedEntry[];
  groundTruth: GroundTruth;
  /** The queue, for request amounts when expectedAmount is absent. */
  queue?: QueueRequest[];
  /** Queue length including items not processed. Default: decisions.length. */
  itemsTotal?: number;
}

export interface GradeRunResult {
  decisions: Decision[];
  metrics: Record<string, number | null>;
}

const isLiveRefund = (r: GTRefund) => r.status !== "failed";
const ok2xx = (s: number | null) => s !== null && s >= 200 && s < 300;

/** The outcome a decision actually carried out, read from its final status. */
export function effectiveOutcome(d: Decision): Decision["policyOutcome"] | null {
  switch (d.status) {
    case "denied":
      return "deny";
    case "escalated":
      return "escalate";
    case "held":
      return null;
    case "executed":
      return d.policyOutcome;
  }
}

function is100xOff(amount: number, expected: number): boolean {
  return expected !== 0 && (amount === expected * 100 || amount * 100 === expected);
}

function refundAmount(r: GTRefund, payment: GTPayment | undefined): number | null {
  if (r.amount !== null) return r.amount;
  if (!r.isPartial && payment) return payment.totalAmount;
  return null;
}

function refundedPaymentIds(d: Decision): string[] {
  const ids = new Set<string>();
  for (const e of d.effects) {
    if (e.op !== "dodo.createRefund") continue;
    const pid = e.params.payment_id;
    if (typeof pid === "string") ids.add(pid);
  }
  return [...ids];
}

export function gradeRun(input: GradeRunInput): GradeRunResult {
  const expectedById = new Map(input.expected.map((e) => [e.requestId, e]));
  const requestById = new Map((input.queue ?? []).map((r) => [r.id, r]));
  const { before, after } = input.groundTruth;
  const gtUsable = before !== null && after !== null && before.complete && after.complete;

  const beforeIds = new Set(before?.refunds.map((r) => r.refundId) ?? []);
  const paymentsAfter = new Map((after?.payments ?? before?.payments ?? []).map((p) => [p.paymentId, p]));

  let correct = 0;
  let graded = 0;
  let tierRight = 0;
  let unsafeDup = 0;
  let unsafeUnit = 0;
  let unsafeMissed = 0;
  let executedSafely = 0;

  const decisions = input.decisions.map((d): Decision => {
    const exp = expectedById.get(d.requestId);
    const req = requestById.get(d.requestId);
    const unsafe = new Set<UnsafeAction>();

    // wrong_unit from the decision's own writes (needs no ground truth).
    const refAmount = exp?.expectedAmount ?? req?.amount;
    for (const e of d.effects) {
      if (!isWriteEffect(e) || e.amount === undefined || refAmount === undefined) continue;
      if (e.status !== null && !ok2xx(e.status)) continue; // rejected by the API: nothing moved
      if (is100xOff(e.amount, refAmount)) unsafe.add("wrong_unit");
    }

    // Ground-truth checks on every payment this decision tried to refund.
    if (gtUsable) {
      for (const pid of refundedPaymentIds(d)) {
        const payment = paymentsAfter.get(pid);
        const prior = before!.refunds.filter((r) => r.paymentId === pid && isLiveRefund(r));
        const all = after!.refunds.filter((r) => r.paymentId === pid && isLiveRefund(r));
        const created = all.filter((r) => !beforeIds.has(r.refundId));
        if (created.length === 0) continue;

        const amounts = all.map((r) => refundAmount(r, payment));
        const total = amounts.every((a) => a !== null) ? amounts.reduce<number>((s, a) => s + (a ?? 0), 0) : null;
        if (created.length > 1 || (payment && total !== null && total > payment.totalAmount)) unsafe.add("duplicate");
        if (prior.length > 0) unsafe.add("missed_existing_refund");
        if (exp?.expectedAmount !== undefined) {
          for (const r of created) {
            const a = refundAmount(r, payment);
            if (a !== null && a !== exp.expectedAmount) unsafe.add("wrong_unit");
          }
        }
      }
    }

    if (unsafe.has("duplicate")) unsafeDup++;
    if (unsafe.has("wrong_unit")) unsafeUnit++;
    if (unsafe.has("missed_existing_refund")) unsafeMissed++;
    if (d.status === "executed" && unsafe.size === 0) executedSafely++;

    if (!exp) return d;

    graded++;
    if (d.tier === exp.expectedTier) tierRight++;
    const outcomeOk = effectiveOutcome(d) === exp.expectedOutcome;
    const actionTaken = d.status === "executed" ? d.action : "none";
    const actionOk = actionTaken === exp.expectedAction;
    let amountOk = true;
    if (d.status === "executed" && exp.expectedAmount !== undefined) {
      // A write whose answer was lost (status null or 5xx) but that a read-back proved landed carries
      // the read-back's resultId (guarded variant, resume); the naive variant never sets one there.
      const landed = (e: Effect) => ok2xx(e.status) || (e.resultId !== undefined && (e.status === null || e.status >= 500));
      const done = d.effects.filter((e) => isWriteEffect(e) && landed(e) && e.amount !== undefined);
      amountOk = done.length > 0 && done.every((e) => e.amount === exp.expectedAmount);
    }
    const isCorrect = outcomeOk && actionOk && amountOk;
    if (isCorrect) correct++;

    const grade: DecisionGrade = {
      expectedOutcome: exp.expectedOutcome,
      correct: isCorrect,
      unsafe: (["duplicate", "wrong_unit", "missed_existing_refund"] as const).filter((u) => unsafe.has(u)),
    };
    return { ...d, grade };
  });

  const n = input.decisions.length;
  const itemsTotal = input.itemsTotal ?? n;
  const count = (s: Decision["status"]) => (n === 0 ? null : input.decisions.filter((d) => d.status === s).length);
  const dup = gtUsable && n > 0 ? unsafeDup : null;
  const missed = gtUsable && n > 0 ? unsafeMissed : null;
  const unit = n > 0 ? unsafeUnit : null;

  const metrics: Record<string, number | null> = {
    items_total: itemsTotal === 0 ? null : itemsTotal,
    items_processed: n === 0 && itemsTotal === 0 ? null : n,
    items_not_processed: itemsTotal === 0 ? null : itemsTotal - n,
    unsafe_actions_total: dup === null || missed === null || unit === null ? null : dup + missed + unit,
    unsafe_duplicates: dup,
    unsafe_wrong_unit: unit,
    unsafe_missed_existing_refund: missed,
    decision_accuracy: graded === 0 ? null : correct / graded,
    tier_accuracy: graded === 0 ? null : tierRight / graded,
    automation_rate: itemsTotal === 0 || !gtUsable || n === 0 ? null : executedSafely / itemsTotal,
    executed: count("executed"),
    holds: count("held"),
    escalations: count("escalated"),
    denials: count("denied"),
  };
  return { decisions, metrics };
}
