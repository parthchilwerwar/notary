/**
 * LLM client: one client, three roles, two providers (TDD "Integrations: AWS Bedrock"; LiteLLM
 * added in session 8). The provider comes from NOTARY_LLM_PROVIDER (src/llm/config.ts; unset =
 * bedrock).
 *
 * bedrock — @aws-sdk/client-bedrock-runtime, Converse API:
 *   new BedrockRuntimeClient({ region }).send(new ConverseCommand({
 *     modelId, system: [{ text }], messages: [{ role, content: [{ text }] }],
 *     inferenceConfig: { maxTokens, temperature: 0 },
 *   }))
 *   → { output: { message: { content: [{ text }] } }, usage: { inputTokens, outputTokens }, stopReason }
 *   Credentials come from the SDK's default provider chain (env keys, AWS_PROFILE / SSO, …). This
 *   module never reads, passes or logs a credential. If the chain finds none, the SDK's
 *   CredentialsProviderError is rethrown as the BLOCKED error.
 *
 * litellm — the OpenAI-compatible `/v1/chat/completions` of a LiteLLM proxy (src/llm/litellm.ts):
 *   { model, messages: [{ role: "system", content }, …], max_tokens, temperature: 0 }
 *   → choices[0].message.content, usage.prompt_tokens / completion_tokens (→ input / output),
 *   finish_reason mapped onto the Bedrock stop reasons ("length" → "max_tokens", "stop" → "end_turn").
 *   LITELLM_BASE_URL / LITELLM_API_KEY missing → the BLOCKED error before any network I/O.
 *
 * Both providers behave identically for callers: same request (system + messages, temperature 0,
 * maxTokens default 2048), same CompleteResult, same secret scrubbing of every prompt (and of error
 * messages), same per-role UsageMeter accounting and pricing, same BLOCKED errors; JSON validation
 * stays in the callers. A non-credential transport error is rethrown (scrubbed) for the caller's
 * fail-safe path.
 *
 * Cost (src/llm/pricing.ts priceCall): env override > LiteLLM-reported (`x-litellm-response-cost`)
 * > Bedrock table > unknown (usd 0, price source "unknown", warning on the meter and once on stderr).
 * USD cap (src/llm/budget.ts): with NOTARY_MAX_USD set, every call first checks the run's spend plus
 * a high estimate of this call and throws UsdCapExceededError (before any I/O) when it would exceed.
 * With the cap set, a call whose price cannot be known (no override, no table price, Bedrock) and any
 * call after one whose cost came back unknown are refused with UsdPriceUnknownError (BLOCKED,
 * naming NOTARY_PRICE_<ROLE>_IN/OUT). Unknown-price calls are counted per role (UsageMeter
 * unknownCalls; the bundle metric `usd_unknown_calls`), since usageByRole's usd stays a number (frozen).
 *
 * Bedrock client: maxAttempts 1 and a request timeout (BEDROCK_REQUEST_TIMEOUT_MS), so every retry
 * goes through our limiter and USD-cap check instead of the SDK's own retry loop.
 *
 * Rate limit (src/llm/limiter.ts): every call to a real provider queues in the process-wide limiter
 * (NOTARY_LLM_RPM, NOTARY_LLM_CONCURRENCY); a 429 backs off per Retry-After and retries (max 3),
 * re-checking the USD cap first; usage/USD are recorded once, for the attempt that succeeded. The
 * wait and the attempt count are attributes on the same `notary.llm` span (llm.waited_ms,
 * llm.attempts, llm.retry_after_ms) plus a log event per retry — no extra LLM span from Notary.
 *
 * Tool calling (Notary Chat's agent loop): `completeTools` sends OpenAI-style function tools
 * (LiteLLM: `tools` / `tool_choice`, assistant `tool_calls` and `tool` result messages fed back;
 * Bedrock: Converse `toolConfig`, `toolUse` / `toolResult` blocks) and returns the model's tool
 * calls next to its text. Same budget cap, limiter, scrubbing, pricing and span as `complete`; it
 * never executes a tool. A fourth model role, "chat" (NOTARY_MODEL_CHAT, falling back to
 * NOTARY_MODEL_REFLECTOR), is accounted in its own meter bucket that totalUsd() counts but that is
 * never written into a bundle's usageByRole (the frozen schema keeps three roles).
 *
 * Every call opens a neatlogs span "notary.llm" (CHAIN) with the agent's display name (`notary.agent`,
 * e.g. "Reflector", "Notary Chat"; P2), role, model id, token counts and USD;
 * prompts are never put in its attributes. Under it, the SDK's provider wrapper (wrapBedrock /
 * wrapOpenAI) emits the LLM span, which does carry the (already secret-scrubbed) messages and
 * completion. Usage accumulates per role in a UsageMeter, whose snapshot is the bundle's
 * `usageByRole`.
 */
