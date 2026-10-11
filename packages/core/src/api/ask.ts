// POST /api/ask (v2 "Ask Notary", local `notary serve` only; token + localhost via session.ts).
//
// 1. Deterministic retrieval over the bundles serve already loads, from ONE data world
//    (explain/world.ts worldKeyOf: real | synthetic | fixture:<scenario>; fixture scenarios never
//    mix): the named run's world; else real when any real bundle exists; else the one world whose
//    runs the question names; else the newest bundle's world. The world's citable records are its
//    bundles' records plus its timelines, approvals and certificates/revocations (ask-world.ts).
//    Records are scored by code: the named run, record ids
//    and run ids mentioned in the question, tool names, and keyword overlap with the record's text;
//    ties break on kind, run and id. The top ASK_TOP_N records with a positive score are kept.
// 2. The executor model answers in strict JSON {answer, citations:[{kind,id,runId?}]} given only
//    those records.
// 3. Validation by code: the JSON shape, at least one citation, and every citation resolving to a
//    record in the loaded world (validateCitations). Anything else is
//    {ok:false, answer:"couldn't answer from the evidence", reason}.
//
// Model not configured (llmBlockedReason: NOTARY_MODEL_EXECUTOR plus LITELLM_BASE_URL/LITELLM_API_KEY
// or AWS_REGION, per NOTARY_LLM_PROVIDER) -> ok:false with a "BLOCKED: <VAR> not set — ... run
// `pnpm notary doctor --llm`" reason and no network call. At NOTARY_MAX_USD the cap message is the reason.
//
// Tracing (neatlogs, one trace per question; README of neatlogs 1.1.26 is the authority):
//   notary.ask            WORKFLOW  root: question length, run named, world, counts, ok, reason
//     notary.ask.retrieve RETRIEVER world, records indexed, top-N `kind:id` ids + scores (ids only)
//     notary.llm          CHAIN     opened by LlmClient (role, model id, tokens, USD); the provider
//       <LLM span>        LLM       wrapper (wrapBedrock / wrapOpenAI) is the one LLM-span owner
//     notary.ask.validate GUARDRAIL cited / passed / failed `kind:id` lists, ok, reason; on the
//                                   BLOCKED and other no-reply paths: skipped=true + the reason
// Never the question text, the prompt, the session token or a secret in attributes. Nesting is by
// async context (the SDK's AsyncLocalStorage), so concurrent asks are separate traces. Spans also go
// to a local sink scoped to the ask (AskOptions.spansPath; serve: runs/_ask/spans.jsonl), never into
// an approval's run file. After each ask a flush is started and NOT awaited: export problems never
// delay or fail the HTTP response. A rate-limited ask (ask-limit.ts) is one short root span with
// notary.ask.rate_limited=true.
//
// Read-only by construction: this module imports no tool client, guarded wrapper, queue executor or
// approval code (test/ask.test.ts checks the import graph), so an ask can never trigger an action.
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { validateCitations } from "../explain/citations.js";
import type { RecordIndex } from "../explain/citations.js";
import { worldKeyOf } from "../explain/world.js";
import { LlmClient } from "../llm/client.js";
import type { LlmLike } from "../llm/client.js";
import { isUsdCapExceeded } from "../llm/budget.js";
import { llmBlockedReason } from "../llm/config.js";
import { AskRequestSchema, CitationSchema } from "../schema/explain.js";
import type { AskRequest, AskResponse, Citation } from "../schema/explain.js";
import type { RunBundle } from "../schema/index.js";
import { flushTracing, withSpan, withSpanSink } from "../trace/index.js";
import type { SpanIds, SpanKind, TraceAttrs } from "../trace/index.js";
import { z } from "zod";
import { ASK_RPM_ENV, SlidingWindowLimiter, askRpm, retryAfterSeconds } from "./ask-limit.js";
import { indexWorldRecords } from "./ask-world.js";
import type { WorldRecords, WorldSources } from "./ask-world.js";
import { loadVerifiedBundles } from "./bundle-source.js";
import type { LoadedBundle } from "./bundle-source.js";
import { requireLocalSession } from "./session.js";
import type { ApiSession } from "./session.js";

type Env = Record<string, string | undefined>;

export const ASK_TOP_N = 12;
/** packages/web/public/certificates/ (real <tool>.json; fixture/<scenario>/<tool>.json). */
export const DEFAULT_CERTIFICATES_DIR = fileURLToPath(new URL("../../../web/public/certificates/", import.meta.url));
export const ASK_FAILED_ANSWER = "couldn't answer from the evidence" as const;
/** Characters of one record's JSON shown to the model. */
export const ASK_RECORD_CHARS = 1500;

