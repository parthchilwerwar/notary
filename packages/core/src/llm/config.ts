/**
 * Which model backend Notary talks to, and whether it is configured — one provider-aware answer
 * used by every "is the model configured?" check (notarize preflight, the fixture demo's live-stop
 * table, Ask Notary, `notary doctor --llm`).
 *
 *   NOTARY_LLM_PROVIDER   "litellm" | "bedrock". Unset/empty means "bedrock" (the original
 *                          behavior, so existing setups keep working unchanged).
 *
 * litellm: an OpenAI-compatible LiteLLM proxy, `POST <base>/v1/chat/completions`.
 *   LITELLM_BASE_URL       proxy URL; a trailing "/" or "/v1" is accepted and normalized, so both
 *                          https://proxy.example and https://proxy.example/v1 work (never /v1/v1).
 *   LITELLM_API_KEY        the proxy key (sent as a Bearer token; never printed, logged or traced).
 *                          Required: a proxy without auth can take any non-empty placeholder.
 * bedrock: AWS Bedrock Converse.
 *   AWS_REGION             plus credentials from the AWS SDK's default chain (env keys, profile, SSO).
 *
 * Both: the same three role model ids, NOTARY_MODEL_EXECUTOR / _REFLECTOR / _ADVERSARY
 * (LiteLLM model names such as "claude-haiku" for litellm, Bedrock model ids for bedrock), plus
 * Notary Chat's NOTARY_MODEL_CHAT (falls back to NOTARY_MODEL_REFLECTOR; src/llm/roles.ts).
 *
 * Nothing here performs I/O; a missing variable is reported by name, never by value.
 */
import { MissingCredentialError } from "../tools/errors.js";
import { CHAT_MODEL_ENV, CHAT_MODEL_FALLBACK_ENV, LLM_FIX_HINT, MODEL_ENV, ModelConfigError, resolveChatModel } from "./roles.js";
import type { ModelRole } from "./roles.js";

export { LLM_FIX_HINT };

type Env = Record<string, string | undefined>;

export type LlmProvider = "bedrock" | "litellm";
export const LLM_PROVIDERS: readonly LlmProvider[] = ["litellm", "bedrock"];
export const LLM_PROVIDER_ENV = "NOTARY_LLM_PROVIDER";
/** Unset provider: Bedrock, as before the LiteLLM backend existed. */
export const DEFAULT_LLM_PROVIDER: LlmProvider = "bedrock";
export const LITELLM_BASE_URL_ENV = "LITELLM_BASE_URL";
export const LITELLM_API_KEY_ENV = "LITELLM_API_KEY";
export const AWS_REGION_ENV = "AWS_REGION";

function read(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

/** The configured provider. Throws ModelConfigError for a value that can never be valid. */
export function llmProvider(env: Env = process.env): LlmProvider {
  const raw = read(env, LLM_PROVIDER_ENV).toLowerCase();
  if (!raw) return DEFAULT_LLM_PROVIDER;
  if (raw === "litellm" || raw === "bedrock") return raw;
  throw new ModelConfigError(
    `${LLM_PROVIDER_ENV} must be "litellm" or "bedrock" (got "${raw}"); fix it in .env (see .env.example) and run \`pnpm notary doctor --llm\``,
  );
}

/**
 * Normalize a LiteLLM base URL to its OpenAI-compatible root ending in "/v1":
 * "https://p.example", "https://p.example/", "https://p.example/v1" and "https://p.example/v1/"
 * all become "https://p.example/v1". Returns null when the value isn't an http(s) URL.
 */
export function normalizeLiteLlmBaseUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  s = s.replace(/\/+$/, "");
  while (/\/v1$/i.test(s)) s = s.replace(/\/v1$/i, "").replace(/\/+$/, "");
  return `${s}/v1`;
}

/** One reason the model for a role can't be called, named by its env variable. */
export type LlmConfigIssue = {
  variable: string;
  problem: "not set" | "invalid";
  /** Full BLOCKED message (never contains a secret value). */
  message: string;
};

export function llmBlockedMessage(variable: string): string {
  return `BLOCKED: ${variable} not set — ${LLM_FIX_HINT}`;
}

/** The BLOCKED error for a missing model setting (MissingCredentialError, so isBlocked() holds). */
export function llmMissing(variable: string): MissingCredentialError {
  return new MissingCredentialError(variable, LLM_FIX_HINT);
}

/** The BLOCKED message for a variable that is set but can never work. */
export function llmInvalidMessage(variable: string, what: string): string {
  return `BLOCKED: ${variable} ${what} — fix it in .env (see .env.example) and run \`pnpm notary doctor --llm\``;
}

function invalid(variable: string, what: string): LlmConfigIssue {
  return { variable, problem: "invalid", message: llmInvalidMessage(variable, what) };
}

/** The BLOCKED error for a set-but-unusable model setting (still a MissingCredentialError, so isBlocked() holds). */
export function llmInvalid(variable: string, what: string): MissingCredentialError {
  const err = new MissingCredentialError(variable);
  err.message = llmInvalidMessage(variable, what);
  return err;
}

function missing(variable: string): LlmConfigIssue {
  return { variable, problem: "not set", message: llmBlockedMessage(variable) };
}

/**
 * Every reason `role`'s model can't be called with this env, in a fixed order: provider, role
 * model id, then the provider's connection settings. Empty when configured. Pure, never throws.
 * (A wrong key or an unreachable proxy is not visible here — `notary doctor --llm` checks those.)
 */
export function llmConfigIssues(env: Env, role: ModelRole): LlmConfigIssue[] {
  let provider: LlmProvider;
  try {
    provider = llmProvider(env);
  } catch {
    return [invalid(LLM_PROVIDER_ENV, `must be "litellm" or "bedrock" (got "${read(env, LLM_PROVIDER_ENV)}")`)];
  }
  const out: LlmConfigIssue[] = [];
  if (role === "chat") {
    if (!resolveChatModel(env)) out.push({ variable: CHAT_MODEL_ENV, problem: "not set", message: `BLOCKED: ${CHAT_MODEL_ENV} not set (and ${CHAT_MODEL_FALLBACK_ENV}, its fallback, is not set either) — ${LLM_FIX_HINT}` });
  } else if (!read(env, MODEL_ENV[role])) out.push(missing(MODEL_ENV[role]));
  if (provider === "litellm") {
    const base = read(env, LITELLM_BASE_URL_ENV);
    if (!base) out.push(missing(LITELLM_BASE_URL_ENV));
    else if (!normalizeLiteLlmBaseUrl(base)) out.push(invalid(LITELLM_BASE_URL_ENV, "is not an http(s) URL"));
    if (!read(env, LITELLM_API_KEY_ENV)) out.push(missing(LITELLM_API_KEY_ENV));
  } else if (!read(env, AWS_REGION_ENV)) {
    out.push(missing(AWS_REGION_ENV));
  }
  return out;
}

/** The first env variable to fix before `role`'s model can be called, or null when configured. */
export function llmConfigProblem(env: Env, role: ModelRole): string | null {
  return llmConfigIssues(env, role)[0]?.variable ?? null;
}

/** The BLOCKED message for `role` ("BLOCKED: <VAR> not set — …"), or null when configured. No I/O. */
export function llmBlockedReason(env: Env, role: ModelRole): string | null {
  return llmConfigIssues(env, role)[0]?.message ?? null;
}
