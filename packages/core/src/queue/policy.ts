/**
 * Billing policy: plain code, no model. Two steps.
 *
 *   1. tierFromCompany()  Crustdata company data -> tier (smb | mid_market | enterprise | unknown)
 *   2. decidePolicy()     tier x plan x request type (+ amounts) -> outcome and the Dodo action to take
 *
 * Money is always integer minor units (cents for USD), the same unit as QueueRequest.amount and
 * Dodo's `total_amount`.
 */
import type { PolicyOutcome, RequestType, Tier } from "../schema/index.js";
import type { CompanyData } from "../tools/index.js";

export type { PolicyOutcome, RequestType, Tier };
export type PolicyAction = "dodo.createRefund" | "dodo.changeSubscriptionPlan" | "dodo.createWalletLedgerEntry" | "none";

export const TIERS = ["smb", "mid_market", "enterprise", "unknown"] as const satisfies readonly Tier[];
export const PLANS = ["starter", "growth", "scale"] as const;
export type Plan = (typeof PLANS)[number];
export const REQUEST_TYPES = ["refund", "partial_refund", "plan_change", "credit"] as const satisfies readonly RequestType[];

// ---------------------------------------------------------------------------------------------
// Tiering thresholds

/** Fewer than this many employees is SMB. */
export const SMB_MAX_EMPLOYEES_EXCLUSIVE = 50;
/** This many employees or more is enterprise. Between the two is mid-market. */
export const ENTERPRISE_MIN_EMPLOYEES = 1000;
/** Funding is used only when no headcount field is present. At or above this: enterprise. */
export const ENTERPRISE_MIN_FUNDING_USD = 500_000_000;
/** Funding at or above this (and below the enterprise bar): mid-market. Any smaller funding: SMB. */
export const MID_MARKET_MIN_FUNDING_USD = 20_000_000;

