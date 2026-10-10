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

export interface Clock {
  /** Milliseconds (epoch for the real clock; arbitrary origin for a virtual one). */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** Virtual time: `sleep` advances `now` instantly. Used by fixture transports and tests. */
export class VirtualClock implements Clock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    if (ms > 0) this.t += ms;
  }
  advance(ms: number): void {
    if (ms > 0) this.t += ms;
  }
}

/** Effective Crustdata requests/minute: NOTARY_CRUSTDATA_RPM if a positive integer, never above 15. */
export function crustdataRpmFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CRUSTDATA_RPM_ENV]?.trim();
  if (!raw) return CRUSTDATA_MAX_REQUESTS_PER_WINDOW;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return CRUSTDATA_MAX_REQUESTS_PER_WINDOW;
  return Math.min(CRUSTDATA_MAX_REQUESTS_PER_WINDOW, n);
}

export interface LimiterStats {
  tool: string;
  limit: number;
  windowMs: number;
  /** True when time is virtual (fixture/tests): waits were counted, not slept. */
  virtual: boolean;
  /** Requests admitted (one per live HTTP request). */
  requests: number;
  /** Requests that had to wait for the window (or a 429 back-off) first. */
  waits: number;
  totalWaitMs: number;
  maxWaitMs: number;
  /** 429 back-offs applied. */
  backOffs: number;
}

export class SlidingWindowLimiter {
  private readonly starts: number[] = [];
  private blockedUntil = -Infinity;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly counters = { requests: 0, waits: 0, totalWaitMs: 0, maxWaitMs: 0, backOffs: 0 };

  constructor(
    readonly tool: string,
    readonly limit: number,
    readonly windowMs: number,
    readonly clock: Clock,
    private readonly virtual: boolean,
  ) {
    if (!(limit >= 1)) throw new Error(`rate limit for ${tool} must be ≥ 1 (got ${limit})`);
  }

  /** Wait (if needed) for a slot, then take it. Resolves with the milliseconds waited. */
  acquire(): Promise<number> {
    const turn = this.chain.then(() => this.take());
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  /** The server asked us to back off: hold every caller of this tool for `ms` from now. */
  backOff(ms: number): void {
    this.counters.backOffs += 1;
    this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + Math.max(0, ms));
  }

  stats(): LimiterStats {
    return { tool: this.tool, limit: this.limit, windowMs: this.windowMs, virtual: this.virtual, ...this.counters };
  }

  private async take(): Promise<number> {
    const started = this.clock.now();
    for (;;) {
      const now = this.clock.now();
      // A start at t occupies the window (t - windowMs, t]; at t + windowMs its slot is free.
      while (this.starts.length > 0 && this.starts[0]! <= now - this.windowMs) this.starts.shift();
      let until = this.blockedUntil;
      if (this.starts.length >= this.limit) until = Math.max(until, this.starts[0]! + this.windowMs);
      if (until <= now) break;
      await this.clock.sleep(until - now);
    }
    const now = this.clock.now();
    this.starts.push(now);
    const waited = Math.max(0, now - started);
    this.counters.requests += 1;
    if (waited > 0) {
      this.counters.waits += 1;
      this.counters.totalWaitMs += waited;
      this.counters.maxWaitMs = Math.max(this.counters.maxWaitMs, waited);
    }
    return waited;
  }
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

// ---------------------------------------------------------------------------------------------
// 429 back-off

/**
 * How long a 429 asks us to wait, from `Retry-After` (seconds or HTTP date) or `x-ratelimit-reset`
 * (epoch seconds, epoch ms, or seconds from now; the Crustdata docs name the header without its
 * unit). Relative to `respondedAt` (the exchange's recorded time) so replay computes the same
 * value. Null when neither header is usable.
 */
export function backOffFromHeaders(headers: Record<string, string>, respondedAt: number): number | null {
  const retryAfter = headers["retry-after"]?.trim();
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, Math.ceil(secs * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - respondedAt);
  }
  const reset = headers["x-ratelimit-reset"]?.trim();
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n)) {
      if (n > 1e12) return Math.max(0, n - respondedAt); // epoch ms
      if (n > 1e9) return Math.max(0, n * 1000 - respondedAt); // epoch seconds
      return Math.max(0, Math.ceil(n * 1000)); // seconds from now
    }
    const date = Date.parse(reset);
    if (Number.isFinite(date)) return Math.max(0, date - respondedAt);
  }
  return null;
}
