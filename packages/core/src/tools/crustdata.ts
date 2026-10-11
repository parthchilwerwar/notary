/**
 * RAW Crustdata client. Not exported from src/tools/index.ts: callers get these methods only
 * through createTools(), which routes each one through `wrap` (guarded() from P6).
 *
 * Endpoints and costs: docs/ENDPOINTS.md. Every call reserves its estimated credits from the
 * ledger first (BudgetExceededError stops it before any I/O), then settles the actual charge from
 * the `X-Credits-Used` response header, falling back to the documented list price.
 *
 * Rate limit: every live request waits for the process-wide Crustdata limiter (15/min, see
 * ratelimit.ts; enforced in Recorder.request). A 429 is settled at 0 credits unless the response
 * carries `X-Credits-Used`, then retried at most CRUSTDATA_MAX_429_RETRIES time(s) after the back-off
 * the server asked for (Retry-After / x-ratelimit-reset, else one full window); a second 429, or a
 * back-off over CRUSTDATA_MAX_BACKOFF_MS, throws RateLimitedError. Both exchanges are recorded, so
 * replay makes the same decision without waiting.
 */
import { buildUrl, requireEnv } from "./client.js";
import type { ToolResult } from "./client.js";
import { CassetteMissError, MissingCredentialError, RateLimitedError, RequestNotSentError, ToolHttpError } from "./errors.js";
import type { CreditLedger } from "./ledger.js";
import {
  CRUSTDATA_MAX_429_RETRIES,
  CRUSTDATA_MAX_BACKOFF_MS,
  CRUSTDATA_MAX_REQUESTS_PER_WINDOW,
  CRUSTDATA_RATE_WINDOW_MS,
  backOffFromHeaders,
} from "./ratelimit.js";
import type { RecordedResponse, Recorder } from "./recorder.js";

export const CRUSTDATA_BASE_URL = "https://api.crustdata.com";
export const CRUSTDATA_API_VERSION = "2025-11-01";
const TOOL = "crustdata";

/** Documented list prices (docs.crustdata.com/general/pricing). */
export const CRUSTDATA_LIST_PRICE = {
  enrichPerRecord: 2,
  technographicsPerRecord: 2,
  identify: 0,
  creditBalance: 0,
} as const;

export type EnrichFieldGroup =
  | "basic_info"
  | "headcount"
  | "funding"
  | "hiring"
  | "people"
  | "technographics"
  | (string & {});

export type IdentifyFieldGroup = "crustdata_company_id" | "basic_info" | "social_profiles";

/** Exactly one identifier type per request (docs). Notary uses domains. */
export interface CompanyIdentifiers {
  domains?: string[];
  names?: string[];
  crustdata_company_ids?: number[];
  professional_network_profile_urls?: string[];
}

export interface EnrichCompanyParams extends CompanyIdentifiers {
  fields?: EnrichFieldGroup[];
  exact_match?: boolean | null;
}

export interface IdentifyCompanyParams extends CompanyIdentifiers {
  fields?: IdentifyFieldGroup[];
  exact_match?: boolean | null;
}

export interface CompanyData {
  crustdata_company_id?: number;
  basic_info?: { name?: string; primary_domain?: string; employee_count_range?: string; [k: string]: unknown };
  headcount?: { total?: number | null; [k: string]: unknown };
  funding?: {
    total_investment_usd?: number | null;
    last_round_type?: string | null;
    last_fundraise_date?: string | null;
    [k: string]: unknown;
  };
  market_intel?: { num_employees_min?: number | null; num_employees_max?: number | null; [k: string]: unknown };
  [k: string]: unknown;
}

export interface CompanyMatchResult {
  matched_on: string;
  match_type: "name" | "domain" | "crustdata_company_id" | "professional_network_profile_url";
  matches: Array<{ confidence_score: number; company_data: CompanyData }>;
}

export interface CreditBalance {
  account: {
    credits: number;
    recurring_credits?: number;
    recurring_credits_frequency?: string | null;
    recurring_credits_refresh_date?: string | null;
    [k: string]: unknown;
  };
}

