/**
 * Guard compiler (TDD "Queue execution and guards", PRD FR-8).
 *
 * ONLY beliefs with status "notarized" compile, and only on the VIOLATED side: a notarized honored
 * belief means the doc is right, so it needs no guard (it satisfies the gate's requirement as is).
 * Deterministic: same beliefs + probes in, same guards (same ids) out; `compiledAt` is the only clock.
 *
 * Defect class (and claim) -> guard kinds, on the op the guard wraps:
 *
 *   unit_mismatch        transform on claim.operation: scale the request param `claim.param` by
 *                        1 / observed ratio, where the ratio (echoed / sent) is read from the
 *                        belief's cited unit_roundtrip probes (observed.ratio, as runner.ts records it). If the
 *                        cited probes disagree or carry no ratio, there is no safe transform: block.
 *   idempotency_hazard   retry_policy on claim.operation (no blind write retries; on timeout/5xx
 *                        read back and retry only if the read-back proves the write did not land)
 *                        + a precheck where one can refuse the write: createRefund -> existing
 *                        refund (refunds listed completely), changeSubscriptionPlan -> pending change.
 *   silent_truncation    paginate_fully on a list op (iterate until an EMPTY page; a page that adds
 *                        nothing new means page_number stopped advancing -> refuse). On a non-list
 *                        op there is no safe transform: block.
 *   undocumented_flag    require_param on claim.operation for claim.param (adding a known default).
 *   refund-existence     claims about payment.refunds[] (any violated class) -> precheck on
 *                        createRefund that lists the customer's refunds completely instead of
 *                        trusting the payment's refunds[] array.
 *   claim overrides      crustdata default fields -> require_param `fields`; customer missing email
 *                        -> require_param `email`.
 *   anything else        block with the reason (silent_coercion, mislabelled_semantics,
 *                        eventual_consistency, rate_limit, expiry have no safe transform here).
 *
 * Narrowed scope: a belief notarized through an adversary `narrow` holds only inside its scope. A
 * currency scope ("USD only") is compiled into `rule.scope = { currency: ["USD"] }` on every non-block
 * guard; guarded() applies the guard inside it and refuses outside it (unverified there). A scope that
 * doesn't parse into such a condition compiles to block on each op, with the scope in the reason.
 */
import { canonicalJson, sha256Hex } from "../bundle/hash.js";
import { GuardSchema } from "../schema/index.js";
import type { Belief, Claim, DefectClass, Guard, Probe } from "../schema/index.js";

type GuardKind = Guard["kind"];

export interface GuardSpec {
  operation: string;
  kind: GuardKind;
  rule: Record<string, unknown>;
  reason: string;
}

export interface CompileInput {
  beliefs: readonly Belief[];
  /** Claim of a belief (by claim id). */
  claimFor: (claimId: string) => Claim | undefined;
  /** Probes the beliefs cite (extra probes are ignored). */
  probes: readonly Probe[];
  now?: () => Date;
}

/** Dodo list ops that take page_size / page_number. */
export const LIST_OPS: ReadonlySet<string> = new Set([
  "dodo.listRefunds",
  "dodo.listPayments",
  "dodo.listCustomers",
  "dodo.listWalletLedgerEntries",
]);

/** Claims about the payment's refunds[] array (the existing-refund precheck source). */
export const REFUND_EXISTENCE_CLAIMS: ReadonlySet<string> = new Set([
  "dodo.payment.refunds-lists-issued-refund",
  "dodo.payment.refunds-array-present",
]);

/** Known safe defaults for require_param, per op and param. */
export const PARAM_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "crustdata.enrichCompany": { fields: ["basic_info", "headcount", "funding"] },
};

/** Documented max page size for Dodo list endpoints. */
export const PAGINATE_PAGE_SIZE = 100;
export const PAGINATE_MAX_PAGES = 200;

export const RETRY_POLICY_RULE = {
  blindRetries: 0,
  onUnknownOutcome: "read_back",
  retryOnlyIfReadBackProvesNotLanded: true,
  maxAttempts: 2,
} as const;