function tierFromHeadcount(n: number): Tier {
  if (n < SMB_MAX_EMPLOYEES_EXCLUSIVE) return "smb";
  if (n >= ENTERPRISE_MIN_EMPLOYEES) return "enterprise";
  return "mid_market";
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** "51-200" -> {lo: 51, hi: 200}; "10001+" -> {lo: 10001, hi: 10001}; anything else -> null. */
export function parseEmployeeRange(range: string): { lo: number; hi: number } | null {
  const s = range.replace(/,/g, "").trim();
  const span = /^(\d+)\s*-\s*(\d+)$/.exec(s);
  if (span) {
    const lo = Number(span[1]);
    const hi = Number(span[2]);
    return lo <= hi ? { lo, hi } : null;
  }
  const open = /^(\d+)\s*\+$/.exec(s);
  if (open) return { lo: Number(open[1]), hi: Number(open[1]) };
  return null;
}

/** A range is placed by its midpoint, floored (so "11-50" -> 30 -> smb, "501-1000" -> 750 -> mid_market). */
function rangeMidpoint(lo: number, hi: number): number {
  return Math.floor((lo + hi) / 2);
}

/**
 * Map Crustdata company data to a tier. Sources, first one present wins:
 *   1. headcount.total (exact count)
 *   2. market_intel.num_employees_min / num_employees_max (midpoint)
 *   3. basic_info.employee_count_range, e.g. "51-200" (midpoint)
 *   4. funding.total_investment_usd (only when no headcount at all)
 * No company or none of these fields -> "unknown".
 */
export function tierFromCompany(company: CompanyData | null | undefined): { tier: Tier; basis: string } {
  if (!company) return { tier: "unknown", basis: "no company data (enrichment failed or no match)" };

  const total = company.headcount?.total;
  if (isCount(total)) return { tier: tierFromHeadcount(total), basis: `headcount.total=${total}` };

  const min = company.market_intel?.num_employees_min;
  const max = company.market_intel?.num_employees_max;
  if (isCount(min) || isCount(max)) {
    const lo = isCount(min) ? min : (max as number);
    const hi = isCount(max) ? max : lo;
    const mid = rangeMidpoint(lo, hi);
    return { tier: tierFromHeadcount(mid), basis: `market_intel.num_employees ${lo}-${hi} (midpoint ${mid})` };
  }

  const range = company.basic_info?.employee_count_range;
  if (typeof range === "string") {
    const parsed = parseEmployeeRange(range);
    if (parsed) {
      const mid = rangeMidpoint(parsed.lo, parsed.hi);
      return { tier: tierFromHeadcount(mid), basis: `basic_info.employee_count_range="${range}" (midpoint ${mid})` };
    }
  }

  const funding = company.funding?.total_investment_usd;
  if (isCount(funding) && funding > 0) {
    const tier: Tier =
      funding >= ENTERPRISE_MIN_FUNDING_USD ? "enterprise" : funding >= MID_MARKET_MIN_FUNDING_USD ? "mid_market" : "smb";
    return { tier, basis: `no headcount; funding.total_investment_usd=${funding}` };
  }

  return { tier: "unknown", basis: "no headcount or funding fields" };
}

// ---------------------------------------------------------------------------------------------
// Policy table: tier x plan x request type -> outcome

export interface PolicyRule {
  outcome: PolicyOutcome;
  why: string;
}

type PlanRow = Record<RequestType, PolicyRule>;

const r = (outcome: PolicyOutcome, why: string): PolicyRule => ({ outcome, why });

// The same row for every plan when the tier alone decides.
const unknownRow: PlanRow = {
  refund: r("escalate", "company unverified; money out needs a human"),
  partial_refund: r("escalate", "company unverified; money out needs a human"),
  plan_change: r("approve", "customer-initiated plan change; Dodo bills the difference"),
  credit: r("deny", "no goodwill credit for an unverified company"),
};

export const POLICY_TABLE: Record<Tier, Record<Plan, PlanRow>> = {
  smb: {
    starter: {
      refund: r("approve", "small self-serve account; full refund"),
      partial_refund: r("approve", "small self-serve account; refund the amount asked"),
      plan_change: r("approve", "self-serve plan change"),
      credit: r("deny", "starter has no goodwill credits; offer a refund instead"),
    },
    growth: {
      refund: r("partial", "SMB on growth: refund half the payment"),
      partial_refund: r("approve", "refund the amount asked"),
      plan_change: r("approve", "self-serve plan change"),
      credit: r("approve", "goodwill credit within the SMB cap"),
    },
    scale: {
      refund: r("escalate", "SMB on the top plan is atypical; human review"),
      partial_refund: r("escalate", "SMB on the top plan is atypical; human review"),
      plan_change: r("approve", "self-serve plan change"),
      credit: r("approve", "goodwill credit within the SMB cap"),
    },
  },
  mid_market: {
    starter: {
      refund: r("approve", "full refund"),
      partial_refund: r("approve", "refund the amount asked"),
      plan_change: r("approve", "plan change"),
      credit: r("deny", "starter has no goodwill credits; offer a refund instead"),
    },
    growth: {
      refund: r("approve", "full refund"),
      partial_refund: r("approve", "refund the amount asked"),
      plan_change: r("approve", "plan change"),
      credit: r("approve", "goodwill credit within the mid-market cap"),
    },
    scale: {
      refund: r("partial", "large plan payment: refund half, account team follows up"),
      partial_refund: r("approve", "refund the amount asked"),
      plan_change: r("approve", "plan change"),
      credit: r("approve", "goodwill credit within the mid-market cap"),
    },
  },
  enterprise: {
    starter: {
      refund: r("approve", "small plan for a large company; full refund"),
      partial_refund: r("approve", "refund the amount asked"),
      plan_change: r("approve", "plan change"),
      credit: r("approve", "goodwill credit within the enterprise cap"),
    },
    growth: {
      refund: r("escalate", "contract account; the account manager decides full refunds"),
      partial_refund: r("approve", "refund the amount asked"),
      plan_change: r("approve", "plan change"),
      credit: r("approve", "goodwill credit within the enterprise cap"),
    },
    scale: {
      refund: r("escalate", "contract account; the account manager decides full refunds"),
      partial_refund: r("escalate", "contract account on the top plan; account manager decides"),
      plan_change: r("escalate", "top-plan enterprise changes go through the account manager"),
      credit: r("approve", "goodwill credit within the enterprise cap"),
    },
  },
  unknown: { starter: unknownRow, growth: unknownRow, scale: unknownRow },
};

// ---------------------------------------------------------------------------------------------
// Amount rules

/** A "partial" outcome refunds this share of the base amount, in basis points (5000 = 50%). */
export const PARTIAL_REFUND_BPS = 5000;

/** Largest goodwill credit approved without a human, per tier, in minor units. */
export const CREDIT_CAP_MINOR: Record<Tier, number> = {
  smb: 5_000, // $50.00
  mid_market: 20_000, // $200.00
  enterprise: 100_000, // $1,000.00
  unknown: 0,
};

/**
 * The partial share of an amount. Rounding rule: FLOOR to the minor unit, so the customer never
 * gets more than the policy share (1999 at 50% -> 999, not 1000).
 */
export function partialShare(amountMinor: number): number {
  return Math.floor((amountMinor * PARTIAL_REFUND_BPS) / 10_000);
}

export interface PolicyInput {
  tier: Tier;
  plan: string;
  type: RequestType;
  /** The amount the request asks for (QueueRequest.amount), minor units. */
  amount?: number;
  /** The payment's total_amount from Dodo, minor units. */
  paymentAmount?: number;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  action: PolicyAction;
  /**
   * Money moved by the action, minor units: the refund amount for createRefund, the credit amount
   * for createWalletLedgerEntry. Absent for plan changes, deny and escalate, and for a full refund
   * whose payment amount is not known (a full refund needs no amount).
   */
  refundAmount?: number;
  reason: string;
}

function isPlan(plan: string): plan is Plan {
  return (PLANS as readonly string[]).includes(plan);
}

const none = (outcome: "deny" | "escalate", reason: string): PolicyDecision => ({ outcome, action: "none", reason });

/** Decide what to do with one request. Deterministic; no I/O. */
export function decidePolicy(input: PolicyInput): PolicyDecision {
  const { tier, plan, type, amount, paymentAmount } = input;
  if (!isPlan(plan)) return none("escalate", `unknown plan "${plan}"; not in the policy table`);

  const rule = POLICY_TABLE[tier][plan][type];
  const why = `${tier} x ${plan} x ${type}: ${rule.why}`;

  if (rule.outcome === "deny" || rule.outcome === "escalate") return none(rule.outcome, why);

  if (rule.outcome === "partial") {
    if (type === "plan_change") return none("escalate", `${why}; a partial plan change is not meaningful`);
    const base = type === "refund" ? paymentAmount : amount;
    if (base === undefined) return none("escalate", `${why}; no amount to take a share of`);
    const share = partialShare(base);
    const action: PolicyAction = type === "credit" ? "dodo.createWalletLedgerEntry" : "dodo.createRefund";
    return {
      outcome: "partial",
      action,
      refundAmount: share,
      reason: `${why} (${PARTIAL_REFUND_BPS / 100}% of ${base} = ${share}, floored to the minor unit)`,
    };
  }

  // approve
  switch (type) {
    case "refund": {
      if (amount !== undefined && paymentAmount !== undefined && amount !== paymentAmount) {
        return none("escalate", `${why}; requested ${amount} differs from the payment total ${paymentAmount}`);
      }
      return paymentAmount === undefined
        ? { outcome: "approve", action: "dodo.createRefund", reason: why }
        : { outcome: "approve", action: "dodo.createRefund", refundAmount: paymentAmount, reason: why };
    }
    case "partial_refund": {
      if (amount === undefined) return none("escalate", `${why}; the request states no amount`);
      if (amount === 0) return none("deny", `${why}; nothing to refund (amount 0)`);
      if (paymentAmount !== undefined && amount > paymentAmount) {
        return none("deny", `${why}; requested ${amount} exceeds the payment total ${paymentAmount}`);
      }
      return { outcome: "approve", action: "dodo.createRefund", refundAmount: amount, reason: why };
    }
    case "plan_change":
      return { outcome: "approve", action: "dodo.changeSubscriptionPlan", reason: why };
    case "credit": {
      if (amount === undefined) return none("escalate", `${why}; the request states no amount`);
      if (amount === 0) return none("deny", `${why}; nothing to credit (amount 0)`);
      const cap = CREDIT_CAP_MINOR[tier];
      if (amount > cap) return none("escalate", `${why}; ${amount} is over the ${tier} credit cap ${cap}`);
      return { outcome: "approve", action: "dodo.createWalletLedgerEntry", refundAmount: amount, reason: why };
    }
  }
}
