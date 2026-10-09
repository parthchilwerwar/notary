/**
 * Required beliefs per irreversible action (TDD "Required beliefs per action", PRD FR-9), mapped to
 * the REAL claim ids in src/contracts. An action runs only when the belief of EVERY listed claim is
 * notarized (honored side: the doc holds; violated side: a compiled guard compensates). Anything
 * missing -> the decision is held with an evidence pack. A test asserts every id resolves.
 *
 * Full refund
 *   refund amount unit          dodo.refund.amount-minor-units
 *   retry safety (timeout/5xx)  dodo.refund.full-retry-no-duplicate
 *   list completeness           dodo.refunds.page-size-max-100, dodo.payments.page-size-max-100
 *                               (finding existing refunds), dodo.payment.refunds-lists-issued-refund
 *                               (the payment's refunds[] used by the precheck and the read-back)
 *   company-size semantics      crustdata.enrich.headcount-total-integer (headcount.total tiers first)
 *
 * Partial refund: all of the above + rounding.
 *   ROUNDING DECISION. The Dodo docs make no rounding promise, so there is no rounding claim
 *   (docs/DECISIONS.md #22). Notary never sends a fractional amount: the policy floors every share to
 *   the minor unit client-side (policy.ts `partialShare`). What remains to trust is that the integer
 *   we send is the integer refunded, unrounded and uncoerced. The closest notarizable claims are:
 *     - dodo.refund.amount-minor-units: its unit_roundtrip probes ARE partial refunds of odd integer
 *       amounts (100/120/130 vs 150) and require an exact echo, so "honored" means no rounding of
 *       the amount sent (already required above);
 *     - dodo.refunds.amount-integer: refund amounts come back as integers (no float coercion /
 *       re-rounding when listed).
 *   So a partial refund additionally requires dodo.refunds.amount-integer. Rounding of non-integer
 *   inputs is not covered by any belief, and Notary never sends one.
 *
 * Plan change
 *   retry safety                dodo.subscription.change-plan-pending-409 (a repeated change-plan is
 *                               refused with 409 rather than stacked)
 *   change semantics            NO CLAIM: "immediately vs next billing date" cannot be expressed by any
 *                               expect rule (DECISIONS #22). The guarded executor never relies on the
 *                               default: it sends `effective_at: "immediately"` explicitly. Recorded as
 *                               a gap, not papered over with an unrelated claim.
 *
 * Credit (wallet ledger)
 *   unit                        dodo.wallet.credit-amount-minor-units
 *   idempotency / retry safety  dodo.wallet.idempotency-key-no-duplicate
 */
import { claimById } from "../contracts/index.js";
import { beliefIdFor } from "../beliefs/store.js";

export type RequiredAction = "full_refund" | "partial_refund" | "plan_change" | "credit";

const FULL_REFUND = [
  "dodo.refund.amount-minor-units",
  "dodo.refund.full-retry-no-duplicate",
  "dodo.refunds.page-size-max-100",
  "dodo.payments.page-size-max-100",
  "dodo.payment.refunds-lists-issued-refund",
  "crustdata.enrich.headcount-total-integer",
] as const;

export const REQUIRED_CLAIMS: Readonly<Record<RequiredAction, readonly string[]>> = {
  full_refund: FULL_REFUND,
  partial_refund: [...FULL_REFUND, "dodo.refunds.amount-integer"],
  plan_change: ["dodo.subscription.change-plan-pending-409"],
  credit: ["dodo.wallet.credit-amount-minor-units", "dodo.wallet.idempotency-key-no-duplicate"],
};

/** Gaps in the TDD table that no doc claim can cover (reported in bundles, never faked). */
export const REQUIRED_GAPS: Readonly<Partial<Record<RequiredAction, string>>> = {
  partial_refund:
    "No doc claim on rounding (DECISIONS #22); covered by exact-echo unit probes on partial refunds plus integer-typed refund amounts, and amounts are floored client-side.",
  plan_change:
    "No doc claim on immediate vs next-billing-date semantics (DECISIONS #22); the guarded executor sends effective_at=immediately explicitly.",
};

/** The irreversible action a policy decision implies (null for no action). */
export function requiredActionFor(
  action: string,
  refundAmount: number | undefined,
  paymentAmount: number | undefined,
  requestType: string,
): RequiredAction | null {
  if (action === "dodo.createRefund") {
    const full = refundAmount === undefined ? requestType !== "partial_refund" : paymentAmount !== undefined && refundAmount >= paymentAmount;
    return full ? "full_refund" : "partial_refund";
  }
  if (action === "dodo.changeSubscriptionPlan") return "plan_change";
  if (action === "dodo.createWalletLedgerEntry") return "credit";
  return null;
}

/** The action a request type would take if approved (used for escalation evidence packs). */
export function requiredActionForRequestType(type: string): RequiredAction {
  if (type === "refund") return "full_refund";
  if (type === "partial_refund") return "partial_refund";
  if (type === "plan_change") return "plan_change";
  return "credit";
}

export function requiredClaims(a: RequiredAction): readonly string[] {
  return REQUIRED_CLAIMS[a];
}

export function requiredBeliefIds(a: RequiredAction): string[] {
  return REQUIRED_CLAIMS[a].map(beliefIdFor);
}

/** Claim ids in REQUIRED_CLAIMS that do not resolve in src/contracts (should be empty). */
export function unresolvedRequiredClaims(): string[] {
  const all = new Set(Object.values(REQUIRED_CLAIMS).flat());
  return [...all].filter((id) => claimById(id) === undefined).sort();
}
