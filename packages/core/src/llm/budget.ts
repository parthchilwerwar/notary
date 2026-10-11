/**
 * Hard per-run USD cap for model calls: NOTARY_MAX_USD (USD; unset = no cap).
 *
 * "Per run" = per LlmClient: one notarize run (or compare-priors arm pair, or one Ask Notary
 * question) builds one client, whose UsageMeter is the run's spend. Before every model call —
 * and before every retry of it — the client checks
 *
 *     spent + estimate(this call) > cap   (or spent ≥ cap)   →  UsdCapExceededError
 *
 * where `estimate` is a deliberately high upper bound when the role's price is known up front (env
 * override or the Bedrock table): input tokens ≈ prompt characters / 2 (real tokenizers average
 * 3–4 characters per token) plus the full output-token cap (maxTokens). With an unknown price (e.g. a
 * LiteLLM model with no NOTARY_PRICE_* override) the estimate is 0, so the cap is enforced on spend
 * already recorded — including the cost LiteLLM reports per response — and the call that crosses
 * it is the last one. The error is thrown before any network I/O, so it never costs anything.
 *
 * Callers stop cleanly on it the way they stop on Crustdata's BudgetExceededError: the probe loop
 * and the adversary phase record it as the run's stopReason and the bundle ends `stopped_budget`;
 * Ask Notary returns its ok:false answer with the message as the reason. Replay re-throws the
 * recorded error by name, so `isUsdCapExceeded` matches on the name, not the class.
 */
import { ModelConfigError } from "./roles.js";
import { AGENTS } from "../schema/agents.js";

type Env = Record<string, string | undefined>;

export const MAX_USD_ENV = "NOTARY_MAX_USD";
/** Characters per token assumed by the pre-call estimate (low on purpose, so the estimate is high). */
export const ESTIMATE_CHARS_PER_TOKEN = 2;

/** The configured cap in USD, or null for no cap. Throws ModelConfigError for an unusable value. */
export function maxUsdFromEnv(env: Env = process.env): number | null {
  const raw = (env[MAX_USD_ENV] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ModelConfigError(`${MAX_USD_ENV} must be a non-negative number of USD per run (got "${raw}"); fix it in .env (see .env.example)`);
  }
  return n;
}

/** Upper-bound input tokens for a prompt of `chars` characters. */
export function estimateInputTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / ESTIMATE_CHARS_PER_TOKEN);
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** A model call would take the run past NOTARY_MAX_USD. Thrown before the call is made. */
export class UsdCapExceededError extends Error {
  readonly cap: number;
  readonly spent: number;
  readonly estimate: number;
  readonly role: string;
  constructor(role: string, cap: number, spent: number, estimate: number) {
    const agent = (AGENTS as Readonly<Record<string, { name: string } | undefined>>)[role]?.name ?? role;
    super(
      `USD cap reached: ${MAX_USD_ENV}=${cap} — ${usd(spent)} already spent this run` +
        (estimate > 0 ? `, the next ${agent} call could cost up to ~${usd(estimate)}` : `, next ${agent} call not made`) +
        ` (raise ${MAX_USD_ENV} in .env to continue)`,
    );
    this.name = "UsdCapExceededError";
    this.cap = cap;
    this.spent = spent;
    this.estimate = estimate;
    this.role = role;
  }
}

/** True for a UsdCapExceededError, including one re-thrown from a replay cassette (matched by name). */
export function isUsdCapExceeded(err: unknown): err is Error {
  return err instanceof UsdCapExceededError || (err instanceof Error && err.name === "UsdCapExceededError");
}

/**
 * The configured cap as stated in a stopReason written from a UsdCapExceededError
 * ("… NOTARY_MAX_USD=<n> …"), or null. Lets a bundle-derived view report the cap without a schema change.
 */
export function usdCapFromStopReason(stopReason: string | undefined): number | null {
  if (!stopReason) return null;
  const m = /\bUSD cap reached: NOTARY_MAX_USD=(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/i.exec(stopReason);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
