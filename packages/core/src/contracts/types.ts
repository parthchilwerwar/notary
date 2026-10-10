import type { Claim } from "../schema/index.js";

/**
 * A contract entry is one documented promise (Claim) plus the cheap recon steps that exercise it.
 *
 * Expect-rule semantics. The checker evaluates `claim.expect` over the exchanges associated with
 * the claim: the exchanges its recon steps produced, or, for queue/probe traffic, every exchange
 * whose op equals `claim.operation`. Field paths are dotted with `[]` for "each element", e.g.
 * `items[].amount`. Only 2xx exchanges are inspected unless the rule says otherwise. A 2xx response
 * in which the path a rule reads resolves to nothing is UNOBSERVABLE for the claim (no anomaly, and
 * not evidence that it holds; see checkClaimDetailed in src/checker/check.ts), except for
 * fieldPresent, where absence is the violation.
 *
 * - maxItems {max}: the response list (the body if it is an array, else the first array among
 *   body.items | data | results | companies | records) has length <= max. `claim.param` names the
 *   request param that sets the page size ("" if none). Anomaly if a list is longer than max, or
 *   if a request asked for more than max and got a 2xx anyway (the limit was not visibly enforced).
 * - type {field, type}: every value at response path `field` has `type`
 *   (string | number | integer | boolean | object | array | null | iso-datetime).
 * - unit {field, unit}: round trip in one exchange. `claim.param` is the request-body path of the
 *   amount sent, `field` the response path that echoes it. unit "minor" holds when the echoed
 *   value equals the sent value. Anomaly records both values and their ratio.
 * - statusOnError {status}: the associated exchanges were deliberately invalid; anomaly if any
 *   returned a different status (including a 2xx).
 * - idempotentOnRetry {}: among exchanges with the same requestHash, anomaly if more than one 2xx
 *   returned a different resource id (`claim.param` = response path of the id).
 * - errorOnUnknownParam {}: the associated exchanges sent the unknown param named in
 *   `claim.param`; anomaly if any returned 2xx (silently ignored).
 * - fieldPresent {field}: anomaly if `field` is missing in any 2xx response.
 * - consistentWithin {ms}: first associated exchange is a write whose created id is at response
 *   path `claim.param`; later exchanges are reads. Anomaly if a read issued >= ms after the write
 *   does not contain that id anywhere in its body.
 */

/** A value of the form "$from:<stepIndex>:<path>" is resolved from an earlier step's response body. */
export type ReconParam = unknown;

export interface ReconStep {
  /** createTools op name, e.g. "dodo.listRefunds" or "crustdata.enrichCompany". */
  op: string;
  params: Record<string, ReconParam>;
  /** Send the identical request this many times (retry probes). Default 1. */
  repeat?: number;
  /** Wait before this step (consistency reads). Capped by the recon runner. */
  delayMs?: number;
  /**
   * Setup step (e.g. create the customer a wallet claim needs). Its response feeds "$from" refs but
   * its exchanges are NOT associated with the claim, so a 200 from setup never trips
   * statusOnError and a setup body never trips fieldPresent. Default false.
   */
  setup?: boolean;
  note: string;
}

export interface ContractEntry {
  claim: Claim;
  /** Steps whose exchanges are associated with this claim. Empty = observed only from queue traffic. */
  recon: ReconStep[];
}
