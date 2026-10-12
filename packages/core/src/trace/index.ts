/**
 * Notary tracing: a thin wrapper over the neatlogs TypeScript SDK.
 *
 * SDK API as verified against `neatlogs` 1.1.26 (README + dist/index.d.ts + dist/index.mjs):
 *
 *   init(options?: InitOptions): Promise<void>
 *     - API key: `options.apiKey`, falling back to env `NEATLOGS_API_KEY` (trimmed).
 *       With no key the SDK does NOT throw: it silently disables HTTP export.
 *     - Other env vars it reads: NEATLOGS_ENDPOINT (default https://ingest.neatlogs.com),
 *       NEATLOGS_DISABLE_EXPORT (true/1/yes), NEATLOGS_UPLOADS_ENABLED, NEATLOGS_AUTO_ROOT,
 *       NEATLOGS_LOG_LEVEL, NEATLOGS_LOG_SPANS / NEATLOGS_LOG_RAW_SPANS (local file dumps).
 *     - `workflowName` becomes the OTel service.name. `captureLogs: true` is REQUIRED for log().
 *     - `registerShutdownHandlers` defaults to true (flush+shutdown on beforeExit/SIGINT/SIGTERM).
 *     - A second init() with different options rejects with NeatlogsConfigurationError
 *       (CONFLICTING_INIT); call shutdown() first to re-init.
 *     - NOTE: `InitOptions.metadata` is documented as "attached to all spans", but in 1.1.26 it
 *       is only used for the init-identity check and never reaches spans. So Notary stamps
 *       `notary.runId` onto each span itself.
 *
 *   span(options: SpanOptions, fn) => wrappedFn
 *     - Higher-order wrapper (returns a function). `kind` is required. The README lists
 *       `metadata`/`tags` options, but the 1.1.26 implementation ignores them. Not used here.
 *
 *   trace<T>(options: TraceOptions, fn: (span: OTelSpan) => T | Promise<T>): Promise<T>
 *     - Inline span. THIS is the metadata API: custom key/values go in
 *       `options.attributes: Record<string, any>`, each written with OTel `span.setAttribute(k, v)`
 *       (unknown keys on `options` are also treated as attributes). You can add more at runtime
 *       via the callback's OTel span: `span.setAttribute("notary.verdict", "pass")`.
 *       `options.metadata` (nested object) is NOT a valid OTel attribute value and gets dropped.
 *     - On export, unrecognised keys such as `notary.*` pass through unchanged; only
 *       `telemetry.distro.*`, `code.*`, `exception.*` attribute keys are stripped.
 *     - `kind` defaults to "CHAIN" (also WORKFLOW, AGENT, TOOL, RETRIEVER, EMBEDDING, MCP_TOOL,
 *       GUARDRAIL, EVALUATOR, LLM, RERANKER, VECTOR_STORE; "HTTP" throws).
 *     - Errors: sets status ERROR + recordException, then rethrows. The span always ends.
 *     - The fn's return value is serialized into the `output.value` attribute automatically.
 *     - Ids: `span.spanContext().spanId` / `.traceId` (standard OTel).
 *
 *   log(msgTemplate: string, options?: Record<string, any>): void
 *     - `{key}` placeholders are filled from options; each key becomes a `log.<key>` attribute;
 *       the special key `level` sets severity. Emitted as an OTel LogRecord tied to the active
 *       span (to /v1/logs). No-op unless init({ captureLogs: true }).
 *
 *   flush(): Promise<boolean>            - flush pending spans/logs, SDK stays usable.
 *   shutdown(reason?, timeoutMs?): Promise<boolean> - flush + tear down; init() may be called again.
 *
 * Differences from docs/TDD.md: TDD names `init`, `span`, `trace`, `log` — all exist, but
 * per-span metadata goes through `trace({ attributes })`, not `span()`, and `log()` needs
 * `captureLogs: true`. Flushing is `flush()` / `shutdown()`.
 *
 * Local span sink (TDD "Integrations": "OTel spans are also written to runs/<runId>/spans.jsonl
 * as a fallback evidence source"): once `setSpanSink(path)` is set, EVERY withSpan appends one
 * JSONL record {name, kind?, traceId, spanId, parentSpanId?, startedAt, endedAt, attrs, status,
 * error?, exported?} (exported: true only when the SDK opened the span, see src/trace/links.ts;
 * kind only when the caller passed one) to that file when the span ends, whether or not neatlogs
 * is enabled. `withSpanSink(path, fn)` overrides the process-wide sink for the spans opened inside
 * `fn`'s async context only (a long-running `notary serve` uses it so concurrent requests never
 * write into each other's files, whatever another request does to the global sink). With the SDK on, the ids
 * are the real OTel ids; with it off, they are generated locally (32-hex trace id, 16-hex span id
 * from crypto.randomUUID) and nested spans inherit their parent's trace id. `attrs` carries the
 * initial attributes plus any set later through `onSpan`'s setter, with the same secret masking
 * as exported spans. Sink write failures never break the traced work.
 *
 * Entry points: each CLI command inits with its own `workflowName` (notarize, recon, queue-run,
 * noise-floor, doctor) and roots its work under `withWorkflow`. Bedrock calls are captured by the
 * SDK's `wrapBedrock` (via `traceBedrockClient`); the manual "notary.llm" span around each call is
 * a CHAIN that only adds role and USD, so each model call yields exactly one LLM span.
 *
 * Agent names (P2, src/schema/agents.ts): span names stay as they were for continuity (notary.llm,
 * notary.adversary, notary.chat.*, notary.queue.item), and every span an agent owns carries
 * `notary.agent` = its display name: notary.llm (the calling agent: Executor / Reflector / Adversary /
 * Notary Chat), notary.adversary (Adversary), notary.chat.message + notary.chat.tool (Notary Chat),
 * notary.queue.item (Executor) and notary.guard (Guard, one GUARDRAIL span per certificate-gate verdict).
 *
 * Secrets: no env var value is ever put into an attribute by this module. As a backstop, a
 * global `mask` scrubs the value of any secret-looking env var (…KEY, …TOKEN, …SECRET, …PASSWORD)
 * from every exported span and log, and attribute keys that look like credentials are dropped.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Neatlogs from "neatlogs";

export type TracingState = { enabled: boolean; reason?: string };
export type TraceAttrs = Record<string, string | number | boolean>;
export type SpanKind = Neatlogs.TraceOptions["kind"];

type Sdk = typeof Neatlogs;

let sdk: Sdk | null = null;
let runId: string | undefined;
let initPromise: Promise<TracingState> | null = null;

/** Attribute keys that look like credentials. Note: `notary.tokens` (LLM usage) is allowed. */
const SECRET_KEY_RE =
  /(api[-_.]?key|secret|passw(or)?d|authorization|credential|cookie|(access|auth|bearer|refresh|session|service)[-_.]?token)/i;
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
const REDACTED = "[REDACTED]";

