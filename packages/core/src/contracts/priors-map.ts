/**
 * Suspected defect class per claim (P7 transfer priors, TDD step 9).
 *
 * Each entry is copied from the `// suspect: <class>` comment written next to the claim in
 * contracts/dodo.ts and contracts/crustdata.ts when the claims were hand-written from the docs (P2).
 * It is the defect class the claim is MOST associated with, i.e. the class whose base rate on the
 * source tool sets the claim's prior. `honored` marks the control claims (no specific suspicion).
 * No model is involved; a test asserts every contract claim has exactly one entry here.
 */
import type { DefectClass } from "../schema/index.js";

export const SUSPECTED_CLASS: Readonly<Record<string, DefectClass>> = {
  // ---------------------------------------------------------------- dodo (contracts/dodo.ts)
  "dodo.refund.amount-minor-units": "unit_mismatch",
  "dodo.refund.full-retry-no-duplicate": "idempotency_hazard",
  "dodo.refunds.amount-integer": "silent_coercion",
  "dodo.refunds.page-size-max-100": "silent_truncation",
  "dodo.payments.page-size-max-100": "silent_truncation",
  "dodo.payment.refunds-array-present": "honored",
  "dodo.payment.refunds-lists-issued-refund": "eventual_consistency",
  "dodo.product.price-minor-units": "honored",
  "dodo.customer.missing-email-422": "silent_coercion",
  "dodo.subscription.change-plan-pending-409": "idempotency_hazard",
  "dodo.wallet.credit-amount-minor-units": "unit_mismatch",
  "dodo.wallet.idempotency-key-no-duplicate": "idempotency_hazard",
  "dodo.wallet.debit-insufficient-400": "honored",
  "dodo.wallets.total-balance-usd-integer": "honored",
  "dodo.wallet.ledger-response-balance-integer": "silent_coercion",
  // ---------------------------------------------------------------- crustdata (contracts/crustdata.ts)
  "crustdata.enrich.headcount-total-integer": "silent_coercion",
  "crustdata.enrich.funding-total-investment-number": "silent_coercion",
  "crustdata.enrich.employee-count-range-string": "mislabelled_semantics",
  "crustdata.enrich.last-fundraise-date-string": "silent_coercion",
  "crustdata.enrich.default-fields-basic-info": "honored",
  "crustdata.enrich.no-match-200-empty": "mislabelled_semantics",
  "crustdata.identify.no-match-200-empty": "honored",
  "crustdata.identify.invalid-fields-400": "undocumented_flag",
  "crustdata.enrich.confidence-score-number": "honored",
  "crustdata.identify.max-25-identifiers": "silent_truncation",
  "crustdata.credits.balance-number": "honored",
};

/** The claim's suspected defect class, or undefined when the claim is not in the map. */
export function suspectedClassOf(claimId: string): DefectClass | undefined {
  return Object.hasOwn(SUSPECTED_CLASS, claimId) ? SUSPECTED_CLASS[claimId] : undefined;
}
