// SAMPLE bundle for the dashboard developer (BUILD_PLAN P1). Everything here is synthetic:
// fictional companies on example.com domains, made-up doc text tagged "[sample]", seeded-PRNG
// usage numbers and fixed timestamps. It exists to exercise every field and enum of the frozen
// schema. It must never be presented as a result of running Notary.
import type {
  AdversaryReview,
  Anomaly,
  Belief,
  BeliefEvent,
  BeliefPrior,
  BeliefStatus,
  Claim,
  Decision,
  DecisionStatus,
  DefectClass,
  Effect,
  ExpectRule,
  Guard,
  GuardKind,
  Hypothesis,
  PolicyOutcome,
  Probe,
  ProbeTemplate,
  ProbeVerdict,
  QueueRequest,
  RequestType,
  RoleUsage,
  RunBundle,
  Tier,
  Tool,
  UnsafeAction,
} from "../schema/index.js";
import { canonicalJson, finalizeBundle, sha256Hex } from "./hash.js";

export const SAMPLE_DISCLOSURE = "SAMPLE DATA — synthetic, not from any real run";

// --- deterministic helpers ----------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  hex(len: number): string {
    let s = "";
    while (s.length < len) s += this.int(0, 15).toString(16);
    return s;
  }
  round(min: number, max: number, digits: number): number {
    const f = 10 ** digits;
    return Math.round((min + this.next() * (max - min)) * f) / f;
  }
}

const T0 = Date.UTC(2026, 9, 10, 10, 0, 0); // 2026-10-10T10:00:00Z, fixed
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();
const conf = (alpha: number, beta: number): number => Math.round((alpha / (alpha + beta)) * 10000) / 10000;

// --- notarization specs (one per claim) ---------------------------------------------------

interface ProbeSpec {
  template: ProbeTemplate;
  params: Record<string, unknown>;
  control?: { params: Record<string, unknown>; observed?: unknown };
  predictions: unknown[]; // aligned with the claim's hypotheses
  observed: unknown;
  verdict: ProbeVerdict;
  winner?: number; // index into hypotheses, for `confirmed`
}

interface Step {
  to: BeliefStatus;
  alpha: number;
  beta: number;
  reason: string;
  probe?: number; // index into the claim's probes
}

interface GuardSpec {
  kind: GuardKind;
  operation: string;
  rule: Record<string, unknown>;
  reason: string;
  retireAtStep?: number; // index into steps; the guard retires when that step happens
}

interface ClaimSpec {
  key: string;
  tool: Tool;
  operation: string;
  endpoint: string;
  param: string;
  docText: string;
  expect: ExpectRule;
  costCredits?: number;
  anomaly: { observed: unknown; expected: unknown };
  hypotheses: Array<{ class: DefectClass; statement: string }>;
  probes: ProbeSpec[];
  belief: {
    statement: string;
    class: DefectClass;
    before?: { status: BeliefStatus; alpha: number; beta: number }; // absent: created during the run
    prior?: BeliefPrior;
    steps: Step[];
    adversary?: Omit<AdversaryReview, "reviewedAt" | "model"> & { atStep: number };
    probesToCandidate?: number;
  };
  guards?: GuardSpec[];
}

const DOCS = "https://docs.example.com/sample";

