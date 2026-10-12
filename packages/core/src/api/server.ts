// Local API for the dashboard's live mode (TDD "Integrations and interfaces" -> Local API).
//
//   GET /api/bundles      index entries merged from every bundle directory (deduped by runId)
//   GET /api/bundles/:id  one bundle, re-verified with verifyBundle on every read
//   GET /api/bundles/:id/timeline  the run's TimelineFile (runs/<id>/timeline.jsonl, else the
//                         published <id>.timeline.json next to the bundle); 404 when absent
//   GET /api/stream       SSE of bus events (decision, probe.committed, probe.verdict,
//                         belief.changed, run.finished, timeline) with Last-Event-ID replay
//
//   GET /api/health       per-integration status (src/api/health.ts; network checks cached ~60 s)
//   GET /api/runs         finished real runs + runs this server started still running (src/api/runs.ts)
//   GET /api/runs/:id     the verified bundle, or 202 {state:"running"}
//   GET /api/runs/:id/events  SSE of the run's TimelineEvents (file replay, then live), `event: end`
//   GET /api/certificates[/:id]  certificates from the real runs this server sees (src/api/certificates.ts)
//
//   POST /api/runs        start a real queue run / notarize in this process (src/api/runs.ts)
//   POST /api/ask         Ask Notary (src/api/ask.ts): cited answers from the loaded records
//                         (NOTARY_ASK_RPM per session, 429 + Retry-After; spans in runs/_ask/spans.jsonl)
//   GET|POST /api/approvals, POST /api/approvals/:id/approve|reject  approval desk (src/api/approvals.ts)
//   GET /api/cfo/status, POST /api/cfo/sync  the cfo.ai MCP connection (src/api/cfo.ts; local only)
//   POST|GET /api/chat, GET|DELETE /api/chat/:id, POST /api/chat/:id/messages (SSE)  Notary Chat
//                         (src/api/chat.ts; read-only tool agent, NOTARY_ASK_RPM per session, spans in
//                         runs/_chat/spans.jsonl, conversations in runs/chat.sqlite)
//
// POST /api/runs, ask, chat, approvals and cfo need the per-session token (Authorization: Bearer) AND a loopback
// socket, Host and Origin (src/api/session.ts). Everything else is read-only and unauthenticated as
// before. CORS is limited to loopback dashboard dev origins. No handler returns canned data: every
// response is read from run files, the environment, or a real integration check.
// /api/runs, /api/certificates and /api/approvals never include sample/fixture bundles.
// Only each bundle directory's own index.json is read; subdirectories of public/bundles are NOT
// scanned, so the fixture-demo bundles in public/bundles/fixture/ (own index) are never merged
// into the list. Under runs/, every immediate subdirectory is a bundle dir (runs/<runId>/).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { verifyBundle } from "../bundle/hash.js";
import { BundleIndexSchema } from "../schema/bundle.js";
import type { BundleIndexEntry } from "../schema/index.js";
import { bus as defaultBus, DEFAULT_EVENT_JOURNAL, tailEventJournal } from "./bus.js";
import type { EventBus, NotaryEvent } from "./bus.js";
import { servedTimeline } from "../timeline/serve.js";
import { listApprovals, mountApprovals } from "./approvals.js";
import { loadVerifiedBundles } from "./bundle-source.js";
import { mountCertificates, realCertificates } from "./certificates.js";
import { CHAT_SPANS_DIR, mountChat } from "./chat.js";
import type { ChatOptions } from "./chat.js";
import type { GuardCoverageSummary } from "../chat/tools.js";
import { createHealth } from "./health.js";
import type { HealthOptions } from "./health.js";
import { mountRuns } from "./runs.js";
import type { RunTracker, RunsOptions } from "./runs.js";
import type { ApprovalsOptions } from "./approvals.js";
import { mountCfo } from "./cfo.js";
import type { CfoApiOptions } from "./cfo.js";
import { ASK_SPANS_DIR, mountAsk } from "./ask.js";
import type { AskOptions } from "./ask.js";
import { createSession, isLoopbackHost } from "./session.js";
import type { ApiSession, CreatedSession } from "./session.js";

