/**
 * Process-wide rate limiter in front of every real model call (both providers, all roles), built
 * like the Crustdata throttle (DECISIONS #95) on the same shared pieces (src/ratelimit/window.ts), so it
 * is deterministic and testable on a VirtualClock.
 *
 *   NOTARY_LLM_RPM           request STARTS per rolling minute (sliding-window log). Default 30.
 *   NOTARY_LLM_CONCURRENCY   calls in flight at once (a semaphore; FIFO hand-off). Default 2.
 *
 * Both are positive integers; anything else falls back to the default. One limiter per process
 * (`llmLimiter()`), created from the env on first use: notarize's reflector and adversary, Ask
 * Notary and `doctor --llm` all queue in the same windows. An LlmClient uses it whenever it talks to
 * a real provider; an injected test/fixture transport gets no limiter unless one is passed in.
 *
 * HTTP 429 (OpenAI-style `status` 429 / RateLimitError from LiteLLM, ThrottlingException from
 * Bedrock): the client backs the whole limiter off for `retry-after-ms`, else `Retry-After` /
 * `x-ratelimit-reset` (backOffFromHeaders), else 2 s · 2^(attempt-1), and retries — at most
 * LLM_MAX_429_RETRIES times, never waiting more than LLM_MAX_BACKOFF_MS per back-off — re-checking
 * NOTARY_MAX_USD before every attempt. Usage and USD are recorded once, for the attempt that
 * succeeded. Then it gives up with LlmRateLimitedError, whose message names NOTARY_LLM_RPM and
 * points to `pnpm notary doctor --llm`.
 */
import { SlidingWindowLimiter, backOffFromHeaders, realClock } from "../ratelimit/window.js";
import type { Clock } from "../ratelimit/window.js";
import { AGENTS } from "../schema/agents.js";

type Env = Record<string, string | undefined>;