function secretEnvValues(): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (SECRET_ENV_RE.test(name) && value && value.trim().length >= 8) out.push(value.trim());
  }
  return out;
}

function scrub(value: unknown, secrets: string[], depth = 0): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join(REDACTED);
    return s;
  }
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrub(value[i], secrets, depth + 1);
    return value;
  }
  const rec = value as Record<string, unknown>;
  for (const k of Object.keys(rec)) rec[k] = scrub(rec[k], secrets, depth + 1);
  return rec;
}

/** Global neatlogs mask: strips secret env values from everything that gets exported. */
function maskSecrets(data: Record<string, any>): Record<string, any> {
  const secrets = secretEnvValues();
  return secrets.length ? (scrub(data, secrets) as Record<string, any>) : data;
}

function safeAttrs(attrs: TraceAttrs | undefined): TraceAttrs {
  const out: TraceAttrs = {};
  if (!attrs) return out;
  const secrets = secretEnvValues();
  for (const [k, v] of Object.entries(attrs)) {
    if (SECRET_KEY_RE.test(k)) continue;
    out[k] = typeof v === "string" ? (scrub(v, secrets) as string) : v;
  }
  return out;
}

function truthy(v: string | undefined): boolean {
  return ["true", "1", "yes"].includes((v ?? "").trim().toLowerCase());
}

export function tracingEnabled(): boolean {
  return sdk !== null;
}

/** The run id stamped on spans (initTracing({ runId })), if any. */
export function tracingRunId(): string | undefined {
  return runId;
}

