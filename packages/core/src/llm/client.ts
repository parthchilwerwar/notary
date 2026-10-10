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
 * Every call opens a neatlogs span "notary.llm" (CHAIN) with role, model id, token counts and USD;
 * prompts are never put in its attributes. Under it, the SDK's provider wrapper (wrapBedrock /
 * wrapOpenAI) emits the LLM span, which does carry the (already secret-scrubbed) messages and
 * completion. Usage accumulates per role in a UsageMeter, whose snapshot is the bundle's
 * `usageByRole`.
 */
import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Role, UsageByRole } from "../schema/index.js";
import { MissingCredentialError } from "../tools/errors.js";
import { traceBedrockClient, withSpan } from "../trace/index.js";
import { costUsd, resolvePrice } from "./pricing.js";
import { ROLES, requireModel, resolveModels } from "./roles.js";
import type { ModelRoster } from "./roles.js";
import { AWS_REGION_ENV, LITELLM_API_KEY_ENV, LITELLM_BASE_URL_ENV, llmInvalid, llmMissing, llmProvider, normalizeLiteLlmBaseUrl } from "./config.js";
import type { LlmProvider } from "./config.js";
import { liteLlmTransport, stopReasonFromFinish } from "./litellm.js";
import type { ChatRequest, ChatTransport } from "./litellm.js";

type Env = Record<string, string | undefined>;

export type LlmMessage = { role: "user" | "assistant"; content: string };

export type CompleteRequest = {
  role: Role;
  system?: string;
  messages: LlmMessage[];
  /** Output token cap. Default 2048. */
  maxTokens?: number;
};

export type CompleteResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  modelId: string;
  /** Stop reason in Bedrock's vocabulary, e.g. "end_turn", "max_tokens" (LiteLLM finish_reason is mapped); "unknown" if absent. */
  stopReason: string;
};

/** Anything that can complete a prompt; lets callers (e.g. the reflector) accept a narrower type. */
export type LlmLike = { complete(req: CompleteRequest): Promise<CompleteResult> };

