/**
 * Per-run credit ledger. Crustdata calls reserve their estimated cost BEFORE the request and settle
 * the actual charge after it; a reservation that would cross the budget throws BudgetExceededError
 * so the call never happens. Dodo calls cost no credits but are counted per op.
 */
import { BudgetExceededError } from "./errors.js";

export const DEFAULT_CREDIT_BUDGET = 200;

export interface LedgerSnapshot {
  budget: number;
  /** Credits actually charged (settled). */
  total: number;
  /** Credits held by in-flight reservations. */
  reserved: number;
  remaining: number;
  byEndpoint: Record<string, number>;
  /** Calls per op, for every tool (Dodo included). */
  calls: Record<string, number>;
}

/** Round away float noise (Crustdata charges fractional credits such as 0.03). */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CRUSTDATA_CREDIT_BUDGET?.trim();
  if (!raw) return DEFAULT_CREDIT_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CREDIT_BUDGET;
}

export class CreditLedger {
  readonly budget: number;
  private settled = 0;
  private readonly byEndpointMap = new Map<string, number>();
  private readonly pending = new Map<string, number[]>();
  private readonly callCounts = new Map<string, number>();

  constructor(opts: { budget?: number; env?: NodeJS.ProcessEnv } = {}) {
    this.budget = opts.budget ?? budgetFromEnv(opts.env);
  }

  get total(): number {
    return this.settled;
  }

  get byEndpoint(): Record<string, number> {
    return Object.fromEntries(this.byEndpointMap);
  }

  get reserved(): number {
    let sum = 0;
    for (const list of this.pending.values()) for (const n of list) sum += n;
    return round(sum);
  }

  /** Hold `estimate` credits for one call to `endpoint`. Throws if it would exceed the budget. */
  reserve(endpoint: string, estimate: number): void {
    if (!(estimate >= 0)) throw new Error(`Invalid credit estimate for ${endpoint}: ${estimate}`);
    const committed = round(this.settled + this.reserved);
    if (round(committed + estimate) > this.budget) {
      throw new BudgetExceededError(endpoint, estimate, committed, this.budget);
    }
    const list = this.pending.get(endpoint) ?? [];
    list.push(estimate);
    this.pending.set(endpoint, list);
  }

  /** Charge `actual` credits for a call to `endpoint`, releasing its oldest reservation if any. */
  settle(endpoint: string, actual: number): void {
    if (!(actual >= 0)) throw new Error(`Invalid credit charge for ${endpoint}: ${actual}`);
    this.pending.get(endpoint)?.shift();
    this.settled = round(this.settled + actual);
    this.byEndpointMap.set(endpoint, round((this.byEndpointMap.get(endpoint) ?? 0) + actual));
  }

  /** Drop a reservation without charging (the call was never sent). */
  release(endpoint: string): void {
    this.pending.get(endpoint)?.shift();
  }

  /** Count one call to `op` (any tool). */
  countCall(op: string): void {
    this.callCounts.set(op, (this.callCounts.get(op) ?? 0) + 1);
  }

  snapshot(): LedgerSnapshot {
    const reserved = this.reserved;
    return {
      budget: this.budget,
      total: this.settled,
      reserved,
      remaining: round(this.budget - this.settled - reserved),
      byEndpoint: this.byEndpoint,
      calls: Object.fromEntries(this.callCounts),
    };
  }
}