// What `notary serve`'s GET /api/health reports for neatlogs (src/api/health.ts): the last init
// outcome and the last flush verdict in this process. Never holds the key.
let lastInitState: TracingState | null = null;
let lastFlush: { ok: boolean; at: string } | null = null;

/** The last initTracing outcome (null: never initialized in this process) and the last flush verdict. */
export function tracingStatus(): { init: TracingState | null; lastFlush: { ok: boolean; at: string } | null } {
  return { init: lastInitState, lastFlush };
}

/**
 * Initialise neatlogs once per process. Never throws: if tracing can't start, every helper
 * below silently becomes a pass-through.
 */
export function initTracing(opts: { runId?: string; serviceName?: string } = {}): Promise<TracingState> {
  if (opts.runId) runId = opts.runId;
  if (initPromise) return initPromise;

  if (!(process.env.NEATLOGS_API_KEY ?? "").trim()) {
    lastInitState = { enabled: false, reason: "NEATLOGS_API_KEY not set" };
    return Promise.resolve(lastInitState);
  }
  if (truthy(process.env.NEATLOGS_DISABLE_EXPORT)) {
    lastInitState = { enabled: false, reason: "NEATLOGS_DISABLE_EXPORT is set" };
    return Promise.resolve(lastInitState);
  }

  const attempt = (async (): Promise<TracingState> => {
    try {
      const mod = (await import("neatlogs")) as Sdk;
      // apiKey is deliberately not passed: the SDK reads NEATLOGS_API_KEY itself.
      await mod.init({
        workflowName: opts.serviceName ?? "notary",
        captureLogs: true,
        mask: maskSecrets,
      });
      sdk = mod;
      lastInitState = { enabled: true };
      return lastInitState;
    } catch (err) {
      sdk = null;
      initPromise = null; // allow a retry
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      lastInitState = { enabled: false, reason: `neatlogs init failed (${scrub(msg, secretEnvValues())})` };
      return lastInitState;
    }
  })();
  initPromise = attempt;
  return attempt;
}

/** Ids of the span opened by withSpan, for linking beliefs/evidence to neatlogs. */
export type SpanIds = { spanId: string; traceId: string };

/** One line of runs/<runId>/spans.jsonl. */
export type SpanRecord = {
  name: string;
  /** neatlogs span kind, when the caller passed one (WORKFLOW, RETRIEVER, GUARDRAIL, CHAIN, LLM, ...). */
  kind?: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startedAt: string;
  endedAt: string;
  attrs: TraceAttrs;
  status: "ok" | "error";
  error?: string;
  /** true when the SDK opened this span (real OTel ids, sent to neatlogs); absent for local-only spans. */
  exported?: true;
};

let sinkPath: string | null = null;
/** Async-context sink override (withSpanSink); takes precedence over `sinkPath` when set. */
const sinkScope = new AsyncLocalStorage<{ path: string | null }>();
const localContext = new AsyncLocalStorage<SpanIds>();
/** Trace ids of spans the SDK opened in this process (used to gate neatlogs trace links). */
const exportedTraceIds = new Set<string>();

/** Trace ids this process sent to neatlogs (spans opened through the SDK). */
export function exportedTraceIdsInProcess(): ReadonlySet<string> {
  return exportedTraceIds;
}

/** Append every span to `path` as JSONL from now on; null turns the sink off. */
export function setSpanSink(path: string | null): void {
  sinkPath = path;
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // writing will fail later and be ignored
    }
  }
}

export function spanSinkPath(): string | null {
  return sinkPath;
}

/**
 * Run `fn` with its own span sink: every span opened inside `fn`'s async context (however deep) is
 * written to `path` (null: to no file), never to the process-wide sink, even if something else
 * swaps the global sink with setSpanSink meanwhile. Outside `fn` nothing changes.
 */
export function withSpanSink<T>(path: string | null, fn: () => Promise<T> | T): Promise<T> {
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // writing will fail later and be ignored
    }
  }
  return sinkScope.run({ path }, async () => await fn());
}

function hexId(chars: number): string {
  let out = "";
  while (out.length < chars) out += randomUUID().replace(/-/g, "");
  return out.slice(0, chars);
}

