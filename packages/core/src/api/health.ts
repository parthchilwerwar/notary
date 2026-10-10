// GET /api/health (no token): the state of each integration `notary serve` depends on, from the
// same checks the doctors run. Nothing here is canned: every state comes from the environment the
// server loaded, a real zero-cost call, or this process's own tracing state.
//
//   llm        src/llm/config.ts (provider-aware variables) + separation of duties; litellm: the
//              doctor's GET <base>/v1/models with the key, every role model must be offered →
//              connected; bedrock: no zero-cost check exists → configured
//   crustdata  CRUSTDATA_API_KEY; GET /account/credits (free: CRUSTDATA_LIST_PRICE.creditBalance = 0,
//              run on a 0-credit ledger so a charge is impossible) → connected
//   dodo       DODO_PAYMENTS_API_KEY + the test-mode lock (NOTARY_MODE=test, test base URL); a free
//              test-mode read, GET /customers?page_size=1 → connected
//   neatlogs   NEATLOGS_API_KEY; this process's SDK state (src/trace tracingStatus): a span exported
//              and flushed OK → connected, SDK initialized → configured, init/flush failure → error
//   entire     the Entire CLI on PATH → connected, else missing with the install instruction
//
// The network checks (llm, crustdata, dodo) are cached for HEALTH_TTL_MS so a polling page never
// spams the proxy or the APIs; concurrent requests share one in-flight check. Both API probes build
// the tools through createTools with a read-only wrap that refuses every op but the one read.
// Labels are exactly "connected" | "configured" | "missing <VAR>" | "error <one line>"; every
// detail, label and fix goes through the env scrubber, and no value of any variable is ever read
// into a response (only whether it is set).
import { findOnPath } from "../beliefs/evidence.js";
import { scrubber } from "../llm/client.js";
import {
  AWS_REGION_ENV,
  LITELLM_API_KEY_ENV,
  LITELLM_BASE_URL_ENV,
  LLM_PROVIDER_ENV,
  llmConfigIssues,
  llmProvider,
  normalizeLiteLlmBaseUrl,
} from "../llm/config.js";
import type { LlmConfigIssue, LlmProvider } from "../llm/config.js";
import { liteLlmModelLister } from "../llm/litellm.js";
import { MODEL_ENV, ROLES, baseModelId } from "../llm/roles.js";
import { HealthResponseSchema } from "../schema/api.js";
import type { HealthResponse, IntegrationName, IntegrationStatus } from "../schema/api.js";
import { CreditLedger, DODO_TEST_BASE_URL, ToolHttpError, createTools } from "../tools/index.js";
import type { Wrap } from "../tools/index.js";
import { exportedTraceIdsInProcess, tracingStatus } from "../trace/index.js";
import type { TracingState } from "../trace/index.js";
import { dodoTestMode } from "./approvals.js";

type Env = NodeJS.ProcessEnv;

export const HEALTH_TTL_MS = 60_000;
/** Per-probe timeout for the network checks. */
export const HEALTH_PROBE_TIMEOUT_MS = 10_000;
export const INTEGRATIONS: readonly IntegrationName[] = ["llm", "crustdata", "dodo", "neatlogs", "entire"];
const RESTART = "then restart `pnpm notary serve`";
export const ENTIRE_INSTALL_FIX =
  "Install the Entire CLI (https://docs.entire.io) so `entire` is on PATH, run `entire enable` in the repo, then restart `pnpm notary serve`";

/** Test seams: every external check. Defaults call the real services / read the real process state. */
export interface HealthProbes {
  /** GET <base>/v1/models with the key (litellm). */
  listModels?: (baseUrl: string, apiKey: string) => Promise<string[]>;
  /** Crustdata's free credit-balance read; throws on failure. */
  crustdata?: (env: Env) => Promise<void>;
  /** Dodo's free test-mode read; throws on failure. */
  dodo?: (env: Env) => Promise<void>;
  entireOnPath?: (env: Env) => boolean;
  tracing?: () => { init: TracingState | null; lastFlush: { ok: boolean; at: string } | null; exportedTraces: number };
}

export interface HealthOptions {
  env?: Env;
  now?: () => Date;
  /** Monotonic ms clock for the cache (default Date.now). */
  clock?: () => number;
  ttlMs?: number;
  probes?: HealthProbes;
}

type Body = Omit<IntegrationStatus, "name" | "checkedAt">;

function oneLine(s: string, max = 240): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof ToolHttpError) return err.status;
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