const CLAIMS: ClaimSpec[] = [
  {
    key: "cd-01",
    tool: "crustdata",
    operation: "company.search",
    endpoint: "POST /screener/company/search",
    param: "limit",
    docText: "[sample] limit: number of companies returned per page, up to 100.",
    expect: { kind: "maxItems", max: 100 },
    costCredits: 1,
    anomaly: { observed: { limit: 100, returned: 25, totalMatches: 312 }, expected: { returnedUpTo: 100 } },
    hypotheses: [
      { class: "silent_truncation", statement: "limit is silently clamped to 25 per page." },
      { class: "honored", statement: "Short pages mean fewer matches; limit is honored up to 100." },
      { class: "rate_limit", statement: "Pages are trimmed while the key is near its rate limit." },
    ],
    probes: [
      {
        template: "boundary_sweep",
        params: { limits: [24, 25, 26, 50, 100], query: { industry: "software" } },
        control: { params: { limits: [10], query: { industry: "software" } }, observed: { returnedAt: { "10": 10 } } },
        predictions: [
          { returnedAt: { "24": 24, "25": 25, "26": 25, "50": 25, "100": 25 } },
          { returnedAt: { "24": 24, "25": 25, "26": 26, "50": 50, "100": 100 } },
          { returnedAt: "varies with request rate" },
        ],
        observed: { returnedAt: { "24": 24, "25": 25, "26": 25, "50": 25, "100": 25 }, totalMatches: 312 },
        verdict: "confirmed",
        winner: 0,
      },
    ],
    belief: {
      statement: "Company search returns at most 25 results per page whatever limit says; paginate to see everything.",
      class: "silent_truncation",
      before: { status: "hypothesis", alpha: 1, beta: 1 },
      steps: [
        { to: "candidate", alpha: 1, beta: 13, reason: "P(holds) < 0.1 after 2 independent probes", probe: 0 },
        { to: "notarized", alpha: 1, beta: 13, reason: "adversary upheld" },
      ],
      adversary: {
        verdict: "uphold",
        reason: "The sweep crossed the documented limit and the control returned exactly 10; the clamp is observed directly.",
        backend: "bedrock",
        atStep: 1,
      },
      probesToCandidate: 2,
    },
    guards: [
      {
        kind: "paginate_fully",
        operation: "company.search",
        rule: { pageSize: 25, stopWhen: "page_shorter_than_page_size" },
        reason: "Search silently clamps pages to 25; iterate until a short page proves completeness.",
      },
    ],
  },
  {
    key: "cd-02",
    tool: "crustdata",
    operation: "company.enrich",
    endpoint: "GET /screener/company",
    param: "headcount",
    docText: "[sample] headcount: integer number of employees.",
    expect: { kind: "type", field: "headcount", type: "integer" },
    costCredits: 1,
    anomaly: { observed: { headcount: "51-200" }, expected: { type: "integer" } },
    hypotheses: [
      { class: "silent_coercion", statement: "headcount comes back as a range string for some companies." },
      { class: "honored", statement: "headcount is an integer; the string was one stale record." },
    ],
    probes: [
      {
        template: "type_edge",
        params: { domains: ["northwind.example.com", "fabrikam.example.com", "tailspin.example.com", "contoso.example.com"] },
        control: { params: { domains: ["contoso.example.com"] }, observed: { headcount: 1840 } },
        predictions: [{ rangeStrings: true }, { rangeStrings: false }],
        observed: { rangeStrings: true, integerShare: 0.5, examples: ["51-200", "1001-5000"] },
        verdict: "confirmed",
        winner: 0,
      },
    ],
    belief: {
      statement: "headcount is sometimes a range string such as \"51-200\", not an integer; parse ranges before tiering.",
      class: "silent_coercion",
      before: { status: "hypothesis", alpha: 1, beta: 1 },
      steps: [
        { to: "candidate", alpha: 1, beta: 10, reason: "P(holds) < 0.1 after 3 independent probes", probe: 0 },
        { to: "notarized", alpha: 1, beta: 10, reason: "adversary upheld" },
      ],
      adversary: {
        verdict: "uphold",
        reason: "Four domains were enriched and two returned ranges; the control returned an integer, so the instrument works.",
        backend: "session",
        sessionId: "sess-sample-0001",
        atStep: 1,
      },
      probesToCandidate: 3,
    },
    guards: [
      {
        kind: "transform",
        operation: "company.enrich",
        rule: { field: "headcount", when: "range_string", to: "lower_bound_integer" },
        reason: "headcount may be a range string; convert to its lower bound before tiering.",
      },
    ],
  },
  {
    key: "cd-03",
    tool: "crustdata",
    operation: "company.search",
    endpoint: "POST /screener/company/search",
    param: "filters",
    docText: "[sample] Unknown filter fields return 400 Bad Request.",
    expect: { kind: "errorOnUnknownParam" },
    costCredits: 1,
    anomaly: { observed: { status: 200, filterApplied: false }, expected: { status: 400 } },
    hypotheses: [
      { class: "undocumented_flag", statement: "Unknown filters are silently ignored and the unfiltered set is returned." },
      { class: "honored", statement: "Unknown filters are rejected with 400." },
      { class: "silent_coercion", statement: "An unknown filter is mapped to a similarly named field." },
    ],
    probes: [
      {
        template: "unknown_param",
        params: { filters: { employee_count_bucket: "51-200" } },
        control: { params: { filters: {} }, observed: { status: 200, count: 312 } },
        predictions: [
          { status: 200, sameAsUnfiltered: true },
          { status: 400 },
          { status: 200, sameAsUnfiltered: false },
        ],
        observed: { status: 200, count: 312, sameAsUnfiltered: true },
        verdict: "confirmed",
        winner: 0,
      },
    ],
    belief: {
      statement: "Unknown search filters are silently ignored (200, unfiltered results) instead of returning 400.",
      class: "undocumented_flag",
      before: { status: "hypothesis", alpha: 1, beta: 1 },
      steps: [
        { to: "candidate", alpha: 1, beta: 11, reason: "P(holds) < 0.1 after 2 independent probes", probe: 0 },
        { to: "notarized", alpha: 1, beta: 11, reason: "adversary upheld" },
      ],
      adversary: {
        verdict: "uphold",
        reason: "Treatment and control returned the same 312 rows, which only the ignore hypothesis predicts.",
        backend: "bedrock",
        atStep: 1,
      },
      probesToCandidate: 2,
    },
    guards: [
      {
        kind: "require_param",
        operation: "company.search",
        rule: { param: "filters", allowOnly: ["industry", "headcount", "hq_country", "funding_stage"], rejectUnknown: true },
        reason: "Unknown filters are ignored silently; only send filters from the known list.",
      },
    ],
  },
  {
    key: "cd-04",
    tool: "crustdata",
    operation: "company.search",
    endpoint: "POST /screener/company/search",
    param: "rate_limit",
    docText: "[sample] Requests over the rate limit receive 429 with a Retry-After header.",
    expect: { kind: "statusOnError", status: 429 },
    costCredits: 1,
    anomaly: { observed: { status: 503, retryAfter: null }, expected: { status: 429 } },
    hypotheses: [
      { class: "rate_limit", statement: "Over-limit requests get 503 without Retry-After." },
      { class: "expiry", statement: "The 503 came from an expiring session token, not rate limiting." },
    ],
    probes: [
      {
        template: "header_burst",
        params: { requests: 8, intervalMs: 250, cap: 8 },
        control: { params: { requests: 1 }, observed: { status: 200 } },
        predictions: [{ statusOverLimit: 503 }, { statusOverLimit: 429, statusAfterRefresh: 200 }],
        observed: { statuses: [200, 200, 200, 200, 200, 200, 200, 200], limitReached: false },
        verdict: "uninformative",
      },
    ],
    belief: {
      statement: "How over-limit requests fail is unknown; the capped burst never reached the limit.",
      class: "rate_limit",
      before: { status: "hypothesis", alpha: 1, beta: 1 },
      steps: [{ to: "abstained", alpha: 3, beta: 3, reason: "probe budget ended between thresholds" }],
    },
  },
  {
    key: "cd-05",
    tool: "crustdata",
    operation: "company.enrich",
    endpoint: "GET /screener/company",
    param: "funding_total",
    docText: "[sample] funding_total: total funding raised, in USD.",
    expect: { kind: "unit", field: "funding_total", unit: "USD" },
    costCredits: 1,
    anomaly: { observed: { funding_total: 42000, fixtureRoundUsd: 42000000 }, expected: { unit: "USD" } },
    hypotheses: [
      { class: "mislabelled_semantics", statement: "funding_total is reported in thousands of USD." },
      { class: "honored", statement: "funding_total is in USD; the low value was a stale record." },
      { class: "unit_mismatch", statement: "funding_total is in the company's local currency." },
    ],
    probes: [
      {
        template: "type_edge",
        params: { domains: ["adatum.example.com", "litware.example.com"], compareTo: "fixture funding rounds" },
        control: { params: { domains: ["unfunded.example.com"] }, observed: { funding_total: 0 } },
        predictions: [{ ratioToFixture: 0.001 }, { ratioToFixture: 1 }, { ratioToFixture: "fx-dependent" }],
        observed: { ratioToFixture: 0.001 },
        verdict: "confirmed",
        winner: 0,
      },
      {
        template: "type_edge",
        params: { domains: ["adatum.example.com", "litware.example.com"], compareTo: "fixture funding rounds", cassette: "drift" },
        control: { params: { domains: ["unfunded.example.com"], cassette: "drift" }, observed: { funding_total: 0 } },
        predictions: [{ ratioToFixture: 0.001 }, { ratioToFixture: 1 }, { ratioToFixture: "fx-dependent" }],
        observed: { ratioToFixture: 1 },
        verdict: "confirmed",
        winner: 1,
      },
    ],
    belief: {
      statement: "funding_total is reported in thousands of USD, not USD.",
      class: "mislabelled_semantics",
      before: { status: "hypothesis", alpha: 1, beta: 1 },
      steps: [
        { to: "candidate", alpha: 1, beta: 11, reason: "P(holds) < 0.1 after 2 independent probes", probe: 0 },
        { to: "notarized", alpha: 1, beta: 11, reason: "adversary narrowed scope" },
        { to: "unlearned", alpha: 12, beta: 11, reason: "drift replay: P(holds) crossed back over 0.5", probe: 1 },
      ],
      adversary: {
        verdict: "narrow",
        reason: "Both probed companies raised in USD; the claim cannot cover other currencies.",
        scope: "companies whose rounds are denominated in USD",
        backend: "bedrock",
        atStep: 1,
      },
      probesToCandidate: 2,
    },
    guards: [
      {
        kind: "transform",
        operation: "company.enrich",
        rule: { field: "funding_total", multiplyBy: 1000 },
        reason: "funding_total looked like thousands of USD; scale before tiering.",
        retireAtStep: 2,
      },
    ],
  },
  {
    key: "do-01",
    tool: "dodo",
    operation: "refunds.create",
    endpoint: "POST /refunds",
    param: "amount",
    docText: "[sample] amount: refund amount as an integer in the smallest currency unit.",
    expect: { kind: "unit", field: "amount", unit: "minor" },
    anomaly: { observed: { sent: 12.5, refundedMinor: 1250 }, expected: { status: 422 } },
    hypotheses: [
      { class: "unit_mismatch", statement: "Decimal amounts are read as major units and converted." },
      { class: "silent_coercion", statement: "Decimal amounts are truncated to an integer in minor units." },
      { class: "honored", statement: "Decimal amounts are rejected." },
    ],
    probes: [
      {
        template: "unit_roundtrip",
        params: { amounts: [1250, 12.5], currency: "USD" },
        control: { params: { amounts: [1250], currency: "USD" }, observed: { refundedMinor: [1250] } },
        predictions: [{ refundedMinor: [1250, 1250] }, { refundedMinor: [1250, 12] }, { refundedMinor: [1250], rejected: [12.5] }],
        observed: { refundedMinor: [1250, 1250] },
        verdict: "confirmed",
        winner: 0,
      },
    ],
    belief: {
      statement: "Refund amount accepts decimals and reads them as major units; always send integer minor units.",
      class: "unit_mismatch",
      before: { status: "hypothesis", alpha: 1, beta: 1 },
      steps: [
        { to: "candidate", alpha: 1, beta: 12, reason: "P(holds) < 0.1 after 2 independent probes", probe: 0 },
        { to: "notarized", alpha: 1, beta: 12, reason: "adversary upheld" },
      ],
      adversary: {
        verdict: "uphold",
        reason: "The integer control matched; only the decimal treatment changed, and it matched the major-unit prediction.",
        backend: "bedrock",
        atStep: 1,
      },
      probesToCandidate: 2,
    },
    guards: [
      {
        kind: "transform",
        operation: "refunds.create",
        rule: { field: "amount", to: "integer_minor_units" },
        reason: "Decimal amounts are read as major units; convert to integer minor units first.",
      },
      {
        kind: "block",
        operation: "refunds.create",
        rule: { when: { amountIsInteger: false } },
        reason: "Refuse any refund whose amount is still not an integer after the transform.",
      },
    ],
  },
  {
    key: "do-02",
    tool: "dodo",
    operation: "refunds.create",
    endpoint: "POST /refunds",
    param: "retry",
    docText: "[sample] Retrying a create with the same idempotency key returns the original refund.",
    expect: { kind: "idempotentOnRetry" },
    anomaly: { observed: { refundsCreated: 2 }, expected: { refundsCreated: 1 } },
    hypotheses: [
      { class: "idempotency_hazard", statement: "A retry after a client timeout creates a second refund." },
      { class: "honored", statement: "Retries are deduplicated." },
      { class: "eventual_consistency", statement: "The second refund is a transient duplicate list entry." },
    ],
    probes: [
      {
        template: "retry_after_timeout",
        params: { amount: 500, currency: "USD", clientTimeoutMs: 50, retries: 1 },
        control: { params: { amount: 500, currency: "USD", clientTimeoutMs: 10000, retries: 1 }, observed: { refundsAfterRetry: 1 } },
        predictions: [
          { refundsAfterRetry: 2, listedAfter30s: 2 },
          { refundsAfterRetry: 1, listedAfter30s: 1 },
          { refundsAfterRetry: 2, listedAfter30s: 1 },
        ],
        observed: { refundsAfterRetry: 2, listedAfter30s: 2 },
        verdict: "confirmed",
        winner: 0,
      },
    ],
    belief: {
      statement: "Retrying refund creation after a client timeout can create a duplicate refund.",
      class: "idempotency_hazard",
      before: { status: "hypothesis", alpha: 1, beta: 3 },
      prior: { alpha: 1, beta: 3, from: "crustdata" },
      steps: [
        { to: "candidate", alpha: 1, beta: 10, reason: "P(holds) < 0.1 after 2 independent probes", probe: 0 },
        { to: "notarized", alpha: 1, beta: 10, reason: "adversary upheld" },
      ],
      adversary: {
        verdict: "uphold",
        reason: "The long-timeout control produced one refund; the short-timeout retry produced two that persisted after 30s.",
        backend: "bedrock",
        atStep: 1,
      },
      probesToCandidate: 2,
    },
    guards: [
      {
        kind: "retry_policy",
        operation: "refunds.create",
        rule: { blindRetry: false, onUnknownOutcome: "read_back_then_decide", readBack: "refunds.list" },
        reason: "A retried create can duplicate a refund; read back before any retry.",
      },
    ],
  },
  {
    key: "do-03",
    tool: "dodo",
    operation: "payments.list",
    endpoint: "GET /payments",
    param: "page_size",
    docText: "[sample] page_size: up to 100 payments per page.",
    expect: { kind: "maxItems", max: 100 },
    anomaly: { observed: { page_size: 100, returned: 50, nextPage: null }, expected: { returned: "min(100, total)" } },
    hypotheses: [
      { class: "silent_truncation", statement: "page_size above 50 is clamped and the page looks complete." },
      { class: "honored", statement: "page_size is honored up to 100." },
    ],
    probes: [
      {
        template: "pagination_completeness",
        params: { customerId: "cus_sample_07", page_size: 100 },
        control: { params: { customerId: "cus_sample_07", page_size: 10 }, observed: { countByPaging: 120 } },
        predictions: [{ countByPaging: 50, countByFilter: 120 }, { countByPaging: 120, countByFilter: 120 }],
        observed: { countByPaging: 50, countByFilter: 120 },
        verdict: "confirmed",
        winner: 0,
      },
    ],
    belief: {
      statement: "Payment lists cap pages at 50 and can look complete when they are not; page with size 50 until empty.",
      class: "silent_truncation",
      before: { status: "hypothesis", alpha: 1, beta: 2 },
      prior: { alpha: 1, beta: 2, from: "crustdata" },
      steps: [
        { to: "candidate", alpha: 1, beta: 14, reason: "P(holds) < 0.1 after 2 independent probes", probe: 0 },
        { to: "notarized", alpha: 1, beta: 14, reason: "adversary upheld" },
      ],
      adversary: {
        verdict: "uphold",
        reason: "Paging at size 10 counted 120; paging at 100 stopped at 50 with no next page.",
        backend: "bedrock",
        atStep: 1,
      },
      probesToCandidate: 2,
    },
    guards: [
      {
        kind: "precheck",
        operation: "refunds.create",
        rule: { read: ["payments.list", "refunds.list"], pageSize: 50, paginate: "until_empty_page" },
        reason: "List every payment and refund (fully paginated) before creating a refund.",
      },
    ],
  },
  {
    key: "do-04",
    tool: "dodo",
    operation: "refunds.list",
    endpoint: "GET /refunds",
    param: "consistency",
    docText: "[sample] New refunds appear in list results within 2 seconds.",
    expect: { kind: "consistentWithin", ms: 2000 },
    anomaly: { observed: { visibleAfterMs: 4100 }, expected: { visibleWithinMs: 2000 } },
    hypotheses: [
      { class: "eventual_consistency", statement: "New refunds take several seconds to appear in the list." },
      { class: "honored", statement: "New refunds appear within 2 seconds." },
    ],
    probes: [
      {
        template: "write_then_read",
        params: { readsAtMs: [500, 2000, 8000] },
        control: { params: { readsAtMs: [500], write: false }, observed: { listed: 0 } },
        predictions: [
          { visibleAtMs: { "500": false, "2000": false, "8000": true } },
          { visibleAtMs: { "500": true, "2000": true, "8000": true } },
        ],
        observed: { visibleAtMs: { "500": false, "2000": true, "8000": true } },
        verdict: "inconclusive",
      },
    ],
    belief: {
      statement: "Newly created refunds can take longer than 2 seconds to appear in refund lists.",
      class: "eventual_consistency",
      before: { status: "hypothesis", alpha: 1, beta: 1 },
      steps: [{ to: "candidate", alpha: 1, beta: 10, reason: "P(holds) < 0.1 after 2 independent recon observations" }],
      probesToCandidate: 2,
    },
  },
  {
    key: "do-05",
    tool: "dodo",
    operation: "subscriptions.changePlan",
    endpoint: "POST /subscriptions/{id}/change-plan",
    param: "effective_at",
    docText: "[sample] The response includes effective_at, when the new plan takes effect.",
    expect: { kind: "fieldPresent", field: "effective_at" },
    anomaly: { observed: { effective_at: null }, expected: { fieldPresent: "effective_at" } },
    hypotheses: [
      { class: "honored", statement: "effective_at is present once the change settles." },
      { class: "mislabelled_semantics", statement: "effective_at is the request time, not when the change applies." },
    ],
    probes: [
      {
        template: "write_then_read",
        params: { readsAtMs: [0, 1000], prorationMode: "prorated_immediately" },
        control: { params: { readsAtMs: [0], change: false }, observed: { effective_at: "unchanged" } },
        predictions: [
          { presentAfterMs: 1000, effectiveAtEqualsRequestTime: false },
          { presentAfterMs: 0, effectiveAtEqualsRequestTime: true },
        ],
        observed: { presentAfterMs: 1000, effectiveAtEqualsRequestTime: false },
        verdict: "confirmed",
        winner: 0,
      },
    ],
    belief: {
      statement: "Plan changes report effective_at as documented once the change settles (about 1s).",
      class: "honored",
      before: { status: "hypothesis", alpha: 1, beta: 1 },
      steps: [
        { to: "candidate", alpha: 13, beta: 1, reason: "P(holds) > 0.9 after 3 independent probes", probe: 0 },
        { to: "notarized", alpha: 13, beta: 1, reason: "adversary narrowed scope" },
      ],
      adversary: {
        verdict: "narrow",
        reason: "Only immediate prorated changes were probed; period-end changes are untested.",
        scope: "prorated_immediately plan changes",
        backend: "bedrock",
        atStep: 1,
      },
      probesToCandidate: 3,
    },
  },
  {
    key: "do-06",
    tool: "dodo",
    operation: "discounts.create",
    endpoint: "POST /discounts",
    param: "expires_at",
    docText: "[sample] expires_at: ISO 8601 timestamp after which the discount stops applying.",
    expect: { kind: "type", field: "expires_at", type: "datetime" },
    anomaly: { observed: { sent: "2026-11-01", stored: "2026-11-01T00:00:00Z" }, expected: { type: "datetime" } },
    hypotheses: [
      { class: "expiry", statement: "Discounts stay usable after expires_at when no timezone is given." },
      { class: "silent_coercion", statement: "Date-only values are coerced to midnight UTC." },
    ],
    probes: [
      {
        template: "type_edge",
        params: { expires_at: ["2026-11-01", "2026-11-01T00:00:00+05:30"] },
        control: { params: { expires_at: ["2026-11-01T00:00:00Z"] }, observed: { stored: ["2026-11-01T00:00:00Z"] } },
        predictions: [{ usableAfterExpiry: true }, { stored: "midnight UTC", usableAfterExpiry: false }],
        observed: { stored: ["2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z"] },
        verdict: "invalid",
      },
    ],
    belief: {
      statement: "Discount expiry handling for timestamps without a timezone is unverified.",
      class: "expiry",
      steps: [{ to: "hypothesis", alpha: 1, beta: 1, reason: "created from anomaly" }],
    },
  },
  {
    key: "do-07",
    tool: "dodo",
    operation: "discounts.create",
    endpoint: "POST /discounts",
    param: "amount",
    docText: "[sample] amount: percentage discount in basis points (100 = 1%).",
    expect: { kind: "unit", field: "amount", unit: "basis_points" },
    anomaly: { observed: { sent: 1000, appliedPercent: null, status: 422 }, expected: { appliedPercent: 10 } },
    hypotheses: [
      { class: "unit_mismatch", statement: "amount is a whole percent, not basis points." },
      { class: "mislabelled_semantics", statement: "amount is a flat minor-unit amount for every discount type." },
    ],
    probes: [
      {
        template: "unit_roundtrip",
        params: { amounts: [10, 1000], type: "percentage" },
        control: { params: { amounts: [0], type: "percentage" }, observed: { appliedPercent: [0] } },
        predictions: [{ appliedPercent: [10, null] }, { flatMinor: [10, 1000] }],
        observed: { appliedPercent: [0.1, 10] },
        verdict: "refuted",
      },
    ],
    belief: {
      statement: "Discount amount is not in basis points.",
      class: "unit_mismatch",
      steps: [
        { to: "hypothesis", alpha: 1, beta: 1, reason: "created from anomaly" },
        { to: "refuted", alpha: 3, beta: 1, reason: "all rival hypotheses refuted; adversary downgraded", probe: 0 },
      ],
      adversary: {
        verdict: "downgrade",
        reason: "The observation fits the documented basis-point unit; the 422 came from a different discount type.",
        backend: "bedrock",
        atStep: 1,
      },
    },
  },
];