import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Role, UsageByRole } from "../schema/index.js";
import { MissingCredentialError } from "../tools/errors.js";
import { traceBedrockClient, traceLog, withSpan } from "../trace/index.js";
import type { SpanIds } from "../trace/index.js";
import { currentIncidentRun, incidentId, reportIncident, reportResolution } from "../incidents/live.js";
import type { AgentId } from "../schema/agents.js";
import { AGENT_SPAN_ATTR, agentName } from "./agents.js";
import { LLM_MAX_429_RETRIES, LLM_MAX_BACKOFF_MS, LlmRateLimitedError, defaultBackOffMs, llmLimiter, rateLimitInfo } from "./limiter.js";
import type { LlmLimiter, LlmSlot } from "./limiter.js";
import { costUsd, priceCall, reportedCostUsd, resolvePrice } from "./pricing.js";
import type { PriceSource } from "./pricing.js";
import { UsdCapExceededError, UsdPriceUnknownError, estimateInputTokens, maxUsdFromEnv } from "./budget.js";
import { ROLES, requireRoleModel, resolveModels } from "./roles.js";
import type { ModelRole, ModelRoster } from "./roles.js";
import { AWS_REGION_ENV, LITELLM_API_KEY_ENV, LITELLM_BASE_URL_ENV, llmInvalid, llmMissing, llmProvider, normalizeLiteLlmBaseUrl } from "./config.js";
import type { LlmProvider } from "./config.js";
import { liteLlmTransport, stopReasonFromFinish } from "./litellm.js";
import type { ChatRequest, ChatTransport } from "./litellm.js";

type Env = Record<string, string | undefined>;

export type LlmMessage = { role: "user" | "assistant"; content: string };

/** One function tool offered to the model (JSON Schema parameters). */
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
/** One tool call the model made; `arguments` is the raw JSON text it produced. */
export type ToolCall = { id: string; name: string; arguments: string };
/** A message in a tool-calling conversation. */
export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };
/** "auto": the model decides; "required": it must call a tool; "none": it must answer in text; {name}: that tool. */
export type ToolChoice = "auto" | "required" | "none" | { name: string };

export type CompleteRequest = {
  /** The model role: a bundle role, or "chat" (Notary Chat). */
  role: ModelRole;
  /**
   * Which agent (src/schema/agents.ts) makes this call, for the `notary.agent` span attribute.
   * Default: the agent that owns `role` (executor → Executor, ...). Notary Chat runs on the executor
   * role and passes "chat". Never affects the request, the cassette key or usage accounting.
   */
  agent?: AgentId;
  system?: string;
  messages: LlmMessage[];
  /** Output token cap. Default 2048. */
  maxTokens?: number;
  /**
   * Abort the call (Notary Chat's Stop): checked before the rate-limit slot and the request, and
   * passed to the provider SDK so an in-flight HTTP request is cancelled. An aborted call records no
   * usage and rejects with the signal's reason.
   */
  signal?: AbortSignal;
  /**
   * Stream the reply: LiteLLM uses `stream: true` and calls this with each text delta as it arrives;
   * a provider/transport that does not stream (Bedrock Converse, test doubles) gets the whole reply
   * in one call after it completes. The returned CompleteResult still carries the full text.
   */
  onText?: (delta: string) => void;
};

export type CompleteResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  modelId: string;
  /** Where `usd` came from: env override, LiteLLM-reported, Bedrock table, or unknown (usd 0). */
  priceSource?: PriceSource;
  /** Stop reason in Bedrock's vocabulary, e.g. "end_turn", "max_tokens" (LiteLLM finish_reason is mapped); "unknown" if absent. */
  stopReason: string;
};

/** Anything that can complete a prompt; lets callers (e.g. the reflector) accept a narrower type. */
export type LlmLike = { complete(req: CompleteRequest): Promise<CompleteResult> };

export type ToolCompleteRequest = Omit<CompleteRequest, "messages"> & {
  messages: AgentMessage[];
  tools: ToolSpec[];
  /** Default "auto". */
  toolChoice?: ToolChoice;
};
export type ToolCompleteResult = CompleteResult & { toolCalls: ToolCall[] };
/** A model that can call tools (LlmClient; Notary Chat's test doubles). */
export type ToolLlmLike = { completeTools(req: ToolCompleteRequest): Promise<ToolCompleteResult> };