const connected = (detail?: string): Body => ({ state: "connected", label: "connected", ...(detail ? { detail } : {}) });
const configured = (detail: string, fix?: string): Body => ({ state: "configured", label: "configured", detail, ...(fix ? { fix } : {}) });
const missing = (variable: string, fix: string, detail?: string): Body => ({
  state: "missing",
  label: `missing ${variable}`,
  variable,
  fix,
  ...(detail ? { detail } : {}),
});
const failed = (detail: string, fix: string, variable?: string): Body => ({
  state: "error",
  label: `error ${oneLine(detail)}`,
  detail: oneLine(detail),
  fix,
  ...(variable ? { variable } : {}),
});

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** A wrap that lets exactly the named read ops through and refuses everything else (health probes only). */
export function readOnlyProbeWrap(allowed: readonly string[]): Wrap {
  return ((op: string, fn: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      if (!allowed.includes(op)) throw new Error(`health probe: ${op} is not allowed (read-only check)`);
      return await fn(...args);
    }) as Wrap;
}

/** Crustdata GET /account/credits (free) on a 0-credit ledger: a charge would throw before the call. */
async function defaultCrustdataProbe(env: Env): Promise<void> {
  const tools = createTools({
    mode: "live",
    // The tools bundle always constructs the Dodo client, whose constructor enforces the test-mode
    // lock. This probe never reaches Dodo (the wrap refuses every Dodo op), so it pins the Dodo side
    // to the test URL + test mode instead of letting the Dodo lock decide the Crustdata state.
    env: { ...env, NOTARY_MODE: "test" },
    dodoBaseUrl: DODO_TEST_BASE_URL,
    wrap: readOnlyProbeWrap(["crustdata.getCreditBalance"]),
    ledger: new CreditLedger({ budget: 0 }),
    timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
  });
  await tools.crustdata.getCreditBalance();
}

/** Dodo GET /customers?page_size=1 in test mode (the client refuses anything else). */
async function defaultDodoProbe(env: Env): Promise<void> {
  const tools = createTools({
    mode: "live",
    env,
    wrap: readOnlyProbeWrap(["dodo.listCustomers"]),
    ledger: new CreditLedger({ budget: 0 }),
    timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
  });
  await tools.dodo.listCustomers({ page_size: 1 });
}

function defaultTracing(): ReturnType<NonNullable<HealthProbes["tracing"]>> {
  const s = tracingStatus();
  return { ...s, exportedTraces: exportedTraceIdsInProcess().size };
}