export const LLM_RPM_ENV = "NOTARY_LLM_RPM";
export const LLM_CONCURRENCY_ENV = "NOTARY_LLM_CONCURRENCY";
export const DEFAULT_LLM_RPM = 30;
export const DEFAULT_LLM_CONCURRENCY = 2;
export const LLM_RATE_WINDOW_MS = 60_000;
/** Retries after a 429 (so at most 1 + 3 attempts per call). */
export const LLM_MAX_429_RETRIES = 3;
/** Longest single back-off Notary waits out; a longer Retry-After gives up at once. */
export const LLM_MAX_BACKOFF_MS = 60_000;
/** Back-off when the 429 names none: 2 s, 4 s, 8 s. */
export const LLM_DEFAULT_BACKOFF_MS = 2_000;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = (env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

export function llmRpmFromEnv(env: Env = process.env): number {
  return positiveInt(env, LLM_RPM_ENV, DEFAULT_LLM_RPM);
}

export function llmConcurrencyFromEnv(env: Env = process.env): number {
  return positiveInt(env, LLM_CONCURRENCY_ENV, DEFAULT_LLM_CONCURRENCY);
}

export type LlmLimiterStats = {
  rpm: number;
  concurrency: number;
  virtual: boolean;
  /** Attempts admitted (each is one provider request). */
  requests: number;
  /** Attempts that waited for the window or a back-off. */
  waits: number;
  totalWaitMs: number;
  maxWaitMs: number;
  /** 429 back-offs applied (= retries scheduled). */
  backOffs: number;
  /** Highest number of calls in flight at once. */
  maxInFlight: number;
};

/** A slot: hold it for the duration of one provider request, then release it. */
export type LlmSlot = { waitedMs: number; release: () => void };

export class LlmLimiter {
  readonly rpm: number;
  readonly concurrency: number;
  readonly clock: Clock;
  readonly virtual: boolean;
  private readonly window: SlidingWindowLimiter;
  private inFlight = 0;
  private maxInFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(opts: { rpm?: number; concurrency?: number; clock?: Clock; env?: Env } = {}) {
    const env = opts.env ?? process.env;
    this.rpm = opts.rpm ?? llmRpmFromEnv(env);
    this.concurrency = opts.concurrency ?? llmConcurrencyFromEnv(env);
    if (!(this.concurrency >= 1)) throw new Error(`Model-call concurrency must be ≥ 1 (got ${this.concurrency})`);
    this.clock = opts.clock ?? realClock;
    this.virtual = this.clock !== realClock;
    this.window = new SlidingWindowLimiter("llm", this.rpm, LLM_RATE_WINDOW_MS, this.clock, this.virtual);
  }

  /** Wait for a concurrency slot, then for the RPM window (and any 429 back-off). */
  async acquire(): Promise<LlmSlot> {
    const t0 = this.clock.now();
    if (this.inFlight < this.concurrency) this.inFlight += 1;
    else await new Promise<void>((resolve) => this.queue.push(resolve)); // slot handed over by release()
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.window.acquire();
    } catch (err) {
      this.releaseSlot();
      throw err;
    }
    let released = false;
    return {
      waitedMs: Math.max(0, this.clock.now() - t0),
      release: () => {
        if (released) return;
        released = true;
        this.releaseSlot();
      },
    };
  }

  /** The provider asked us to back off: hold every model call in this process for `ms`. */
  backOff(ms: number): void {
    this.window.backOff(ms);
  }

  inFlightNow(): number {
    return this.inFlight;
  }

  stats(): LlmLimiterStats {
    const w = this.window.stats();
    return {
      rpm: this.rpm,
      concurrency: this.concurrency,
      virtual: this.virtual,
      requests: w.requests,
      waits: w.waits,
      totalWaitMs: w.totalWaitMs,
      maxWaitMs: w.maxWaitMs,
      backOffs: w.backOffs,
      maxInFlight: this.maxInFlight,
    };
  }

  private releaseSlot(): void {
    const next = this.queue.shift();
    if (next) next(); // the slot passes straight to the next waiter (inFlight unchanged)
    else this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

let processLimiter: LlmLimiter | null = null;
let override: LlmLimiter | null = null;

/** The process-wide limiter (created from `env` on first use). */
export function llmLimiter(env: Env = process.env): LlmLimiter {
  if (override) return override;
  processLimiter ??= new LlmLimiter({ env });
  return processLimiter;
}

/** Install a limiter (tests: a VirtualClock one); returns a function restoring the previous one. */
export function setLlmLimiter(limiter: LlmLimiter | null): () => void {
  const previous = override;
  override = limiter;
  return () => {
    override = previous;
  };
}

/** Forget the process limiter (tests): the next real call re-reads the env. */
export function resetLlmLimiter(): void {
  processLimiter = null;
}

// ---------------------------------------------------------------------------------------------
// 429 handling

function headerRecord(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h || typeof h !== "object") return out;
  if (typeof (h as Headers).forEach === "function" && typeof (h as Headers).get === "function") {
    (h as Headers).forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (typeof v === "string") out[k.toLowerCase()] = v;
  return out;
}

/**
 * When `err` is a provider rate limit (HTTP 429 / RateLimitError / Bedrock ThrottlingException),
 * the back-off it asks for (ms; null = none named). Null when it isn't a rate limit.
 */
export function rateLimitInfo(err: unknown, nowEpochMs: number = Date.now()): { retryAfterMs: number | null } | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { status?: unknown; name?: unknown; headers?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const is429 =
    e.status === 429 ||
    e.name === "RateLimitError" ||
    e.name === "ThrottlingException" ||
    e.$metadata?.httpStatusCode === 429;
  if (!is429) return null;
  const headers = headerRecord(e.headers);
  const ms = Number(headers["retry-after-ms"]);
  if (headers["retry-after-ms"] !== undefined && Number.isFinite(ms) && ms >= 0) return { retryAfterMs: Math.ceil(ms) };
  return { retryAfterMs: backOffFromHeaders(headers, nowEpochMs) };
}

/** Default back-off for retry `attempt` (1-based) when the 429 named none: 2 s, 4 s, 8 s, … */
export function defaultBackOffMs(attempt: number): number {
  return Math.min(LLM_MAX_BACKOFF_MS, LLM_DEFAULT_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
}

/** The provider kept rate-limiting a model call; Notary gave up. */
export class LlmRateLimitedError extends Error {
  readonly role: string;
  readonly modelId: string;
  readonly attempts: number;
  readonly retryAfterMs: number | null;
  constructor(role: string, modelId: string, attempts: number, retryAfterMs: number | null, limits: { rpm: number; concurrency: number }, detail?: string) {
    super(
      `Model call rate limited (HTTP 429) for the ${(AGENTS as Readonly<Record<string, { name: string } | undefined>>)[role]?.name ?? role} ("${modelId}") after ${attempts} attempt${attempts === 1 ? "" : "s"}${detail ? `; ${detail}` : ""}. ` +
        `Lower ${LLM_RPM_ENV} (now ${limits.rpm}/min) or ${LLM_CONCURRENCY_ENV} (now ${limits.concurrency}) in .env and check with \`pnpm notary doctor --llm\``,
    );
    this.name = "LlmRateLimitedError";
    this.role = role;
    this.modelId = modelId;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
  }
}