/** Sends one Converse request. Injectable so tests never reach AWS. `abortSignal` cancels it. */
export type ConverseTransport = (input: ConverseCommandInput, opts?: { abortSignal?: AbortSignal }) => Promise<ConverseCommandOutput>;

/** The AWS SDK's "no credentials found" errors (from @smithy/property-provider). */
const CREDENTIAL_ERROR_NAMES = new Set(["CredentialsProviderError", "TokenProviderError"]);

export const AWS_CREDENTIALS_LABEL = "AWS credentials (env keys or AWS_PROFILE/SSO)";
/** Fix for missing AWS credentials (Bedrock only; LiteLLM never needs them). */
export const AWS_CREDENTIALS_HINT =
  "set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or AWS_PROFILE) in .env (see .env.example), or switch to NOTARY_LLM_PROVIDER=litellm, and run `pnpm notary doctor --llm`";

export function isAwsCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return CREDENTIAL_ERROR_NAMES.has(err.name) || /Could not load credentials from any providers/i.test(err.message);
}

const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** Replaces the value of every secret-looking env var (length ≥ 8, longest first) with [REDACTED]. */
export function scrubber(env: Env): (text: string) => string {
  const secrets = Object.entries(env)
    .filter(([name, v]) => SECRET_ENV_RE.test(name) && (v?.trim().length ?? 0) >= 8)
    .map(([, v]) => v!.trim())
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const s of secrets) if (out.includes(s)) out = out.split(s).join("[REDACTED]");
    return out;
  };
}

/**
 * The scrubber for streamed text: a secret split across deltas is still replaced. `push` returns the
 * text safe to pass on now, holding back a tail that could be the start of a secret; `end` flushes it.
 */
export function streamScrubber(env: Env): { push: (delta: string) => string; end: () => string } {
  const secrets = Object.entries(env)
    .filter(([name, v]) => SECRET_ENV_RE.test(name) && (v?.trim().length ?? 0) >= 8)
    .map(([, v]) => v!.trim());
  const clean = scrubber(env);
  let buf = "";
  return {
    push(delta) {
      buf = clean(buf + delta);
      let hold = 0;
      for (const s of secrets) {
        for (let k = Math.min(s.length - 1, buf.length); k > hold; k--) {
          if (buf.endsWith(s.slice(0, k))) {
            hold = k;
            break;
          }
        }
      }
      const out = buf.slice(0, buf.length - hold);
      buf = buf.slice(buf.length - hold);
      return out;
    },
    end() {
      const out = clean(buf);
      buf = "";
      return out;
    },
  };
}

let warningSink: ((message: string) => void) | null = (message) => console.warn(`notary: warning: ${message}`);
const warnedOnce = new Set<string>();

/** Print a pricing/config warning once per process (stderr by default). */
function warnOnce(message: string): void {
  if (warnedOnce.has(message)) return;
  warnedOnce.add(message);
  try {
    warningSink?.(message);
  } catch {
    // a warning must never break a call
  }
}

/** Replace the once-per-process warning sink (tests; null silences it). Returns the previous sink. */
export function setLlmWarningSink(sink: ((message: string) => void) | null): ((message: string) => void) | null {
  const prev = warningSink;
  warningSink = sink;
  warnedOnce.clear();
  return prev;
}

/** Per-role token and USD accounting. */
export class UsageMeter {
  private readonly usage: UsageByRole = {
    executor: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    reflector: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    adversary: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
  };
  /** Notary Chat's usage: counted by totalUsd() (NOTARY_MAX_USD), never part of snapshot(). */
  private readonly chat = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
  /** Calls whose price was unknown (their usd is recorded as 0, which is not their cost), per role. */
  private readonly unknown: Record<ModelRole, number> = { executor: 0, reflector: 0, adversary: 0, chat: 0 };
  /** Pricing problems (unknown model, bad override). De-duplicated. */
  readonly warnings: string[] = [];

  add(role: ModelRole, u: { inputTokens: number; outputTokens: number; usd: number; unknownPrice?: boolean }): void {
    if (u.unknownPrice) this.unknown[role] += 1;
    const r = role === "chat" ? this.chat : this.usage[role];
    r.inputTokens += u.inputTokens;
    r.outputTokens += u.outputTokens;
    r.usd = Math.round((r.usd + u.usd) * 1e9) / 1e9;
    r.calls += 1;
  }

  warn(message: string): void {
    if (this.warnings.includes(message)) return;
    this.warnings.push(message);
    warnOnce(message);
  }

  /** Unknown-price calls of the three bundle roles (Notary Chat excluded, like snapshot()). */
  unknownCalls(): number {
    return this.unknown.executor + this.unknown.reflector + this.unknown.adversary;
  }