function read(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

function listVars(vars: readonly string[]): string {
  if (vars.length <= 1) return vars.join("");
  return `${vars.slice(0, -1).join(", ")} and ${vars[vars.length - 1]}`;
}

// ------------------------------------------------------------------------------------------- llm

async function llmCheck(env: Env, probes: HealthProbes): Promise<Body> {
  let provider: LlmProvider;
  try {
    provider = llmProvider(env);
  } catch {
    return failed(`${LLM_PROVIDER_ENV} must be "litellm" or "bedrock"`, `Set ${LLM_PROVIDER_ENV}=litellm (or bedrock) in .env, ${RESTART}`, LLM_PROVIDER_ENV);
  }
  // Connection settings first (they gate everything), then the role models; de-duplicated across roles.
  const connection = provider === "litellm" ? [LITELLM_BASE_URL_ENV, LITELLM_API_KEY_ENV] : [AWS_REGION_ENV];
  const rank = (v: string): number => {
    const c = connection.indexOf(v);
    if (c >= 0) return c;
    const r = ROLES.findIndex((role) => MODEL_ENV[role] === v);
    return 10 + (r < 0 ? 9 : r);
  };
  const issues = new Map<string, LlmConfigIssue>();
  for (const role of ROLES) for (const i of llmConfigIssues(env, role)) if (!issues.has(i.variable)) issues.set(i.variable, i);
  const ordered = [...issues.values()].sort((a, b) => rank(a.variable) - rank(b.variable));
  const invalid = ordered.find((i) => i.problem === "invalid");
  if (invalid) {
    return failed(`${invalid.variable} ${invalid.message.replace(/^BLOCKED: \S+ /, "").replace(/ — .*$/, "")}`, `Fix ${invalid.variable} in .env (see .env.example), ${RESTART}; check with \`pnpm notary doctor --llm\``, invalid.variable);
  }
  const unset = ordered.filter((i) => i.problem === "not set").map((i) => i.variable);
  if (unset.length) {
    return missing(
      unset[0]!,
      `Set ${listVars(unset)} in .env (see .env.example), ${RESTART}; check with \`pnpm notary doctor --llm\``,
      `provider ${provider}${read(env, LLM_PROVIDER_ENV) ? "" : ` (${LLM_PROVIDER_ENV} unset: default)`}; not set: ${unset.join(", ")}`,
    );
  }
  const refl = read(env, MODEL_ENV.reflector);
  const adv = read(env, MODEL_ENV.adversary);
  if (baseModelId(refl) === baseModelId(adv)) {
    return failed(
      `separation of duties: reflector and adversary are the same model ("${refl}")`,
      `Set ${MODEL_ENV.adversary} to a different model than ${MODEL_ENV.reflector} in .env, ${RESTART}`,
      MODEL_ENV.adversary,
    );
  }
  if (provider === "bedrock") {
    return configured(
      "provider bedrock: every variable is set, but Bedrock has no zero-cost check; the AWS credentials are exercised only by a model call",
      "Run `pnpm notary doctor --llm` to make one tiny call per role",
    );
  }
  const baseUrl = normalizeLiteLlmBaseUrl(read(env, LITELLM_BASE_URL_ENV))!;
  const lister = probes.listModels ?? ((url: string, key: string) => liteLlmModelLister({ baseUrl: url, apiKey: key })());
  let available: string[];
  try {
    available = await withTimeout(lister(baseUrl, read(env, LITELLM_API_KEY_ENV)), HEALTH_PROBE_TIMEOUT_MS, "GET /v1/models");
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      return failed(`the LiteLLM proxy rejected ${LITELLM_API_KEY_ENV} (HTTP ${status})`, `Set ${LITELLM_API_KEY_ENV} to a valid proxy key in .env, ${RESTART}`, LITELLM_API_KEY_ENV);
    }
    return failed(
      `GET /v1/models failed: ${errText(err)}`,
      `Check ${LITELLM_BASE_URL_ENV} in .env and that the proxy is reachable, ${RESTART}; \`pnpm notary doctor --llm\` shows the details`,
    );
  }
  const offered = new Set(available);
  const notOffered = ROLES.filter((r) => !offered.has(read(env, MODEL_ENV[r])));
  if (notOffered.length) {
    const r = notOffered[0]!;
    return failed(
      `${MODEL_ENV[r]} "${read(env, MODEL_ENV[r])}" is not offered by the proxy for this key`,
      `Set ${MODEL_ENV[r]} to one of the proxy's models (${available.slice(0, 8).join(", ") || "none listed"}) in .env, ${RESTART}`,
      MODEL_ENV[r],
    );
  }
  return connected(`provider litellm: GET /v1/models listed ${available.length} model(s); all three role models are offered`);
}

// ----------------------------------------------------------------------------- crustdata / dodo

async function crustdataCheck(env: Env, probes: HealthProbes): Promise<Body> {
  if (!read(env, "CRUSTDATA_API_KEY")) return missing("CRUSTDATA_API_KEY", `Set CRUSTDATA_API_KEY in .env, ${RESTART}`);
  try {
    await withTimeout((probes.crustdata ?? defaultCrustdataProbe)(env), HEALTH_PROBE_TIMEOUT_MS + 2_000, "Crustdata GET /account/credits");
    return connected("GET /account/credits answered (free, 0 credits)");
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      return failed(`Crustdata rejected CRUSTDATA_API_KEY (HTTP ${status})`, `Set CRUSTDATA_API_KEY to a valid key in .env, ${RESTART}`, "CRUSTDATA_API_KEY");
    }
    return failed(`Crustdata GET /account/credits: ${errText(err)}`, `Check the network and CRUSTDATA_API_KEY, ${RESTART}`);
  }
}

async function dodoCheck(env: Env, probes: HealthProbes): Promise<Body> {
  if (!read(env, "DODO_PAYMENTS_API_KEY")) {
    return missing("DODO_PAYMENTS_API_KEY", `Set DODO_PAYMENTS_API_KEY in .env (a Dodo TEST-mode key), ${RESTART}`);
  }
  const lock = dodoTestMode(env);
  if (!lock.testMode) {
    return failed(lock.reason ?? "Dodo test-mode lock is off", `Set NOTARY_MODE=test and DODO_BASE_URL=${DODO_TEST_BASE_URL} in .env, ${RESTART}`, "NOTARY_MODE");
  }
  try {
    await withTimeout((probes.dodo ?? defaultDodoProbe)(env), HEALTH_PROBE_TIMEOUT_MS + 2_000, "Dodo GET /customers");
    return connected("test mode: GET /customers?page_size=1 answered");
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      return failed(`Dodo rejected DODO_PAYMENTS_API_KEY (HTTP ${status})`, `Set DODO_PAYMENTS_API_KEY to a valid TEST-mode key in .env, ${RESTART}`, "DODO_PAYMENTS_API_KEY");
    }
    return failed(`Dodo GET /customers: ${errText(err)}`, `Check the network and DODO_PAYMENTS_API_KEY (test mode), ${RESTART}`);
  }
}

