// Per-session rate limit for POST /api/ask (local `notary serve`).
//
// NOTARY_ASK_RPM questions per minute (default 10), counted over a sliding 60 s window of the
// questions actually accepted (a 400 or a 429 does not use a slot). One limiter per mounted session:
// `notary serve` creates one session per process, so each process (and each session in tests) has
// its own counter, held in memory only. Time comes from an injectable clock.
//
// This limits questions to the ask endpoint only. The model-call limiter (NOTARY_LLM_RPM /
// NOTARY_LLM_CONCURRENCY) lives in src/llm and is separate. Imports nothing that can act.

type Env = Record<string, string | undefined>;

export const ASK_RPM_ENV = "NOTARY_ASK_RPM";
export const DEFAULT_ASK_RPM = 10;
export const ASK_RATE_WINDOW_MS = 60_000;
const MAX_ASK_RPM = 10_000;

/** The configured questions-per-minute limit; an invalid value falls back to the default with a `problem`. */
export function askRpm(env: Env, override?: number): { rpm: number; problem?: string } {
  if (override !== undefined) {
    if (Number.isInteger(override) && override >= 1 && override <= MAX_ASK_RPM) return { rpm: override };
    return { rpm: DEFAULT_ASK_RPM, problem: `ask rpm must be an integer 1-${MAX_ASK_RPM}, got ${override}; using ${DEFAULT_ASK_RPM}` };
  }
  const raw = (env[ASK_RPM_ENV] ?? "").trim();
  if (!raw) return { rpm: DEFAULT_ASK_RPM };
  const n = Number(raw);
  if (/^\d+$/.test(raw) && n >= 1 && n <= MAX_ASK_RPM) return { rpm: n };
  return { rpm: DEFAULT_ASK_RPM, problem: `${ASK_RPM_ENV} must be an integer 1-${MAX_ASK_RPM}, got ${JSON.stringify(raw)}; using ${DEFAULT_ASK_RPM}` };
}

export type TakeResult = { ok: true } | { ok: false; retryAfterMs: number };

/** Sliding-window counter: at most `limit` accepted takes in any `windowMs`. Synchronous, so check-and-record is atomic. */
export class SlidingWindowLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly now: () => number;
  private readonly accepted: number[] = [];

  constructor(opts: { limit: number; windowMs?: number; now?: () => number }) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs ?? ASK_RATE_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  take(): TakeResult {
    const now = this.now();
    while (this.accepted.length > 0 && this.accepted[0]! <= now - this.windowMs) this.accepted.shift();
    if (this.accepted.length >= this.limit) return { ok: false, retryAfterMs: Math.max(0, this.accepted[0]! + this.windowMs - now) };
    this.accepted.push(now);
    return { ok: true };
  }
}

/** Retry-After header value: whole seconds, at least 1. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
