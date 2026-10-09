/**
 * Deterministic contract checker (TDD "The notarization loop", step 1). No LLM, no network, no
 * clock, no randomness: the same claim and exchanges always produce byte-identical anomalies.
 *
 * Rule semantics are specified in src/contracts/types.ts. Choices that file leaves open:
 * - One anomaly per (exchange, violation); a rule that finds several bad values in one response
 *   (type, fieldPresent) reports them together in one anomaly.
 * - A value that is missing is not a `type` violation (that is `fieldPresent`'s job); `null` is
 *   present for `fieldPresent`.
 * - `type` accepts a `|` union ("string|null"); `iso-datetime` is an ISO-8601 date-time string
 *   with an optional timezone. An unknown type name throws (a broken contract, not an anomaly).
 * - `unit` pairs sent and echoed values by position when both paths expand to the same number of
 *   values; otherwise (or when either side is missing) the exchange is not comparable and skipped.
 *   The round trip is unit-agnostic: whatever `unit` says, the echo must equal what was sent.
 * - `statusOnError` and `errorOnUnknownParam` inspect every status; exchanges that never got a
 *   response (status 0) are skipped as uninformative.
 * - `idempotentOnRetry` with `claim.param` "" compares whole response bodies.
 * - `consistentWithin` measures "issued" from `recordedAt` (set before the request is sent); if
 *   the write failed or its id is missing, nothing can be checked and no anomaly is emitted.
 *   "Contains the id" means some leaf value equals it exactly.
 */
import { canonicalJson, sha256Hex } from "../bundle/hash.js";
import type { Anomaly, Claim } from "../schema/index.js";
import type { Exchange } from "../tools/index.js";
import type { ContractEntry } from "../contracts/types.js";
import { containsValue, resolvePath, valuesAt } from "./path.js";

export interface Observation {
  claimId: string;
  exchange: Exchange;
}

/** How many offending values one anomaly lists before truncating (the count is always exact). */
const MAX_LISTED = 10;

const LIST_KEYS = ["items", "data", "results", "companies", "records"] as const;

function is2xx(ex: Exchange): boolean {
  return ex.status >= 200 && ex.status < 300;
}

function traceIds(ex: Exchange): { traceId: string; spanId: string } {
  const e = ex as Exchange & { traceId?: unknown; spanId?: unknown };
  return {
    traceId: typeof e.traceId === "string" ? e.traceId : "",
    spanId: typeof e.spanId === "string" ? e.spanId : "",
  };
}

export function anomalyId(claimId: string, ex: Pick<Exchange, "requestHash" | "occurrence">, detail: string): string {
  return `anom-${sha256Hex(`${claimId}|${ex.requestHash}|${ex.occurrence}|${detail}`).slice(0, 12)}`;
}

function anomaly(claim: Claim, ex: Exchange, detail: string, observed: unknown, expected: unknown): Anomaly {
  return {
    id: anomalyId(claim.id, ex, detail),
    claimId: claim.id,
    tool: claim.tool,
    observed,
    expected,
    exchangeId: ex.requestHash,
    ...traceIds(ex),
  };
}

// ---------------------------------------------------------------------------------------------
// Value helpers

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
  "iso-datetime": (v) => typeof v === "string" && ISO_DATETIME.test(v) && !Number.isNaN(Date.parse(v)),
};

function typeMatcher(type: string): (v: unknown) => boolean {
  const checks = type.split("|").map((t) => {
    const check = TYPE_CHECKS[t.trim()];
    if (!check) throw new Error(`Unknown type in expect rule: ${JSON.stringify(type)}`);
    return check;
  });
  return (v) => checks.some((c) => c(v));
}

function responseList(body: unknown): { key: string; list: unknown[] } | null {
  if (Array.isArray(body)) return { key: "", list: body };
  if (body !== null && typeof body === "object") {
    for (const key of LIST_KEYS) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return { key, list: v };
    }
  }
  return null;
}

/** The size a request asked for via `param`: a number, or an array's length. Body first, then URL query. */
function requestedSize(ex: Exchange, param: string): number | null {
  if (param === "") return null;
  const fromBody = valuesAt(ex.requestBody, param)[0];
  const candidate = fromBody !== undefined ? fromBody : queryParam(ex.url, param);
  if (Array.isArray(candidate)) return candidate.length;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string" && candidate.trim() !== "" && Number.isFinite(Number(candidate))) return Number(candidate);
  return null;
}