export function guardId(beliefId: string, operation: string, kind: GuardKind, rule: Record<string, unknown>): string {
  return `grd-${sha256Hex(canonicalJson({ beliefId, operation, kind, rule })).slice(0, 12)}`;
}

/** The side a belief stands on: honored (doc holds) or violated. */
export function beliefSide(b: Belief): "honored" | "violated" {
  if (b.class === "honored") return "honored";
  if (b.class) return "violated";
  return b.confidence >= 0.5 ? "honored" : "violated";
}

/** Ratios (echoed / sent) from the belief's cited unit_roundtrip probes that saw a x100 / div100 outcome. */
export function observedUnitRatios(b: Belief, probesById: ReadonlyMap<string, Probe>): Array<{ probeId: string; ratio: number }> {
  const out: Array<{ probeId: string; ratio: number }> = [];
  for (const ev of b.evidence) {
    if (ev.valid === false) continue;
    const p = probesById.get(ev.probeId);
    if (!p || p.template !== "unit_roundtrip") continue;
    // reflect/runner.ts records `observed` as {outcome, ...observation.treatment}, so the ratio is a
    // top-level field on real probes; `treatment.ratio` is the older nested shape (kept for old records).
    const obs = p.observed as { outcome?: unknown; ratio?: unknown; treatment?: { ratio?: unknown } } | undefined;
    const ratio = obs?.ratio ?? obs?.treatment?.ratio;
    if ((obs?.outcome === "x100" || obs?.outcome === "div100") && typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) {
      out.push({ probeId: p.id, ratio });
    }
  }
  return out;
}

function block(op: string, reason: string): GuardSpec {
  return { operation: op, kind: "block", rule: { reason }, reason };
}

function precheckFor(op: string, cls: DefectClass): GuardSpec | null {
  if (op === "dodo.createRefund") {
    return {
      operation: op,
      kind: "precheck",
      rule: { check: "existing_refund", source: "listRefunds_full", pageSize: PAGINATE_PAGE_SIZE, maxPages: PAGINATE_MAX_PAGES },
      reason: `${cls}: list the customer's refunds completely (and read the payment) before refunding; refuse if one exists`,
    };
  }
  if (op === "dodo.changeSubscriptionPlan") {
    return {
      operation: op,
      kind: "precheck",
      rule: { check: "pending_plan_change" },
      reason: `${cls}: read the subscription first; refuse if a plan change is already scheduled`,
    };
  }
  return null;
}

