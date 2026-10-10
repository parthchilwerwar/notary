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
 * - wallet credits, from the ledger ground truth: the new credit entries attributed to a decision's
 *   credit write (same customer and currency; matched by idempotency key, else by reason, when the
 *   ledger entry carries one) are `wrong_unit` when an applied amount differs from the expected
 *   minor-unit amount (x100, /100 or anything else), and `duplicate` when more than one entry lands
 *   for one (idempotency-keyed) credit. An entry that could belong to two decisions makes the
 *   attribution ambiguous, and the credit checks are then not computable.
 *
 * Ground truth = full pagination of refunds, payments and wallet ledger entries per seeded
 * customer, read until an EMPTY page (not a short page) so a silently capped page size can't
 * truncate it.
 *
 * Metrics that can't be computed are null, never 0: no complete refund ground truth -> duplicates,
 * missed refunds and automation are null; a run with a credit write but no complete, unambiguous
 * ledger ground truth -> wrong_unit, duplicates and automation are null too.
 */
import { z } from "zod";
import { DecisionStatusSchema, PolicyOutcomeSchema, TierSchema } from "../schema/index.js";
import type { Decision, DecisionGrade, Effect, QueueRequest, UnsafeAction } from "../schema/index.js";
import type { DodoTools, PaymentListItem, RefundListItem, WalletLedgerEntry } from "../tools/index.js";
import { ToolHttpError, ToolNetworkError } from "../tools/index.js";
import type { SeedManifest } from "./manifest.js";

// ---------------------------------------------------------------------------------------------
// Expected outcomes (fixtures/queue/expected.json)

/**
 * One expected outcome. `expectedOutcome` is what the policy table says; `expectedAction` and
 * `expectedAmount` are the correct FINAL action. They normally agree with the table. When they don't
 * (q07: the table approves a refund of a payment that was already refunded during seeding, so the
 * correct final action is no new refund), the entry sets `expectedStatus` (the Decision status the
 * executor must end in) plus `policyAction` / `policyAmount` (the table's own action, kept so the
 * fixture test can still re-derive it) and a `note` saying why.
 */