export interface AskOptions extends WorldSources {
  /** The bundle directories serve loads (read per ask). */
  bundleDirs: () => string[];
  env?: Env;
  /** Test seam: a model double. When set, the BLOCKED config check is skipped. */
  llm?: LlmLike;
  topN?: number;
  /**
   * Local span sink for this ask's spans (withSpanSink): a file, or null for none. Undefined: the
   * process-wide sink (setSpanSink). createApp passes <runsDir>/_ask/spans.jsonl.
   */
  spansPath?: string | null;
  /** Started (never awaited) once after every ask. Default flushTracing. Test seam. */
  flush?: () => Promise<unknown>;
  /** Questions per minute per session for POST /api/ask; default from NOTARY_ASK_RPM, else 10. */
  rpm?: number;
  /** Clock (ms) for the rate limiter. Test seam. */
  now?: () => number;
}

/** Directory under runs/ holding serve's ask spans (a leading "_" can never be a run id). */
export const ASK_SPANS_DIR = "_ask";
/** Longest `kind:id` list written to one attribute. */
const ASK_ID_LIST_CHARS = 2000;

type Setter = (key: string, value: string | number | boolean) => void;

function idList(xs: readonly { kind: string; id: string }[]): string {
  const s = xs.map((x) => `${x.kind}:${x.id}`).join(",");
  return s.length > ASK_ID_LIST_CHARS ? `${s.slice(0, ASK_ID_LIST_CHARS)}...(truncated)` : s;
}

/** One span whose body gets the attribute setter. Bodies return small summaries only (the SDK records the return value). */
function step<T>(name: string, kind: SpanKind, attrs: TraceAttrs, fn: (set: Setter) => Promise<T> | T, onIds?: (ids: SpanIds) => void): Promise<T> {
  let setter: Setter = () => {};
  return withSpan(name, attrs, () => fn((k, v) => setter(k, v)), {
    kind,
    onSpan: (ids, s) => {
      setter = s;
      onIds?.(ids);
    },
  });
}

/** Run one ask's spans in its own sink scope, then start (not await) a flush. */
async function tracedAsk<T>(opts: AskOptions, fn: () => Promise<T>): Promise<T> {
  try {
    return opts.spansPath === undefined ? await fn() : await withSpanSink(opts.spansPath, fn);
  } finally {
    startFlush(opts.flush ?? flushTracing);
  }
}

function startFlush(flush: () => Promise<unknown>): void {
  try {
    void Promise.resolve(flush()).catch(() => undefined);
  } catch {
    // an export problem never reaches the response
  }
}

function rootAttrs(req: AskRequest): TraceAttrs {
  return { "notary.ask.question_length": req.question.length, "notary.ask.run_named": req.runId !== undefined };
}

export interface RetrievedRecord {
  kind: Citation["kind"];
  id: string;
  runId?: string;
  score: number;
  record: unknown;
}

export interface Retrieval {
  /** worldKeyOf key: "real" | "synthetic" | "fixture:<scenario>". */
  world: string;
  bundles: RunBundle[];
  index: RecordIndex;
  counts: WorldRecords["counts"];
  records: RetrievedRecord[];
}

const STOPWORDS = new Set(
  "the and for are was were why what when which who how did does was has have had not but with from that this into its it's out any all can could would should about there their them they than then been being our your you".split(
    " ",
  ),
);

const KIND_ORDER: Record<string, number> = {
  decision: 0,
  belief: 1,
  probe: 2,
  guard: 3,
  claim: 4,
  hypothesis: 5,
  anomaly: 6,
  belief_event: 7,
  certificate: 8,
  revocation: 9,
  approval: 10,
  timeline_event: 11,
};

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9_.:-]*[a-z0-9]|[a-z0-9]/g) ?? [];
}

function keywords(question: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(question)) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(w);
    // "dodo.createrefund" also matches "createrefund"; "q09:refund" matches both halves.
    for (const part of w.split(/[.:_-]/)) if (part.length >= 3 && !STOPWORDS.has(part)) out.add(part);
  }
  return out;
}

/** Tool names in the question: "dodo", "crustdata", and op names like "dodo.createRefund". */
function toolMentions(question: string): Set<string> {
  const out = new Set<string>();
  for (const m of question.toLowerCase().matchAll(/\b(dodo|crustdata)(?:\.([a-z]+))?\b/g)) {
    out.add(m[1]!);
    if (m[2]) out.add(`${m[1]}.${m[2]}`);
  }
  return out;
}