/** Sends one Converse request. Injectable so tests never reach AWS. */
export type ConverseTransport = (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;

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

/** Per-role token and USD accounting. */
export class UsageMeter {
  private readonly usage: UsageByRole = {
    executor: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    reflector: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
    adversary: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
  };
  /** Pricing problems (unknown model, bad override). De-duplicated. */
  readonly warnings: string[] = [];

  add(role: Role, u: { inputTokens: number; outputTokens: number; usd: number }): void {
    const r = this.usage[role];
    r.inputTokens += u.inputTokens;
    r.outputTokens += u.outputTokens;
    r.usd = Math.round((r.usd + u.usd) * 1e9) / 1e9;
    r.calls += 1;
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** The bundle's `usageByRole` shape, always with all three roles. A copy. */
  snapshot(): UsageByRole {
    const out = {} as UsageByRole;
    for (const role of ROLES) out[role] = { ...this.usage[role] };
    return out;
  }
}

/** Default transport: the real Bedrock Runtime client, created lazily on the first call. */
export function bedrockTransport(region: string): ConverseTransport {
  let client: { send: (cmd: unknown) => Promise<unknown> } | null = null;
  let ConverseCommandCtor: (new (input: ConverseCommandInput) => unknown) | null = null;
  return async (input) => {
    if (!client || !ConverseCommandCtor) {
      const sdk = await import("@aws-sdk/client-bedrock-runtime");
      // wrapBedrock (when tracing is on) emits the LLM span with messages, completion and usage.
      client = traceBedrockClient(new sdk.BedrockRuntimeClient({ region })) as unknown as typeof client;
      ConverseCommandCtor = sdk.ConverseCommand;
    }
    return (await client!.send(new ConverseCommandCtor!(input))) as ConverseCommandOutput;
  };
}

export type LlmClientOptions = {
  env?: Env;
  /** Override the Bedrock transport (tests). When omitted, AWS_REGION must be set. */
  transport?: ConverseTransport;
  /** Override the LiteLLM transport (tests). When omitted, LITELLM_BASE_URL and LITELLM_API_KEY must be set. */
  chatTransport?: ChatTransport;
  meter?: UsageMeter;
};

/** One provider reply, normalized. */
type ProviderReply = { text: string; inputTokens: number; outputTokens: number; stopReason: string };
type ProviderRequest = { system?: string; messages: LlmMessage[]; maxTokens: number };
type ProviderCall = (modelId: string, req: ProviderRequest) => Promise<ProviderReply>;

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
  private readonly env: Env;
  private readonly roster: ModelRoster;
  private transport: ConverseTransport | undefined;
  private chatTransport: ChatTransport | undefined;

  constructor(opts: LlmClientOptions = {}) {
    this.env = opts.env ?? process.env;
    this.provider = llmProvider(this.env); // throws ModelConfigError on an unknown provider
    this.roster = resolveModels(this.env); // throws ModelConfigError on a separation-of-duties breach
    this.meter = opts.meter ?? new UsageMeter();
    if (this.provider === "litellm" && opts.transport && !opts.chatTransport) {
      throw new Error("LlmClient: a Bedrock transport was injected but NOTARY_LLM_PROVIDER=litellm (inject chatTransport)");
    }
    if (this.provider === "bedrock" && opts.chatTransport && !opts.transport) {
      throw new Error("LlmClient: a LiteLLM chatTransport was injected but the provider is bedrock (set NOTARY_LLM_PROVIDER=litellm)");
    }
    this.transport = opts.transport;
    this.chatTransport = opts.chatTransport;
  }

  /** The configured model id for a role, or the BLOCKED error. */
  modelFor(role: Role): string {
    return requireModel(this.roster, role);
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
      return async (modelId, req) => {
        const body: ChatRequest = {
          model: modelId,
          messages: [
            ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
            ...req.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
          max_tokens: req.maxTokens,
          temperature: 0,
        };
        const { completion } = await transport(body);
        const choice = completion.choices?.[0];
        const content = choice?.message?.content;
        return {
          text: typeof content === "string" ? content : "",
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
          stopReason: stopReasonFromFinish(choice?.finish_reason),
        };
      };
    }
    const transport = this.getTransport();
    return async (modelId, req) => {
      const input: ConverseCommandInput = {
        modelId,
        messages: req.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
        inferenceConfig: { maxTokens: req.maxTokens, temperature: 0 },
        ...(req.system ? { system: [{ text: req.system }] } : {}),
      };
      let out: ConverseCommandOutput;
      try {
        out = await transport(input);
      } catch (err) {
        if (isAwsCredentialError(err)) throw new MissingCredentialError(AWS_CREDENTIALS_LABEL, AWS_CREDENTIALS_HINT);
        throw err;
      }
      const blocks = out.output && "message" in out.output ? (out.output.message?.content ?? []) : [];
      return {
        text: blocks.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join(""),
        inputTokens: out.usage?.inputTokens ?? 0,
        outputTokens: out.usage?.outputTokens ?? 0,
        stopReason: String(out.stopReason ?? "unknown"),
      };
    };
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const modelId = this.modelFor(req.role);
    const call = this.providerCall();
    // P9 (AUDIT-08): backstop — no secret env value is ever sent to a model, whatever built the prompt.
    const clean = scrubber(this.env);
    const scrubbed: ProviderRequest = {
      messages: req.messages.map((m) => ({ role: m.role, content: clean(m.content) })),
      maxTokens: req.maxTokens ?? 2048,
      ...(req.system ? { system: clean(req.system) } : {}),
    };

    let setAttr: ((k: string, v: string | number | boolean) => void) | undefined;
    return withSpan(
      "notary.llm",
      { "notary.role": req.role, "llm.model_id": modelId, "llm.provider": this.provider },
      async () => {
        let out: ProviderReply;
        try {
          out = await call(modelId, scrubbed);
        } catch (err) {
          throw scrubError(err, clean);
        }
        const { inputTokens, outputTokens, text, stopReason } = out;
        const priced = resolvePrice(req.role, modelId, this.env);
        if (priced.warning) this.meter.warn(priced.warning);
        const usd = costUsd(priced.price, inputTokens, outputTokens);
        this.meter.add(req.role, { inputTokens, outputTokens, usd });

        if (setAttr) {
          setAttr("llm.input_tokens", inputTokens);
          setAttr("llm.output_tokens", outputTokens);
          setAttr("llm.usd", usd);
          setAttr("llm.price_source", priced.source);
          setAttr("llm.stop_reason", stopReason);
        }
        return { text, inputTokens, outputTokens, usd, modelId, stopReason };
      },
      // CHAIN, not LLM: the wrapped provider client emits the LLM child span (no double capture).
      { kind: "CHAIN", onSpan: (_ids, set) => (setAttr = set) },
    );
  }
}
