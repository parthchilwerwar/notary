/**
 * Generic rate-limit building blocks shared by the Crustdata throttle (src/tools/ratelimit.ts) and the
 * model-call limiter (src/llm/limiter.ts): an injectable Clock (real or virtual), a sliding-window
 * log limiter with a 429 back-off, and the Retry-After / x-ratelimit-reset parser. No tool or
 * provider knowledge lives here. Moved out of src/tools/ratelimit.ts unchanged (it re-exports them).
 *
 * Sliding-window log: at most `limit` request STARTS in any rolling `windowMs`; a caller that would
 * be request limit+1 waits until the oldest start leaves the window. Acquires are serialized, so
 * concurrent callers can't overshoot. A server 429 adds a back-off (`backOff`) that holds every
 * caller of the limiter until it passes.
 */
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