/** Code-point order (locale-independent). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function mentions(questionLower: string, id: string): boolean {
  const needle = id.toLowerCase();
  return needle.length >= 3 && questionLower.includes(needle);
}

/**
 * The one world to answer from (worldKeyOf: "real" | "synthetic" | "fixture:<scenario>"): the named
 * run's; else "real" when any real bundle is loaded; else the one world whose run ids the question
 * mentions; else the world of the newest bundle (startedAt, then runId). Deterministic.
 */
export function chooseWorld(allBundles: readonly RunBundle[], req: AskRequest): { key: string } | { error: string } {
  if (allBundles.length === 0) return { error: "no bundles are loaded" };
  if (req.runId !== undefined) {
    const named = allBundles.find((b) => b.runId === req.runId);
    return named ? { key: worldKeyOf(named) } : { error: `unknown run ${req.runId}` };
  }
  if (allBundles.some((b) => !b.sample)) return { key: "real" };
  const qLower = req.question.toLowerCase();
  const mentioned = [...new Set(allBundles.filter((b) => mentions(qLower, b.runId)).map(worldKeyOf))];
  if (mentioned.length === 1) return { key: mentioned[0]! };
  const newest = [...allBundles].sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt) || (x.runId < y.runId ? 1 : x.runId > y.runId ? -1 : 0))[0]!;
  return { key: worldKeyOf(newest) };
}

/** Pick the data world, index every citable record in it, and score them. Deterministic. */
export function retrieve(
  loaded: readonly LoadedBundle[],
  req: AskRequest,
  opts: WorldSources & { topN?: number } = {},
): Retrieval | { error: string } {
  const topN = opts.topN ?? ASK_TOP_N;
  const chosen = chooseWorld(
    loaded.map((l) => l.bundle),
    req,
  );
  if ("error" in chosen) return chosen;
  const world = indexWorldRecords(chosen.key, loaded, opts);
  const { bundles, index } = world;

  const qLower = req.question.toLowerCase();
  const keys = keywords(req.question);
  const tools = toolMentions(req.question);
  const runsMentioned = new Set(bundles.filter((b) => mentions(qLower, b.runId)).map((b) => b.runId));

  const scored: RetrievedRecord[] = [];
  for (const rec of index.all()) {
    const text = JSON.stringify(rec.record).toLowerCase();
    const tokens = new Set(words(text));
    for (const t of [...tokens]) for (const part of t.split(/[.:_-]/)) if (part.length >= 3) tokens.add(part);
    let score = 0;
    if (req.runId !== undefined && rec.runId === req.runId) score += 100;
    if (rec.runId !== undefined && runsMentioned.has(rec.runId)) score += 30;
    if (mentions(qLower, rec.id)) score += 50;
    for (const t of tools) if (tokens.has(t)) score += 10;
    for (const k of keys) if (tokens.has(k)) score += 1;
    if (score > 0) scored.push({ kind: rec.kind, id: rec.id, ...(rec.runId === undefined ? {} : { runId: rec.runId }), score, record: rec.record });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99) ||
      cmp(a.runId ?? "", b.runId ?? "") ||
      cmp(a.id, b.id),
  );
  return { world: world.key, bundles, index, counts: world.counts, records: scored.slice(0, topN) };
}

export const ASK_SYSTEM_PROMPT = [
  "You answer questions about Notary run records (an agent's decisions, probes, beliefs, guards and claims about the tools it uses).",
  "Use ONLY the records in the user message. Do not use outside knowledge and do not guess.",
  'Reply with one JSON object and nothing else: {"answer": "<plain text>", "citations": [{"kind": "<kind>", "id": "<id>", "runId": "<runId>"}]}.',
  "Every citation must copy the kind, id and runId of a record from the list exactly. Cite every record your answer relies on.",
  'If the records do not answer the question, reply {"answer": "", "citations": []}.',
].join("\n");

export function buildAskPrompt(question: string, records: readonly RetrievedRecord[]): string {
  const lines = records.map((r) => {
    const json = JSON.stringify(r.record);
    const body = json.length > ASK_RECORD_CHARS ? `${json.slice(0, ASK_RECORD_CHARS)}...(truncated)` : json;
    return `- kind=${r.kind} id=${r.id}${r.runId === undefined ? "" : ` runId=${r.runId}`}\n  ${body}`;
  });
  return `Question: ${question}\n\nRecords (${records.length}):\n${lines.join("\n")}`;
}