export interface CrustdataClientOptions {
  recorder: Recorder;
  ledger: CreditLedger;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

function identifierCount(p: CompanyIdentifiers): number {
  const lists = [p.domains, p.names, p.crustdata_company_ids, p.professional_network_profile_urls].filter(
    (l) => Array.isArray(l),
  );
  if (lists.length !== 1) throw new Error("Crustdata: provide exactly one identifier type");
  const n = lists[0]!.length;
  if (n === 0) throw new Error("Crustdata: identifier list is empty");
  return n;
}

/** Parse `X-Credits-Used`; absent → documented fallback (0 on 429, where the docs say it's absent). */
function creditsFrom(fallback: number) {
  return (res: { status: number; headers: Record<string, string> }): number => {
    const raw = res.headers["x-credits-used"];
    if (raw !== undefined && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
    if (res.status === 429) return 0;
    return fallback;
  };
}

export class CrustdataClient {
  private readonly recorder: Recorder;
  private readonly ledger: CreditLedger;
  private readonly baseUrl: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: CrustdataClientOptions) {
    this.recorder = opts.recorder;
    this.ledger = opts.ledger;
    this.baseUrl = opts.baseUrl ?? CRUSTDATA_BASE_URL;
    this.env = opts.env ?? process.env;
  }

  /** POST /company/enrich — tiering fields (headcount, funding) must be requested explicitly. */
  enrichCompany(params: EnrichCompanyParams): Promise<ToolResult<CompanyMatchResult[]>> {
    const n = identifierCount(params);
    const perRecord =
      CRUSTDATA_LIST_PRICE.enrichPerRecord +
      (params.fields?.includes("technographics") ? CRUSTDATA_LIST_PRICE.technographicsPerRecord : 0);
    return this.call("crustdata.enrichCompany", "POST", "/company/enrich", params, n * perRecord);
  }

  /** POST /company/identify — free per the pricing page; 1–25 identifiers. */
  identifyCompany(params: IdentifyCompanyParams): Promise<ToolResult<CompanyMatchResult[]>> {
    const n = identifierCount(params);
    if (n > 25) throw new Error("Crustdata identify accepts at most 25 identifiers");
    return this.call("crustdata.identifyCompany", "POST", "/company/identify", params, CRUSTDATA_LIST_PRICE.identify);
  }

  /** GET /account/credits — free. */
  getCreditBalance(): Promise<ToolResult<CreditBalance>> {
    return this.call("crustdata.getCreditBalance", "GET", "/account/credits", undefined, CRUSTDATA_LIST_PRICE.creditBalance);
  }

  private async call<T>(op: string, method: string, path: string, body: unknown, estimate: number): Promise<ToolResult<T>> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.attempt(op, method, path, body, estimate);
      if (res.status === 429) {
        const asked = backOffFromHeaders(res.headers, Date.parse(res.exchange.recordedAt));
        const limit = `limit ${CRUSTDATA_MAX_REQUESTS_PER_WINDOW}/${CRUSTDATA_RATE_WINDOW_MS / 1000}s`;
        if (attempt > CRUSTDATA_MAX_429_RETRIES) {
          throw new RateLimitedError(op, res.body, res.exchange.id, attempt, asked, `still limited after waiting out the back-off (${limit}); try again later or lower NOTARY_CRUSTDATA_RPM`);
        }
        const waitMs = asked ?? CRUSTDATA_RATE_WINDOW_MS;
        if (waitMs > CRUSTDATA_MAX_BACKOFF_MS) {
          throw new RateLimitedError(op, res.body, res.exchange.id, attempt, asked, `server asked for a ${Math.ceil(waitMs / 1000)}s back-off, over the ${CRUSTDATA_MAX_BACKOFF_MS / 1000}s Notary will wait (${limit})`);
        }
        // Live: every Crustdata caller in this process pauses until the back-off passes. Replay: no-op.
        this.recorder.rateLimitBackOff(TOOL, waitMs);
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new ToolHttpError(op, res.status, res.body, res.exchange.id);
      return { data: res.body as T, status: res.status, exchangeId: res.exchange.id };
    }
  }

  /** One HTTP request: reserve, send, settle. Returns any status; throws only when nothing came back. */
  private async attempt(op: string, method: string, path: string, body: unknown, estimate: number): Promise<RecordedResponse> {
    this.ledger.reserve(op, estimate);
    let res: RecordedResponse;
    try {
      res = await this.recorder.request({
        tool: TOOL,
        op,
        method,
        url: buildUrl(this.baseUrl, path),
        body,
        headers: () => ({
          authorization: `Bearer ${requireEnv(this.env, "CRUSTDATA_API_KEY")}`,
          "x-api-version": CRUSTDATA_API_VERSION,
        }),
        credits: creditsFrom(estimate),
      });
    } catch (err) {
      if (err instanceof MissingCredentialError || err instanceof CassetteMissError || err instanceof RequestNotSentError) {
        this.ledger.release(op); // nothing was sent
      } else {
        // Sent but no response (network error): the charge is unknown, so assume the estimate.
        this.ledger.countCall(op);
        this.ledger.settle(op, estimate);
      }
      throw err;
    }
    this.ledger.countCall(op);
    // A 429 without X-Credits-Used settles 0 (creditsFrom); with the header, what the API says.
    this.ledger.settle(op, res.exchange.credits ?? (res.status === 429 ? 0 : estimate));
    return res;
  }
}
