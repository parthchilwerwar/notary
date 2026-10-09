/**
 * Crustdata contract: documented promises (Claims) for the three endpoints Notary calls, each with
 * the cheapest recon that exercises it. Doc text is quoted verbatim from docs.crustdata.com (read
 * Oct 10, 2026, API version 2025-11-01).
 *
 * Paths: enrich and identify return a TOP-LEVEL array, so their response paths start with "[]"
 * ("[].matches[].company_data.headcount.total" = every match of every entry).
 *
 * Nullable fields: the docs mark headcount/funding fields as nullable, so their `type` rules use the
 * checker's union form ("integer|null").
 *
 * Credit budget: enrich costs 2 credits per identifier (list price). Recon uses two real domains
 * (TIER_DOMAINS) for the tiering fields and one unmatchable domain, and prefers the free identify
 * endpoint wherever it suffices. Total recon spend is checked <= 40 in test/contracts.test.ts.
 */
import type { ContractEntry } from "./types.js";

const ENRICH_URL = "https://docs.crustdata.com/api-reference/company-apis/get-full-company-enrichment.md";
const IDENTIFY_URL =
  "https://docs.crustdata.com/api-reference/company-apis/identify-a-company-from-name-domain-id-or-profile-url.md";
const CREDITS_URL = "https://docs.crustdata.com/api-reference/account-apis/get-account-credit-balance.md";

const ENRICH = "crustdata.enrichCompany";
const IDENTIFY = "crustdata.identifyCompany";
const BALANCE = "crustdata.getCreditBalance";

/** Two real companies of clearly different size: enough to see both tier fields populated. */
const TIER_DOMAINS = ["stripe.com", "notion.so"];
/** Reserved TLD (RFC 2606): can never resolve to a company. */
const NO_MATCH_DOMAIN = "notary-no-such-company-7f3a9c.example";
const TIER_FIELDS = ["basic_info", "headcount", "funding"];

const enrichTierFields = {
  op: ENRICH,
  params: { domains: TIER_DOMAINS, fields: TIER_FIELDS },
  note: "Enrich two real domains with the tiering field groups (4 credits)",
};

