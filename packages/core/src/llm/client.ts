/**
 * Bedrock LLM client: one client, three roles (TDD "Integrations: AWS Bedrock").
 *
 * SDK: @aws-sdk/client-bedrock-runtime, Converse API —
 *   new BedrockRuntimeClient({ region }).send(new ConverseCommand({
 *     modelId, system: [{ text }], messages: [{ role, content: [{ text }] }],
 *     inferenceConfig: { maxTokens, temperature: 0 },
 *   }))
 *   → { output: { message: { content: [{ text }] } }, usage: { inputTokens, outputTokens }, stopReason }
 *
 * Credentials come from the SDK's default provider chain (env keys, AWS_PROFILE / SSO, …). This
 * module never reads, passes or logs a credential. If the chain finds none, the SDK's
 * CredentialsProviderError is rethrown as the BLOCKED error.
 *
 * Every call opens a neatlogs span "notary.llm" (CHAIN) with role, model id, token counts and USD;
 * prompts are never put in its attributes. Under it, the SDK's wrapBedrock emits the LLM span,
 * which does carry the (already secret-scrubbed) messages and completion. Usage accumulates per role in a UsageMeter, whose snapshot is
 * the bundle's `usageByRole`.
 */
import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Role, UsageByRole } from "../schema/index.js";
import { MissingCredentialError } from "../tools/errors.js";
import { traceBedrockClient, withSpan } from "../trace/index.js";
import { costUsd, resolvePrice } from "./pricing.js";
import { ROLES, requireModel, resolveModels } from "./roles.js";
import type { ModelRoster } from "./roles.js";

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
  /** Bedrock stop reason, e.g. "end_turn", "max_tokens"; "unknown" if absent. */
  stopReason: string;
};

/** Anything that can complete a prompt; lets callers (e.g. the reflector) accept a narrower type. */
export type LlmLike = { complete(req: CompleteRequest): Promise<CompleteResult> };

/** Sends one Converse request. Injectable so tests never reach AWS. */
export type ConverseTransport = (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;

/** The AWS SDK's "no credentials found" errors (from @smithy/property-provider). */
const CREDENTIAL_ERROR_NAMES = new Set(["CredentialsProviderError", "TokenProviderError"]);

export const AWS_CREDENTIALS_LABEL = "AWS credentials (env keys or AWS_PROFILE/SSO)";

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
  meter?: UsageMeter;
};

export class LlmClient implements LlmLike {
  readonly meter: UsageMeter;
  private readonly env: Env;
  private readonly roster: ModelRoster;
  private transport: ConverseTransport | undefined;

  constructor(opts: LlmClientOptions = {}) {
    this.env = opts.env ?? process.env;
    this.roster = resolveModels(this.env); // throws ModelConfigError on a separation-of-duties breach
    this.meter = opts.meter ?? new UsageMeter();
    this.transport = opts.transport;
  }

  /** The configured model id for a role, or the BLOCKED error. */
  modelFor(role: Role): string {
    return requireModel(this.roster, role);
  }

  private getTransport(): ConverseTransport {
    if (this.transport) return this.transport;
    const region = (this.env.AWS_REGION ?? "").trim();
    if (!region) throw new MissingCredentialError("AWS_REGION");
    this.transport = bedrockTransport(region);
    return this.transport;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const modelId = this.modelFor(req.role);
    const transport = this.getTransport();
    // P9 (AUDIT-08): backstop — no secret env value is ever sent to a model, whatever built the prompt.
    const clean = scrubber(this.env);
    const input: ConverseCommandInput = {
      modelId,
      messages: req.messages.map((m) => ({ role: m.role, content: [{ text: clean(m.content) }] })),
      inferenceConfig: { maxTokens: req.maxTokens ?? 2048, temperature: 0 },
      ...(req.system ? { system: [{ text: clean(req.system) }] } : {}),
    };

    let setAttr: ((k: string, v: string | number | boolean) => void) | undefined;
    return withSpan(
      "notary.llm",
      { "notary.role": req.role, "llm.model_id": modelId },
      async () => {
        let out: ConverseCommandOutput;
        try {
          out = await transport(input);
        } catch (err) {
          if (isAwsCredentialError(err)) throw new MissingCredentialError(AWS_CREDENTIALS_LABEL);
          throw err;
        }
        const inputTokens = out.usage?.inputTokens ?? 0;
        const outputTokens = out.usage?.outputTokens ?? 0;
        const priced = resolvePrice(req.role, modelId, this.env);
        if (priced.warning) this.meter.warn(priced.warning);
        const usd = costUsd(priced.price, inputTokens, outputTokens);
        this.meter.add(req.role, { inputTokens, outputTokens, usd });

        const blocks = out.output && "message" in out.output ? (out.output.message?.content ?? []) : [];
        const text = blocks.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("");
        const stopReason = String(out.stopReason ?? "unknown");

        if (setAttr) {
          setAttr("llm.input_tokens", inputTokens);
          setAttr("llm.output_tokens", outputTokens);
          setAttr("llm.usd", usd);
          setAttr("llm.price_source", priced.source);
          setAttr("llm.stop_reason", stopReason);
        }
        return { text, inputTokens, outputTokens, usd, modelId, stopReason };
      },
      // CHAIN, not LLM: the wrapped Bedrock client emits the LLM child span (no double capture).
      { kind: "CHAIN", onSpan: (_ids, set) => (setAttr = set) },
    );
  }
}