  /** The roles (Notary Chat included) with at least one unknown-price call. */
  unknownRoles(): ModelRole[] {
    return (Object.keys(this.unknown) as ModelRole[]).filter((r) => this.unknown[r] > 0);
  }

  /** USD recorded so far across all roles (the run's model spend). */
  totalUsd(): number {
    return Math.round((this.usage.executor.usd + this.usage.reflector.usd + this.usage.adversary.usd + this.chat.usd) * 1e9) / 1e9;
  }

  /** Notary Chat's usage (not part of any bundle). A copy. */
  chatUsage(): { inputTokens: number; outputTokens: number; usd: number; calls: number } {
    return { ...this.chat };
  }

  /** The bundle's `usageByRole` shape, always with all three roles. A copy. */
  snapshot(): UsageByRole {
    const out = {} as UsageByRole;
    for (const role of ROLES) out[role] = { ...this.usage[role] };
    return out;
  }
}

/** Per-request timeout for Bedrock Converse calls (ms). */
export const BEDROCK_REQUEST_TIMEOUT_MS = 120_000;

/** Options the Bedrock Runtime client is built with (exported for the test that pins them). */
export const BEDROCK_CLIENT_OPTIONS = { maxAttempts: 1, requestTimeoutMs: BEDROCK_REQUEST_TIMEOUT_MS } as const;

/** Default transport: the real Bedrock Runtime client, created lazily on the first call. */
export function bedrockTransport(region: string): ConverseTransport {
  let client: { send: (cmd: unknown, opts?: { abortSignal?: AbortSignal }) => Promise<unknown> } | null = null;
  let ConverseCommandCtor: (new (input: ConverseCommandInput) => unknown) | null = null;
  return async (input, opts) => {
    if (!client || !ConverseCommandCtor) {
      const sdk = await import("@aws-sdk/client-bedrock-runtime");
      // wrapBedrock (when tracing is on) emits the LLM span with messages, completion and usage.
      // maxAttempts 1: retries are ours (limiter + USD-cap check per attempt), never the SDK's hidden ones.
      // requestHandler as an options object: the SDK builds its default Node handler with these timeouts.
      const requestHandler = { connectionTimeout: 10_000, requestTimeout: BEDROCK_REQUEST_TIMEOUT_MS };
      client = traceBedrockClient(new sdk.BedrockRuntimeClient({ region, maxAttempts: BEDROCK_CLIENT_OPTIONS.maxAttempts, requestHandler })) as unknown as typeof client;
      ConverseCommandCtor = sdk.ConverseCommand;
    }
    const cmd = new ConverseCommandCtor!(input);
    return (await (opts?.abortSignal ? client!.send(cmd, { abortSignal: opts.abortSignal }) : client!.send(cmd))) as ConverseCommandOutput;
  };
}

export type LlmClientOptions = {
  env?: Env;
  /** Override the Bedrock transport (tests). When omitted, AWS_REGION must be set. */
  transport?: ConverseTransport;
  /** Override the LiteLLM transport (tests). When omitted, LITELLM_BASE_URL and LITELLM_API_KEY must be set. */
  chatTransport?: ChatTransport;
  meter?: UsageMeter;
  /**
   * Rate limiter for this client's calls. Default: the process-wide `llmLimiter()` when the client
   * talks to a real provider, none when a test/fixture transport is injected. `null` disables it.
   */
  limiter?: LlmLimiter | null;
};

/** One provider reply, normalized. */
type ProviderReply = {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  /** Cost the provider reported for this response (LiteLLM `x-litellm-response-cost`), else null. */
  reportedUsd: number | null;
};
type ProviderRequest = { system?: string; messages: AgentMessage[]; maxTokens: number; tools?: ToolSpec[]; toolChoice?: ToolChoice };
/** Per-call I/O options (not part of the prompt, never priced or traced). */
type ProviderIo = { signal?: AbortSignal; onDelta?: (delta: string) => void };
type ProviderCall = (modelId: string, req: ProviderRequest, io?: ProviderIo) => Promise<ProviderReply>;

/** Reject with the signal's reason (an AbortError by default) when it has fired. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  throw reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}

/** Scrub secret env values out of an error's message (the error object is kept, so its class survives). */
function scrubError(err: unknown, clean: (s: string) => string): unknown {
  if (err instanceof Error) {
    const m = clean(err.message);
    if (m !== err.message) {
      try {
        err.message = m;
      } catch {
        // read-only message: leave it
      }
    }
  }
  return err;
}