export const crustdataContract: ContractEntry[] = [
  {
    // suspect: silent_coercion (headcount as a string or float would mis-tier near a boundary)
    claim: {
      id: "crustdata.enrich.headcount-total-integer",
      tool: "crustdata",
      operation: ENRICH,
      param: "fields",
      docText: "headcount.total: integer, nullable (enrich response schema)",
      expect: { kind: "type", field: "[].matches[].company_data.headcount.total", type: "integer|null" },
      docUrl: ENRICH_URL,
      endpoint: "POST /company/enrich",
      costCredits: 2,
    },
    recon: [enrichTierFields],
  },
  {
    // suspect: silent_coercion (funding returned as a formatted string, e.g. "$141M")
    claim: {
      id: "crustdata.enrich.funding-total-investment-number",
      tool: "crustdata",
      operation: ENRICH,
      param: "fields",
      docText: "funding.total_investment_usd: number, nullable (enrich response schema)",
      expect: { kind: "type", field: "[].matches[].company_data.funding.total_investment_usd", type: "number|null" },
      docUrl: ENRICH_URL,
      endpoint: "POST /company/enrich",
      costCredits: 2,
    },
    recon: [enrichTierFields],
  },
  {
    // suspect: mislabelled_semantics (range string vs headcount.total disagree on tier) — control on type
    claim: {
      id: "crustdata.enrich.employee-count-range-string",
      tool: "crustdata",
      operation: ENRICH,
      param: "fields",
      docText: "employee_count_range: string, nullable (example: 51-200)",
      expect: { kind: "type", field: "[].matches[].company_data.basic_info.employee_count_range", type: "string|null" },
      docUrl: ENRICH_URL,
      endpoint: "POST /company/enrich",
      costCredits: 2,
    },
    recon: [enrichTierFields],
  },
  {
    // suspect: silent_coercion (epoch number instead of a date string)
    claim: {
      id: "crustdata.enrich.last-fundraise-date-string",
      tool: "crustdata",
      operation: ENRICH,
      param: "fields",
      docText: "last_fundraise_date: string, format date, nullable (example: '2025-10-10')",
      expect: { kind: "type", field: "[].matches[].company_data.funding.last_fundraise_date", type: "string|null" },
      docUrl: ENRICH_URL,
      endpoint: "POST /company/enrich",
      costCredits: 2,
    },
    recon: [enrichTierFields],
  },
  {
    // suspect: honored (control) — default field groups
    claim: {
      id: "crustdata.enrich.default-fields-basic-info",
      tool: "crustdata",
      operation: ENRICH,
      param: "fields",
      docText:
        "When `fields` is omitted, only `crustdata_company_id` and `basic_info` are returned",
      expect: { kind: "fieldPresent", field: "[].matches[].company_data.basic_info" },
      docUrl: ENRICH_URL,
      endpoint: "POST /company/enrich",
      costCredits: 2,
    },
    recon: [
      {
        op: ENRICH,
        params: { domains: [TIER_DOMAINS[0]] },
        note: "Enrich one real domain with no fields (2 credits)",
      },
    ],
  },
  {
    // suspect: mislabelled_semantics (the spec also documents 404 "No data found" for the same case)
    claim: {
      id: "crustdata.enrich.no-match-200-empty",
      tool: "crustdata",
      operation: ENRICH,
      param: "domains",
      docText: "No-match responses currently return `200` with an empty `matches` array.",
      expect: { kind: "statusOnError", status: 200 },
      docUrl: ENRICH_URL,
      endpoint: "POST /company/enrich",
      costCredits: 2,
    },
    recon: [
      {
        op: ENRICH,
        params: { domains: [NO_MATCH_DOMAIN], fields: TIER_FIELDS },
        note: "Enrich an unmatchable domain (2 credits at most; X-Credits-Used shows if no-match is charged)",
      },
    ],
  },
  {
    // suspect: honored (control) — identify's documented no-match example; free
    claim: {
      id: "crustdata.identify.no-match-200-empty",
      tool: "crustdata",
      operation: IDENTIFY,
      param: "domains",
      docText: "[implied] no_match_found example returns 200 with matches: []; 404 is also documented as \"No data found\"",
      expect: { kind: "statusOnError", status: 200 },
      docUrl: IDENTIFY_URL,
      endpoint: "POST /company/identify",
      costCredits: 0,
    },
    recon: [
      {
        op: IDENTIFY,
        params: { domains: [NO_MATCH_DOMAIN] },
        note: "Identify an unmatchable domain (free)",
      },
    ],
  },
  {
    // suspect: undocumented_flag (an enrich-only group silently ignored or honored instead of 400)
    claim: {
      id: "crustdata.identify.invalid-fields-400",
      tool: "crustdata",
      operation: IDENTIFY,
      param: "fields",
      docText: "requesting any other group returns `400 Invalid fields`",
      expect: { kind: "statusOnError", status: 400 },
      docUrl: IDENTIFY_URL,
      endpoint: "POST /company/identify",
      costCredits: 0,
    },
    recon: [
      {
        op: IDENTIFY,
        params: { domains: [TIER_DOMAINS[0]], fields: ["headcount"] },
        note: "Ask identify for an enrich-only field group (free)",
      },
    ],
  },
  {
    // suspect: honored (control) — match confidence is numeric
    claim: {
      id: "crustdata.enrich.confidence-score-number",
      tool: "crustdata",
      operation: ENRICH,
      param: "domains",
      docText: "Each item in `matches` has `confidence_score` (number) and `company_data`.",
      expect: { kind: "type", field: "[].matches[].confidence_score", type: "number" },
      docUrl: ENRICH_URL,
      endpoint: "POST /company/enrich",
      costCredits: 2,
    },
    recon: [enrichTierFields],
  },
  {
    // suspect: silent_truncation (more than 25 results accepted). Observed from queue traffic: the
    // client refuses > 25 identifiers locally, so recon cannot send an over-limit request.
    claim: {
      id: "crustdata.identify.max-25-identifiers",
      tool: "crustdata",
      operation: IDENTIFY,
      param: "domains",
      docText: "each may contain 1 to 25 values.",
      expect: { kind: "maxItems", max: 25 },
      docUrl: IDENTIFY_URL,
      endpoint: "POST /company/identify",
      costCredits: 0,
    },
    recon: [],
  },
  {
    // suspect: honored (control) — balance is numeric (fractional)
    claim: {
      id: "crustdata.credits.balance-number",
      tool: "crustdata",
      operation: BALANCE,
      param: "",
      docText: "account.credits: number. Credits currently remaining on the account.",
      expect: { kind: "type", field: "account.credits", type: "number" },
      docUrl: CREDITS_URL,
      endpoint: "GET /account/credits",
      costCredits: 0,
    },
    recon: [{ op: BALANCE, params: {}, note: "Read the credit balance (free)" }],
  },
];

