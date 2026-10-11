/**
 * Cassette recorder over the global fetch (Node's fetch is undici).
 *
 * live   — calls the network, redacts the exchange, records it, optionally writes the cassette
 *          after every exchange (so a crash keeps what was recorded).
 * replay — serves exchanges from loaded cassettes; never touches the network or the environment.
 *          A request with no recorded match throws CassetteMissError.
 *
 * Matching: requestHash = sha256(canonical { method, url, body }) of the REDACTED request, so the
 * hash is reproducible without secrets. Identical requests (retries, list-after-write) are told
 * apart by `occurrence` (0, 1, 2…): the n-th identical request in a run gets the n-th recorded one.
 *
 * Callers receive the redacted response in both modes, so a live run and its replay see the same
 * bytes and make the same decisions. Redaction removes auth headers, cookies, the value of any
 * secret-looking env var, client secrets, and email/phone values (structure is kept).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CassetteMissError, ReadOnlyRequestError, RequestNotSentError, TestModeLockError, ToolNetworkError } from "./errors.js";
import { RateLimitScope, VirtualClock, rateLimitScope, setRateLimitScope } from "./ratelimit.js";

export type RecorderMode = "live" | "replay";

export interface Exchange {
  id: string;
  tool: string;
  /** Logical op name, e.g. "dodo.listRefunds". */
  op: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  /** 0 when no HTTP response arrived (see `error`). */
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  latencyMs: number;
  /** Credits charged (Crustdata); null when the tool doesn't charge credits or it is unknown. */
  credits: number | null;
  recordedAt: string;
  requestHash: string;
  occurrence: number;
  /** Set when the request failed without a response (timeout, reset). */
  error?: string;
}

export interface Cassette {
  name: string;
  tool: string;
  createdAt: string;
  exchanges: Exchange[];
  /** sha256 of the canonical JSON of `exchanges`. */
  contentHash: string;
  /**
   * Set on every cassette written while a FIXTURE transport is installed (`notary demo --fixture`):
   * simulated traffic, never a recorded live run. Replay refuses such cassettes (replay/pins.ts).
   */
  fixture?: true;
}

// ---------------------------------------------------------------------------------------------
// Transport override (demo hook)

/** A fetch-compatible function: what the recorder sends live requests through. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RecorderTransport {
  fetch: FetchLike;
  /** True for simulated traffic: cassettes saved meanwhile are stamped `fixture: true`. */
  fixture: boolean;
  /**
   * Rate-limit scope used while this transport is installed. Default: a fresh scope on a
   * VirtualClock when `fixture` is true (throttle waits are counted, never slept), otherwise the
   * process scope (real time).
   */
  rateLimits?: RateLimitScope;
}

let transportOverride: RecorderTransport | null = null;

/**
 * Process-wide transport override for live-mode recorders (used only by `notary demo --fixture`,
 * which installs an in-process fixture API). While a fixture transport is installed, every saved
 * cassette is stamped `fixture: true` and saving into the real cassette dir is refused. Returns
 * a function that restores the previous override.
 */
export function setRecorderTransport(t: RecorderTransport | null): () => void {
  const previous = transportOverride;
  transportOverride = t;
  const scope = t?.rateLimits ?? (t?.fixture ? new RateLimitScope({ clock: new VirtualClock() }) : null);
  const restoreScope = scope ? setRateLimitScope(scope) : null;
  return () => {
    restoreScope?.();
    transportOverride = previous;
  };
}

export function recorderTransport(): RecorderTransport | null {
  return transportOverride;
}

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  exchange: Exchange;
}

export interface RequestSpec {
  tool: string;
  op: string;
  method: string;
  url: string;
  /** Evaluated only in live mode, right before the network call (credentials are read lazily). */
  headers?: () => Record<string, string>;
  body?: unknown;
  /** Credits charged for this response (live only; replay uses the recorded value). */
  credits?: (res: { status: number; headers: Record<string, string> }) => number | null;
}

export type ExchangeListener = (exchange: Exchange, meta: { mode: RecorderMode }) => void;

export interface RecorderOptions {
  mode: RecorderMode;
  /** Replay: cassettes to serve from, in priority order. */
  cassettes?: Cassette[];
  /** Live: record into this cassette name (written after every exchange). Omit to keep in memory. */
  record?: { name: string; tool?: string };
  /** Directory for cassette files. Default: packages/core/fixtures/cassettes. */
  cassetteDir?: string;
  onExchange?: ExchangeListener;
  /** Environment used to find secret values to mask. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Live request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Live: cancels in-flight requests (combined with the timeout). Notary Chat's Stop. */
  signal?: AbortSignal;
  /**
   * Live: HTTP methods this recorder may send (e.g. ["GET"] for Notary Chat's Dodo reads). Any other
   * method is refused with ReadOnlyRequestError before credentials are read or any I/O happens.
   */
  allowedMethods?: readonly string[];
}