// -------------------------------------------------------------------------------- neatlogs / entire

function truthy(v: string | undefined): boolean {
  return ["true", "1", "yes"].includes((v ?? "").trim().toLowerCase());
}

function neatlogsCheck(env: Env, probes: HealthProbes): Body {
  if (!read(env, "NEATLOGS_API_KEY")) {
    return missing("NEATLOGS_API_KEY", `Set NEATLOGS_API_KEY in .env (the neatlogs project ingest key), ${RESTART}; \`pnpm notary doctor\` sends a test span`);
  }
  if (truthy(env.NEATLOGS_DISABLE_EXPORT)) {
    return failed("NEATLOGS_DISABLE_EXPORT is set, so no span is exported", `Unset NEATLOGS_DISABLE_EXPORT in .env, ${RESTART}`, "NEATLOGS_DISABLE_EXPORT");
  }
  const t = (probes.tracing ?? defaultTracing)();
  if (!t.init) {
    return configured("NEATLOGS_API_KEY is set; the neatlogs SDK has not been initialized in this process", "Restart `pnpm notary serve` (it initializes tracing at startup); `pnpm notary doctor` sends a test span");
  }
  if (!t.init.enabled) return failed(t.init.reason ?? "neatlogs SDK did not start", `Check NEATLOGS_API_KEY in .env, ${RESTART}; \`pnpm notary doctor\` shows the details`);
  if (t.lastFlush && !t.lastFlush.ok) {
    return failed("the last neatlogs flush in this process failed", `Check NEATLOGS_API_KEY and the network, ${RESTART}; \`pnpm notary doctor\` shows the details`);
  }
  if (t.lastFlush?.ok && t.exportedTraces > 0) return connected(`${t.exportedTraces} trace(s) exported by this process; last flush OK at ${t.lastFlush.at}`);
  return configured("neatlogs SDK initialized; nothing exported and flushed by this process yet", "`pnpm notary doctor` sends a test span and flushes it");
}

function entireCheck(env: Env, probes: HealthProbes): Body {
  const onPath = (probes.entireOnPath ?? ((e: Env) => findOnPath("entire", e) !== undefined))(env);
  return onPath ? connected("Entire CLI on PATH") : missing("entire", ENTIRE_INSTALL_FIX, "the Entire CLI is not on PATH");
}

// ------------------------------------------------------------------------------------------ api

export interface Health {
  check(): Promise<HealthResponse>;
}

export function createHealth(opts: HealthOptions = {}): Health {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const clock = opts.clock ?? Date.now;
  const ttl = opts.ttlMs ?? HEALTH_TTL_MS;
  const probes = opts.probes ?? {};
  const clean = scrubber(env);
  const cache = new Map<IntegrationName, { at: number; result: Promise<IntegrationStatus> }>();

  const scrubbed = (name: IntegrationName, body: Body): IntegrationStatus => ({
    name,
    state: body.state,
    label: clean(body.label),
    ...(body.variable ? { variable: body.variable } : {}),
    ...(body.detail ? { detail: clean(body.detail) } : {}),
    ...(body.fix ? { fix: clean(body.fix) } : {}),
    checkedAt: now().toISOString(),
  });

  const run = async (name: IntegrationName): Promise<IntegrationStatus> => {
    let body: Body;
    try {
      switch (name) {
        case "llm":
          body = await llmCheck(env, probes);
          break;
        case "crustdata":
          body = await crustdataCheck(env, probes);
          break;
        case "dodo":
          body = await dodoCheck(env, probes);
          break;
        case "neatlogs":
          body = neatlogsCheck(env, probes);
          break;
        case "entire":
          body = entireCheck(env, probes);
          break;
      }
    } catch (err) {
      body = failed(`${name} check crashed: ${errText(err)}`, "See the `notary serve` terminal and run the matching `pnpm notary doctor` command");
    }
    return scrubbed(name, body);
  };

  const cached = (name: IntegrationName): Promise<IntegrationStatus> => {
    // Local-state checks are cheap and always fresh; network checks are cached for `ttl`.
    if (name === "neatlogs" || name === "entire") return run(name);
    const hit = cache.get(name);
    if (hit && clock() - hit.at < ttl) return hit.result;
    const result = run(name);
    cache.set(name, { at: clock(), result });
    return result;
  };

  return {
    async check() {
      const integrations = await Promise.all(INTEGRATIONS.map(cached));
      return HealthResponseSchema.parse({ ok: true, service: "notary serve", integrations });
    },
  };
}
