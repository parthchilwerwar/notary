/**
 * retry_after_timeout — repeat a write, then list to count duplicates (TDD step 3).
 *
 * The identical write is sent RETRY_REPEAT (<= 3) times, as a client would after a timeout or a
 * 5xx, then the subject is read back and its records counted. No timeout is forced: the retry is
 * the same request again, which is what a blind retry sends.
 *
 * Subjects:
 *   dodo.createRefund             full refund on a probe-reserved succeeded payment; count = the
 *                                 payment's refunds[] before (control) and after (treatment).
 *   dodo.createWalletLedgerEntry  keyed credit (same idempotency_key) on a fresh customer; count =
 *                                 ledger entries; control = a fresh customer's empty ledger.
 * Outcome from delta = after - before: single (1) | duplicate (>= 2) | none (0).
 * Predictions by class: honored -> single; idempotency_hazard -> duplicate.
 * Uninformative: a count read failed, or no write returned 2xx.
 * Instrument: the before (control) and after (treatment) counts must differ; equal counts mean no
 * write landed where the read looks.
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

/** Identical write attempts per probe. Hard limit 3. */
export const RETRY_REPEAT = 2;
export const WALLET_RETRY_REPEAT = 3;
/** Wait before the read-back. */
export const RETRY_READ_DELAY_MS = 1000;

function countOf(body: unknown, field: "refunds" | "list"): number | null {
  if (field === "refunds") {
    const v = body !== null && typeof body === "object" ? (body as Record<string, unknown>).refunds : undefined;
    return Array.isArray(v) ? v.length : null;
  }
  const list = responseList(body);
  return list ? list.length : null;
}

export const retryAfterTimeout: ProbeTemplateModule = {
  name: "retry_after_timeout",

  appliesTo(claim) {
    if (claim.operation === "dodo.createRefund") return claim.expect.kind === "idempotentOnRetry";
    if (claim.operation === "dodo.createWalletLedgerEntry") {
      return claim.expect.kind === "idempotentOnRetry" || (claim.expect.kind === "maxItems" && claim.param === "");
    }
    return false;
  },

  design(claim, hypotheses, ctx) {
    if (!retryAfterTimeout.appliesTo(claim)) return { skip: "retry_after_timeout needs a retry claim on dodo.createRefund or a keyed wallet credit" };
    let treatment: ProbeStep[];
    let control: ProbeStep[];
    let paymentIds: string[] | undefined;
    let countField: "refunds" | "list";
    if (claim.operation === "dodo.createRefund") {
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
          repeat: RETRY_REPEAT,
          tag: "write",
          note: `Send the identical full refund ${RETRY_REPEAT} times`,
        },
        { op: "dodo.getPayment", params: { payment_id: paymentId }, delayMs: RETRY_READ_DELAY_MS, tag: "count", note: "Count refunds after" },
      ];
    } else {
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
            amount: 500,
            currency: "USD",
            entry_type: "credit",
            idempotency_key: `notary-probe-${ctx.tag}`,
            reason: `notary probe retry ${ctx.tag}`,
          },
          repeat: WALLET_RETRY_REPEAT,
          tag: "write",
          note: `Send the identical keyed credit ${WALLET_RETRY_REPEAT} times`,
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
        params: { steps: treatment, countField },
        control: { params: { steps: control } },
        predictions: predictionsFor(hypotheses, RETRY_TABLE),
        ...(paymentIds ? { paymentIds } : {}),
      },
      ctx.costs,
    );
  },

  execute(io, design) {
    return executeVariants(io, design);
  },

  observe(exchanges, design): ProbeObservation {
    const field = design.params.countField === "refunds" ? "refunds" : "list";
    const beforeEx = first(exchanges, "control", "count");
    const afterEx = first(exchanges, "treatment", "count");
    const before = is2xx(beforeEx) ? countOf(beforeEx!.responseBody, field) : null;
    const after = is2xx(afterEx) ? countOf(afterEx!.responseBody, field) : null;
    const writes = pick(exchanges, "treatment", "write");
    const writes2xx = writes.filter((w) => is2xx(w)).length;
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
      treatment: { writes: writes.length, writes2xx, statuses: writes.map((w) => w.status), after },
      control: { before },
      instrument: outcome === null ? null : { treatment: after, control: before },
      ...(note ? { note } : {}),
    };
  },

  matches: matchesOutcome,
  informative: informativeOutcome,
};