function writeSpanRecord(rec: SpanRecord, scoped: { path: string | null } | undefined): void {
  const path = scoped ? scoped.path : sinkPath;
  if (!path) return;
  try {
    const secrets = secretEnvValues();
    const clean = secrets.length ? (scrub(structuredClone(rec), secrets) as SpanRecord) : rec;
    appendFileSync(path, `${JSON.stringify(clean)}\n`, "utf8");
  } catch {
    // the sink must never break the traced work
  }
}

/**
 * Run `fn` inside a neatlogs span named `name` with `attrs` as span attributes
 * (e.g. `notary.probeId`, `notary.prediction`). `notary.runId` from initTracing is added
 * automatically. Errors are recorded on the span and rethrown unchanged. The return value is
 * captured as the span output by the SDK, so never return secrets from `fn`.
 *
 * `onSpan` (optional) receives the span/trace ids and a setter for attributes known only
 * after the work starts (e.g. `notary.verdict`).
 */
export async function withSpan<T>(
  name: string,
  attrs: TraceAttrs,
  fn: () => Promise<T> | T,
  opts: {
    kind?: SpanKind;
    onSpan?: (ids: SpanIds, set: (key: string, value: string | number | boolean) => void) => void;
  } = {},
): Promise<T> {
  const mod = sdk;
  const attributes = safeAttrs({ ...(runId ? { "notary.runId": runId } : {}), ...attrs });
  const parent = localContext.getStore();
  const scopedSink = sinkScope.getStore();
  const startedAt = new Date().toISOString();
  // Sink record state; ids are replaced by the real OTel ids when the SDK opens a span.
  const rec: SpanRecord = {
    name,
    ...(opts.kind ? { kind: opts.kind } : {}),
    traceId: parent?.traceId ?? hexId(32),
    spanId: hexId(16),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    startedAt,
    endedAt: startedAt,
    attrs: { ...attributes },
    status: "ok",
  };
  const finish = (err?: unknown): void => {
    rec.endedAt = new Date().toISOString();
    if (err !== undefined) {
      rec.status = "error";
      rec.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    writeSpanRecord(rec, scopedSink);
  };
  const recordAttr = (k: string, v: string | number | boolean): TraceAttrs => {
    const clean = safeAttrs({ [k]: v });
    if (k in clean) rec.attrs[k] = clean[k]!;
    return clean;
  };
  const runLocal = async (): Promise<T> => {
    if (opts.onSpan) {
      try {
        opts.onSpan({ spanId: rec.spanId, traceId: rec.traceId }, (k, v) => void recordAttr(k, v));
      } catch {
        // tracing must never break the traced work
      }
    }
    return await localContext.run({ spanId: rec.spanId, traceId: rec.traceId }, async () => await fn());
  };

  if (!mod) {
    try {
      const out = await runLocal();
      finish();
      return out;
    } catch (err) {
      finish(err);
      throw err;
    }
  }

  let started = false;
  let finished = false;
  let result: T | undefined;
  try {
    const out = await mod.trace<T>({ name, kind: opts.kind ?? "CHAIN", attributes }, async (span) => {
      started = true;
      try {
        const ctx = span.spanContext();
        if (ctx.traceId) rec.traceId = ctx.traceId;
        if (ctx.spanId) rec.spanId = ctx.spanId;
        if (ctx.traceId && ctx.spanId) {
          rec.exported = true;
          exportedTraceIds.add(ctx.traceId.toLowerCase());
        }
      } catch {
        // keep the local ids
      }
      if (opts.onSpan) {
        try {
          opts.onSpan({ spanId: rec.spanId, traceId: rec.traceId }, (k, v) => {
            const clean = recordAttr(k, v);
            if (k in clean) span.setAttribute(k, clean[k] as string | number | boolean);
          });
        } catch {
          // tracing must never break the traced work
        }
      }
      try {
        result = await localContext.run({ spanId: rec.spanId, traceId: rec.traceId }, async () => await fn());
      } catch (err) {
        finish(err);
        throw err;
      }
      finished = true;
      finish();
      return result;
    });
    return out;
  } catch (err) {
    if (finished) return result as T; // SDK hiccup after fn succeeded: keep fn's result
    if (started) throw err; // error came from fn (already recorded on the span and the sink)
    // the SDK itself failed before running fn: run untraced (still written to the sink)
    try {
      const out = await runLocal();
      finish();
      return out;
    } catch (e) {
      finish(e);
      throw e;
    }
  }
}

/**
 * Root one CLI entry point under a neatlogs WORKFLOW span named `name`, so every span the command
 * opens lands in one trace. Export-only: nothing is written to the local span sink (the root sits
 * outside any run's spans.jsonl). Pass-through when tracing is off; an SDK failure before `fn`
 * starts runs `fn` untraced, and errors from `fn` are rethrown unchanged.
 */
export async function withWorkflow<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const mod = sdk;
  if (!mod) return await fn();
  let started = false;
  let finished = false;
  let result: T | undefined;
  try {
    return await mod.trace<T>(
      { name, kind: "WORKFLOW", attributes: safeAttrs(runId ? { "notary.runId": runId } : {}) },
      async () => {
        started = true;
        result = await fn();
        finished = true;
        return result;
      },
    );
  } catch (err) {
    if (finished) return result as T;
    if (started) throw err;
    return await fn();
  }
}

