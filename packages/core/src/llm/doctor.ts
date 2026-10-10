/**
 * `notary doctor --llm`: is the model backend reachable and configured for all three roles?
 * The CLI loads .env, inits tracing ("doctor") and roots the run in a WORKFLOW span; this module
 * only checks and reports.
 *
 * litellm:
 *   1. config: provider, proxy URL (normalized), key set / not set (never its value), role models
 *   2. GET <base>/v1/models with the key → the ids this key may use
 *   3. each configured role model is in that list
 *   4. separation of duties: reflector ≠ adversary (base model id, as src/llm/roles.ts compares)
 *   5. one tiny call per role (max 5 output tokens, "Reply with OK") through the real LlmClient:
 *      latency, tokens, USD
 * bedrock: the same, minus the listing (Bedrock has no per-key model list here); credentials are
 * only exercised by the test calls.
 *
 * Every problem prints one FIX line naming the exact env variable with an example value.
 * Exit codes follow `notary doctor`: 0 all good, 1 a real failure (wrong model, rejected key,
 * failed call, invalid config), 3 BLOCKED (a required variable is not set) when nothing failed.
 * Secrets: every line goes through the env scrubber (secret-looking env values → [REDACTED]),
 * error messages from the HTTP client included, and a URL never shows user:password.
 */
import type { Role } from "../schema/index.js";
import { LlmClient, scrubber } from "./client.js";
import type { ConverseTransport } from "./client.js";
import {
  AWS_REGION_ENV,
  LITELLM_API_KEY_ENV,
  LITELLM_BASE_URL_ENV,
  LLM_PROVIDER_ENV,
  llmConfigIssues,
  llmProvider,
  normalizeLiteLlmBaseUrl,
} from "./config.js";
import type { LlmConfigIssue, LlmProvider } from "./config.js";
import { liteLlmModelLister } from "./litellm.js";
import type { ChatTransport, ModelLister } from "./litellm.js";
import { MODEL_ENV, ROLES, baseModelId } from "./roles.js";

type Env = Record<string, string | undefined>;

export const DOCTOR_PROMPT = "Reply with OK";
export const DOCTOR_MAX_TOKENS = 5;

export type LlmDoctorOptions = {
  env?: Env;
  /** Test doubles; by default the real proxy / Bedrock are called. */
  chatTransport?: ChatTransport;
  transport?: ConverseTransport;
  listModels?: ModelLister;
  /** Monotonic ms clock for latency (default performance.now). */
  now?: () => number;
};

export type LlmDoctorReport = {
  status: "ok" | "failed" | "blocked";
  exitCode: 0 | 1 | 3;
  provider: LlmProvider | null;
  lines: string[];
};

const EXAMPLE: Record<string, string> = {
  [LLM_PROVIDER_ENV]: "litellm",
  [LITELLM_BASE_URL_ENV]: "https://litellm.example.com/v1",
  [LITELLM_API_KEY_ENV]: "<your LiteLLM proxy key>",
  [AWS_REGION_ENV]: "us-east-1",
};

