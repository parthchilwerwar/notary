/**
 * Beta-binomial belief math (TDD "The notarization loop", step 7; PRD FR-5).
 *
 * DEFINITION. Each belief is a Beta(α, β) posterior over θ, the rate at which the doc claim holds
 * (the probability that one informative probe of the claim comes back "honored"). Starting point:
 * Beta(1, 1) (uniform) or a transfer prior. A confirmed "honored" probe adds 1 to α, a confirmed
 * violation adds 1 to β.
 *
 *     confidence = P(holds) = P(θ > 0.5 | Beta(α, β)) = 1 − I_{0.5}(α, β)
 *
 * where I_x is the regularized incomplete beta function. So "the claim holds" means "the claim
 * holds more often than not", and P(holds) is the posterior mass on that.
 *
 * Exact for integer α, β via the binomial-sum identity
 *     I_x(a, b) = P(Binomial(n = a + b − 1, x) ≥ a)
 * which at x = 0.5 gives
 *     P(holds) = Σ_{j=0}^{α−1} C(α+β−1, j) / 2^(α+β−1).
 * The sum is evaluated in log space (log-sum-exp), so large counts never underflow.
 * Non-integer α or β (transfer priors may be fractional) fall back to the Lentz continued fraction
 * for I_x (Numerical Recipes `betacf`), accurate to ~1e-12.
 *
 * Known values: Beta(1,1) → 0.5; Beta(1,4) → 1/16 = 0.0625; Beta(4,1) → 15/16 = 0.9375;
 * P(holds | α, β) = 1 − P(holds | β, α) (symmetry).
 *
 * Thresholds reached from Beta(1,1) with same-side confirmed probes only:
 *   honored  > 0.9: Beta(4,1) = 0.9375 (3 probes; Beta(3,1) = 0.875 is not enough)
 *   violated < 0.1: Beta(1,4) = 0.0625 (3 probes; Beta(1,3) = 0.125 is not enough)
 */

const LN2 = Math.LN2;

function isPositiveInteger(x: number): boolean {
  return Number.isInteger(x) && x > 0;
}

function assertParams(alpha: number, beta: number): void {
  if (!(alpha > 0) || !(beta > 0) || !Number.isFinite(alpha) || !Number.isFinite(beta)) {
    throw new RangeError(`Beta(α, β) needs finite α, β > 0; got Beta(${alpha}, ${beta})`);
  }
}

/** Exact P(θ > 0.5) for integer α, β (binomial-sum identity, log space). */
function pHoldsInteger(alpha: number, beta: number): number {
  const n = alpha + beta - 1;
  // log C(n, j) built incrementally; terms are C(n, j) / 2^n for j = 0..α−1.
  let logC = 0;
  const logs: number[] = [];
  for (let j = 0; j < alpha; j++) {
    logs.push(logC - n * LN2);
    logC += Math.log(n - j) - Math.log(j + 1);
  }
  const max = Math.max(...logs);
  let sum = 0;
  for (const l of logs) sum += Math.exp(l - max);
  return Math.min(1, Math.max(0, Math.exp(max) * sum));
}

/** Lanczos approximation of ln Γ(x), x > 0. */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xx = x - 1;
  let a = c[0]!;
  const t = xx + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (modified Lentz). */
function betacf(x: number, a: number, b: number): number {
  const MAXIT = 300;
  const EPS = 1e-15;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b), numeric (any a, b > 0). */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  assertParams(a, b);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) return (front * betacf(x, a, b)) / a;
  return 1 - (front * betacf(1 - x, b, a)) / b;
}

/** P(holds) = P(θ > 0.5 | Beta(α, β)). Exact for integer α, β; numeric otherwise. */
export function pHolds(alpha: number, beta: number): number {
  assertParams(alpha, beta);
  if (alpha === beta) return 0.5; // exact by symmetry (no rounding drift on the unlearn line)
  if (isPositiveInteger(alpha) && isPositiveInteger(beta)) return pHoldsInteger(alpha, beta);
  return Math.min(1, Math.max(0, 1 - regularizedIncompleteBeta(0.5, alpha, beta)));
}

/** The belief's `confidence` field: P(holds). Alias kept for readability at call sites. */
export const confidenceOf = pHolds;

/** Posterior mean E[θ] = α / (α + β). */
export function posteriorMean(alpha: number, beta: number): number {
  assertParams(alpha, beta);
  return alpha / (alpha + beta);
}

/** TDD step 7 thresholds. */
export const CANDIDATE_HOLDS_ABOVE = 0.9;
export const CANDIDATE_VIOLATED_BELOW = 0.1;
/** A notarized belief unlearns when P(holds) crosses back over this line. */
export const UNLEARN_LINE = 0.5;
/** Independent probes required before a belief can become a candidate. */
export const MIN_INDEPENDENT_PROBES = 2;

export type Side = "honored" | "violated";

/** Which threshold (if any) P(holds) is past. */
export function sidePastThreshold(confidence: number): Side | null {
  if (confidence > CANDIDATE_HOLDS_ABOVE) return "honored";
  if (confidence < CANDIDATE_VIOLATED_BELOW) return "violated";
  return null;
}
