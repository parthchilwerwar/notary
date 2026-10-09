/** Errors raised by the guard layer. Neither is fatal to a run: the executor turns both into held decisions. */

/** A guard refused the call outright (a `block` guard, a failed precheck, a missing required param, ...). */
export class GuardBlockedError extends Error {
  readonly guardId: string;
  readonly op: string;
  readonly reason: string;
  constructor(guardId: string, op: string, reason: string) {
    super(`guard ${guardId} blocked ${op}: ${reason}`);
    this.name = "GuardBlockedError";
    this.guardId = guardId;
    this.op = op;
    this.reason = reason;
  }
}

/**
 * A write's outcome stayed unknown (timeout / 5xx) and the read-back could not prove whether it
 * landed, so the guard refused to retry it blindly.
 */
export class UnknownWriteOutcomeError extends Error {
  readonly op: string;
  readonly guardId: string;
  readonly detail: string;
  constructor(guardId: string, op: string, detail: string) {
    super(`${op}: write outcome unknown and not provable by read-back (${detail}); not retried`);
    this.name = "UnknownWriteOutcomeError";
    this.op = op;
    this.guardId = guardId;
    this.detail = detail;
  }
}