function read(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

/** A URL for display: no user:password, no query. */
function displayUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "(unparseable)";
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

/** "e.g." model ids for a role's FIX line: listed ids first, else a placeholder. */
function modelExample(available: readonly string[] | null, avoid: readonly string[] = []): string {
  const pick = available?.find((id) => !avoid.includes(id));
  return pick ?? "<model id>";
}

export async function runLlmDoctor(opts: LlmDoctorOptions = {}): Promise<LlmDoctorReport> {
  const env = opts.env ?? process.env;
  const clean = scrubber(env);
  const now = opts.now ?? (() => performance.now());
  const lines: string[] = [];
  let failed = false;
  let blocked = false;
  const out = (s: string): void => void lines.push(clean(s));
  const fail = (what: string, fix: string): void => {
    failed = true;
    out(`FAIL ${what}`);
    out(`  FIX: ${fix}`);
  };
  const block = (issue: LlmConfigIssue, example: string): void => {
    if (issue.problem === "invalid") failed = true;
    else blocked = true;
    out(issue.message);
    out(`  FIX: add ${issue.variable}=${example} to .env (see .env.example)`);
  };
  const finish = (provider: LlmProvider | null): LlmDoctorReport => {
    const status = failed ? "failed" : blocked ? "blocked" : "ok";
    out(`result: ${status === "ok" ? "OK — all three roles answered" : status === "blocked" ? "BLOCKED — set the variables above" : "FAILED — fix the lines marked FAIL"}`);
    return { status, exitCode: failed ? 1 : blocked ? 3 : 0, provider, lines };
  };

  // 1. Provider and connection config.
  let provider: LlmProvider;
  try {
    provider = llmProvider(env);
  } catch {
    fail(`${LLM_PROVIDER_ENV} is "${read(env, LLM_PROVIDER_ENV)}"`, `set ${LLM_PROVIDER_ENV}=litellm (or bedrock) in .env`);
    return finish(null);
  }
  out(`provider: ${provider}${read(env, LLM_PROVIDER_ENV) ? "" : ` (${LLM_PROVIDER_ENV} unset: default)`}`);
  let baseUrl: string | null = null;
  if (provider === "litellm") {
    const raw = read(env, LITELLM_BASE_URL_ENV);
    baseUrl = raw ? normalizeLiteLlmBaseUrl(raw) : null;
    out(`  ${LITELLM_BASE_URL_ENV}: ${raw ? (baseUrl ? `${displayUrl(baseUrl)} (normalized)` : "invalid") : "not set"}`);
    out(`  ${LITELLM_API_KEY_ENV}: ${read(env, LITELLM_API_KEY_ENV) ? "set (value never shown)" : "not set"}`);
  } else {
    out(`  ${AWS_REGION_ENV}: ${read(env, AWS_REGION_ENV) || "not set"}`);
    out("  AWS credentials: SDK default chain (env keys / profile / SSO); exercised by the test calls only");
  }
  for (const role of ROLES) out(`  ${role.padEnd(9)} ${MODEL_ENV[role]} = ${read(env, MODEL_ENV[role]) || "(not set)"}`);

  // Config issues, de-duplicated across roles (the connection settings are shared).
  const issues = new Map<string, LlmConfigIssue>();
  for (const role of ROLES) for (const i of llmConfigIssues(env, role)) if (!issues.has(i.variable)) issues.set(i.variable, i);
  const connectionMissing = [...issues.values()].some((i) => !Object.values(MODEL_ENV).includes(i.variable));

  // 2. Model listing (litellm only, needs URL + key).
  let available: string[] | null = null;
  let authRejected = false;
  if (provider === "litellm" && !connectionMissing && baseUrl) {
    const lister = opts.listModels ?? liteLlmModelLister({ baseUrl, apiKey: read(env, LITELLM_API_KEY_ENV) });
    const t0 = now();
    try {
      available = await lister();
      out(`ok   GET /v1/models: ${available.length} model(s) for this key (${Math.round(now() - t0)} ms): ${available.join(", ") || "(none)"}`);
    } catch (err) {
      const status = statusOf(err);
      authRejected = status === 401 || status === 403;
      fail(
        `GET /v1/models: ${errText(err)}`,
        authRejected
          ? `the proxy rejected the key; set ${LITELLM_API_KEY_ENV}=<a valid proxy key> in .env`
          : `check ${LITELLM_BASE_URL_ENV} (e.g. ${LITELLM_BASE_URL_ENV}=${EXAMPLE[LITELLM_BASE_URL_ENV]}) and that the proxy is reachable`,
      );
    }
  } else if (provider === "bedrock") {
    out("skip model listing: not available for bedrock");
  }

  // Missing / invalid variables (with listed ids as examples where possible).
  for (const issue of issues.values()) {
    const role = ROLES.find((r) => MODEL_ENV[r] === issue.variable);
    block(issue, role ? modelExample(available) : (EXAMPLE[issue.variable] ?? "<value>"));
  }

  // 3. Each configured role model is offered by the proxy.
  const offered = new Set(available ?? []);
  const usable: Role[] = [];
  for (const role of ROLES) {
    const id = read(env, MODEL_ENV[role]);
    if (!id) continue;
    if (available && !offered.has(id)) {
      fail(
        `${role}: model "${id}" is not offered by the proxy for this key`,
        `set ${MODEL_ENV[role]} to one of: ${available.join(", ") || "(none listed)"} (e.g. ${MODEL_ENV[role]}=${modelExample(available)})`,
      );
      continue;
    }
    if (available) out(`ok   ${role}: "${id}" is offered by the proxy`);
    usable.push(role);
  }

  // 4. Separation of duties (same comparison as resolveModels).
  const refl = read(env, MODEL_ENV.reflector);
  const adv = read(env, MODEL_ENV.adversary);
  let separated = true;
  if (refl && adv) {
    if (baseModelId(refl) === baseModelId(adv)) {
      separated = false;
      fail(
        `separation of duties: reflector and adversary are the same model ("${refl}")`,
        `set ${MODEL_ENV.adversary} to a different model, e.g. ${MODEL_ENV.adversary}=${modelExample(available, [refl])}`,
      );
    } else {
      out(`ok   separation of duties: reflector "${refl}" ≠ adversary "${adv}"`);
    }
  }

  // 5. One tiny call per usable role.
  if (connectionMissing) {
    out("skip test calls: connection settings missing (see BLOCKED above)");
  } else if (authRejected) {
    out("skip test calls: the proxy rejected the key");
  } else {
    for (const role of usable) {
      const id = read(env, MODEL_ENV[role]);
      // One client per role holding only that role's model, so a separation-of-duties breach in the
      // other roles never stops this role's check (it is reported above).
      const roleEnv: Env = { ...env };
      for (const other of ROLES) if (other !== role) roleEnv[MODEL_ENV[other]] = "";
      let llm: LlmClient;
      try {
        llm = new LlmClient({
          env: roleEnv,
          ...(opts.chatTransport ? { chatTransport: opts.chatTransport } : {}),
          ...(opts.transport ? { transport: opts.transport } : {}),
        });
      } catch (err) {
        fail(`${role} test call: ${errText(err)}`, `fix the model settings in .env and rerun \`pnpm notary doctor --llm\``);
        continue;
      }
      const t0 = now();
      try {
        const res = await llm.complete({ role, messages: [{ role: "user", content: DOCTOR_PROMPT }], maxTokens: DOCTOR_MAX_TOKENS });
        const ms = Math.round(now() - t0);
        out(
          `ok   ${role} test call: "${id}" ${ms} ms, ${res.inputTokens} in / ${res.outputTokens} out tokens, $${res.usd.toFixed(6)}, stop ${res.stopReason}, reply ${JSON.stringify(res.text.slice(0, 40))}`,
        );
      } catch (err) {
        const status = statusOf(err);
        fail(
          `${role} test call ("${id}"): ${errText(err)}`,
          status === 401 || status === 403
            ? `the provider rejected the credentials; check ${provider === "litellm" ? LITELLM_API_KEY_ENV : "the AWS credentials"} in .env`
            : status === 404 || status === 400
              ? `check ${MODEL_ENV[role]} (e.g. ${MODEL_ENV[role]}=${modelExample(available)})`
              : `check the provider settings in .env and that ${provider === "litellm" ? "the proxy" : "Bedrock"} is reachable`,
        );
      }
    }
  }
  if (!separated) out("note: the bundle-producing commands refuse this roster until reflector ≠ adversary");
  return finish(provider);
}
