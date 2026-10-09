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
 * JSONL record {name, traceId, spanId, parentSpanId?, startedAt, endedAt, attrs, status, error?}
 * to that file when the span ends, whether or not neatlogs is enabled. With the SDK on, the ids
 * are the real OTel ids; with it off, they are generated locally (32-hex trace id, 16-hex span id
 * from crypto.randomUUID) and nested spans inherit their parent's trace id. `attrs` carries the
 * initial attributes plus any set later through `onSpan`'s setter, with the same secret masking
 * as exported spans. Sink write failures never break the traced work.
 *
 * Secrets: no env var value is ever put into an attribute by this module. As a backstop, a
 * global `mask` scrubs the value of any secret-looking env var (…KEY, …TOKEN, …SECRET, …PASSWORD)
 * from every exported span and log, and attribute keys that look like credentials are dropped.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
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

/**
 * Initialise neatlogs once per process. Never throws: if tracing can't start, every helper
 * below silently becomes a pass-through.
 */
export function initTracing(opts: { runId?: string; serviceName?: string } = {}): Promise<TracingState> {
  if (opts.runId) runId = opts.runId;
  if (initPromise) return initPromise;

  if (!(process.env.NEATLOGS_API_KEY ?? "").trim()) {
    return Promise.resolve({ enabled: false, reason: "NEATLOGS_API_KEY not set" });
  }
  if (truthy(process.env.NEATLOGS_DISABLE_EXPORT)) {
    return Promise.resolve({ enabled: false, reason: "NEATLOGS_DISABLE_EXPORT is set" });
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
      return { enabled: true };
    } catch (err) {
      sdk = null;
      initPromise = null; // allow a retry
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { enabled: false, reason: `neatlogs init failed (${scrub(msg, secretEnvValues())})` };
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
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startedAt: string;
  endedAt: string;
  attrs: TraceAttrs;
  status: "ok" | "error";
  error?: string;
};

let sinkPath: string | null = null;
const localContext = new AsyncLocalStorage<SpanIds>();

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

function hexId(chars: number): string {
  let out = "";
  while (out.length < chars) out += randomUUID().replace(/-/g, "");
  return out.slice(0, chars);
}

function writeSpanRecord(rec: SpanRecord): void {
  const path = sinkPath;
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
  const startedAt = new Date().toISOString();
  // Sink record state; ids are replaced by the real OTel ids when the SDK opens a span.
  const rec: SpanRecord = {
    name,
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
    writeSpanRecord(rec);
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

/** Emit a neatlogs log record tied to the active span. No-op when tracing is off. */
export function traceLog(message: string, attrs?: TraceAttrs): void {
  if (!sdk) return;
  try {
    sdk.log(message, safeAttrs({ ...(runId ? { "notary.runId": runId } : {}), ...attrs }));
  } catch {
    // ignore
  }
}

/** Flush pending spans and logs. Never throws; no-op when tracing is off. */
export async function flushTracing(): Promise<void> {
  await flushTracingDetailed();
}

/** Like flushTracing, but returns the SDK's verdict (false = a pipeline failed to flush). */
export async function flushTracingDetailed(): Promise<boolean> {
  if (!sdk) return true;
  try {
    return await sdk.flush();
  } catch {
    return false;
  }
}

/** Flush and tear down the SDK (e.g. at the end of a CLI run). Safe to call when disabled. */
export async function shutdownTracing(): Promise<void> {
  const mod = sdk;
  sdk = null;
  initPromise = null;
  if (!mod) return;
  try {
    await mod.shutdown();
  } catch {
    // ignore
  }
}
