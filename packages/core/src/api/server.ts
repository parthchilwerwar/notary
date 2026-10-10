// Local API for the dashboard's live mode (TDD "Integrations and interfaces" -> Local API).
//
//   GET /api/bundles      index entries merged from every bundle directory (deduped by runId)
//   GET /api/bundles/:id  one bundle, re-verified with verifyBundle on every read
//   GET /api/stream       SSE of bus events (decision, probe.committed, probe.verdict,
//                         belief.changed, run.finished) with Last-Event-ID replay
//
// Read-only: there are no write endpoints. CORS is limited to loopback dashboard dev origins.
// Only each bundle directory's own index.json is read; subdirectories of public/bundles are NOT
// scanned, so the fixture-demo bundles in public/bundles/fixture/ (own index) are never merged
// into the list. Under runs/, every immediate subdirectory is a bundle dir (runs/<runId>/).
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { verifyBundle } from "../bundle/hash.js";
import { BundleIndexSchema } from "../schema/bundle.js";
import type { BundleIndexEntry } from "../schema/index.js";
import { bus as defaultBus, DEFAULT_EVENT_JOURNAL, tailEventJournal } from "./bus.js";
import type { EventBus, NotaryEvent } from "./bus.js";

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

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (LOOPBACK_ORIGIN.test(origin) ? origin : null),
      allowMethods: ["GET", "HEAD", "OPTIONS"],
      allowHeaders: ["Last-Event-ID", "Cache-Control"],
      exposeHeaders: [HASH_MISMATCH_HEADER],
    }),
  );

  app.get("/api/bundles", async (c) => {
    const index = await loadIndex(opts);
    return c.json(sortEntries([...index.values()].map((v) => v.entry)));
  });

  app.get("/api/bundles/:id", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_RUN_ID.test(id)) return c.json({ error: "invalid bundle id" }, 400);
    const found = (await loadIndex(opts)).get(id);
    if (!found) return c.json({ error: `unknown bundle ${id}` }, 404);
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

  // Read-only API: anything that is not a read is refused explicitly.
  app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/*", (c) => c.json({ error: "the Notary API is read-only" }, 405));

  return app;
}

export interface StartedServer {
  url: string;
  close: () => Promise<void>;
}

/** Bind the API with @hono/node-server. Loopback by default. */
export async function startServer(
  opts: ApiOptions & { port?: number; host?: string; eventJournal?: string | null } = {},
): Promise<StartedServer> {
  const { serve } = await import("@hono/node-server");
  const app = createApp(opts);
  // Pick up events from `notary run` / `notary notarize` running in other processes.
  const tail = opts.eventJournal === null ? null : tailEventJournal(opts.eventJournal ?? DEFAULT_EVENT_JOURNAL, opts.bus ?? defaultBus);
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8787;
  return await new Promise<StartedServer>((res, rej) => {
    const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      const shownHost = info.address.includes(":") ? `[${info.address}]` : info.address;
      res({
        url: `http://${shownHost}:${info.port}`,
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
