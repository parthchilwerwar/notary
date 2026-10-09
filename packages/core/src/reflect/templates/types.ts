/**
 * Probe templates (TDD "The notarization loop", step 3). Shared types and plumbing.
 *
 * A template turns (claim, rival hypotheses) into a pre-registered experiment:
 *   design    -> treatment steps, CONTROL steps, and one prediction per hypothesis. Predictions are
 *                derived by code from each hypothesis's DefectClass via the template's class table;
 *                the model never writes a prediction.
 *   execute   -> runs control then treatment through a ProbeIo, returning tagged exchanges.
 *   observe   -> reduces the exchanges to a discrete `outcome` (null = uninformative) plus the
 *                instrument readings that must differ between control and treatment.
 *   matches   -> prediction.outcomes contains the observed outcome (or the "*" wildcard).
 *
 * Wildcard: a hypothesis whose class the template cannot speak to gets outcomes ["*"]. It matches
 * every observation, so it can never be refuted (or confirmed against) by this template, and it
 * separates from nothing in the selection score.
 */
import type { ContractEntry, ReconStep } from "../../contracts/types.js";
import type { Anomaly, Claim, DefectClass, Hypothesis, ProbeTemplate } from "../../schema/index.js";
import type { Exchange } from "../../tools/index.js";

/** A recon-style step (op, params with "$from:<i>:<path>" refs, repeat, delayMs, setup) plus a tag. */
export type ProbeStep = ReconStep & { tag?: string };

export interface VariantParams {
  steps: ProbeStep[];
  [key: string]: unknown;
}

export const ANY = "*";

export interface PredictedObservation {
  [key: string]: unknown;
  class: DefectClass;
  /** Outcomes this hypothesis predicts; ["*"] = no prediction under this template. */
  outcomes: string[];
}

export interface ProbeDesign {
  template: ProbeTemplate;
  params: VariantParams;
  control: { params: VariantParams };
  predictions: Record<string, PredictedObservation>;
  estCredits: number;
  estCalls: number;
  /** Probe-reserved Dodo payment ids this design consumes (see PaymentPool). */
  paymentIds?: string[];
}

export interface Skip {
  skip: string;
}

export function isSkip(d: ProbeDesign | Skip): d is Skip {
  return (d as Skip).skip !== undefined;
}

export type Variant = "treatment" | "control";

export interface TaggedExchange {
  variant: Variant;
  step: number;
  tag?: string;
  exchange: Exchange;
}

export interface ProbeObservation {
  [key: string]: unknown;
  /** Discrete result the predictions are matched against; null = uninformative. */
  outcome: string | null;
  treatment: Record<string, unknown>;
  control: Record<string, unknown>;
  /**
   * Readings the template says must DIFFER between control and treatment (instrument check).
   * null = this template/observation has no should-differ reading.
   */
  instrument: { treatment: unknown; control: unknown } | null;
  /** Why the observation is uninformative, when it is. */
  note?: string;
}

/**
 * The tool surface a probe runs against. `call` returns the exchanges the call produced (HTTP
 * errors are data, not exceptions); it throws for BLOCKED, budget, test-mode and cassette misses.
 */
export interface ProbeIo {
  call(op: string, args: unknown[]): Promise<Exchange[]>;
  sleep(ms: number): Promise<void>;
}

export interface CostModel {
  /** Estimated credits for one call of `op` with `params`. */
  creditsPerCall(op: string, params: Record<string, unknown>): number;
}

/** Probe-reserved Dodo payments (succeeded, not referenced by the seeded queue). */
export interface PaymentPool {
  available(): readonly string[];
  consume(ids: readonly string[]): void;
}

export class SimplePaymentPool implements PaymentPool {
  private readonly free: string[];
  constructor(ids: readonly string[] = []) {
    this.free = [...ids];
  }
  available(): readonly string[] {
    return this.free;
  }
  consume(ids: readonly string[]): void {
    for (const id of ids) {
      const i = this.free.indexOf(id);
      if (i >= 0) this.free.splice(i, 1);
    }
  }
}

/** header_burst: hard per-run cap on rate-limit probe requests, shared across all probes. */
export const HEADER_BURST_MAX_REQUESTS_PER_RUN = 10;

export class BurstCapError extends Error {
  constructor(max: number) {
    super(`header_burst cap reached: at most ${max} rate-limit probe requests per run`);
    this.name = "BurstCapError";
  }
}

export class BurstCounter {
  readonly max: number;
  private used = 0;
  constructor(max: number = HEADER_BURST_MAX_REQUESTS_PER_RUN) {
    this.max = Math.min(max, HEADER_BURST_MAX_REQUESTS_PER_RUN);
  }
  get remaining(): number {
    return this.max - this.used;
  }
  get count(): number {
    return this.used;
  }
  /** Take one request from the run's allowance; throws BurstCapError instead of exceeding it. */
  take(): void {
    if (this.used >= this.max) throw new BurstCapError(this.max);
    this.used += 1;
  }
}

export interface ProbeContext {
  runId: string;
  /** Unique per probe within the run (fresh-customer emails, idempotency keys, product names). */
  tag: string;
  anomaly?: Anomaly;
  /** The claim's contract entry (recon steps); default contractEntryById(claim.id). */
  entry?: ContractEntry;
  costs: CostModel;
  burst: BurstCounter;
  payments: PaymentPool;
  /**
   * Which design variant to build (0-based; default 0). Only templates that declare `variants > 1`
   * read it; each variant changes the treatment's value at the claim's parameter (or, for
   * type_edge, the input record) and stamps `variant: k` into the treatment params for k > 0, so
   * every variant has its own design fingerprint (src/beliefs/params.ts).
   */
  variant?: number;
}

export interface ProbeTemplateModule {
  name: ProbeTemplate;
  /** Distinct deterministic designs this template can build per claim (ctx.variant 0..n-1); default 1. */
  variants?: number;
  appliesTo(claim: Claim): boolean;
  design(claim: Claim, hypotheses: readonly Hypothesis[], ctx: ProbeContext): ProbeDesign | Skip;
  execute(io: ProbeIo, design: ProbeDesign, ctx: ProbeContext): Promise<TaggedExchange[]>;
  observe(exchanges: readonly TaggedExchange[], design: ProbeDesign, claim: Claim): ProbeObservation;
  matches(prediction: PredictedObservation, observation: ProbeObservation): boolean;
  informative(observation: ProbeObservation): boolean;
}
