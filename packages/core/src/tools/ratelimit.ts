/**
 * Process-wide request throttle for rate-limited tools (today: Crustdata only; Dodo is not throttled).
 *
 * Crustdata documents 15 requests per minute for `POST /company/enrich` (docs/ENDPOINTS.md,
 * CRUSTDATA_RATE_LIMIT_DOC). Notary applies that, the tightest documented Crustdata limit, to EVERY
 * Crustdata HTTP request, because recon, the probe loop and the queue executor each build their own
 * createTools()/Recorder in one process (`notarize` = recon then probes; `run` = enrichment). So the
 * limiter is not owned by a Recorder: it lives in the current RateLimitScope, a module-level
 * singleton, and every live Recorder in the process asks the same scope (Recorder.request).
 *
 * Algorithm: sliding-window log. At most `limit` request STARTS in any rolling `windowMs`; a caller
 * that would be request limit+1 waits until the oldest start leaves the window. Acquires are
 * serialized, so concurrent callers can't overshoot. A server 429 adds a back-off (`backOff`) that
 * holds every caller of the tool until it passes.
 *
 * Time is injectable (Clock). Live network traffic uses the real clock. A FIXTURE transport
 * (`setRecorderTransport({fixture: true})`, i.e. `notary demo --fixture`) gets a scope on a
 * VirtualClock: waits are computed, counted and reported in `stats()` but take no wall time.
 * Replay never reaches the limiter at all (cassettes are served without I/O).
 */

import { SlidingWindowLimiter, VirtualClock, backOffFromHeaders, realClock } from "../ratelimit/window.js";
import type { Clock, LimiterStats } from "../ratelimit/window.js";

// The generic pieces live in src/ratelimit/window.ts (shared with the model-call limiter); re-exported
// here so every existing import keeps working.
export { SlidingWindowLimiter, VirtualClock, backOffFromHeaders, realClock };
export type { Clock, LimiterStats };

/** Where the 15/min figure comes from (Crustdata enrich endpoint page; see docs/ENDPOINTS.md). */
export const CRUSTDATA_RATE_LIMIT_DOC =
  "https://docs.crustdata.com/api-reference/company-apis/get-full-company-enrichment.md";
/** Documented Crustdata limit: requests per window. Also the ceiling for the env override. */
export const CRUSTDATA_MAX_REQUESTS_PER_WINDOW = 15;
/** Documented Crustdata window: one minute. */
export const CRUSTDATA_RATE_WINDOW_MS = 60_000;
/** Env override for the per-minute limit: a positive integer, clamped to ≤ 15 (never raises it). */
export const CRUSTDATA_RPM_ENV = "NOTARY_CRUSTDATA_RPM";
/** Retries after a Crustdata 429 (each after the server's back-off); then the call fails cleanly. */
export const CRUSTDATA_MAX_429_RETRIES = 1;
/** Longest server-requested back-off Notary will wait out before its single retry. */
export const CRUSTDATA_MAX_BACKOFF_MS = 2 * CRUSTDATA_RATE_WINDOW_MS;


/** Effective Crustdata requests/minute: NOTARY_CRUSTDATA_RPM if a positive integer, never above 15. */
export function crustdataRpmFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CRUSTDATA_RPM_ENV]?.trim();
  if (!raw) return CRUSTDATA_MAX_REQUESTS_PER_WINDOW;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return CRUSTDATA_MAX_REQUESTS_PER_WINDOW;
  return Math.min(CRUSTDATA_MAX_REQUESTS_PER_WINDOW, n);
}


/** One limiter per throttled tool, all on one clock. */
export class RateLimitScope {
  readonly clock: Clock;
  readonly virtual: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly limiters = new Map<string, SlidingWindowLimiter>();

  constructor(opts: { clock?: Clock; env?: NodeJS.ProcessEnv } = {}) {
    this.clock = opts.clock ?? realClock;
    this.virtual = opts.clock !== undefined && opts.clock !== realClock;
    this.env = opts.env ?? process.env;
  }

  /** The limiter for `tool`, or null when the tool isn't throttled (Dodo). */
  limiter(tool: string): SlidingWindowLimiter | null {
    if (tool !== "crustdata") return null;
    let l = this.limiters.get(tool);
    if (!l) {
      l = new SlidingWindowLimiter(tool, crustdataRpmFromEnv(this.env), CRUSTDATA_RATE_WINDOW_MS, this.clock, this.virtual);
      this.limiters.set(tool, l);
    }
    return l;
  }

  /** Stats per tool that has seen traffic (or `tool` alone; zeros if it hasn't). */
  stats(): LimiterStats[];
  stats(tool: string): LimiterStats | null;
  stats(tool?: string): LimiterStats[] | LimiterStats | null {
    if (tool !== undefined) return this.limiter(tool)?.stats() ?? null;
    return [...this.limiters.values()].map((l) => l.stats());
  }
}

let processScope: RateLimitScope | null = null;
let scopeOverride: RateLimitScope | null = null;

/** The scope every live Recorder in this process throttles through. */
export function rateLimitScope(): RateLimitScope {
  if (scopeOverride) return scopeOverride;
  processScope ??= new RateLimitScope();
  return processScope;
}

/**
 * Install a scope (fixture transport, tests); returns a function restoring the previous one.
 * `setRecorderTransport({fixture: true})` does this automatically with a VirtualClock.
 */
export function setRateLimitScope(scope: RateLimitScope | null): () => void {
  const previous = scopeOverride;
  scopeOverride = scope;
  return () => {
    scopeOverride = previous;
  };
}

/** Forget the process scope (tests): the next live request starts a fresh window and re-reads the env. */
export function resetRateLimitScope(): void {
  processScope = null;
}