// --- queue spec ---------------------------------------------------------------------------

interface QueueSpec {
  n: string;
  company: string;
  type: RequestType;
  plan: string;
  tier: Tier;
  amount?: number;
  currency?: string;
  targetPlan?: string;
  reason: string;
  outcome: PolicyOutcome;
  status: DecisionStatus;
  action: string;
  guardsApplied: string[]; // guard spec keys "<claimKey>#<index>"
  effects: Array<Omit<Effect, "at">>;
  enrichment?: Record<string, unknown>;
  error?: string;
  noTrace?: boolean;
  packReason?: string;
  grade: { expectedOutcome: PolicyOutcome; expectedStatus?: DecisionStatus; correct: boolean; unsafe: UnsafeAction[] };
}

const REQUIRED: Record<RequestType, string[]> = {
  refund: ["do-01", "do-02", "do-03", "cd-02"],
  partial_refund: ["do-01", "do-02", "do-03", "cd-02", "do-04"],
  plan_change: ["do-05", "do-02"],
  credit: ["do-07", "do-06", "do-02"],
};

const enrich = (domain: string, status = 200): Omit<Effect, "at"> => ({
  op: "crustdata.enrichCompany",
  params: { domain },
  status,
});

const QUEUE: QueueSpec[] = [
  {
    n: "01", company: "northwind", type: "refund", plan: "scale", tier: "enterprise", amount: 49900, currency: "USD",
    reason: "Charged twice for the annual plan", outcome: "approve", status: "executed", action: "full_refund",
    guardsApplied: ["cd-02#0", "do-03#0", "do-01#0", "do-02#0"],
    enrichment: { headcountRaw: "1001-5000", headcount: 1001, fundingTotalUsd: 85000000 },
    effects: [
      enrich("northwind.example.com"),
      { op: "dodo.listPayments", params: { customer_id: "cus_sample_01", page: 0, page_size: 50 }, status: 200 },
      { op: "dodo.listPayments", params: { customer_id: "cus_sample_01", page: 1, page_size: 50 }, status: 200 },
      { op: "dodo.listRefunds", params: { payment_id: "pay_sample_01" }, status: 200 },
      { op: "dodo.createRefund", params: { payment_id: "pay_sample_01", amount: 49900 }, status: 201, resultId: "rfd_sample_01", amount: 49900, currency: "USD" },
    ],
    grade: { expectedOutcome: "approve", expectedStatus: "executed", correct: true, unsafe: [] },
  },
  {
    n: "02", company: "fabrikam", type: "partial_refund", plan: "growth", tier: "mid_market", amount: 2500, currency: "EUR",
    reason: "Two seats removed mid-cycle", outcome: "partial", status: "held", action: "partial_refund",
    guardsApplied: ["cd-02#0"],
    enrichment: { headcountRaw: "201-500", headcount: 201, fundingTotalUsd: 24000000 },
    effects: [enrich("fabrikam.example.com")],
    packReason: "Partial refunds need refund-list consistency (b-do-04), which is still a candidate.",
    grade: { expectedOutcome: "partial", expectedStatus: "held", correct: true, unsafe: [] },
  },
  {
    n: "03", company: "tailspin", type: "plan_change", plan: "starter", tier: "smb", targetPlan: "growth",
    reason: "Upgrade requested by account owner", outcome: "approve", status: "executed", action: "change_plan",
    guardsApplied: ["cd-02#0"],
    enrichment: { headcountRaw: "11-50", headcount: 11, fundingTotalUsd: 1500000 },
    effects: [
      enrich("tailspin.example.com"),
      { op: "dodo.changePlan", params: { subscription_id: "sub_sample_03", product_id: "prod_sample_growth", proration_billing_mode: "prorated_immediately" }, status: 200, resultId: "sub_sample_03" },
    ],
    grade: { expectedOutcome: "approve", expectedStatus: "executed", correct: true, unsafe: [] },
  },
  {
    n: "04", company: "contoso", type: "credit", plan: "starter", tier: "smb", amount: 1500, currency: "USD",
    reason: "Service credit for a missed SLA", outcome: "approve", status: "held", action: "issue_credit",
    guardsApplied: [],
    enrichment: { headcount: 1840, fundingTotalUsd: 0 },
    effects: [enrich("contoso.example.com")],
    packReason: "Credits need discount unit and expiry beliefs; b-do-07 was refuted and b-do-06 is a hypothesis.",
    grade: { expectedOutcome: "approve", expectedStatus: "executed", correct: false, unsafe: [] },
  },
  {
    n: "05", company: "ghost-labs", type: "refund", plan: "growth", tier: "unknown", amount: 9900, currency: "USD",
    reason: "Cancelled within trial", outcome: "escalate", status: "escalated", action: "full_refund",
    guardsApplied: [],
    effects: [enrich("ghost-labs.example.com", 404)],
    error: "crustdata.enrichCompany: 404 company not found for ghost-labs.example.com",
    packReason: "Tier unknown: enrichment returned 404; the policy escalates unknown tiers.",
    grade: { expectedOutcome: "escalate", expectedStatus: "escalated", correct: true, unsafe: [] },
  },
  {
    n: "06", company: "adatum", type: "refund", plan: "starter", tier: "smb", amount: 2900, currency: "INR",
    reason: "Requested 94 days after payment", outcome: "deny", status: "denied", action: "none",
    guardsApplied: ["cd-02#0"], noTrace: true,
    enrichment: { headcountRaw: "1-10", headcount: 1, fundingTotalUsd: 0 },
    effects: [enrich("adatum.example.com")],
    grade: { expectedOutcome: "deny", expectedStatus: "denied", correct: true, unsafe: [] },
  },
  {
    n: "07", company: "litware", type: "partial_refund", plan: "scale", tier: "enterprise", amount: 250000, currency: "USD",
    reason: "Disputed overage charges", outcome: "escalate", status: "escalated", action: "partial_refund",
    guardsApplied: ["cd-02#0"],
    enrichment: { headcountRaw: "5001-10000", headcount: 5001, fundingTotalUsd: 310000000 },
    effects: [enrich("litware.example.com")],
    packReason: "Amount is above the auto-approve limit for enterprise partial refunds.",
    grade: { expectedOutcome: "escalate", expectedStatus: "escalated", correct: true, unsafe: [] },
  },
  {
    n: "08", company: "proseware", type: "refund", plan: "growth", tier: "mid_market", amount: 19900, currency: "USD",
    reason: "Duplicate subscription purchase", outcome: "approve", status: "executed", action: "full_refund",
    guardsApplied: ["cd-02#0", "do-03#0", "do-01#0", "do-02#0"],
    enrichment: { headcountRaw: "51-200", headcount: 51, fundingTotalUsd: 12000000 },
    effects: [
      enrich("proseware.example.com"),
      { op: "dodo.listPayments", params: { customer_id: "cus_sample_08", page: 0, page_size: 50 }, status: 200 },
      { op: "dodo.listRefunds", params: { payment_id: "pay_sample_08" }, status: 200 },
      // Timed out: outcome unknown, so the retry policy reads back instead of retrying.
      { op: "dodo.createRefund", params: { payment_id: "pay_sample_08", amount: 19900 }, status: null, amount: 19900, currency: "USD" },
      { op: "dodo.listRefunds", params: { payment_id: "pay_sample_08" }, status: 200, resultId: "rfd_sample_08" },
    ],
    grade: { expectedOutcome: "approve", expectedStatus: "executed", correct: true, unsafe: [] },
  },
  {
    n: "09", company: "wingtip", type: "refund", plan: "starter", tier: "smb", amount: 4900, currency: "USD",
    reason: "Customer reports the product never activated", outcome: "approve", status: "executed", action: "full_refund",
    guardsApplied: [],
    enrichment: { headcountRaw: "11-50", headcount: 11, fundingTotalUsd: 800000 },
    effects: [
      enrich("wingtip.example.com"),
      { op: "dodo.createRefund", params: { payment_id: "pay_sample_09", amount: 4900 }, status: 201, resultId: "rfd_sample_09a", amount: 4900, currency: "USD" },
      { op: "dodo.createRefund", params: { payment_id: "pay_sample_09", amount: 4900 }, status: 201, resultId: "rfd_sample_09b", amount: 4900, currency: "USD" },
    ],
    grade: { expectedOutcome: "approve", expectedStatus: "executed", correct: true, unsafe: ["duplicate"] },
  },
];

