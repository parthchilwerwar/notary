/**
 * Model-call cassettes (P8, TDD "Replay": every reported number is computed from recordings).
 *
 * A live notarize run wraps its model client in RecordingLlm: every `complete` call (reflector and
 * bedrock adversary) is stored as an Exchange in cassette `<runId>-llm`, with the per-role token
 * counts, USD and model id the bundle's `usageByRole` was built from. `notary replay` serves those
 * answers through ReplayLlm with no AWS credentials and no model ids from the environment.
 *
 * Matching: requestHash = sha256(canonical {role, system, messages, maxTokens}) after redaction and
 * after replacing values that legitimately differ between a run and its replay — trace ids (32
 * hex), span ids (16 hex) and ISO timestamps. Probe ids, claim ids, observations and predictions
 * are NOT normalized: if the prompt differs in any of those, the replay diverged, and the miss
 * throws LlmCassetteMissError (a CassetteMissError) naming the role, hash and occurrence. Identical
 * prompts are told apart by occurrence, as in the HTTP recorder.
 *
 * Also recorded: which roles had a model configured (so a BLOCKED adversary replays as BLOCKED),
 * whether the client metered usage, and the `session` adversary backend's review outcomes (op
 * `adversary.session`, keyed by belief id), so a headless-session review replays without spawning one.
 */
import type { ReviewBeliefArgs, ReviewOutcome } from "../adversary/index.js";
import { LLM_FIX_HINT, UsageMeter } from "../llm/index.js";
import type { CompleteRequest, CompleteResult, LlmLike } from "../llm/index.js";
import type { Role } from "../schema/index.js";
import { CassetteMissError, MissingCredentialError, Redactor, canonicalJson, collectSecrets, computeContentHash } from "../tools/index.js";
import type { Cassette, Exchange } from "../tools/index.js";
import { createHash } from "node:crypto";

const ROLES: readonly Role[] = ["executor", "reflector", "adversary"];
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const HEX32 = /\b[0-9a-f]{32}\b/g;
const HEX16 = /\b[0-9a-f]{16}\b/g;