/**
 * Wrap a BedrockRuntimeClient with the SDK's `wrapBedrock`, which emits one LLM span per
 * Converse/InvokeModel call (model, messages, completion, token usage). Returns the client
 * unchanged when tracing is off or wrapping fails. Exported spans pass through the secret mask.
 */
export function traceBedrockClient<T extends object>(client: T): T {
  if (!sdk) return client;
  try {
    return sdk.wrapBedrock(client);
  } catch {
    return client;
  }
}

/** Emit a neatlogs log record tied to the active span. No-op when tracing is off. */
export function traceLog(message: string, attrs?: TraceAttrs): void {
  if (!sdk) return;
  try {
    sdk.log(message, safeAttrs({ ...(runId ? { "notary.runId": runId } : {}), ...attrs }));
  } catch {
    // ignore
  }
}

/** neatlogs log severities (the SDK's special `level` key). */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Like traceLog, at an explicit severity (`level` is the SDK's special key; every other key is
 * recorded as a `log.<key>` attribute). The record is tied to the span active in the SDK's context
 * when called. Returns true when the SDK accepted it (false: tracing off or the SDK threw).
 */
export function traceLogAt(level: LogLevel, message: string, attrs?: TraceAttrs): boolean {
  if (!sdk) return false;
  try {
    sdk.log(message, { ...safeAttrs({ ...(runId ? { "notary.runId": runId } : {}), ...attrs }), level });
    return true;
  } catch {
    return false;
  }
}

/** Ids of the innermost span opened by withSpan in this async context (undefined outside any). */
export function currentSpanIds(): SpanIds | undefined {
  const s = localContext.getStore();
  return s ? { ...s } : undefined;
}

/** Version of the neatlogs SDK (its `__version__` export); undefined when it can't be loaded. */
export async function neatlogsSdkVersion(): Promise<string | undefined> {
  try {
    const loaded = sdk as (Sdk & { __version__?: unknown }) | null;
    if (loaded && typeof loaded.__version__ === "string") return loaded.__version__;
  } catch {
    // a module without the export (test doubles): fall through
  }
  // Not loaded: read the installed package.json next to the resolved entry (cheap; no SDK import).
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve("neatlogs")));
    for (let i = 0; i < 4; i++) {
      const pkg = join(dir, "package.json");
      if (existsSync(pkg)) {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown; version?: unknown };
        if (parsed.name === "neatlogs" && typeof parsed.version === "string") return parsed.version;
      }
      dir = dirname(dir);
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** Flush pending spans and logs. Never throws; no-op when tracing is off. */
export async function flushTracing(): Promise<void> {
  await flushTracingDetailed();
}

/** Like flushTracing, but returns the SDK's verdict (false = a pipeline failed to flush). */
export async function flushTracingDetailed(): Promise<boolean> {
  if (!sdk) return true;
  let ok: boolean;
  try {
    ok = await sdk.flush();
  } catch {
    ok = false;
  }
  lastFlush = { ok, at: new Date().toISOString() };
  return ok;
}

/** Flush and tear down the SDK (e.g. at the end of a CLI run). Safe to call when disabled. */
export async function shutdownTracing(): Promise<void> {
  const mod = sdk;
  sdk = null;
  initPromise = null;
  lastInitState = null;
  if (!mod) return;
  try {
    await mod.shutdown();
  } catch {
    // ignore
  }
}