export class LlmClient implements LlmLike {
  readonly meter: UsageMeter;
  readonly provider: LlmProvider;
  /** NOTARY_MAX_USD for this client's run, or null (no cap). */
  readonly maxUsd: number | null;
  private readonly env: Env;
  private readonly roster: ModelRoster;
  private transport: ConverseTransport | undefined;
  private chatTransport: ChatTransport | undefined;
  private readonly limiterOpt: LlmLimiter | null | undefined;
  private readonly injected: boolean;

  constructor(opts: LlmClientOptions = {}) {
    this.env = opts.env ?? process.env;
    this.provider = llmProvider(this.env); // throws ModelConfigError on an unknown provider
    this.roster = resolveModels(this.env); // throws ModelConfigError on a separation-of-duties breach
    this.maxUsd = maxUsdFromEnv(this.env); // throws ModelConfigError on an unusable NOTARY_MAX_USD
    this.meter = opts.meter ?? new UsageMeter();
    if (this.provider === "litellm" && opts.transport && !opts.chatTransport) {
      throw new Error("LlmClient: a Bedrock transport was injected but NOTARY_LLM_PROVIDER=litellm (inject chatTransport)");
    }
    if (this.provider === "bedrock" && opts.chatTransport && !opts.transport) {
      throw new Error("LlmClient: a LiteLLM chatTransport was injected but the provider is bedrock (set NOTARY_LLM_PROVIDER=litellm)");
    }
    this.transport = opts.transport;
    this.chatTransport = opts.chatTransport;
    this.limiterOpt = opts.limiter;
    this.injected = this.provider === "litellm" ? opts.chatTransport !== undefined : opts.transport !== undefined;
  }

  /** The limiter in front of this client's calls (null: none). */
  limiter(): LlmLimiter | null {
    if (this.limiterOpt !== undefined) return this.limiterOpt;
    return this.injected ? null : llmLimiter(this.env);
  }

  /** The configured model id for a role, or the BLOCKED error. */
  modelFor(role: ModelRole): string {
    return requireRoleModel(this.env, this.roster, role);
  }

  private getTransport(): ConverseTransport {
    if (this.transport) return this.transport;
    const region = (this.env[AWS_REGION_ENV] ?? "").trim();
    if (!region) throw llmMissing(AWS_REGION_ENV);
    this.transport = bedrockTransport(region);
    return this.transport;
  }

  private getChatTransport(): ChatTransport {
    if (this.chatTransport) return this.chatTransport;
    const rawBase = (this.env[LITELLM_BASE_URL_ENV] ?? "").trim();
    if (!rawBase) throw llmMissing(LITELLM_BASE_URL_ENV);
    const baseUrl = normalizeLiteLlmBaseUrl(rawBase);
    if (!baseUrl) throw llmInvalid(LITELLM_BASE_URL_ENV, "is not an http(s) URL");
    const apiKey = (this.env[LITELLM_API_KEY_ENV] ?? "").trim();
    if (!apiKey) throw llmMissing(LITELLM_API_KEY_ENV);
    this.chatTransport = liteLlmTransport({ baseUrl, apiKey });
    return this.chatTransport;
  }

