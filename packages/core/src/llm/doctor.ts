/**
 * `notary doctor --llm`: is the model backend reachable and configured for every model agent? Output
 * names each role by its agent (src/schema/agents.ts): Executor, Reflector, Adversary (P2), plus
 * Notary Chat (NOTARY_MODEL_CHAT, falling back to NOTARY_MODEL_REFLECTOR), whose test call is a real
 * tool call (one function tool, tool_choice forcing it) because the chat agent needs tool calling.
 * The CLI loads .env, inits tracing ("doctor") and roots the run in a WORKFLOW span; this module
 * only checks and reports.
 *
 * litellm:
 *   1. config: provider, proxy URL (normalized), key set / not set (never its value), role models
 *   2. GET <base>/v1/models with the key → the ids this key may use
 *   3. each configured role model is in that list
 *   4. separation of duties: reflector ≠ adversary (base model id, as src/llm/roles.ts compares)
 *   5. one tiny call per role (max 5 output tokens, "Reply with OK") through the real LlmClient:
 *      latency, tokens, USD and where the price came from (env / litellm / table / unknown)
 * Also printed: the USD cap (NOTARY_MAX_USD) and each role's price source; an unknown price is a
 * WARN line naming NOTARY_PRICE_<ROLE>_IN/_OUT (usd is recorded as 0 until set).
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
import { CHAT_MODEL_ENV, CHAT_MODEL_FALLBACK_ENV, MODEL_ENV, ROLES, baseModelId, resolveChatModel } from "./roles.js";
import type { ModelRole } from "./roles.js";
import { AGENTS } from "../schema/agents.js";
import { roleAgentName as nm } from "./agents.js";
import { MAX_USD_ENV, maxUsdFromEnv } from "./budget.js";
import { resolvePrice } from "./pricing.js";
import { LLM_CONCURRENCY_ENV, LLM_MAX_429_RETRIES, LLM_MAX_BACKOFF_MS, LLM_RPM_ENV, llmConcurrencyFromEnv, llmRpmFromEnv } from "./limiter.js";

type Env = Record<string, string | undefined>;

export const DOCTOR_PROMPT = "Reply with OK";
export const DOCTOR_MAX_TOKENS = 5;
/** The chat role's check: one forced call of this tool (proves tool calling works through the provider). */
export const DOCTOR_TOOL = { name: "notary_ping", description: "Answer the doctor's ping.", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
export const DOCTOR_TOOL_PROMPT = "Call the notary_ping tool with ok=true.";
export const DOCTOR_TOOL_MAX_TOKENS = 60;

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
    out(`result: ${status === "ok" ? `OK — ${[...ROLES.map(nm), AGENTS.chat.name].join(", ").replace(/, ([^,]*)$/, " and $1")} answered` : status === "blocked" ? "BLOCKED — set the variables above" : "FAILED — fix the lines marked FAIL"}`);
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
  for (const role of ROLES) out(`  ${nm(role)} (${MODEL_ENV[role]}) = ${read(env, MODEL_ENV[role]) || "(not set)"}`);
  const chat = resolveChatModel(env);
  out(
    `  ${AGENTS.chat.name} (${CHAT_MODEL_ENV}) = ${
      chat ? (chat.source === CHAT_MODEL_ENV ? chat.model : `(not set; falls back to ${CHAT_MODEL_FALLBACK_ENV} = ${chat.model})`) : `(not set, and ${CHAT_MODEL_FALLBACK_ENV} is not set either)`
    }`,
  );

  // Rate limits (process-wide, every real model call).
  out(
    `  limits: ${LLM_RPM_ENV}=${llmRpmFromEnv(env)}/min, ${LLM_CONCURRENCY_ENV}=${llmConcurrencyFromEnv(env)} in flight` +
      ` (429 → up to ${LLM_MAX_429_RETRIES} retries honoring Retry-After, ≤ ${LLM_MAX_BACKOFF_MS / 1000} s each)`,
  );

  // Cost: the per-run cap and where each role's price will come from.
  try {
    const cap = maxUsdFromEnv(env);
    out(`  ${MAX_USD_ENV}: ${cap === null ? "not set (no USD cap)" : `$${cap} per run (calls stop before exceeding it)`}`);
  } catch {
    fail(`${MAX_USD_ENV} is "${read(env, MAX_USD_ENV)}"`, `set ${MAX_USD_ENV} to a non-negative number of USD per run, e.g. ${MAX_USD_ENV}=1, or leave it empty for no cap`);
  }
  const priced: { role: ModelRole; id: string; name: string }[] = [
    ...ROLES.flatMap((role) => (read(env, MODEL_ENV[role]) ? [{ role, id: read(env, MODEL_ENV[role]), name: nm(role) }] : [])),
    ...(chat ? [{ role: "chat" as const, id: chat.model, name: AGENTS.chat.name }] : []),
  ];
  for (const { role, id, name } of priced) {
    const r = resolvePrice(role, id, env);
    const names = `NOTARY_PRICE_${role.toUpperCase()}_IN/_OUT`;
    if (r.source === "env") out(`  price ${name}: env override ${names} ($${r.price!.inPerM} in / $${r.price!.outPerM} out per 1M tokens)`);
    else if (r.warning && /must both be/.test(r.warning)) fail(`price ${name}: ${r.warning}`, `set both ${names} (USD per 1M tokens) or neither`);
    else if (r.source === "table") out(`  price ${name}: Bedrock table ($${r.price!.inPerM} in / $${r.price!.outPerM} out per 1M tokens)${provider === "litellm" ? "; a proxy-reported cost takes precedence" : ""}`);
    else out(`  price ${name}: ${provider === "litellm" ? "the proxy's x-litellm-response-cost if it sends one, else unknown" : "unknown"} (set ${names} to fix it)`);
  }

  // Config issues, de-duplicated across roles (the connection settings are shared).
  const issues = new Map<string, LlmConfigIssue>();
  for (const role of [...ROLES, "chat" as const]) for (const i of llmConfigIssues(env, role)) if (!issues.has(i.variable)) issues.set(i.variable, i);
  const modelVars = [...Object.values(MODEL_ENV), CHAT_MODEL_ENV];
  const connectionMissing = [...issues.values()].some((i) => !modelVars.includes(i.variable));

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
    block(issue, role || issue.variable === CHAT_MODEL_ENV ? modelExample(available) : (EXAMPLE[issue.variable] ?? "<value>"));
  }

  // 3. Each configured role model is offered by the proxy.
  const offered = new Set(available ?? []);
  const usable: Role[] = [];
  for (const role of ROLES) {
    const id = read(env, MODEL_ENV[role]);
    if (!id) continue;
    if (available && !offered.has(id)) {
      fail(
        `${nm(role)}: model "${id}" is not offered by the proxy for this key`,
        `set ${MODEL_ENV[role]} to one of: ${available.join(", ") || "(none listed)"} (e.g. ${MODEL_ENV[role]}=${modelExample(available)})`,
      );
      continue;
    }
    if (available) out(`ok   ${nm(role)}: "${id}" is offered by the proxy`);
    usable.push(role);
  }
  let chatUsable = false;
  if (chat) {
    if (available && !offered.has(chat.model)) {
      fail(
        `${AGENTS.chat.name}: model "${chat.model}" (${chat.source}) is not offered by the proxy for this key`,
        `set ${CHAT_MODEL_ENV} to one of: ${available.join(", ") || "(none listed)"} (e.g. ${CHAT_MODEL_ENV}=${modelExample(available)})`,
      );
    } else {
      if (available) out(`ok   ${AGENTS.chat.name}: "${chat.model}" is offered by the proxy`);
      chatUsable = true;
    }
  }

  // 4. Separation of duties (same comparison as resolveModels).
  const refl = read(env, MODEL_ENV.reflector);
  const adv = read(env, MODEL_ENV.adversary);
  let separated = true;
  if (refl && adv) {
    if (baseModelId(refl) === baseModelId(adv)) {
      separated = false;
      fail(
        `separation of duties: ${nm("reflector")} and ${nm("adversary")} are the same model ("${refl}")`,
        `set ${MODEL_ENV.adversary} to a different model, e.g. ${MODEL_ENV.adversary}=${modelExample(available, [refl])}`,
      );
    } else {
      out(`ok   separation of duties: ${nm("reflector")} "${refl}" ≠ ${nm("adversary")} "${adv}"`);
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
        fail(`${nm(role)} test call: ${errText(err)}`, `fix the model settings in .env and rerun \`pnpm notary doctor --llm\``);
        continue;
      }
      const t0 = now();
      try {
        const res = await llm.complete({ role, messages: [{ role: "user", content: DOCTOR_PROMPT }], maxTokens: DOCTOR_MAX_TOKENS });
        const ms = Math.round(now() - t0);
        const source = res.priceSource ?? "unknown";
        out(
          `ok   ${nm(role)} test call: "${id}" ${ms} ms, ${res.inputTokens} in / ${res.outputTokens} out tokens, $${res.usd.toFixed(6)} (price: ${source}), stop ${res.stopReason}, reply ${JSON.stringify(res.text.slice(0, 40))}`,
        );
        if (source === "unknown") {
          const up = role.toUpperCase();
          out(`WARN ${nm(role)}: price unknown for "${id}" — USD is recorded as $0 (and ${MAX_USD_ENV} can only count proxy-reported costs)`);
          out(`  FIX: set NOTARY_PRICE_${up}_IN=<USD per 1M input tokens> and NOTARY_PRICE_${up}_OUT=<USD per 1M output tokens> in .env`);
        }
      } catch (err) {
        const status = statusOf(err);
        fail(
          `${nm(role)} test call ("${id}"): ${errText(err)}`,
          status === 401 || status === 403
            ? `the provider rejected the credentials; check ${provider === "litellm" ? LITELLM_API_KEY_ENV : "the AWS credentials"} in .env`
            : status === 404 || status === 400
              ? `check ${MODEL_ENV[role]} (e.g. ${MODEL_ENV[role]}=${modelExample(available)})`
              : `check the provider settings in .env and that ${provider === "litellm" ? "the proxy" : "Bedrock"} is reachable`,
        );
      }
    }
  }
  // 6. Notary Chat: one forced tool call (its agent loop depends on native tool calling).
  if (chat && chatUsable && !connectionMissing && !authRejected) {
    const chatEnv: Env = { ...env, [MODEL_ENV.executor]: "", [MODEL_ENV.adversary]: "" };
    try {
      const llm = new LlmClient({
        env: chatEnv,
        ...(opts.chatTransport ? { chatTransport: opts.chatTransport } : {}),
        ...(opts.transport ? { transport: opts.transport } : {}),
      });
      const t0 = now();
      const res = await llm.completeTools({
        role: "chat",
        agent: "chat",
        messages: [{ role: "user", content: DOCTOR_TOOL_PROMPT }],
        tools: [DOCTOR_TOOL],
        toolChoice: { name: DOCTOR_TOOL.name },
        maxTokens: DOCTOR_TOOL_MAX_TOKENS,
      });
      const ms = Math.round(now() - t0);
      const call = res.toolCalls.find((c) => c.name === DOCTOR_TOOL.name);
      const source = res.priceSource ?? "unknown";
      if (call) {
        out(
          `ok   ${AGENTS.chat.name} tool call: "${chat.model}" ${ms} ms, ${res.inputTokens} in / ${res.outputTokens} out tokens, $${res.usd.toFixed(6)} (price: ${source}), called ${call.name}(${call.arguments.slice(0, 40)})`,
        );
      } else {
        fail(
          `${AGENTS.chat.name} tool call ("${chat.model}"): the model answered without calling the tool (stop ${res.stopReason}, reply ${JSON.stringify(res.text.slice(0, 40))})`,
          `Notary Chat needs a model with tool calling through the proxy; set ${CHAT_MODEL_ENV} to one that supports it (e.g. ${CHAT_MODEL_ENV}=${modelExample(available)})`,
        );
      }
      if (call && source === "unknown") {
        out(`WARN ${AGENTS.chat.name}: price unknown for "${chat.model}" — USD is recorded as $0 (and ${MAX_USD_ENV} can only count proxy-reported costs)`);
        out(`  FIX: set NOTARY_PRICE_CHAT_IN=<USD per 1M input tokens> and NOTARY_PRICE_CHAT_OUT=<USD per 1M output tokens> in .env`);
      }
    } catch (err) {
      const status = statusOf(err);
      fail(
        `${AGENTS.chat.name} tool call ("${chat.model}"): ${errText(err)}`,
        status === 401 || status === 403
          ? `the provider rejected the credentials; check ${provider === "litellm" ? LITELLM_API_KEY_ENV : "the AWS credentials"} in .env`
          : `check ${CHAT_MODEL_ENV} (e.g. ${CHAT_MODEL_ENV}=${modelExample(available)}) and that the model supports tool calling`,
      );
    }
  }
  if (!separated) out(`note: the bundle-producing commands refuse this roster until the ${nm("reflector")} and the ${nm("adversary")} run on different models`);
  return finish(provider);
}