export const DEFAULT_CASSETTE_DIR = fileURLToPath(new URL("../../fixtures/cassettes/", import.meta.url));

// ---------------------------------------------------------------------------------------------
// Canonical JSON and hashing

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function computeContentHash(exchanges: Exchange[]): string {
  return sha256(canonicalJson(exchanges));
}

// ---------------------------------------------------------------------------------------------
// Redaction

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "api-key",
  "x-api-key",
  "cookie",
  "set-cookie",
]);
const SECRET_FIELD = /^(client_secret|secret|password|api_?key|access_token|refresh_token|token)$/i;
const EMAIL_FIELD = /email/i;
const PHONE_FIELD = /phone/i;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface SecretValue {
  name: string;
  value: string;
}

/** Values of env vars whose name looks secret (*KEY*, *TOKEN*, *SECRET*, *PASSWORD*), length ≥ 8. */
export function collectSecrets(env: NodeJS.ProcessEnv = process.env): SecretValue[] {
  const out: SecretValue[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (value && value.length >= 8 && SECRET_ENV_NAME.test(name)) out.push({ name, value });
  }
  // Longest first so a secret that contains another is masked whole.
  return out.sort((a, b) => b.value.length - a.value.length);
}

export class Redactor {
  constructor(private readonly secrets: SecretValue[]) {}

  string(s: string): string {
    let out = s;
    for (const { name, value } of this.secrets) {
      if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
    }
    return out.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  }

  headers(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      const key = k.toLowerCase();
      out[key] = SENSITIVE_HEADERS.has(key) ? "[REDACTED]" : this.string(v);
    }
    return out;
  }

  url(raw: string): string {
    let u: URL;
    try {
      u = new URL(this.string(raw));
    } catch {
      return this.string(raw);
    }
    const params = [...u.searchParams.entries()].map(([k, v]): [string, string] => {
      if (EMAIL_FIELD.test(k)) return [k, "[REDACTED_EMAIL]"];
      if (PHONE_FIELD.test(k)) return [k, "[REDACTED_PHONE]"];
      if (SECRET_FIELD.test(k)) return [k, "[REDACTED]"];
      return [k, v];
    });
    params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = new URLSearchParams(params).toString();
    // URLSearchParams percent-encodes the brackets; keep the markers readable.
    return u.toString().replace(/%5BREDACTED(_[A-Z]+|%3A[A-Za-z0-9_]+)?%5D/g, (m) => decodeURIComponent(m));
  }

  body(value: unknown, key?: string): unknown {
    if (typeof value === "string") {
      if (key !== undefined) {
        if (SECRET_FIELD.test(key)) return "[REDACTED]";
        if (EMAIL_FIELD.test(key)) return "[REDACTED_EMAIL]";
        if (PHONE_FIELD.test(key)) return "[REDACTED_PHONE]";
      }
      return this.string(value);
    }
    if (Array.isArray(value)) return value.map((v) => this.body(v, key));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.body(v, k);
      return out;
    }
    return value;
  }
}

// ---------------------------------------------------------------------------------------------
// Cassette files

const CASSETTE_NAME = /^[A-Za-z0-9._-]+$/;

function cassettePath(nameOrPath: string, dir: string): string {
  if (nameOrPath.endsWith(".json") && (isAbsolute(nameOrPath) || nameOrPath.includes("/") || nameOrPath.includes("\\"))) {
    return resolve(nameOrPath);
  }
  const name = nameOrPath.replace(/\.json$/, "");
  if (!CASSETTE_NAME.test(name)) throw new Error(`Invalid cassette name: ${nameOrPath}`);
  return join(dir, `${name}.json`);
}

/** Load a cassette by name (from the cassette dir) or by path; verifies its content hash. */
export function loadCassette(nameOrPath: string, opts: { dir?: string; verify?: boolean } = {}): Cassette {
  const file = cassettePath(nameOrPath, opts.dir ?? DEFAULT_CASSETTE_DIR);
  const cassette = JSON.parse(readFileSync(file, "utf8")) as Cassette;
  if (!Array.isArray(cassette.exchanges)) throw new Error(`Not a cassette: ${file}`);
  if (opts.verify !== false) {
    const actual = computeContentHash(cassette.exchanges);
    if (actual !== cassette.contentHash) {
      throw new Error(`Cassette ${cassette.name} content hash mismatch (file ${cassette.contentHash.slice(0, 12)}, computed ${actual.slice(0, 12)})`);
    }
  }
  return cassette;
}