  /** The provider call for this client; resolving it throws BLOCKED before any network I/O. */
  private providerCall(): ProviderCall {
    if (this.provider === "litellm") {
      const transport = this.getChatTransport();
      return async (modelId, req, io) => {
        const body: ChatRequest = {
          model: modelId,
          messages: [...(req.system ? [{ role: "system" as const, content: req.system }] : []), ...req.messages.map(toOpenAiMessage)],
          max_tokens: req.maxTokens,
          temperature: 0,
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
                tool_choice: toOpenAiToolChoice(req.toolChoice ?? "auto"),
              }
            : {}),
        };
        const { completion, headers } = await (io?.signal || io?.onDelta ? transport(body, { ...(io.signal ? { signal: io.signal } : {}), ...(io.onDelta ? { onDelta: io.onDelta } : {}) }) : transport(body));
        const choice = completion.choices?.[0];
        const content = choice?.message?.content;
        const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).flatMap((tc) =>
          tc.type === "function" ? [{ id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? "" }] : [],
        );
        return {
          text: typeof content === "string" ? content : "",
          toolCalls,
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
          stopReason: stopReasonFromFinish(choice?.finish_reason),
          reportedUsd: reportedCostUsd(headers),
        };
      };
    }
    const transport = this.getTransport();
    return async (modelId, req, io) => {
      const toolMode = Boolean(req.tools?.length) || req.messages.some((m) => m.role === "tool" || (m.role === "assistant" && m.toolCalls?.length));
      const input: ConverseCommandInput = {
        modelId,
        messages: toolMode ? toConverseMessages(req.messages) : req.messages.map((m) => ({ role: m.role as "user" | "assistant", content: [{ text: m.content }] })),
        inferenceConfig: { maxTokens: req.maxTokens, temperature: 0 },
        ...(req.system ? { system: [{ text: req.system }] } : {}),
        ...(req.tools?.length ? { toolConfig: toConverseToolConfig(req.tools, req.toolChoice ?? "auto") } : {}),
      };
      let out: ConverseCommandOutput;
      try {
        out = await (io?.signal ? transport(input, { abortSignal: io.signal }) : transport(input));
      } catch (err) {
        if (isAwsCredentialError(err)) throw new MissingCredentialError(AWS_CREDENTIALS_LABEL, AWS_CREDENTIALS_HINT);
        throw err;
      }
      const blocks = out.output && "message" in out.output ? (out.output.message?.content ?? []) : [];
      const toolCalls: ToolCall[] = blocks.flatMap((b) =>
        "toolUse" in b && b.toolUse?.name ? [{ id: b.toolUse.toolUseId ?? "", name: b.toolUse.name, arguments: JSON.stringify(b.toolUse.input ?? {}) }] : [],
      );
      return {
        text: blocks.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join(""),
        toolCalls,
        inputTokens: out.usage?.inputTokens ?? 0,
        outputTokens: out.usage?.outputTokens ?? 0,
        stopReason: String(out.stopReason ?? "unknown"),
        reportedUsd: null,
      };
    };
  }

  /**
   * NOTARY_MAX_USD check before a call (and before each retry): throws UsdCapExceededError when the
   * run's spend plus a high estimate of this call (0 when the price isn't known up front) would
   * exceed the cap. No I/O.
   */
  private checkUsdCap(role: ModelRole, modelId: string, req: ProviderRequest): void {
    if (this.maxUsd === null) return;
    const spent = this.meter.totalUsd();
    const known = resolvePrice(role, modelId, this.env);
    // An earlier call's cost is unknown: the recorded spend is not the real spend.
    const unknownRoles = this.meter.unknownRoles();
    if (unknownRoles.length) {
      const r = unknownRoles[0]!;
      throw new UsdPriceUnknownError(r, this.maxUsd, spent, `an earlier ${r} model call's cost is unknown (no price override, no table price, no cost reported by the provider)`);
    }
    // No price up front and a provider that reports no per-response cost: this call's cost would be unknown.
    if (!known.price && this.provider !== "litellm") {
      throw new UsdPriceUnknownError(role, this.maxUsd, spent, `the price of model "${modelId}" is unknown (no NOTARY_PRICE_${role.toUpperCase()}_IN/OUT override, no table price, and ${this.provider} reports no per-response cost)`);
    }
    const chars =
      (req.system?.length ?? 0) +
      req.messages.reduce((n, m) => n + m.content.length + (m.role === "assistant" ? (m.toolCalls ?? []).reduce((k, t) => k + t.arguments.length + t.name.length, 0) : 0), 0) +
      (req.tools ? JSON.stringify(req.tools).length : 0);
    const estimate = known.price ? costUsd(known.price, estimateInputTokens(chars), req.maxTokens) : 0;
    if (spent >= this.maxUsd || spent + estimate > this.maxUsd) throw new UsdCapExceededError(role, this.maxUsd, spent, estimate);
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const { toolCalls: _toolCalls, ...res } = await this.invoke(req, req.messages);
    return res;
  }

  /**
   * One tool-calling turn: the model sees `tools` and the conversation so far (its earlier tool calls
   * and their results included) and replies with text and/or tool calls. Running the calls is the
   * caller's job; this method never executes a tool.
   */
  async completeTools(req: ToolCompleteRequest): Promise<ToolCompleteResult> {
    return this.invoke(req, req.messages, req.tools, req.toolChoice);
  }

  private async invoke(req: Omit<CompleteRequest, "messages">, messages: readonly AgentMessage[], tools?: ToolSpec[], toolChoice?: ToolChoice): Promise<ToolCompleteResult> {
    const modelId = this.modelFor(req.role);
    const call = this.providerCall();
    // P9 (AUDIT-08): backstop — no secret env value is ever sent to a model, whatever built the prompt.
    const clean = scrubber(this.env);
    const scrubbed: ProviderRequest = {
      messages: messages.map((m) => scrubMessage(m, clean)),
      maxTokens: req.maxTokens ?? 2048,
      ...(req.system ? { system: clean(req.system) } : {}),
      ...(tools?.length ? { tools, toolChoice: toolChoice ?? "auto" } : {}),
    };

    // Streaming: deltas go to the caller as they arrive; a non-streaming provider gets one delta at the end.
    // Deltas are scrubbed as a stream, so a secret split across two deltas is still replaced.
    let streamed = false;
    const streamClean = req.onText ? streamScrubber(this.env) : null;
    const io: ProviderIo = {
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.onText
        ? {
            onDelta: (d: string) => {
              if (!d) return;
              streamed = true;
              const safe = streamClean!.push(d);
              if (safe) req.onText!(safe);
            },
          }
        : {}),
    };

    let setAttr: ((k: string, v: string | number | boolean) => void) | undefined;
    let spanIds: SpanIds | undefined;
    const agentLabel = agentName(req.agent ?? req.role);
    // Incidents on this span (same ids as src/incidents/derive.ts: subject = this span id).
    const failed = (err: unknown): unknown => {
      try {
        const aborted = err instanceof Error && (err.name === "AbortError" || req.signal?.aborted === true);
        if (spanIds && !aborted) {
          const usdCap = err instanceof UsdCapExceededError;
          reportIncident({
            kind: usdCap ? "budget_stop" : "model_error",
            subject: spanIds.spanId,
            severity: "error",
            summary: usdCap
              ? `The ${agentLabel}'s next ${modelId} call would exceed NOTARY_MAX_USD; it was not sent.`
              : `A ${modelId} call by the ${agentLabel} failed: ${clean(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 160)}`,
            attrs: { "notary.role": req.role, "llm.model_id": modelId, "llm.provider": this.provider },
          });
        }
      } catch {
        // never mask the real error
      }
      return err;
    };
    return withSpan(
      "notary.llm",
      { [AGENT_SPAN_ATTR]: agentName(req.agent ?? req.role), "notary.agent_id": req.agent ?? req.role, "notary.role": req.role, "llm.model_id": modelId, "llm.provider": this.provider },
      async () => {
        const startedMs = Date.now();
        if (setAttr && this.maxUsd !== null) setAttr("llm.usd_cap", this.maxUsd);
        const limiter = this.limiter();
        let out: ProviderReply | undefined;
        let attempt = 0;
        let waitedMs = 0;
        while (!out) {
          attempt += 1;
          // NOTARY_MAX_USD before every attempt (a retry is a new spend decision).
          try {
            this.checkUsdCap(req.role, modelId, scrubbed);
          } catch (err) {
            throw failed(err);
          }
          throwIfAborted(req.signal);
          let slot: LlmSlot | null = null;
          if (limiter) {
            slot = await limiter.acquire();
            waitedMs += slot.waitedMs;
          }
          try {
            throwIfAborted(req.signal);
            out = await call(modelId, scrubbed, io);
          } catch (err) {
            const rl = limiter ? rateLimitInfo(err) : null;
            if (!rl || !limiter) throw failed(scrubError(err, clean));
            const limits = { rpm: limiter.rpm, concurrency: limiter.concurrency };
            if (attempt > LLM_MAX_429_RETRIES) throw failed(new LlmRateLimitedError(req.role, modelId, attempt, rl.retryAfterMs, limits));
            const backOffMs = rl.retryAfterMs ?? defaultBackOffMs(attempt);
            if (backOffMs > LLM_MAX_BACKOFF_MS) {
              throw failed(new LlmRateLimitedError(req.role, modelId, attempt, backOffMs, limits, `the provider asked to wait ${Math.ceil(backOffMs / 1000)} s, longer than Notary waits (${LLM_MAX_BACKOFF_MS / 1000} s)`));
            }
            limiter.backOff(backOffMs);
            setAttr?.("llm.retry_after_ms", backOffMs);
            setAttr?.("llm.attempts", attempt + 1);
            traceLog("llm retry after 429 for {role}: attempt {attempt}, back-off {retryAfterMs} ms", { role: req.role, attempt: attempt + 1, retryAfterMs: backOffMs });
            if (spanIds) {
              reportIncident({
                kind: "rate_limited",
                subject: spanIds.spanId,
                severity: "warning",
                summary: `${modelId} answered 429 (rate limited) for the ${agentLabel}; the call was retried.`,
                attrs: { "notary.role": req.role, "llm.model_id": modelId, "llm.provider": this.provider, "llm.retry_after_ms": backOffMs, "llm.attempts": attempt + 1 },
              });
            }
          } finally {
            slot?.release();
          }
        }
        const { inputTokens, outputTokens, text, stopReason, toolCalls } = out;
        if (attempt > 1 && spanIds) {
          reportResolution(incidentId("rate_limited", spanIds.spanId, currentIncidentRun()), { status: "resolved", action: "retried", summary: `Succeeded on attempt ${attempt} after a ${waitedMs} ms wait in the limiter.`, recordIds: [spanIds.spanId] });
        }
        if (req.onText && streamed) {
          const tail = streamClean!.end();
          if (tail) req.onText(tail);
        }
        if (req.onText && !streamed && text) req.onText(clean(text));
        if (setAttr && req.onText) setAttr("llm.streamed", streamed);
        const priced = priceCall(req.role, modelId, { inputTokens, outputTokens }, this.env, out.reportedUsd);
        if (priced.warning) this.meter.warn(priced.warning);
        const usd = priced.usd;
        this.meter.add(req.role, { inputTokens, outputTokens, usd, unknownPrice: priced.source === "unknown" });

        if (setAttr) {
          setAttr("llm.input_tokens", inputTokens);
          setAttr("llm.output_tokens", outputTokens);
          setAttr("llm.usd", usd);
          setAttr("llm.price_source", priced.source);
          setAttr("llm.stop_reason", stopReason);
          setAttr("llm.latency_ms", Date.now() - startedMs);
          setAttr("llm.attempts", attempt);
          if (limiter) setAttr("llm.waited_ms", waitedMs);
        }
        return { text, toolCalls, inputTokens, outputTokens, usd, modelId, stopReason, priceSource: priced.source };
      },
      // CHAIN, not LLM: the wrapped provider client emits the LLM child span (no double capture).
      { kind: "CHAIN", onSpan: (ids, set) => ((spanIds = ids), (setAttr = set)) },
    );
  }
}