const ModelAnswerSchema = z.object({ answer: z.string().trim().min(1), citations: z.array(CitationSchema) }).strict();

/** Parse the model's reply: one JSON object (a single surrounding code fence is tolerated). */
export function parseModelAnswer(text: string): { ok: true; answer: string; citations: Citation[] } | { ok: false; reason: string } {
  let body = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(body);
  if (fence) body = fence[1]!.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: "model reply is not JSON" };
  }
  const parsed = ModelAnswerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `model reply has the wrong shape (${parsed.error.issues[0]?.message ?? "invalid"})` };
  return { ok: true, answer: parsed.data.answer.trim(), citations: parsed.data.citations };
}

function failed(reason: string, traceId?: string): AskResponse {
  return { ok: false, answer: ASK_FAILED_ANSWER, reason, ...(traceId ? { traceId } : {}) };
}

/** BLOCKED reason when the executor model can't be called, else null. No network. */
export function askBlockedReason(env: Env): string | null {
  // Provider-aware (NOTARY_LLM_PROVIDER: litellm needs LITELLM_BASE_URL/LITELLM_API_KEY, bedrock
  // AWS_REGION; both need NOTARY_MODEL_EXECUTOR). The message names the exact variable and points
  // to `pnpm notary doctor --llm`.
  return llmBlockedReason(env, "executor");
}

export async function answerQuestion(req: AskRequest, opts: AskOptions): Promise<AskResponse> {
  const env = opts.env ?? process.env;
  const topN = opts.topN ?? ASK_TOP_N;
  let traceId: string | undefined;
  const out = await tracedAsk(opts, () =>
    step(
      "notary.ask",
      "WORKFLOW",
      rootAttrs(req),
      async (note): Promise<AskResponse> => {
        const finish = (r: AskResponse, citationsValid: boolean): AskResponse => {
          note("notary.ask.ok", r.ok);
          note("notary.ask.citations_valid", citationsValid);
          if (!r.ok) note("notary.ask.reason", r.reason.slice(0, 200));
          return r;
        };
        /** The validation step on a path with no model reply to validate: skipped, with the reason. */
        const skip = async (reason: string): Promise<AskResponse> => {
          await step("notary.ask.validate", "GUARDRAIL", { "notary.ask.skipped": true, "notary.ask.ok": false, "notary.ask.reason": reason.slice(0, 200) }, () => ({ skipped: true }));
          return finish(failed(reason), false);
        };

        const blocked = opts.llm ? null : askBlockedReason(env);
        note("notary.ask.blocked", blocked !== null);
        note("notary.ask.model_called", false);

        // 1. Retrieval: always, BLOCKED included (local files only, no network), so the trace shows
        //    what the question would have been answered from. Ids, counts and scores only.
        let r: Retrieval | { error: string } = { error: "retrieval did not run" };
        await step("notary.ask.retrieve", "RETRIEVER", { "notary.ask.top_n": topN }, async (set) => {
          const loaded = await loadVerifiedBundles(opts.bundleDirs());
          set("notary.ask.bundles_loaded", loaded.length);
          const got = retrieve(loaded, req, {
            topN,
            runsDir: opts.runsDir ?? null,
            certificatesDir: opts.certificatesDir === undefined ? DEFAULT_CERTIFICATES_DIR : opts.certificatesDir,
          });
          r = got;
          if ("error" in got) {
            set("notary.ask.retrieved", 0);
            set("notary.ask.error", got.error.slice(0, 200));
            return { retrieved: 0 };
          }
          set("notary.ask.world", got.world);
          set("notary.ask.world_bundles", got.bundles.length);
          set("notary.ask.indexed", got.index.size);
          set("notary.ask.retrieved", got.records.length);
          set("notary.ask.record_ids", idList(got.records));
          set("notary.ask.scores", got.records.map((x) => x.score).join(","));
          return { retrieved: got.records.length };
        });
        const got = r as Retrieval | { error: string };
        if ("error" in got) note("notary.ask.retrieved", 0);
        else {
          note("notary.ask.world", got.world);
          note("notary.ask.indexed", got.index.size);
          note("notary.ask.retrieved", got.records.length);
        }

        if (blocked) return await skip(blocked);
        if ("error" in got) return await skip(got.error);
        if (got.records.length === 0) return await skip("no records matched the question");

        // 2. The model call. LlmClient opens "notary.llm" (CHAIN: role, model id, tokens, USD) and the
        //    provider wrapper emits the one LLM span under it; both nest under this root by context.
        let llm: LlmLike;
        try {
          llm = opts.llm ?? new LlmClient({ env });
        } catch (err) {
          return await skip(`model config invalid: ${err instanceof Error ? err.message : String(err)}`);
        }
        let text: string;
        note("notary.ask.model_called", true);
        try {
          const res = await llm.complete({
            role: "executor",
            agent: "chat",
            system: ASK_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildAskPrompt(req.question, got.records) }],
            maxTokens: 1024,
          });
          text = res.text;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return await skip(msg.startsWith("BLOCKED:") || isUsdCapExceeded(err) ? msg : `model call failed: ${msg}`);
        }

        // 3. Citation validation by code.
        let result: AskResponse = failed("validation did not run");
        await step("notary.ask.validate", "GUARDRAIL", {}, (set) => {
          const parsed = parseModelAnswer(text);
          set("notary.ask.parse_ok", parsed.ok);
          if (!parsed.ok) {
            result = failed(parsed.reason);
          } else {
            const check = validateCitations(parsed.citations, got.index);
            const bad = new Set(check.invalid);
            set("notary.ask.cited", idList(parsed.citations));
            set("notary.ask.cited_count", parsed.citations.length);
            set("notary.ask.passed", idList(parsed.citations.filter((c) => !bad.has(c))));
            set("notary.ask.failed", idList(check.invalid));
            set("notary.ask.failed_count", check.invalid.length);
            if (!check.ok) {
              result = failed(parsed.citations.length === 0 ? "the answer cites no record" : `${check.invalid.length} citation(s) do not resolve to a loaded record`);
            } else {
              // Fill in the trace id of a uniquely resolved record (deterministic, from the index).
              const citations = parsed.citations.map((c) => {
                if (c.traceId) return c;
                const hits = got.index.find(c.kind, c.id, c.runId);
                const t = hits.length === 1 ? hits[0]!.traceId : undefined;
                return t ? { ...c, traceId: t } : c;
              });
              result = { ok: true, answer: parsed.answer, citations };
            }
          }
          set("notary.ask.ok", result.ok);
          if (!result.ok) set("notary.ask.reason", result.reason.slice(0, 200));
          return { ok: result.ok };
        });
        const final = result as AskResponse;
        if (final.ok) note("notary.ask.citations", final.citations.length);
        return finish(final, final.ok);
      },
      (ids) => {
        traceId = ids.traceId;
      },
    ),
  );
  return traceId && out.traceId === undefined ? { ...out, traceId } : out;
}