export const DEFAULT_WEB_BUNDLES_DIR = fileURLToPath(new URL("../../../web/public/bundles/", import.meta.url));
export const DEFAULT_RUNS_DIR = fileURLToPath(new URL("../../runs/", import.meta.url));
export const DEFAULT_KEEP_ALIVE_MS = 15_000;
export const HASH_MISMATCH_HEADER = "X-Notary-Hash-Mismatch";

/** Same rule writeBundle uses for file names: no separators, no leading dot. */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Dashboard dev servers on loopback only (Vite, preview, any port). */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

export interface ApiOptions {
  /** Directories holding an index.json plus <runId>.json files. Earlier directories win on duplicate runIds. */
  bundleDirs?: string[];
  /** Each immediate subdirectory (runs/<runId>/) is also treated as a bundle directory. null disables. */
  runsDir?: string | null;
  bus?: EventBus;
  keepAliveMs?: number;
  /**
   * Per-session token check for POST /api/ask and GET/POST /api/approvals (src/api/session.ts).
   * Absent: a fresh random session nobody knows the token of, so those endpoints answer 401.
   */
  session?: ApiSession;
  /** POST /api/ask options (test seams: model double, env). */
  ask?: Omit<AskOptions, "bundleDirs">;
  /** /api/chat options (test seams: model double, env, fetch, store, tools). */
  chat?: Omit<ChatOptions, "session" | "runsDir" | "bundleDirs">;
  /** GET/POST /api/approvals options (test seams: env, tools, store, manifest). */
  approvals?: Omit<ApprovalsOptions, "runsDir" | "bus">;
  /** GET /api/cfo/status, POST /api/cfo/sync options (test seams: cfo state paths, MCP URL, fetch, economics paths). */
  cfo?: CfoApiOptions;
  /** GET /api/health options (test seams: env, probes, clock). */
  health?: HealthOptions;
  /** POST/GET /api/runs options (test seams: env, runners, precheck). */
  runs?: Pick<RunsOptions, "env" | "now" | "runQueue" | "notarize" | "precheck">;
  /** Receives this app's run tracker (tests). */
  onRunTracker?: (tracker: RunTracker) => void;
  /**
   * Hosted, read-only deployment (src/api/hosted.ts): ask and chat use `guard` (a bearer token from
   * AWS Secrets Manager) instead of localhost + session token; approvals and starting runs are not
   * mounted at all (404 / 405); CORS allows `allowedOrigins` instead of loopback dev origins.
   */
  hosted?: { guard: MiddlewareHandler; allowedOrigins: readonly string[] };
  /** Guard coverage for Notary Chat (default: src/guards/coverage.ts, tsc walk, cached GUARD_COVERAGE_TTL_MS). */
  guardCoverage?: () => Promise<GuardCoverageSummary>;
}

/** How long a computed guard coverage report is reused by chat (the walk takes seconds). */
export const GUARD_COVERAGE_TTL_MS = 10 * 60_000;

/** A coverage walk that runs longer than this is killed (the tool then says it could not check). */
export const GUARD_COVERAGE_TIMEOUT_MS = 240_000;

