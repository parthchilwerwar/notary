/**
 * USD per 1M input / output tokens, per model id.
 *
 * Resolution order for a call made by `role` with `modelId` (`priceCall`):
 *   1. env overrides NOTARY_PRICE_<ROLE>_IN and NOTARY_PRICE_<ROLE>_OUT (USD per 1M tokens; both
 *      must be set and be non-negative numbers) — they apply to any model id, LiteLLM names included,
 *   2. the cost the LiteLLM proxy reports for that response (`x-litellm-response-cost` header, USD),
 *   3. the table below (Bedrock model ids only),
 *   4. otherwise the price is unknown: usd = 0, price source "unknown", and a warning naming the
 *      env vars is recorded on the meter and printed once per process. Notary never guesses a
 *      price; set the env override for any model not listed.
 *
 * Sources (checked 2026-10-10):
 *   - AWS Bedrock pricing: https://aws.amazon.com/bedrock/pricing/  (authoritative for Bedrock)
 *   - Anthropic model pricing: https://platform.claude.com/docs/en/about-claude/pricing — lists the
 *     base input/output price per MTok used below, and states that from Claude Sonnet 4.5 / Haiku 4.5
 *     / Opus 4.5 onward, Bedrock regional (geo / in-region) endpoints carry a 10% premium over
 *     global endpoints; Opus 4.1 and earlier keep a single price.
 * The Bedrock page's price tables did not render for an automated fetch, so the figures are the
 * Anthropic list prices for Bedrock global endpoints. Only model ids whose exact Bedrock id is
 * known are listed; anything else (including newer models) needs the env override.
 */
import type { ModelRole } from "./roles.js";
import { baseModelId } from "./roles.js";
import { AGENTS } from "../schema/agents.js";

export type ModelPrice = {
  /** USD per 1M input tokens. */
  inPerM: number;
  /** USD per 1M output tokens. */
  outPerM: number;
};

type TableEntry = ModelPrice & {
  /** True for models priced +10% on regional/geo endpoints vs. "global." (Claude 4.5 and later). */
  regionalPremium: boolean;
};

export const BEDROCK_PRICING_URL = "https://aws.amazon.com/bedrock/pricing/";
export const REGIONAL_PREMIUM = 1.1;

/** Keyed by bare Bedrock model id (no geo prefix), lowercased. */
export const PRICE_TABLE: Readonly<Record<string, TableEntry>> = {
  "anthropic.claude-opus-4-5-20251101-v1:0": { inPerM: 5, outPerM: 25, regionalPremium: true },
  "anthropic.claude-sonnet-4-5-20250929-v1:0": { inPerM: 3, outPerM: 15, regionalPremium: true },
  "anthropic.claude-haiku-4-5-20251001-v1:0": { inPerM: 1, outPerM: 5, regionalPremium: true },
  "anthropic.claude-opus-4-1-20250805-v1:0": { inPerM: 15, outPerM: 75, regionalPremium: false },
  "anthropic.claude-opus-4-20250514-v1:0": { inPerM: 15, outPerM: 75, regionalPremium: false },
  "anthropic.claude-sonnet-4-20250514-v1:0": { inPerM: 3, outPerM: 15, regionalPremium: false },
  "anthropic.claude-3-5-haiku-20241022-v1:0": { inPerM: 0.8, outPerM: 4, regionalPremium: false },
};

export type PriceSource = "env" | "litellm" | "table" | "unknown";

export type ResolvedPrice = {
  price: ModelPrice | null;
  source: PriceSource;
  /** Set when the price could not be resolved (usd will be recorded as 0). */
  warning?: string;
};

type Env = Record<string, string | undefined>;

function envNumber(env: Env, name: string): number | undefined | "invalid" {
  const raw = (env[name] ?? "").trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

export function resolvePrice(role: ModelRole, modelId: string, env: Env = process.env): ResolvedPrice {
  const inName = `NOTARY_PRICE_${role.toUpperCase()}_IN`;
  const outName = `NOTARY_PRICE_${role.toUpperCase()}_OUT`;
  const inP = envNumber(env, inName);
  const outP = envNumber(env, outName);
  if (inP !== undefined || outP !== undefined) {
    if (typeof inP === "number" && typeof outP === "number") {
      return { price: { inPerM: inP, outPerM: outP }, source: "env" };
    }
    return {
      price: null,
      source: "unknown",
      warning: `${inName} and ${outName} must both be non-negative numbers (USD per 1M tokens); usd recorded as 0 for the ${AGENTS[role].name}`,
    };
  }

  const entry = PRICE_TABLE[baseModelId(modelId)];
  if (entry) {
    const isGlobal = /^global\./i.test(modelId.trim());
    const mult = entry.regionalPremium && !isGlobal ? REGIONAL_PREMIUM : 1;
    return { price: { inPerM: entry.inPerM * mult, outPerM: entry.outPerM * mult }, source: "table" };
  }
  return {
    price: null,
    source: "unknown",
    warning: `No price for model "${modelId}" (${AGENTS[role].name}); usd recorded as 0. Set ${inName} and ${outName} (USD per 1M tokens; Bedrock list prices: ${BEDROCK_PRICING_URL})`,
  };
}

/** The proxy-reported cost of one response (USD), or null when absent / unusable. */
export function reportedCostUsd(headers: Record<string, string> | undefined): number | null {
  const raw = headers?.["x-litellm-response-cost"]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type PricedCall = {
  usd: number;
  source: PriceSource;
  /** Set when the price is unknown (usd recorded as 0) or an override is half-set. */
  warning?: string;
};

/**
 * USD for one finished call, by precedence: env override > LiteLLM-reported > table > unknown (0).
 * `reportedUsd` is the proxy's own figure for this response, when it sent one.
 */
export function priceCall(
  role: ModelRole,
  modelId: string,
  tokens: { inputTokens: number; outputTokens: number },
  env: Env = process.env,
  reportedUsd: number | null = null,
): PricedCall {
  const r = resolvePrice(role, modelId, env);
  if (r.source === "env") return { usd: costUsd(r.price, tokens.inputTokens, tokens.outputTokens), source: "env" };
  // A half-set override is a config error: keep its warning even if the proxy reported a cost.
  const halfSet = r.warning && /must both be/.test(r.warning) ? { warning: r.warning } : {};
  if (reportedUsd !== null) return { usd: Math.round(reportedUsd * 1e9) / 1e9, source: "litellm", ...halfSet };
  if (r.source === "table") return { usd: costUsd(r.price, tokens.inputTokens, tokens.outputTokens), source: "table" };
  return { usd: 0, source: "unknown", ...(r.warning ? { warning: r.warning } : {}) };
}

/** USD for one call; 0 when the price is unknown. Rounded to 1e-9 to keep sums stable. */
export function costUsd(price: ModelPrice | null, inputTokens: number, outputTokens: number): number {
  if (!price) return 0;
  const usd = (inputTokens * price.inPerM + outputTokens * price.outPerM) / 1_000_000;
  return Math.round(usd * 1e9) / 1e9;
}