/** The trace of a rate-limited ask: one short root span, no retrieval, no model call. */
async function traceRateLimited(req: AskRequest, rpm: number, retryAfterS: number, opts: AskOptions): Promise<void> {
  await tracedAsk(opts, () =>
    step(
      "notary.ask",
      "WORKFLOW",
      {
        ...rootAttrs(req),
        "notary.ask.rate_limited": true,
        "notary.ask.rpm": rpm,
        "notary.ask.retry_after_s": retryAfterS,
        "notary.ask.ok": false,
        "notary.ask.model_called": false,
        "notary.ask.reason": `rate limited (${ASK_RPM_ENV}=${rpm})`,
      },
      () => ({ rateLimited: true }),
    ),
  );
}

/**
 * Mount POST /api/ask (token + localhost), rate limited per session: this mount's session gets its
 * own sliding-window counter (ask-limit.ts). Over the limit -> 429 + Retry-After, no model call.
 */
export function mountAsk(app: Hono, opts: AskOptions & { session: ApiSession }): void {
  const limit = askRpm(opts.env ?? process.env, opts.rpm);
  if (limit.problem) console.warn(`notary serve: ${limit.problem}`);
  const limiter = new SlidingWindowLimiter({ limit: limit.rpm, ...(opts.now ? { now: opts.now } : {}) });
  app.post("/api/ask", requireLocalSession(opts.session), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const parsed = AskRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: `invalid ask request: ${parsed.error.issues[0]?.message ?? "invalid"}` }, 400);
    const gate = limiter.take();
    if (!gate.ok) {
      const retryAfterS = retryAfterSeconds(gate.retryAfterMs);
      await traceRateLimited(parsed.data, limit.rpm, retryAfterS, opts);
      c.header("Retry-After", String(retryAfterS));
      return c.json({ error: `rate limited: at most ${limit.rpm} questions per minute (${ASK_RPM_ENV})` }, 429);
    }
    return c.json(await answerQuestion(parsed.data, opts));
  });
}