/** Run src/agents/coverage-child.ts in a child process (same runtime flags, so tsx works) and parse its one JSON line. */
export function guardCoverageInChild(timeoutMs = GUARD_COVERAGE_TIMEOUT_MS): Promise<GuardCoverageSummary> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL("../agents/coverage-child.ts", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      rej(new Error(`the coverage walk took longer than ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString("utf8")).slice(-2000)));
    child.on("error", (e) => (clearTimeout(timer), rej(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).at(-1) ?? "";
      try {
        if (code !== 0) throw new Error(`exit ${code}: ${err.trim().split(/\r?\n/).at(-1) ?? ""}`);
        res(JSON.parse(line) as GuardCoverageSummary);
      } catch (e) {
        rej(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

/** Default guard coverage source: the same tsc walk as `notary guards coverage`, in a child process, computed lazily and cached. */
export function cachedGuardCoverage(ttlMs = GUARD_COVERAGE_TTL_MS, now: () => number = Date.now): () => Promise<GuardCoverageSummary> {
  let cached: { at: number; value: Promise<GuardCoverageSummary> } | null = null;
  return () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const value = guardCoverageInChild();
    cached = { at: now(), value };
    value.catch(() => (cached = null));
    return value;
  };
}

interface IndexedEntry {
  entry: BundleIndexEntry;
  dir: string;
}

function bundleDirectories(opts: ApiOptions): string[] {
  const dirs = [...(opts.bundleDirs ?? [DEFAULT_WEB_BUNDLES_DIR])];
  const runsDir = opts.runsDir === undefined ? DEFAULT_RUNS_DIR : opts.runsDir;
  if (runsDir !== null && existsSync(runsDir)) {
    for (const name of readdirSync(runsDir).sort()) {
      const sub = join(runsDir, name);
      try {
        if (statSync(sub).isDirectory()) dirs.push(sub);
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return dirs;
}

/** Merge every directory's index.json; invalid or missing indexes are skipped. First directory wins per runId. */
async function loadIndex(opts: ApiOptions): Promise<Map<string, IndexedEntry>> {
  const byId = new Map<string, IndexedEntry>();
  for (const dir of bundleDirectories(opts)) {
    const indexPath = join(dir, "index.json");
    if (!existsSync(indexPath)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(indexPath, "utf8"));
    } catch {
      continue;
    }
    const parsed = BundleIndexSchema.safeParse(raw);
    if (!parsed.success) continue;
    for (const entry of parsed.data) {
      if (!SAFE_RUN_ID.test(entry.runId) || byId.has(entry.runId)) continue;
      byId.set(entry.runId, { entry, dir });
    }
  }
  return byId;
}

function sortEntries(entries: BundleIndexEntry[]): BundleIndexEntry[] {
  return entries.sort(
    (x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt) || (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0),
  );
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(resolve(dir), resolve(file));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function parseLastEventId(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,15}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

export function createApp(opts: ApiOptions = {}): Hono {
  const bus = opts.bus ?? defaultBus;
  const keepAliveMs = opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const app = new Hono();

  // DNS-rebinding defence for the LOCAL server: every route (reads, /api/health, static files)
  // requires a loopback Host header. A missing header (in-process requests) falls back to the URL's
  // host. The hosted deployment sits behind a load balancer with its own host name and is exempt.
  if (!opts.hosted) {
    app.use("*", async (c, next) => {
      const host = c.req.header("Host") ?? new URL(c.req.url).host;
      if (!isLoopbackHost(host)) return c.json({ error: "forbidden: Host must be localhost, 127.0.0.1 or [::1]" }, 403);
      await next();
    });
  }

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (opts.hosted ? (opts.hosted.allowedOrigins.includes(origin) ? origin : null) : LOOPBACK_ORIGIN.test(origin) ? origin : null),
      // POST + Authorization + Content-Type for the token-protected ask/approvals endpoints; loopback origins only.
      allowMethods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Last-Event-ID", "Cache-Control", "Authorization", "Content-Type"],
      // Retry-After: the ask endpoint's 429 (rate limit) tells the dashboard when to try again.
      exposeHeaders: [HASH_MISMATCH_HEADER, "Retry-After"],
    }),
  );

  app.get("/api/bundles", async (c) => {
    const index = await loadIndex(opts);
    return c.json(sortEntries([...index.values()].map((v) => v.entry)));
  });

  /** One indexed bundle, re-verified on every read (GET /api/bundles/:id and GET /api/runs/:id). */
  const bundleResponse = async (c: Context, found: IndexedEntry, id: string): Promise<Response> => {
    const file = join(found.dir, `${id}.json`);
    if (!isInside(found.dir, file)) return c.json({ error: "invalid bundle id" }, 400);
    if (!existsSync(file)) return c.json({ error: `bundle ${id} is indexed but its file is missing` }, 404);

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      return c.json({ error: `bundle ${id} is not valid JSON: ${(err as Error).message}` }, 500);
    }
    const checked = verifyBundle(raw);
    if (checked.ok) return c.json(checked.bundle);
    if (checked.reason === "hash") {
      // TDD: a tampered bundle must fail visibly. Serve it so the dashboard can show it next to the error.
      c.header(HASH_MISMATCH_HEADER, "1");
      return c.json({ ...checked.bundle, error: checked.error });
    }
    return c.json({ error: checked.error }, 500);
  };

  app.get("/api/bundles/:id", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_RUN_ID.test(id)) return c.json({ error: "invalid bundle id" }, 400);
    const found = (await loadIndex(opts)).get(id);
    if (!found) return c.json({ error: `unknown bundle ${id}` }, 404);
    return await bundleResponse(c, found, id);
  });

  app.get("/api/bundles/:id/timeline", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_RUN_ID.test(id)) return c.json({ error: "invalid bundle id" }, 400);
    const found = (await loadIndex(opts)).get(id);
    if (!found) return c.json({ error: `unknown bundle ${id}` }, 404);
    const served = servedTimeline({ id, entry: found.entry, dir: found.dir, runsDir: opts.runsDir === undefined ? DEFAULT_RUNS_DIR : opts.runsDir });
    return served.ok ? c.json(served.file) : c.json({ error: served.error }, served.status);
  });

  app.get("/api/stream", (c) => {
    // EventSource sends Last-Event-ID on reconnect; a first connection can pass ?lastEventId=0 to
    // replay everything still buffered. Without either, only new events are sent.
    const afterId = parseLastEventId(c.req.header("Last-Event-ID") ?? c.req.query("lastEventId"));
    return streamSSE(c, async (stream) => {
      const pending: NotaryEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = bus.subscribe((event) => {
        pending.push(event);
        wake?.();
      });
      const stop = (): void => {
        unsubscribe();
        wake?.();
      };
      stream.onAbort(stop);
      c.req.raw.signal.addEventListener("abort", () => stream.abort(), { once: true });

      try {
        // Subscribe first, then replay, then dedupe by id: no gap and no duplicate at the seam.
        let lastSent = afterId ?? bus.lastId;
        const replay = afterId === undefined ? [] : bus.since(afterId);
        await stream.write(`retry: 3000\n: connected\n\n`);
        if (afterId !== undefined && replay.length > 0 && replay[0]!.id > afterId + 1) {
          await stream.write(`: replay truncated; events ${afterId + 1}-${replay[0]!.id - 1} left the buffer\n\n`);
        }
        const send = async (event: NotaryEvent): Promise<void> => {
          if (event.id <= lastSent) return;
          await stream.writeSSE({ event: event.type, id: String(event.id), data: JSON.stringify({ at: event.at, payload: event.payload }) });
          lastSent = event.id;
        };
        for (const event of replay) await send(event);

        while (!stream.aborted && !stream.closed) {
          while (pending.length > 0 && !stream.aborted) await send(pending.shift()!);
          if (stream.aborted) break;
          let timer: NodeJS.Timeout | undefined;
          const timedOut = await new Promise<boolean>((res) => {
            wake = () => res(false);
            timer = setTimeout(() => res(true), keepAliveMs);
          });
          wake = null;
          clearTimeout(timer);
          if (timedOut && pending.length === 0 && !stream.aborted) await stream.write(": keep-alive\n\n");
        }
      } finally {
        unsubscribe();
      }
    });
  });

  const session = opts.session ?? createSession();
  const runsDir = opts.runsDir === undefined ? DEFAULT_RUNS_DIR : opts.runsDir;
  const verifiedBundles = () => loadVerifiedBundles(bundleDirectories(opts));

  const health = createHealth(opts.health ?? {});
  app.get("/api/health", async (c) => c.json(await health.check()));

  mountCertificates(app, { verifiedBundles });

  // Hosted: read-only. Starting runs and the approvals desk are refused before any other handler.
  if (opts.hosted) {
    app.post("/api/runs", (c) => c.json({ error: "the hosted Notary site is read-only: runs are started from the CLI or the agents task" }, 405));
    app.all("/api/approvals", (c) => c.json({ error: "approvals are not available on the hosted read-only site; use a local notary serve" }, 404));
    app.all("/api/approvals/*", (c) => c.json({ error: "approvals are not available on the hosted read-only site; use a local notary serve" }, 404));
    app.all("/api/cfo/*", (c) => c.json({ error: "the cfo.ai connection is not available on the hosted read-only site; use a local notary serve" }, 404));
  }

  // Runs (POST is token + localhost); reads are open like the bundle endpoints.
  const { tracker } = mountRuns(app, {
    ...opts.runs,
    runsDir,
    bus,
    session,
    keepAliveMs,
    loadIndex: () => loadIndex(opts),
    verifiedBundles,
    bundleResponse,
  });
  opts.onRunTracker?.(tracker);

  // The other non-read endpoints: token + localhost (src/api/session.ts). Ask is read-only by construction.
  mountAsk(app, {
    runsDir,
    // Ask spans get their own local sink (runs/_ask/spans.jsonl), scoped to each ask's async context,
    // so they never land in an approval's runs/<runId>/spans.jsonl (approvals swap the global sink).
    spansPath: runsDir === null ? null : join(runsDir, ASK_SPANS_DIR, "spans.jsonl"),
    ...opts.ask,
    ...(opts.hosted ? { guard: opts.hosted.guard } : {}),
    session,
    bundleDirs: () => bundleDirectories(opts),
  });
  // Notary Chat (token + localhost). Its certificate, approvals and health readers are injected here so
  // the chat module itself never imports approval/queue/certify code (test/chat-safety.test.ts).
  const approvalsRead = { ...opts.approvals, runsDir, bus };
  mountChat(app, {
    runsDir,
    spansPath: runsDir === null ? null : join(runsDir, CHAT_SPANS_DIR, "spans.jsonl"),
    certificates: () => realCertificates({ verifiedBundles }),
    // Hosted: the approvals desk is not exposed, not even read-only through chat.
    ...(opts.hosted ? {} : { approvals: () => listApprovals(approvalsRead) }),
    health: () => health.check(),
    guardCoverage: opts.guardCoverage ?? cachedGuardCoverage(),
    ...opts.chat,
    ...(opts.hosted ? { guard: opts.hosted.guard } : {}),
    session,
    bundleDirs: () => bundleDirectories(opts),
  });
  if (!opts.hosted) {
    mountApprovals(app, {
      ...opts.approvals,
      session,
      runsDir: opts.runsDir === undefined ? DEFAULT_RUNS_DIR : opts.runsDir,
      bus,
    });
    // cfo.ai over MCP: local only (token + localhost), never on the hosted API.
    mountCfo(app, { ...opts.cfo, session });
  }

  // Everything else is read-only: any other write is refused explicitly.
  app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/*", (c) => c.json({ error: "the Notary API is read-only" }, 405));

  return app;
}

export interface StartedServer {
  url: string;
  close: () => Promise<void>;
  /** This server's session (its token is shown once at startup by `notary serve`, never stored). */
  session: CreatedSession;
}

/** Bind the API with @hono/node-server. Loopback by default. */
export async function startServer(
  opts: Omit<ApiOptions, "session"> & { port?: number; host?: string; eventJournal?: string | null; session?: CreatedSession; prewarmGuardCoverage?: boolean } = {},
): Promise<StartedServer> {
  const { serve } = await import("@hono/node-server");
  const session = opts.session ?? createSession();
  // Notary Chat's get_guard_coverage: start the (slow, child-process) walk now so the first question finds it ready.
  let guardCoverage = opts.guardCoverage;
  if (!guardCoverage && opts.prewarmGuardCoverage !== false) {
    guardCoverage = cachedGuardCoverage();
    void guardCoverage().catch(() => undefined);
  }
  const app = createApp({ ...opts, session, ...(guardCoverage ? { guardCoverage } : {}) });
  // Pick up events from `notary run` / `notary notarize` running in other processes.
  const tail = opts.eventJournal === null ? null : tailEventJournal(opts.eventJournal ?? DEFAULT_EVENT_JOURNAL, opts.bus ?? defaultBus);
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8787;
  return await new Promise<StartedServer>((res, rej) => {
    const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      const shownHost = info.address.includes(":") ? `[${info.address}]` : info.address;
      res({
        url: `http://${shownHost}:${info.port}`,
        session,
        close: () =>
          new Promise<void>((done) => {
            tail?.stop();
            if ("closeAllConnections" in server) server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
    server.once("error", rej);
  });
}