/** Guard specs for one notarized, violated belief. */
export function specsFor(b: Belief, claim: Claim, probesById: ReadonlyMap<string, Probe>): GuardSpec[] {
  const cls: DefectClass = b.class && b.class !== "honored" ? b.class : "mislabelled_semantics";
  const op = claim.operation;

  // Claim-specific overrides first.
  if (REFUND_EXISTENCE_CLAIMS.has(claim.id)) {
    const pre = precheckFor("dodo.createRefund", cls)!;
    return [{ ...pre, reason: `${claim.id} violated (${cls}): payment.refunds[] is not a complete record; ${pre.reason}` }];
  }
  if (claim.id === "crustdata.enrich.default-fields-basic-info") {
    const def = PARAM_DEFAULTS[op]?.fields;
    return [
      {
        operation: op,
        kind: "require_param",
        rule: { param: "fields", default: def },
        reason: `${claim.id} violated (${cls}): always send fields explicitly`,
      },
    ];
  }
  if (claim.id === "dodo.customer.missing-email-422") {
    return [
      {
        operation: op,
        kind: "require_param",
        rule: { param: "email" },
        reason: `${claim.id} violated (${cls}): the API accepts a customer without email; demand it client-side`,
      },
    ];
  }

  switch (cls) {
    case "unit_mismatch": {
      const ratios = observedUnitRatios(b, probesById);
      if (ratios.length === 0) {
        return [block(op, `${claim.id} violated (unit_mismatch) but no cited probe recorded an observed ratio: no safe transform`)];
      }
      const r0 = ratios[0]!.ratio;
      if (ratios.some((r) => Math.abs(r.ratio - r0) > 1e-9 * Math.max(1, r0))) {
        return [
          block(op, `${claim.id} violated (unit_mismatch) with inconsistent observed ratios ${ratios.map((r) => r.ratio).join(", ")}: no safe transform`),
        ];
      }
      return [
        {
          operation: op,
          kind: "transform",
          rule: {
            param: claim.param,
            scale: 1 / r0,
            observedRatio: r0,
            probeIds: ratios.map((r) => r.probeId),
            requireInteger: true,
          },
          reason: `${claim.id} violated (unit_mismatch): the API echoed ${r0}x what was sent; scale ${claim.param} by 1/${r0} (refuse if not an integer)`,
        },
      ];
    }
    case "idempotency_hazard": {
      const specs: GuardSpec[] = [
        {
          operation: op,
          kind: "retry_policy",
          rule: { ...RETRY_POLICY_RULE },
          reason: `${claim.id} violated (idempotency_hazard): never retry ${op} blindly; on timeout/5xx read back, retry only if it provably did not land`,
        },
      ];
      const pre = precheckFor(op, cls);
      if (pre) specs.push(pre);
      return specs;
    }
    case "silent_truncation": {
      if (LIST_OPS.has(op)) {
        return [
          {
            operation: op,
            kind: "paginate_fully",
            rule: { pageSize: PAGINATE_PAGE_SIZE, stopOn: "empty_page", maxPages: PAGINATE_MAX_PAGES },
            reason: `${claim.id} violated (silent_truncation): one page is not the whole list; page until an empty page`,
          },
        ];
      }
      return [block(op, `${claim.id} violated (silent_truncation) on a non-list op: no safe transform`)];
    }
    case "undocumented_flag": {
      const def = PARAM_DEFAULTS[op]?.[claim.param];
      return [
        {
          operation: op,
          kind: "require_param",
          rule: { param: claim.param, ...(def === undefined ? {} : { default: def }) },
          reason: `${claim.id} violated (undocumented_flag): ${claim.param} must be sent explicitly`,
        },
      ];
    }
    default:
      return [block(op, `${claim.id} violated (${cls}): no safe transform`)];
  }
}

// ------------------------------------------------------------------------------------ scope

/** ISO 4217 codes a narrowed scope may name. ("ALL", the lek, is left out: it reads as "all".) */
export const SCOPE_CURRENCIES: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "INR", "JPY", "CAD", "AUD", "NZD", "CHF", "CNY", "HKD", "SGD", "SEK", "NOK", "DKK", "PLN",
  "CZK", "HUF", "RON", "BGN", "ILS", "TRY", "AED", "SAR", "QAR", "KWD", "BHD", "ZAR", "NGN", "KES", "EGP", "BRL",
  "MXN", "ARS", "CLP", "COP", "PEN", "KRW", "TWD", "THB", "IDR", "MYR", "PHP", "VND", "PKR", "BDT", "LKR", "UAH",
]);

/** Words a currency scope may contain besides the codes ("USD only", "only EUR and GBP refunds"). */
const SCOPE_FILLER: ReadonlySet<string> = new Set([
  "only", "in", "for", "and", "or", "the", "currency", "currencies", "denominated", "payment", "payments", "refund",
  "refunds", "credit", "credits", "charge", "charges", "transaction", "transactions", "amount", "amounts", "wallet", "wallets",
]);

/** Machine-checkable form of a narrowed scope. Only currency scopes are understood. */
export interface GuardScope {
  currency: string[];
}

/** The scope text an adversary `narrow` left on a belief (the store falls back to the reason), else null. */
export function narrowedScopeText(b: Belief): string | null {
  if (b.adversary?.verdict !== "narrow") return null;
  const text = (b.adversary.scope ?? b.adversary.reason).trim();
  return text === "" ? null : text;
}

/** Words that would make a rationale after "<condition>:" a further restriction (then: unparseable). */
const RESTRICTION_MARKERS: ReadonlySet<string> = new Set([
  "only", "except", "excluding", "exclude", "unless", "if", "when", "where", "while", "under", "over", "below", "above",
  "between", "before", "after", "less", "more", "than", "least", "most", "up", "limited", "restricted", "but", "for",
  "on", "in", "from", "to", "within", "per", "via", "by", "not", "no", "without",
]);