// ------------------------------------------------------------------------- tool-calling mapping

function scrubMessage(m: AgentMessage, clean: (s: string) => string): AgentMessage {
  if (m.role === "tool") return { role: "tool", toolCallId: m.toolCallId, name: m.name, content: clean(m.content) };
  if (m.role === "assistant") {
    return { role: "assistant", content: clean(m.content), ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: clean(t.arguments) })) } : {}) };
  }
  return { role: "user", content: clean(m.content) };
}

type OpenAiMessage = ChatRequest["messages"][number];

/** AgentMessage → OpenAI chat message (assistant tool_calls; tool results keyed by tool_call_id). */
export function toOpenAiMessage(m: AgentMessage): OpenAiMessage {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content.trim() ? m.content : null,
      tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments || "{}" } })),
    };
  }
  return { role: m.role, content: m.content };
}

export function toOpenAiToolChoice(c: ToolChoice): NonNullable<ChatRequest["tool_choice"]> {
  return typeof c === "string" ? c : { type: "function", function: { name: c.name } };
}

type ConverseMessage = NonNullable<ConverseCommandInput["messages"]>[number];
type ConverseBlock = NonNullable<ConverseMessage["content"]>[number];
type ConverseToolConfig = NonNullable<ConverseCommandInput["toolConfig"]>;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * AgentMessage[] → Converse messages: assistant tool calls become toolUse blocks, tool results become
 * toolResult blocks in a user message, and neighbours with the same role are merged (Converse needs
 * strict user/assistant alternation).
 */