/** Cassette names available in the cassette dir. */
export function listCassettes(dir: string = DEFAULT_CASSETTE_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function saveCassette(cassette: Cassette, dir: string = DEFAULT_CASSETTE_DIR): string {
  const file = cassettePath(cassette.name, dir);
  if (transportOverride?.fixture) {
    // Simulated traffic never lands next to recorded live cassettes, and is always marked.
    if (resolve(dir) === resolve(DEFAULT_CASSETTE_DIR)) {
      throw new Error(`refusing to save fixture cassette ${cassette.name} into ${DEFAULT_CASSETTE_DIR} (fixture transport installed)`);
    }
    cassette = { ...cassette, fixture: true };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
  return file;
}

// ---------------------------------------------------------------------------------------------
// Dodo test-mode lock at the network chokepoint (P9)

/** The only Dodo host a live request may reach (docs: test-mode-vs-live-mode). */
export const DODO_TEST_HOST = "test.dodopayments.com";

/**
 * Throws TestModeLockError for a request to any dodopayments.com host other than the test host
 * over https. DodoClient already refuses a non-test base URL; this backstop covers any other code
 * path that reaches the recorder (it is the only place a live request is sent).
 */
export function assertDodoTestHost(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return; // not a URL fetch could send either
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "dodopayments.com" && !host.endsWith(".dodopayments.com")) return;
  if (host !== DODO_TEST_HOST || u.protocol !== "https:") {
    throw new TestModeLockError(`live request to ${u.protocol}//${host} refused; only https://${DODO_TEST_HOST} is allowed`);
  }
}

// ---------------------------------------------------------------------------------------------
// Recorder

export class Recorder {
  readonly mode: RecorderMode;
  private readonly recorded: Exchange[] = [];
  private readonly occurrences = new Map<string, number>();
  private readonly replayIndex = new Map<string, Exchange[]>();
  private readonly listeners: ExchangeListener[] = [];
  private readonly redactor: Redactor;
  private readonly createdAt = new Date().toISOString();

  constructor(private readonly opts: RecorderOptions) {
    this.mode = opts.mode;
    // Replay needs no environment at all; live masks whatever secrets the environment holds.
    this.redactor = new Redactor(opts.mode === "live" ? collectSecrets(opts.env ?? process.env) : []);
    if (opts.onExchange) this.listeners.push(opts.onExchange);
    if (opts.mode === "replay") {
      for (const cassette of opts.cassettes ?? []) this.addCassette(cassette);
    }
    if (opts.record && !CASSETTE_NAME.test(opts.record.name)) {
      throw new Error(`Invalid cassette name: ${opts.record.name}`);
    }
  }

  /** Replay: add another cassette. Its exchanges queue after any already loaded for the same hash. */
  addCassette(cassette: Cassette): void {
    const sorted = [...cassette.exchanges].sort((a, b) => a.occurrence - b.occurrence);
    for (const ex of sorted) {
      const list = this.replayIndex.get(ex.requestHash) ?? [];
      list.push(ex);
      this.replayIndex.set(ex.requestHash, list);
    }
  }

  onExchange(listener: ExchangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Exchanges seen this session (recorded live, or served in replay). */
  exchanges(): Exchange[] {
    return [...this.recorded];
  }

  hashRequest(method: string, url: string, body: unknown): string {
    return sha256(
      canonicalJson({
        method: method.toUpperCase(),
        url: this.redactor.url(url),
        body: body === undefined ? null : this.redactor.body(body),
      }),
    );
  }

  async request(spec: RequestSpec): Promise<RecordedResponse> {
    const method = spec.method.toUpperCase();
    const requestHash = this.hashRequest(method, spec.url, spec.body);
    const occurrence = this.occurrences.get(requestHash) ?? 0;
    const id = `${spec.op}#${requestHash.slice(0, 12)}#${occurrence}`;

    let exchange: Exchange;
    if (this.mode === "replay") {
      const hit = this.replayIndex.get(requestHash)?.[occurrence];
      if (!hit) throw new CassetteMissError(spec.op, method, this.redactor.url(spec.url), requestHash, occurrence);
      this.occurrences.set(requestHash, occurrence + 1);
      exchange = hit;
    } else {
      // P9 (AUDIT-06): the network chokepoint enforces the Dodo test-mode lock too, whatever built the request.
      assertDodoTestHost(spec.url);
      // Read-only recorders (Notary Chat) refuse any other method here, before credentials or I/O.
      const allowed = this.opts.allowedMethods;
      if (allowed && !allowed.map((m) => m.toUpperCase()).includes(method)) throw new ReadOnlyRequestError(spec.op, method, allowed);
      if (this.opts.signal?.aborted) throw new RequestNotSentError(spec.op, "aborted before sending");
      // Credentials are resolved here, before any I/O: a missing key throws without a request.
      const headers = spec.headers?.() ?? {};
      this.occurrences.set(requestHash, occurrence + 1);
      // Throttle (Crustdata: 15/min) through the PROCESS-WIDE scope, shared by every live Recorder
      // (recon, probes, queue). Replay never gets here, so it never waits.
      await rateLimitScope().limiter(spec.tool)?.acquire();
      if (this.opts.signal?.aborted) throw new RequestNotSentError(spec.op, "aborted before sending");
      exchange = await this.live(spec, method, headers, id, requestHash, occurrence);
    }

    this.recorded.push(exchange);
    if (this.mode === "live" && this.opts.record) this.save();
    for (const listener of this.listeners) listener(exchange, { mode: this.mode });

    if (exchange.error !== undefined) throw new ToolNetworkError(exchange.op, exchange.id, exchange.error);
    return { status: exchange.status, headers: exchange.responseHeaders, body: exchange.responseBody, exchange };
  }

  private async live(
    spec: RequestSpec,
    method: string,
    headers: Record<string, string>,
    id: string,
    requestHash: string,
    occurrence: number,
  ): Promise<Exchange> {
    const r = this.redactor;
    const sendHeaders: Record<string, string> = { accept: "application/json", ...headers };
    let payload: string | undefined;
    if (spec.body !== undefined) {
      payload = JSON.stringify(spec.body);
      sendHeaders["content-type"] = "application/json";
    }
    const base = {
      id,
      tool: spec.tool,
      op: spec.op,
      method,
      url: r.url(spec.url),
      requestHeaders: r.headers(sendHeaders),
      requestBody: spec.body === undefined ? null : r.body(spec.body),
      recordedAt: new Date().toISOString(),
      requestHash,
      occurrence,
    };

    const started = performance.now();
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: sendHeaders,
        signal: this.opts.signal
          ? AbortSignal.any([this.opts.signal, AbortSignal.timeout(this.opts.timeoutMs ?? 30_000)])
          : AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      };
      if (payload !== undefined) init.body = payload;
      res = await (transportOverride?.fetch ?? globalThis.fetch)(spec.url, init);
    } catch (err) {
      return {
        ...base,
        status: 0,
        responseHeaders: {},
        responseBody: null,
        latencyMs: Math.round(performance.now() - started),
        credits: null,
        error: r.string(err instanceof Error ? err.message : String(err)),
      };
    }
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - started);
    const rawHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      rawHeaders[k.toLowerCase()] = v;
    });
    let body: unknown = text;
    if (text.length === 0) body = null;
    else {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return {
      ...base,
      status: res.status,
      responseHeaders: r.headers(rawHeaders),
      responseBody: r.body(body),
      latencyMs,
      credits: spec.credits ? spec.credits({ status: res.status, headers: rawHeaders }) : null,
    };
  }

  /**
   * The server rate-limited `tool` (429) and asked for `ms` of back-off: live mode holds every
   * caller of the tool in this process until it passes; replay ignores it (nothing waits).
   */
  rateLimitBackOff(tool: string, ms: number): void {
    if (this.mode !== "live") return;
    rateLimitScope().limiter(tool)?.backOff(ms);
  }

  /** The cassette for everything recorded so far. */
  toCassette(name?: string, tool?: string): Cassette {
    const exchanges = this.exchanges();
    const tools = [...new Set(exchanges.map((e) => e.tool))].sort();
    return {
      name: name ?? this.opts.record?.name ?? "session",
      tool: tool ?? this.opts.record?.tool ?? (tools.join("+") || "none"),
      createdAt: this.createdAt,
      exchanges,
      contentHash: computeContentHash(exchanges),
    };
  }

  /** Write the recorded cassette (live). Returns the file path. */
  save(name?: string): string {
    if (this.mode !== "live") throw new Error("Recorder.save is only valid in live mode");
    return saveCassette(this.toCassette(name), this.opts.cassetteDir ?? DEFAULT_CASSETTE_DIR);
  }
}