function parseCondition(text: string): GuardScope | null {
  const currency = new Set<string>();
  for (const raw of text.split(/[\s,;/&+()-]+/)) {
    const tok = raw.replace(/[.!]+$/, "");
    if (tok === "") continue;
    if (/^[A-Z]{3}$/.test(tok) && SCOPE_CURRENCIES.has(tok)) currency.add(tok);
    else if (!SCOPE_FILLER.has(tok.toLowerCase())) return null;
  }
  return currency.size === 0 ? null : { currency: [...currency].sort() };
}

/** A tail after "<condition>:" counts as rationale only if it cannot add a restriction (conservative). */
function isRationale(tail: string, head: GuardScope): boolean {
  if (/\d/.test(tail)) return false;
  for (const raw of tail.split(/[^A-Za-z0-9_.]+/)) {
    const tok = raw.replace(/\.+$/, "");
    if (tok === "") continue;
    if (RESTRICTION_MARKERS.has(tok.toLowerCase())) return false;
    if (/^[A-Z]{3}$/.test(tok) && SCOPE_CURRENCIES.has(tok) && !head.currency.includes(tok)) return false;
  }
  return true;
}

/**
 * Parse a narrowed scope into a condition guarded() can check, or null. Deliberately strict: the
 * condition may contain only upper-case ISO currency codes and filler words ("USD only", "only EUR and
 * GBP refunds"). A "<condition>: <rationale>" form is accepted when the rationale has no number, no
 * other currency and no restricting word (for/on/under/except/...); otherwise it might narrow further,
 * so the whole scope is not machine-checkable. Anything else returns null.
 */
export function parseScope(text: string): GuardScope | null {
  const colon = text.indexOf(":");
  if (colon === -1) return parseCondition(text);
  const head = parseCondition(text.slice(0, colon));
  return head && isRationale(text.slice(colon + 1), head) ? head : null;
}

/**
 * Apply a belief's narrowed scope to its specs: each non-block spec carries `rule.scope` (guarded()
 * applies it inside the scope and refuses outside it, where the behavior is unverified); an
 * unparseable scope turns every op into a block. Block specs already refuse everywhere.
 */
export function scopeSpecs(b: Belief, claim: Claim, specs: GuardSpec[]): GuardSpec[] {
  const text = narrowedScopeText(b);
  if (text === null) return specs;
  const scope = parseScope(text);
  if (!scope) {
    const ops = [...new Set(specs.map((s) => s.operation))];
    return ops.map((op) =>
      block(op, `${claim.id}: the adversary narrowed this belief to "${text}", which is not a machine-checkable scope; behavior is unverified, so refuse`),
    );
  }
  const label = `currency ${scope.currency.join("/")}`;
  return specs.map((s) =>
    s.kind === "block"
      ? s
      : { ...s, rule: { ...s.rule, scope }, reason: `${s.reason} [narrowed scope: ${label}; outside it the behavior is unverified, so refuse]` },
  );
}

/** Compile every notarized, violated belief into guards (all active). */
export function compileGuards(input: CompileInput): Guard[] {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const probesById = new Map(input.probes.map((p) => [p.id, p]));
  const out = new Map<string, Guard>();
  for (const b of [...input.beliefs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    if (b.status !== "notarized" || beliefSide(b) === "honored") continue;
    const claim = input.claimFor(b.claimId);
    if (!claim) continue;
    const cls: DefectClass = b.class && b.class !== "honored" ? b.class : "mislabelled_semantics";
    for (const s of scopeSpecs(b, claim, specsFor(b, claim, probesById))) {
      const id = guardId(b.id, s.operation, s.kind, s.rule);
      out.set(
        id,
        GuardSchema.parse({
          id,
          beliefId: b.id,
          operation: s.operation,
          kind: s.kind,
          class: cls,
          rule: s.rule,
          reason: s.reason,
          active: true,
          compiledAt: now,
        }),
      );
    }
  }
  return [...out.values()];
}