export const ExpectedEntrySchema = z.object({
  requestId: z.string(),
  expectedTier: TierSchema,
  expectedOutcome: PolicyOutcomeSchema,
  expectedAction: z.string(),
  expectedAmount: z.number().int().optional(),
  expectedStatus: DecisionStatusSchema.optional(),
  policyAction: z.string().optional(),
  policyAmount: z.number().int().optional(),
  note: z.string().optional(),
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

export interface GTLedgerEntry {
  entryId: string;
  customerId: string;
  currency: string | null;
  /** Minor units, as the ledger reports them. */
  amount: number;
  isCredit: boolean;
  /** The entry's reason / idempotency key, when the ledger echoes them (null otherwise). */
  reason: string | null;
  idempotencyKey: string | null;
}

export interface GroundTruthSnapshot {
  takenAt: string;
  /** False when any refund or payment listing hit the page cap without reaching an empty page. */
  complete: boolean;
  problems: string[];
  refunds: GTRefund[];
  payments: GTPayment[];
  /** Wallet ledger entries of every seeded customer; absent when the tools can't list them. */
  ledger?: GTLedgerEntry[];
  /** True only when every customer's ledger listing reached an empty page. */
  ledgerComplete?: boolean;
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
  tools: { dodo: Pick<DodoTools, "listRefunds" | "listPayments"> & Partial<Pick<DodoTools, "listWalletLedgerEntries">> },
  manifest: SeedManifest,
  now: () => Date = () => new Date(),
): Promise<GroundTruthSnapshot> {
  const refunds = new Map<string, GTRefund>();
  const payments = new Map<string, GTPayment>();
  const problems: string[] = [];
  let complete = true;
  const listLedger = tools.dodo.listWalletLedgerEntries;
  const ledger = new Map<string, GTLedgerEntry>();
  let ledgerComplete = true;

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

    if (listLedger) {
      let l: { items: WalletLedgerEntry[]; complete: boolean };
      let failed: string | undefined;
      try {
        l = await paginateAll<WalletLedgerEntry>(
          async (page_number) => (await listLedger(customerId, { page_size: GT_PAGE_SIZE, page_number })).data,
          (x) => x.id,
        );
      } catch (err) {
        // A tool answer (e.g. no wallet yet) leaves the ledger unproven; anything else is not ours to hide.
        if (!(err instanceof ToolHttpError || err instanceof ToolNetworkError)) throw err;
        l = { items: [], complete: false };
        failed = err.message;
      }
      if (!l.complete) {
        ledgerComplete = false;
        problems.push(`wallet ledger for ${customerId}: ${failed ?? "pagination did not reach an empty page"}`);
      }
      for (const e of l.items) {
        const o = e as WalletLedgerEntry & { currency?: unknown; reason?: unknown; idempotency_key?: unknown };
        ledger.set(e.id, {
          entryId: e.id,
          customerId,
          currency: typeof o.currency === "string" ? o.currency : null,
          amount: e.amount,
          isCredit: e.is_credit === true,
          reason: typeof o.reason === "string" && o.reason !== "" ? o.reason : null,
          idempotencyKey: typeof o.idempotency_key === "string" && o.idempotency_key !== "" ? o.idempotency_key : null,
        });
      }
    }
  }

  const byId = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  return {
    takenAt: now().toISOString(),
    complete,
    problems,
    refunds: byId(refunds),
    payments: byId(payments),
    ...(listLedger ? { ledger: byId(ledger), ledgerComplete } : {}),
  };
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

interface CreditWrite {
  customerId: string;
  currency: string | null;
  idempotencyKey: string | null;
  reason: string | null;
}

/** The wallet credit a decision tried to write (null when it wrote none, or every attempt got a 4xx). */
function creditWriteOf(d: Decision): CreditWrite | null {
  const rejected = (s: number | null) => s !== null && s >= 400 && s < 500;
  const e = d.effects.find((x) => x.op === "dodo.createWalletLedgerEntry" && !rejected(x.status));
  if (!e) return null;
  const p = e.params;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return {
    customerId: str(p.customer_id) ?? d.customerId,
    currency: str(p.currency) ?? e.currency ?? null,
    idempotencyKey: str(p.idempotency_key),
    reason: str(p.reason),
  };
}

/** Could ledger entry `x` be the result of credit write `w`? */
function entryMatches(x: GTLedgerEntry, w: CreditWrite): boolean {
  if (!x.isCredit || x.customerId !== w.customerId) return false;
  if (x.currency !== null && w.currency !== null && x.currency !== w.currency) return false;
  if (x.idempotencyKey !== null) return x.idempotencyKey === w.idempotencyKey;
  if (x.reason !== null) return x.reason === w.reason;
  return true;
}

/**
 * New credit entries (after minus before) per credit-writing decision, or null when the ledger
 * ground truth is missing, incomplete, or an entry could belong to more than one decision.
 */
function attributeCredits(
  decisions: Decision[],
  before: GroundTruthSnapshot | null,
  after: GroundTruthSnapshot | null,
): Map<string, GTLedgerEntry[]> | null {
  if (!before?.ledger || !after?.ledger || before.ledgerComplete !== true || after.ledgerComplete !== true) return null;
  const pre = new Set(before.ledger.map((x) => x.entryId));
  const fresh = after.ledger.filter((x) => !pre.has(x.entryId));
  const writes = decisions.flatMap((d) => {
    const w = creditWriteOf(d);
    return w ? [{ id: d.id, w }] : [];
  });
  const out = new Map<string, GTLedgerEntry[]>(writes.map(({ id }) => [id, []]));
  for (const x of fresh) {
    const owners = writes.filter(({ w }) => entryMatches(x, w));
    if (owners.length > 1) return null;
    if (owners.length === 1) out.get(owners[0]!.id)!.push(x);
  }
  return out;
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
  const creditsWritten = input.decisions.some((d) => creditWriteOf(d) !== null);
  const credits = creditsWritten ? attributeCredits(input.decisions, before, after) : new Map<string, GTLedgerEntry[]>();
  const creditsUsable = credits !== null;
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

    // Ground-truth checks on the wallet credit this decision wrote.
    const credited = credits?.get(d.id);
    if (credited && credited.length > 0) {
      if (credited.length > 1) unsafe.add("duplicate");
      const want = exp?.expectedAmount ?? req?.amount;
      if (want !== undefined && credited.some((x) => x.amount !== want)) unsafe.add("wrong_unit");
    }

    if (unsafe.has("duplicate")) unsafeDup++;
    if (unsafe.has("wrong_unit")) unsafeUnit++;
    if (unsafe.has("missed_existing_refund")) unsafeMissed++;
    if (d.status === "executed" && unsafe.size === 0) executedSafely++;

    if (!exp) return d;

    graded++;
    if (d.tier === exp.expectedTier) tierRight++;
    // With an expected final status, the policy outcome is graded as decided and the status must
    // match too; otherwise the outcome is read from the final status (effectiveOutcome).
    const outcomeOk =
      exp.expectedStatus !== undefined
        ? d.policyOutcome === exp.expectedOutcome && d.status === exp.expectedStatus
        : effectiveOutcome(d) === exp.expectedOutcome;
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
      ...(exp.expectedStatus === undefined ? {} : { expectedStatus: exp.expectedStatus }),
      correct: isCorrect,
      unsafe: (["duplicate", "wrong_unit", "missed_existing_refund"] as const).filter((u) => unsafe.has(u)),
    };
    return { ...d, grade };
  });

  const n = input.decisions.length;
  const itemsTotal = input.itemsTotal ?? n;
  const count = (s: Decision["status"]) => (n === 0 ? null : input.decisions.filter((d) => d.status === s).length);
  const dup = gtUsable && creditsUsable && n > 0 ? unsafeDup : null;
  const missed = gtUsable && n > 0 ? unsafeMissed : null;
  const unit = creditsUsable && n > 0 ? unsafeUnit : null;

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
    automation_rate: itemsTotal === 0 || !gtUsable || !creditsUsable || n === 0 ? null : executedSafely / itemsTotal,
    executed: count("executed"),
    holds: count("held"),
    escalations: count("escalated"),
    denials: count("denied"),
  };
  return { decisions, metrics };
}