export function toConverseMessages(msgs: readonly AgentMessage[]): ConverseMessage[] {
  const out: ConverseMessage[] = [];
  for (const m of msgs) {
    const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
    const blocks: ConverseBlock[] = [];
    if (m.role === "tool") blocks.push({ toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content || "(empty)" }] } } as ConverseBlock);
    else {
      if (m.content.trim()) blocks.push({ text: m.content } as ConverseBlock);
      if (m.role === "assistant") for (const t of m.toolCalls ?? []) blocks.push({ toolUse: { toolUseId: t.id, name: t.name, input: parseArgs(t.arguments) } } as unknown as ConverseBlock);
      if (!blocks.length) blocks.push({ text: "(empty)" } as ConverseBlock);
    }
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = [...(last.content ?? []), ...blocks];
    else out.push({ role, content: blocks });
  }
  return out;
}

/**
 * Converse toolConfig. Converse has no "none" choice and needs toolConfig whenever the history holds
 * toolUse blocks, so "none" is sent as auto (the caller's prompt asks for a text answer).
 */
export function toConverseToolConfig(tools: readonly ToolSpec[], choice: ToolChoice): ConverseToolConfig {
  return {
    tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } } })) as unknown as ConverseToolConfig["tools"],
    toolChoice: typeof choice === "object" ? { tool: { name: choice.name } } : choice === "required" ? { any: {} } : { auto: {} },
  } as ConverseToolConfig;
}