function queryParam(url: string, name: string): string | undefined {
  try {
    return new URL(url).searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function sameValue(a: unknown, b: unknown): boolean {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na === nb;
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function limited<T>(items: T[]): { items: T[]; count: number; truncated: boolean } {
  return { items: items.slice(0, MAX_LISTED), count: items.length, truncated: items.length > MAX_LISTED };
}

// ---------------------------------------------------------------------------------------------
// Rules

export function checkClaim(claim: Claim, exchanges: Exchange[]): Anomaly[] {
  const rule = claim.expect;
  const out: Anomaly[] = [];

  switch (rule.kind) {
    case "maxItems": {
      for (const ex of exchanges) {
        if (!is2xx(ex)) continue;
        const found = responseList(ex.responseBody);
        if (found && found.list.length > rule.max) {
          out.push(
            anomaly(
              claim,
              ex,
              "maxItems:listLength",
              { listKey: found.key, listLength: found.list.length, status: ex.status },
              { maxItems: rule.max },
            ),
          );
        }
        const requested = requestedSize(ex, claim.param);
        if (requested !== null && requested > rule.max) {
          out.push(
            anomaly(
              claim,
              ex,
              "maxItems:requestAboveMax",
              { param: claim.param, requested, status: ex.status, listLength: found ? found.list.length : null },
              { maxItems: rule.max, onRequestAboveMax: "non-2xx (limit enforced)" },
            ),
          );
        }
      }
      break;
    }

    case "type": {
      const matches = typeMatcher(rule.type);
      for (const ex of exchanges) {
        if (!is2xx(ex)) continue;
        const bad = resolvePath(ex.responseBody, rule.field)
          .filter((h) => h.found && !matches(h.value))
          .map((h) => ({ path: h.path, type: typeOf(h.value), value: h.value ?? null }));
        if (bad.length === 0) continue;
        const l = limited(bad);
        out.push(
          anomaly(
            claim,
            ex,
            `type:${rule.field}`,
            { field: rule.field, mismatches: l.items, count: l.count, truncated: l.truncated },
            { field: rule.field, type: rule.type },
          ),
        );
      }
      break;
    }

    case "unit": {
      for (const ex of exchanges) {
        if (!is2xx(ex)) continue;
        const sent = resolvePath(ex.requestBody, claim.param).filter((h) => h.found);
        const echoed = resolvePath(ex.responseBody, rule.field).filter((h) => h.found);
        if (sent.length === 0 || sent.length !== echoed.length) continue;
        sent.forEach((s, i) => {
          const e = echoed[i]!;
          if (sameValue(s.value, e.value)) return;
          const sn = asNumber(s.value);
          const en = asNumber(e.value);
          const ratio = sn !== null && en !== null && sn !== 0 ? en / sn : null;
          out.push(
            anomaly(
              claim,
              ex,
              `unit:${i}`,
              { sentPath: s.path, sent: s.value ?? null, echoedPath: e.path, echoed: e.value ?? null, ratio },
              { unit: rule.unit, echoed: s.value ?? null },
            ),
          );
        });
      }
      break;
    }

    case "statusOnError": {
      for (const ex of exchanges) {
        if (ex.status === 0) continue;
        if (ex.status !== rule.status) {
          out.push(anomaly(claim, ex, "statusOnError", { status: ex.status }, { status: rule.status }));
        }
      }
      break;
    }

    case "idempotentOnRetry": {
      const firstId = new Map<string, unknown>();
      for (const ex of exchanges) {
        if (!is2xx(ex)) continue;
        const id = claim.param === "" ? ex.responseBody : valuesAt(ex.responseBody, claim.param)[0];
        if (id === undefined) continue;
        if (!firstId.has(ex.requestHash)) {
          firstId.set(ex.requestHash, id);
          continue;
        }
        const first = firstId.get(ex.requestHash);
        if (!sameValue(first, id)) {
          out.push(
            anomaly(
              claim,
              ex,
              "idempotentOnRetry",
              { idPath: claim.param, id, occurrence: ex.occurrence },
              { idPath: claim.param, id: first ?? null },
            ),
          );
        }
      }
      break;
    }

    case "errorOnUnknownParam": {
      for (const ex of exchanges) {
        if (!is2xx(ex)) continue;
        out.push(
          anomaly(
            claim,
            ex,
            "errorOnUnknownParam",
            { param: claim.param, status: ex.status, ignored: true },
            { param: claim.param, status: "non-2xx (unknown param rejected)" },
          ),
        );
      }
      break;
    }

    case "fieldPresent": {
      for (const ex of exchanges) {
        if (!is2xx(ex)) continue;
        const missing = resolvePath(ex.responseBody, rule.field)
          .filter((h) => !h.found)
          .map((h) => h.path);
        if (missing.length === 0) continue;
        const l = limited(missing);
        out.push(
          anomaly(
            claim,
            ex,
            `fieldPresent:${rule.field}`,
            { field: rule.field, missing: l.items, count: l.count, truncated: l.truncated },
            { field: rule.field, present: true },
          ),
        );
      }
      break;
    }

    case "consistentWithin": {
      const [write, ...reads] = exchanges;
      if (!write || !is2xx(write)) break;
      const id = valuesAt(write.responseBody, claim.param)[0];
      if (id === undefined || id === null) break;
      const writeAt = Date.parse(write.recordedAt);
      if (Number.isNaN(writeAt)) break;
      for (const ex of reads) {
        if (!is2xx(ex)) continue;
        const readAt = Date.parse(ex.recordedAt);
        if (Number.isNaN(readAt)) continue;
        const afterMs = readAt - writeAt;
        if (afterMs < rule.ms) continue;
        if (containsValue(ex.responseBody, id)) continue;
        out.push(
          anomaly(
            claim,
            ex,
            "consistentWithin",
            { id, readAfterMs: afterMs, found: false, op: ex.op },
            { id, visibleWithinMs: rule.ms },
          ),
        );
      }
      break;
    }

    default: {
      const never: never = rule;
      throw new Error(`Unknown expect rule: ${JSON.stringify(never)}`);
    }
  }

  return dedupe(out);
}

function dedupe(anomalies: Anomaly[]): Anomaly[] {
  const seen = new Set<string>();
  return anomalies.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

/**
 * Check every entry against the exchanges observed for it (association is by observation claimId
 * only; use observationsByOperation to build observations for queue traffic). Output order: by claimId (code-unit
 * order), then exchange order within the observations. Observations for unknown claims are ignored.
 */
export function checkAll(entries: ContractEntry[], observations: Observation[]): Anomaly[] {
  const byClaim = new Map<string, Exchange[]>();
  for (const o of observations) {
    const list = byClaim.get(o.claimId) ?? [];
    list.push(o.exchange);
    byClaim.set(o.claimId, list);
  }
  const claims = [...new Map(entries.map((e) => [e.claim.id, e.claim])).values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const out: Anomaly[] = [];
  for (const claim of claims) out.push(...checkClaim(claim, byClaim.get(claim.id) ?? []));
  return dedupe(out);
}

/**
 * Rules whose exchanges must be crafted on purpose (deliberately invalid requests, an unknown
 * param, a write followed by timed reads). Ordinary queue traffic says nothing about them.
 */
const CRAFTED_ONLY = new Set(["statusOnError", "errorOnUnknownParam", "consistentWithin"]);

/**
 * Queue/probe traffic: associate each exchange with every claim that has NO recon steps and whose
 * `operation` equals the exchange's op, except claims whose rule needs crafted exchanges (see
 * CRAFTED_ONLY). Claims with recon steps are judged on their recon observations only (some hold
 * only under the state their recon sets up, e.g. a fresh wallet).
 */
export function observationsByOperation(entries: ContractEntry[], exchanges: Exchange[]): Observation[] {
  const out: Observation[] = [];
  for (const ex of exchanges) {
    for (const e of entries) {
      if (e.recon.length === 0 && e.claim.operation === ex.op && !CRAFTED_ONLY.has(e.claim.expect.kind)) {
        out.push({ claimId: e.claim.id, exchange: ex });
      }
    }
  }
  return out;
}