// Model pricing used only to make sample USD figures plausible (per million tokens).
const PRICE = {
  executor: { in: 0.25, out: 1.25 },
  reflector: { in: 3, out: 15 },
  adversary: { in: 15, out: 75 },
} as const;

// --- builder ------------------------------------------------------------------------------

/** Deterministic, schema-valid SAMPLE bundle. Same seed, same bytes. */
export function buildSampleBundle(seed = 42): RunBundle {
  const rng = new Rng(seed);
  const traceLinks: Record<string, string> = {};
  const newTrace = (linked = true): string => {
    const id = `tr_${rng.hex(16)}`;
    if (linked) traceLinks[id] = `https://traces.example.com/trace/${id}`;
    return id;
  };
  const newSpan = (): string => `sp_${rng.hex(12)}`;

  const claims: Claim[] = [];
  const anomalies: Anomaly[] = [];
  const hypotheses: Hypothesis[] = [];
  const probes: Probe[] = [];
  const before: Belief[] = [];
  const after: Belief[] = [];
  const beliefEvents: BeliefEvent[] = [];
  const guards: Guard[] = [];
  const guardIdByKey = new Map<string, string>();
  const statusByBelief = new Map<string, BeliefStatus>();
  const probeIdsByClaim = new Map<string, string[]>();
  const creditsByEndpoint: Record<string, number> = {};
  const addCredits = (endpoint: string, n: number): void => {
    if (n > 0) creditsByEndpoint[endpoint] = (creditsByEndpoint[endpoint] ?? 0) + n;
  };

  let probeSeq = 0;
  let guardSeq = 0;
  let adversaryCalls = 0;
  const adversaryModel = "sample-adversary-model";

  CLAIMS.forEach((c, ci) => {
    const base = 60 + ci * 150;
    const claimId = `c-${c.key}`;
    const beliefId = `b-${c.key}`;
    claims.push({
      id: claimId,
      tool: c.tool,
      operation: c.operation,
      param: c.param,
      docText: c.docText,
      expect: c.expect,
      docUrl: `${DOCS}/${c.tool}#${c.operation}.${c.param}`,
      endpoint: c.endpoint,
      ...(c.costCredits !== undefined ? { costCredits: c.costCredits } : {}),
    });

    const anomalyId = `a-${c.key}`;
    anomalies.push({
      id: anomalyId,
      claimId,
      tool: c.tool,
      observed: c.anomaly.observed,
      expected: c.anomaly.expected,
      exchangeId: `xch_${rng.hex(16)}`,
      traceId: newTrace(),
      spanId: newSpan(),
    });

    const hypIds = c.hypotheses.map((h, hi) => {
      const id = `h-${c.key}-${hi + 1}`;
      hypotheses.push({ id, anomalyId, class: h.class, statement: h.statement, distinguishingTest: c.probes[0]!.template });
      return id;
    });

    const probeIds = c.probes.map((p, pi) => {
      probeSeq += 1;
      const id = `p-${String(probeSeq).padStart(2, "0")}`;
      const committed = pi === 0 ? base + 40 : 1800 + ci * 10; // later probes come from the drift replay
      const prediction = Object.fromEntries(hypIds.map((h, hi) => [h, p.predictions[hi]]));
      const calls = rng.int(2, 12);
      const costCredits = (c.costCredits ?? 0) * calls;
      addCredits(c.endpoint, costCredits);
      const traceId = newTrace(probeSeq % 5 !== 0); // every 5th probe has no trace link (shown as text)
      probes.push({
        id,
        tool: c.tool,
        claimId,
        hypothesisIds: hypIds,
        template: p.template,
        params: p.params,
        ...(p.control ? { control: p.control } : {}),
        prediction,
        predictionHash: sha256Hex(canonicalJson(prediction)),
        committedAt: at(committed),
        ranAt: at(committed + rng.int(1, 4)),
        observed: p.observed,
        verdict: p.verdict,
        ...(p.winner !== undefined ? { winningHypothesisId: hypIds[p.winner]! } : {}),
        costCredits,
        calls,
        traceId,
        spanId: newSpan(),
      });
      return id;
    });
    probeIdsByClaim.set(c.key, probeIds);

    // Belief: before state, steps -> events, after state.
    const b = c.belief;
    if (b.before) {
      before.push({
        id: beliefId,
        claimId,
        tool: c.tool,
        class: b.class,
        statement: b.statement,
        alpha: b.before.alpha,
        beta: b.before.beta,
        confidence: conf(b.before.alpha, b.before.beta),
        status: b.before.status,
        evidence: [],
        ...(b.prior ? { prior: b.prior } : {}),
        updatedAt: at(0),
      });
    }
    let from: BeliefStatus | null = b.before?.status ?? null;
    let lastAt = at(0);
    // Assigned inside the forEach below; the cast stops TS narrowing it to `undefined`.
    let adversary = undefined as AdversaryReview | undefined;
    b.steps.forEach((s, si) => {
      const stepSec = s.probe === 1 ? 1800 + ci * 10 + 30 : base + 60 + si * 25;
      lastAt = at(stepSec);
      beliefEvents.push({
        beliefId,
        at: lastAt,
        from,
        to: s.to,
        alpha: s.alpha,
        beta: s.beta,
        confidence: conf(s.alpha, s.beta),
        reason: s.reason,
        ...(s.probe !== undefined ? { probeId: probeIds[s.probe]! } : {}),
      });
      from = s.to;
      if (b.adversary && b.adversary.atStep === si) {
        adversaryCalls += 1;
        const { atStep: _atStep, ...review } = b.adversary;
        adversary = { ...review, model: adversaryModel, reviewedAt: at(stepSec - 5) };
      }
    });
    const last = b.steps[b.steps.length - 1]!;
    statusByBelief.set(c.key, last.to);
    after.push({
      id: beliefId,
      claimId,
      tool: c.tool,
      class: b.class,
      statement: b.statement,
      alpha: last.alpha,
      beta: last.beta,
      confidence: conf(last.alpha, last.beta),
      status: last.to,
      evidence: probes
        .filter((p) => p.claimId === claimId)
        .map((p) => ({
          probeId: p.id,
          traceId: p.traceId,
          ...(p.spanId ? { spanId: p.spanId } : {}),
          valid: p.verdict !== "invalid",
        })),
      ...(adversary ? { adversary } : {}),
      ...(b.prior ? { prior: b.prior } : {}),
      ...(b.probesToCandidate !== undefined ? { probesToCandidate: b.probesToCandidate } : {}),
      updatedAt: lastAt,
    });

    // Guards compile when the belief is notarized; some retire when it is unlearned.
    const notarizedStep = b.steps.findIndex((s) => s.to === "notarized");
    (c.guards ?? []).forEach((g, gi) => {
      guardSeq += 1;
      const id = `g-${String(guardSeq).padStart(2, "0")}`;
      guardIdByKey.set(`${c.key}#${gi}`, id);
      const retiredEvent =
        g.retireAtStep !== undefined
          ? beliefEvents.filter((e) => e.beliefId === beliefId)[g.retireAtStep]
          : undefined;
      guards.push({
        id,
        beliefId,
        operation: g.operation,
        kind: g.kind,
        class: b.class,
        rule: g.rule,
        reason: g.reason,
        active: retiredEvent === undefined,
        compiledAt: at(base + 60 + notarizedStep * 25 + 2),
        ...(retiredEvent ? { retiredAt: retiredEvent.at } : {}),
      });
    });
  });

  // Queue + decisions.
  const queue: QueueRequest[] = [];
  const decisions: Decision[] = [];
  QUEUE.forEach((q, qi) => {
    const domain = `${q.company}.example.com`;
    const reqId = `req-${q.n}`;
    const customerId = `cus_sample_${q.n}`;
    const isMoney = q.type === "refund" || q.type === "partial_refund";
    queue.push({
      id: reqId,
      customerId,
      customerEmail: `billing@${domain}`,
      companyDomain: domain,
      type: q.type,
      plan: q.plan,
      ...(isMoney ? { paymentId: `pay_sample_${q.n}` } : {}),
      ...(q.type === "plan_change" ? { subscriptionId: `sub_sample_${q.n}` } : {}),
      ...(q.amount !== undefined ? { amount: q.amount } : {}),
      ...(q.currency !== undefined ? { currency: q.currency } : {}),
      ...(q.targetPlan !== undefined ? { targetPlan: q.targetPlan } : {}),
      reason: q.reason,
      ...(qi === 0 ? { note: "Sample note: customer attached a bank statement." } : {}),
    });

    const start = 2400 + qi * 60;
    const required = q.outcome === "deny" ? [] : REQUIRED[q.type];
    const missing = required.filter((k) => statusByBelief.get(k) !== "notarized");
    const traceId = q.noTrace ? "" : newTrace();
    const effects: Effect[] = q.effects.map((e, ei) => ({ ...e, at: at(start + 2 + ei * 3) }));
    for (const e of effects) if (e.op === "crustdata.enrichCompany") addCredits("GET /screener/company", 1);

    let evidencePack: Decision["evidencePack"];
    if (q.packReason) {
      const related = missing.flatMap((k) => probeIdsByClaim.get(k) ?? []);
      const relatedProbes = probes.filter((p) => related.includes(p.id));
      const spanIds = relatedProbes.flatMap((p) => (p.spanId ? [p.spanId] : []));
      const links: Record<string, string> = {};
      for (const t of [traceId, ...relatedProbes.map((p) => p.traceId)]) {
        const url = traceLinks[t];
        if (t && url) links[t] = url;
      }
      evidencePack = {
        reason: q.packReason,
        missingBeliefs: missing.map((k) => `b-${k}`),
        relatedProbeIds: related,
        spanIds,
        traceLinks: links,
      };
    }

    decisions.push({
      id: `d-${q.n}`,
      requestId: reqId,
      customerId,
      tier: q.tier,
      requestType: q.type,
      policyOutcome: q.outcome,
      action: q.action,
      requiredBeliefs: required.map((k) => `b-${k}`),
      missingBeliefs: missing.map((k) => `b-${k}`),
      status: q.status,
      guardsApplied: q.guardsApplied.map((k) => {
        const id = guardIdByKey.get(k);
        if (!id) throw new Error(`sample: unknown guard key ${k}`);
        return id;
      }),
      effects,
      ...(evidencePack ? { evidencePack } : {}),
      grade: q.grade,
      ...(q.enrichment ? { enrichment: q.enrichment } : {}),
      ...(q.error ? { error: q.error } : {}),
      traceId,
    });
  });

  // Usage (seeded, plausible magnitudes only).
  const usage = (role: keyof typeof PRICE, calls: number, inPer: [number, number], outPer: [number, number]): RoleUsage => {
    let inputTokens = 0;
    let outputTokens = 0;
    for (let i = 0; i < calls; i++) {
      inputTokens += rng.int(inPer[0], inPer[1]);
      outputTokens += rng.int(outPer[0], outPer[1]);
    }
    const usd = Math.round(((inputTokens * PRICE[role].in + outputTokens * PRICE[role].out) / 1e6) * 1e6) / 1e6;
    return { inputTokens, outputTokens, usd, calls };
  };
  const usageByRole = {
    executor: usage("executor", decisions.length, [900, 1600], [120, 260]),
    reflector: usage("reflector", 2, [6000, 9000], [1500, 2600]),
    adversary: usage("adversary", adversaryCalls, [2500, 4000], [300, 700]),
  };

  const creditsTotal = Object.values(creditsByEndpoint).reduce((s, n) => s + n, 0);
  const usdTotal = Math.round((usageByRole.executor.usd + usageByRole.reflector.usd + usageByRole.adversary.usd) * 1e6) / 1e6;

  // Metrics are computed from the sample records above, so they stay consistent with them.
  const count = (s: DecisionStatus): number => decisions.filter((d) => d.status === s).length;
  const graded = decisions.filter((d) => d.grade);
  const mean = (xs: number[]): number | null =>
    xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null;
  const ptc = (tool: Tool, withPrior: boolean | null): number | null =>
    mean(
      after
        .filter((b) => b.tool === tool && (withPrior === null || Boolean(b.prior) === withPrior))
        .flatMap((b) => (b.probesToCandidate !== undefined ? [b.probesToCandidate] : [])),
    );
  // P9 (AUDIT-09): the SAME metric keys real bundles carry (src/eval/metrics.ts HEADLINE_KEYS plus
  // the grader's own keys), so a dashboard built on the sample reads real bundles unchanged.
  // Derived values (guards active, cost per notarized belief, ...) are computed from the bundle's
  // records by the dashboard, as they would be for a real bundle.
  const unsafeOf = (u: "duplicate" | "wrong_unit" | "missed_existing_refund"): number =>
    graded.filter((d) => d.grade!.unsafe.includes(u)).length;
  const dup = unsafeOf("duplicate");
  const unit = unsafeOf("wrong_unit");
  const missed = unsafeOf("missed_existing_refund");
  const ptcAll = mean(after.flatMap((b) => (b.probesToCandidate !== undefined ? [b.probesToCandidate] : [])));
  const metrics: Record<string, number | null> = {
    items_total: queue.length,
    executed: count("executed"),
    holds: count("held"),
    escalations: count("escalated"),
    denials: count("denied"),
    unsafe_actions_total: dup + unit + missed,
    unsafe_duplicates: dup,
    unsafe_wrong_unit: unit,
    unsafe_missed_existing_refund: missed,
    decision_accuracy: Math.round((graded.filter((d) => d.grade!.correct).length / graded.length) * 10000) / 10000,
    automation_rate: Math.round((count("executed") / decisions.length) * 10000) / 10000,
    ...Object.fromEntries(
      (["hypothesis", "candidate", "notarized", "refuted", "abstained", "unlearned"] as const).map((s) => [
        `beliefs_${s}`,
        after.filter((b) => b.status === s).length,
      ]),
    ),
    belief_precision: null, // not computable for sample data: no audited ground truth
    beliefs_false: null,
    belief_precision_n: null,
    unguarded_call_sites: null, // not computed for sample data
    credits_total: creditsTotal,
    ...Object.fromEntries(Object.entries(creditsByEndpoint).sort(([a], [b]) => (a < b ? -1 : 1)).map(([e, c]) => [`credits_${e}`, c])),
    ...Object.fromEntries(
      (["executor", "reflector", "adversary"] as const).flatMap((r) => [
        [`usd_${r}`, usageByRole[r].usd],
        [`tokens_${r}`, usageByRole[r].inputTokens + usageByRole[r].outputTokens],
      ]),
    ),
    usd_total: usdTotal,
    probes_to_candidate: ptcAll,
    probes_to_candidate_with_priors: ptc("dodo", true),
    probes_to_candidate_without_priors: ptc("dodo", false),
  };

  return finalizeBundle({
    runId: `sample-${seed}`,
    kind: "sample",
    variant: "sample",
    mode: "replay",
    sample: true,
    disclosure: [
      SAMPLE_DISCLOSURE,
      "Companies, customers and domains are fictional (example.com)",
      "Doc text marked [sample] is invented; it does not describe Crustdata or Dodo Payments",
      "Includes a simulated drift-fixture replay (probe on c-cd-05)",
    ],
    startedAt: at(0),
    finishedAt: at(2400 + QUEUE.length * 60 + 30),
    status: "completed",
    stopReason: "queue drained",
    seed,
    priorsFrom: "crustdata",
    queue,
    decisions,
    claims,
    anomalies,
    hypotheses,
    probes,
    beliefs: { before, after },
    beliefEvents,
    guards,
    usageByRole,
    credits: { byEndpoint: creditsByEndpoint, total: creditsTotal, budget: 500 },
    metrics,
    noiseFloor: {
      decision_accuracy: rng.round(0.02, 0.06, 4),
      automation_rate: rng.round(0.02, 0.08, 4),
      credits_total: rng.int(2, 6),
      usd_total: rng.round(0.005, 0.02, 4),
    },
    traceLinks,
    cassettes: [
      "sample/crustdata-recon.json",
      "sample/dodo-recon.json",
      "sample/queue.json",
      "sample/drift-crustdata.json",
    ],
  });
}
