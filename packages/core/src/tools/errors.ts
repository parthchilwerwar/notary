/**
 * Typed errors for the tool layer. Callers branch on the class (or on `isBlocked`) rather than on
 * message text, except that a missing credential always reads "BLOCKED: <VAR> not set" so a run
 * log makes the reason obvious.
 */

/**
 * A live call needs a credential that isn't in the environment. Thrown before any network I/O.
 * `hint` (optional) is appended as "BLOCKED: <VAR> not set — <hint>" (model settings point to
 * `notary doctor --llm`).
 */
export class MissingCredentialError extends Error {
  readonly variable: string;
  constructor(variable: string, hint?: string) {
    super(`BLOCKED: ${variable} not set${hint ? ` — ${hint}` : ""}`);
    this.name = "MissingCredentialError";
    this.variable = variable;
  }
}

/** The Dodo client refused to start outside test mode (TDD "Security and safety controls"). */
export class TestModeLockError extends Error {
  constructor(reason: string) {
    super(`Dodo test-mode lock: ${reason}`);
    this.name = "TestModeLockError";
  }
}

/** A Crustdata call would push the run past its credit budget. Thrown before the call is made. */
export class BudgetExceededError extends Error {
  readonly endpoint: string;
  readonly estimate: number;
  readonly committed: number;
  readonly budget: number;
  constructor(endpoint: string, estimate: number, committed: number, budget: number) {
    super(
      `Credit budget exceeded: ${endpoint} needs ~${estimate} credits, ${committed} already committed of ${budget}`,
    );
    this.name = "BudgetExceededError";
    this.endpoint = endpoint;
    this.estimate = estimate;
    this.committed = committed;
    this.budget = budget;
  }
}

/** Replay mode had no recorded exchange for this request. Replay never falls back to the network. */
export class CassetteMissError extends Error {
  readonly op: string;
  readonly method: string;
  readonly url: string;
  readonly requestHash: string;
  readonly occurrence: number;
  constructor(op: string, method: string, url: string, requestHash: string, occurrence: number) {
    super(
      `Cassette miss: ${op} ${method} ${url} (hash ${requestHash.slice(0, 12)}, occurrence ${occurrence})`,
    );
    this.name = "CassetteMissError";
    this.op = op;
    this.method = method;
    this.url = url;
    this.requestHash = requestHash;
    this.occurrence = occurrence;
  }
}

/** The request never got an HTTP response (timeout, DNS, reset). Recorded, and re-thrown on replay. */
export class ToolNetworkError extends Error {
  readonly op: string;
  readonly exchangeId: string;
  constructor(op: string, exchangeId: string, message: string) {
    super(`${op}: network error: ${message}`);
    this.name = "ToolNetworkError";
    this.op = op;
    this.exchangeId = exchangeId;
  }
}

/** The API answered with a non-2xx status. The body is kept (redacted) for the checker. */
export class ToolHttpError extends Error {
  readonly op: string;
  readonly status: number;
  readonly body: unknown;
  readonly exchangeId: string;
  constructor(op: string, status: number, body: unknown, exchangeId: string) {
    super(`${op}: HTTP ${status}`);
    this.name = "ToolHttpError";
    this.op = op;
    this.status = status;
    this.body = body;
    this.exchangeId = exchangeId;
  }
}

/**
 * The API kept answering 429 (rate limited) after Notary waited out its requested back-off and
 * retried (Crustdata: CRUSTDATA_MAX_429_RETRIES), or asked for a back-off longer than Notary will
 * wait. Still a ToolHttpError (status 429), so callers that branch on HTTP status keep working.
 */
export class RateLimitedError extends ToolHttpError {
  /** HTTP requests made for this call (the original plus retries). */
  readonly attempts: number;
  /** The back-off the last 429 asked for (Retry-After / x-ratelimit-reset), null if it named none. */
  readonly retryAfterMs: number | null;
  constructor(op: string, body: unknown, exchangeId: string, attempts: number, retryAfterMs: number | null, detail: string) {
    super(op, 429, body, exchangeId);
    this.name = "RateLimitedError";
    this.message = `${op}: HTTP 429 rate limited after ${attempts} request${attempts === 1 ? "" : "s"}; ${detail}`;
    this.attempts = attempts;
    this.retryAfterMs = retryAfterMs;
  }
}

/** True when the error means "can't proceed without a credential" (the BLOCKED state). */
export function isBlocked(err: unknown): err is MissingCredentialError {
  return (
    err instanceof MissingCredentialError ||
    (err instanceof Error && err.name === "MissingCredentialError" && err.message.startsWith("BLOCKED:"))
  );
}

/** The request was never sent (refused or cancelled before any I/O): nothing to count or charge. */
export class RequestNotSentError extends Error {
  readonly op: string;
  constructor(op: string, reason: string) {
    super(`${op}: not sent: ${reason}`);
    this.name = "RequestNotSentError";
    this.op = op;
  }
}

/** A request refused by a recorder restricted to `allowedMethods` (Notary Chat's GET-only Dodo client). */
export class ReadOnlyRequestError extends RequestNotSentError {
  constructor(op: string, method: string, allowed: readonly string[]) {
    super(op, `${method} refused — this client may only send ${allowed.join(", ")} (read-only)`);
    this.name = "ReadOnlyRequestError";
  }
}