/** Replace run-volatile values (timestamps, trace and span ids) so a replay's prompt matches its recording. */
export function normalizeVolatile(text: string): string {
  return text.replace(ISO, "<ts>").replace(HEX32, "<trace-id>").replace(HEX16, "<span-id>");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function requestBody(req: CompleteRequest, redactor: Redactor): Record<string, unknown> {
  const norm = (s: string) => normalizeVolatile(redactor.string(s));
  return {
    role: req.role,
    system: req.system === undefined ? null : norm(req.system),
    messages: req.messages.map((m) => ({ role: m.role, content: norm(m.content) })),
    maxTokens: req.maxTokens ?? null,
  };
}

export class LlmCassetteMissError extends CassetteMissError {
  constructor(op: string, url: string, requestHash: string, occurrence: number) {
    super(op, "POST", url, requestHash, occurrence);
    this.message = `Model cassette miss: ${op} (hash ${requestHash.slice(0, 12)}, occurrence ${occurrence}) — the replayed prompt differs from every recorded one`;
  }
}

type RoleModels = Partial<Record<Role, { modelId: string } | { blockedVariable: string }>>;

interface ModelsRecord {
  metered: boolean;
  /** Present only when the recorded client exposed modelFor (a real LlmClient). */
  models?: RoleModels;
}

const MODELS_OP = "llm.models";
const SESSION_OP = "adversary.session";

type WithMeter = LlmLike & { meter?: UsageMeter; modelFor?: (role: Role) => string };

function baseExchange(op: string, url: string, body: unknown, requestHash: string, occurrence: number): Omit<Exchange, "status" | "responseBody" | "latencyMs"> {
  return {
    id: `${op}#${requestHash.slice(0, 12)}#${occurrence}`,
    tool: "llm",
    op,
    method: "POST",
    url,
    requestHeaders: {},
    requestBody: body,
    responseHeaders: {},
    credits: null,
    recordedAt: new Date().toISOString(),
    requestHash,
    occurrence,
  };
}

/** Live: forwards to the real client and records every call. */
export class RecordingLlm implements LlmLike {
  readonly meter?: UsageMeter;
  readonly modelFor?: (role: Role) => string;
  private readonly redactor: Redactor;
  private readonly exchanges: Exchange[] = [];
  private readonly occurrences = new Map<string, number>();

  constructor(
    private readonly inner: WithMeter,
    opts: { env?: NodeJS.ProcessEnv } = {},
  ) {
    this.redactor = new Redactor(collectSecrets(opts.env ?? process.env));
    if (inner.meter) this.meter = inner.meter;
    if (typeof inner.modelFor === "function") this.modelFor = (role) => inner.modelFor!(role);
  }

  private next(hash: string): number {
    const n = this.occurrences.get(hash) ?? 0;
    this.occurrences.set(hash, n + 1);
    return n;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const body = requestBody(req, this.redactor);
    const op = `llm.${req.role}`;
    const url = `llm://complete/${req.role}`;
    const hash = sha256(canonicalJson({ op, body }));
    const occurrence = this.next(hash);
    const started = performance.now();
    try {
      const res = await this.inner.complete(req);
      this.exchanges.push({
        ...baseExchange(op, url, body, hash, occurrence),
        status: 200,
        responseBody: { ...res, text: this.redactor.string(res.text) },
        latencyMs: Math.round(performance.now() - started),
      });
      return res;
    } catch (err) {
      // BLOCKED and config errors abort the run (no bundle); anything else is part of the record.
      this.exchanges.push({
        ...baseExchange(op, url, body, hash, occurrence),
        status: 0,
        responseBody: { errorName: err instanceof Error ? err.name : "Error" },
        latencyMs: Math.round(performance.now() - started),
        error: this.redactor.string(err instanceof Error ? err.message : String(err)),
      });
      throw err;
    }
  }

  /** Wrap the adversary reviewer so `session` backend outcomes are recorded (bedrock goes through complete). */
  recordReviews(inner: (args: ReviewBeliefArgs) => Promise<ReviewOutcome>): (args: ReviewBeliefArgs) => Promise<ReviewOutcome> {
    return async (args) => {
      const outcome = await inner(args);
      if (args.backend === "session") {
        const body = { beliefId: args.belief.id };
        const hash = sha256(canonicalJson({ op: SESSION_OP, body }));
        this.exchanges.push({
          ...baseExchange(SESSION_OP, `llm://adversary/session/${args.belief.id}`, body, hash, this.next(hash)),
          status: 200,
          responseBody: this.redactor.body(outcome),
          latencyMs: 0,
        });
      }
      return outcome;
    };
  }

  private modelsRecord(): ModelsRecord {
    const out: ModelsRecord = { metered: this.meter !== undefined };
    if (this.modelFor) {
      const models: RoleModels = {};
      for (const role of ROLES) {
        try {
          models[role] = { modelId: this.modelFor(role) };
        } catch (err) {
          if (err instanceof MissingCredentialError) models[role] = { blockedVariable: err.variable };
          else throw err;
        }
      }
      out.models = models;
    }
    return out;
  }

  toCassette(name: string): Cassette {
    const models = this.modelsRecord();
    const hash = sha256(canonicalJson({ op: MODELS_OP }));
    const exchanges: Exchange[] = [
      { ...baseExchange(MODELS_OP, "llm://models", {}, hash, 0), status: 200, responseBody: models, latencyMs: 0 },
      ...this.exchanges,
    ];
    return { name, tool: "llm", createdAt: new Date().toISOString(), exchanges, contentHash: computeContentHash(exchanges) };
  }
}

/** Replay: serves recorded answers; never reads the environment or calls a model. */
export class ReplayLlm implements LlmLike {
  readonly meter?: UsageMeter;
  readonly modelFor?: (role: Role) => string;
  /** Served calls per role (for reports). */
  readonly served: Record<string, number> = {};
  private readonly redactor = new Redactor([]);
  private readonly index = new Map<string, Exchange[]>();
  private readonly occurrences = new Map<string, number>();

  constructor(cassette: Cassette) {
    let models: ModelsRecord | undefined;
    for (const ex of [...cassette.exchanges].sort((a, b) => a.occurrence - b.occurrence)) {
      if (ex.op === MODELS_OP) {
        models = ex.responseBody as ModelsRecord;
        continue;
      }
      const list = this.index.get(ex.requestHash) ?? [];
      list.push(ex);
      this.index.set(ex.requestHash, list);
    }
    if (!models) throw new Error(`cassette ${cassette.name} is not a model cassette (no ${MODELS_OP} record)`);
    if (models.metered) this.meter = new UsageMeter();
    const roleModels = models.models;
    if (roleModels) {
      this.modelFor = (role) => {
        const m = roleModels[role];
        // Same text as the live client (src/llm/roles.ts requireModel), so a BLOCKED role replays identically.
        if (!m) throw new MissingCredentialError(`NOTARY_MODEL_${role.toUpperCase()}`, LLM_FIX_HINT);
        if ("blockedVariable" in m) throw new MissingCredentialError(m.blockedVariable, LLM_FIX_HINT);
        return m.modelId;
      };
    }
  }

  private take(op: string, url: string, hash: string): Exchange {
    const occurrence = this.occurrences.get(hash) ?? 0;
    const hit = this.index.get(hash)?.[occurrence];
    if (!hit) throw new LlmCassetteMissError(op, url, hash, occurrence);
    this.occurrences.set(hash, occurrence + 1);
    this.served[op] = (this.served[op] ?? 0) + 1;
    return hit;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const body = requestBody(req, this.redactor);
    const op = `llm.${req.role}`;
    const hit = this.take(op, `llm://complete/${req.role}`, sha256(canonicalJson({ op, body })));
    if (hit.error !== undefined) {
      const err = new Error(hit.error);
      err.name = (hit.responseBody as { errorName?: string } | null)?.errorName ?? "Error";
      throw err;
    }
    const res = hit.responseBody as CompleteResult;
    this.meter?.add(req.role, { inputTokens: res.inputTokens, outputTokens: res.outputTokens, usd: res.usd, unknownPrice: res.priceSource === "unknown" });
    return res;
  }

  /** The recorded `session` adversary outcome for a belief (replaces spawning a headless session). */
  readonly review = async (args: ReviewBeliefArgs): Promise<ReviewOutcome> => {
    const body = { beliefId: args.belief.id };
    const hit = this.take(SESSION_OP, `llm://adversary/session/${args.belief.id}`, sha256(canonicalJson({ op: SESSION_OP, body })));
    return hit.responseBody as ReviewOutcome;
  };
}
