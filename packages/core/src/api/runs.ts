// Runs on the local API (Redesign R1): start real runs with the real agent, list them, read them,
// and stream their timelines.
//
//   POST /api/runs            token + localhost. {kind:"queue", variant} runs runQueue over the real
//                             seeded queue (fixtures/queue/seeded.json) in this process; {kind:"notarize",
//                             tool} runs notarize (live, adversary backend "bedrock" = the configured LLM
//                             provider, as the CLI default). Preconditions are checked before anything is
//                             created: a missing key / test-mode lock / seed manifest -> 503 with the exact
//                             BLOCKED message naming the variable. One run at a time per kind+target
//                             (queue:<variant>, notarize:<tool>); a second start -> 409. The run itself
//                             goes on in the background: 202 {runId, state:"running"} at once. The runId
//                             is the CLI's (run-<variant>-<stamp> / notarize-<tool>-<stamp>), passed in.
//                             A failure inside the run ends as the CLI would (a failed/blocked result, a
//                             bundle when the run wrote one); nothing a run throws can crash the server.
//   GET  /api/runs            finished runs (verified, sample:false bundles from the bundle dirs) plus the
//                             runs this server started that are still running.
//   GET  /api/runs/:id        the hash-verified bundle; 202 {state:"running"} while running; a run that
//                             ended without a bundle -> 503 (blocked) / 500 (failed) {runId, state, error};
//                             404 unknown (sample/fixture bundles are not live runs: 404 too).
//   GET  /api/runs/:id/events SSE of TimelineEvents, the same events runs/<runId>/timeline.jsonl holds
//                             (or the published <runId>.timeline.json): the file is replayed first (id =
//                             seq; Last-Event-ID / ?lastEventId resumes after a seq), then live `timeline`
//                             bus events for the run: best-effort ones (data.live) without an id, final
//                             ones deduped by seq. `event: end` once run.finished has been sent (at once for
//                             a finished run; for a running one when it ends, after re-reading the file).
//
// Limits (NOTARY_MAX_USD, credit budget, rate limits) are enforced inside the clients the runs use.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { unguardedCallSitesMetric } from "../eval/metrics.js";
import { scrubber } from "../llm/client.js";
import { DEFAULT_MANIFEST_PATH, MANIFEST_MISSING_MESSAGE } from "../queue/manifest.js";
import { QUEUE_RUN_KEYS, runQueue } from "../queue/run.js";
import { SEEDED_QUEUE_PATH, notarize, preflight } from "../reflect/notarize.js";
import { RunsListResponseSchema, StartRunRequestSchema, StartRunResponseSchema } from "../schema/api.js";
import type { RunListEntry, RunningRun, StartRunRequest } from "../schema/api.js";
import { BundleIndexEntrySchema } from "../schema/bundle.js";
import type { BundleIndexEntry, RunBundle, Tool } from "../schema/index.js";
import { TimelineEventSchema } from "../schema/timeline.js";
import type { TimelineEvent } from "../schema/timeline.js";
import { servedTimeline } from "../timeline/serve.js";
import { readTimeline, timelinePath } from "../timeline/store.js";
import { MissingCredentialError } from "../tools/index.js";
import { withSpanSink, withWorkflow } from "../trace/index.js";
import { dodoTestMode } from "./approvals.js";
import type { EventBus } from "./bus.js";
import { SAFE_RUN_ID } from "./bundle-source.js";
import type { LoadedBundle } from "./bundle-source.js";
import { requireLocalSession } from "./session.js";
import type { ApiSession } from "./session.js";

export type TrackedState = "running" | "finished" | "failed" | "blocked";

export interface TrackedRun {
  runId: string;
  kind: "run" | "notarize";
  /** queue:<variant> | notarize:<tool>: one running run per key. */
  key: string;
  startedAt: string;
  state: TrackedState;
  /** The run's own status when it returned (bundle status, or "blocked"/"failed" without a bundle). */
  status?: RunBundle["status"];
  /** Why it ended without a bundle (scrubbed, one line). */
  error?: string;
  endedAt?: string;
}

/** What a runner returns: the CLI result shape of runQueue / notarize. */
export interface RunnerResult {
  exitCode: number;
  lines: string[];
  status: RunBundle["status"];
}

export interface RunnerArgs {
  runId: string;
  env: NodeJS.ProcessEnv;
  runsDir: string;
}

export interface RunsOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  runsDir: string | null;
  bus: EventBus;
  session: ApiSession;
  keepAliveMs: number;
  /** Index entries of every bundle directory (first wins per runId). */
  loadIndex: () => Promise<Map<string, { entry: BundleIndexEntry; dir: string }>>;
  /** Every verified bundle the server sees. */
  verifiedBundles: () => Promise<LoadedBundle[]>;
  /** The verified-bundle response GET /api/bundles/:id gives (hash mismatch header included). */
  bundleResponse: (c: Context, found: { entry: BundleIndexEntry; dir: string }, id: string) => Promise<Response>;
  /** Test seams: the runners (default: the real runQueue / notarize) and the precondition check. */
  runQueue?: (args: RunnerArgs & { variant: "guarded" | "naive" }) => Promise<RunnerResult>;
  notarize?: (args: RunnerArgs & { tool: Tool }) => Promise<RunnerResult>;
  precheck?: (req: StartRunRequest, env: NodeJS.ProcessEnv) => string[];
}

function compactStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function parseLastEventId(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,15}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/**
 * Every reason this run can't start, as BLOCKED lines naming the variable (empty: ready). No I/O
 * beyond an existsSync; nothing is created.
 */
export function startPreconditions(req: StartRunRequest, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (req.kind === "queue") {
    for (const v of QUEUE_RUN_KEYS) if (!(env[v] ?? "").trim()) out.push(new MissingCredentialError(v).message);
  } else {
    // Tool key + the provider-aware model settings (reflector), exactly what `notary notarize` checks.
    const pre = preflight({ tool: req.tool, replay: false }, env);
    if (pre.result) out.push(...pre.result.lines);
  }
  // Every live run builds the Dodo client, which refuses to start outside test mode.
  const lock = dodoTestMode(env);
  if (!lock.testMode) out.push(`BLOCKED: ${lock.reason ?? "Dodo test-mode lock is off"}`);
  if (req.kind === "queue" && !existsSync(DEFAULT_MANIFEST_PATH)) out.push(MANIFEST_MISSING_MESSAGE);
  return out;
}

async function defaultQueueRunner(a: RunnerArgs & { variant: "guarded" | "naive" }): Promise<RunnerResult> {
  return await withWorkflow(`queue-run.${a.variant}`, () =>
    runQueue({
      queueFile: SEEDED_QUEUE_PATH,
      variant: a.variant,
      mode: "live",
      runId: a.runId,
      env: a.env,
      runsDir: a.runsDir,
      unguardedCallSites: unguardedCallSitesMetric,
    }),
  );
}

async function defaultNotarizeRunner(a: RunnerArgs & { tool: Tool }): Promise<RunnerResult> {
  // Scope this run's spans to its own runs/<runId>/spans.jsonl (the path notarize sets anyway), so a
  // concurrent run or approval swapping the process-wide sink can't redirect them.
  return await withSpanSink(join(a.runsDir, a.runId, "spans.jsonl"), () =>
    withWorkflow(`notarize.${a.tool}`, () =>
      notarize({
        tool: a.tool,
        replay: false,
        adversary: "bedrock",
        runId: a.runId,
        env: a.env,
        runsDir: a.runsDir,
        unguardedCallSites: unguardedCallSitesMetric,
      }),
    ),
  );
}

/** In-memory registry of the runs this server started. */
export class RunTracker {
  private readonly runs = new Map<string, TrackedRun>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get(runId: string): TrackedRun | undefined {
    return this.runs.get(runId);
  }

  all(): TrackedRun[] {
    return [...this.runs.values()];
  }

  runningFor(key: string): TrackedRun | undefined {
    return this.all().find((r) => r.key === key && r.state === "running");
  }

  /** Called once when `runId` ends (immediately if it already has). Returns unsubscribe. */
  onEnd(runId: string, fn: () => void): () => void {
    const r = this.runs.get(runId);
    if (r && r.state !== "running") {
      fn();
      return () => undefined;
    }
    const set = this.listeners.get(runId) ?? new Set<() => void>();
    set.add(fn);
    this.listeners.set(runId, set);
    return () => void set.delete(fn);
  }

  /** Register `run` and execute `work` in the background. Never rejects; never throws into the caller. */
  launch(run: TrackedRun, work: () => Promise<RunnerResult>, opts: { bundleExists: () => boolean; clean: (s: string) => string; now: () => Date }): Promise<void> {
    this.runs.set(run.runId, run);
    const done = (async () => {
      try {
        const res = await work();
        run.status = res.status;
        if (opts.bundleExists()) {
          run.state = "finished";
        } else {
          run.state = res.status === "blocked" ? "blocked" : "failed";
          const why = res.lines.find((l) => l.startsWith("BLOCKED:")) ?? res.lines.find((l) => /fail|error|STOPPED/i.test(l)) ?? res.lines[res.lines.length - 1];
          run.error = opts.clean((why ?? `the run ended with status ${res.status} and wrote no bundle`).split("\n")[0]!).slice(0, 500);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        run.state = opts.bundleExists() ? "finished" : msg.startsWith("BLOCKED:") ? "blocked" : "failed";
        if (run.state !== "finished") run.error = opts.clean(msg.split("\n")[0]!).slice(0, 500);
      } finally {
        run.endedAt = opts.now().toISOString();
        const set = this.listeners.get(run.runId);
        this.listeners.delete(run.runId);
        for (const fn of set ?? []) {
          try {
            fn();
          } catch {
            // a closed stream must never break the tracker
          }
        }
      }
    })();
    return done;
  }
}

export function mountRuns(app: Hono, opts: RunsOptions): { tracker: RunTracker } {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const clean = scrubber(env);
  const tracker = new RunTracker();
  const precheck = opts.precheck ?? startPreconditions;
  const queueRunner = opts.runQueue ?? defaultQueueRunner;
  const notarizeRunner = opts.notarize ?? defaultNotarizeRunner;
  const runsDir = opts.runsDir;

  // ---------------------------------------------------------------------------- POST /api/runs
  app.post("/api/runs", requireLocalSession(opts.session), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const parsed = StartRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: `invalid run request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` }, 400);
    }
    const req = parsed.data;
    const key = req.kind === "queue" ? `queue:${req.variant}` : `notarize:${req.tool}`;
    const running = tracker.runningFor(key);
    if (running) return c.json({ error: `a ${key} run is already running (${running.runId}); one at a time`, runId: running.runId }, 409);
    if (runsDir === null) return c.json({ error: "BLOCKED: this server has no runs directory (runsDir: null); runs can't be written" }, 503);

    const blocked = precheck(req, env).map((l) => clean(l));
    if (blocked.length) return c.json({ error: blocked[0], blocked }, 503);

    const started = now();
    const runId = req.kind === "queue" ? `run-${req.variant}-${compactStamp(started)}` : `notarize-${req.tool}-${compactStamp(started)}`;
    if (tracker.get(runId) || existsSync(join(runsDir, runId))) {
      return c.json({ error: `run ${runId} already exists (two starts in the same second); try again`, runId }, 409);
    }
    const run: TrackedRun = { runId, kind: req.kind === "queue" ? "run" : "notarize", key, startedAt: started.toISOString(), state: "running" };
    const work =
      req.kind === "queue"
        ? () => queueRunner({ runId, env, runsDir, variant: req.variant })
        : () => notarizeRunner({ runId, env, runsDir, tool: req.tool });
    void tracker.launch(run, work, { bundleExists: () => existsSync(join(runsDir, runId, `${runId}.json`)), clean, now });
    return c.json(StartRunResponseSchema.parse({ runId, state: "running" }), 202);
  });

  // ----------------------------------------------------------------------------- GET /api/runs
  app.get("/api/runs", async (c) => {
    const finished: RunListEntry[] = [];
    for (const { bundle } of await opts.verifiedBundles()) {
      if (bundle.sample) continue;
      finished.push({ ...BundleIndexEntrySchema.parse(bundle), state: "finished" });
    }
    const done = new Set(finished.map((r) => r.runId));
    const running: RunningRun[] = tracker
      .all()
      .filter((r) => r.state === "running" && !done.has(r.runId))
      .map((r) => ({ runId: r.runId, state: "running", kind: r.kind, startedAt: r.startedAt }));
    const runs = [...finished, ...running].sort(
      (x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt) || (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0),
    );
    return c.json(RunsListResponseSchema.parse({ runs }));
  });

  // ------------------------------------------------------------------------- GET /api/runs/:id
  app.get("/api/runs/:id", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_RUN_ID.test(id)) return c.json({ error: "invalid run id" }, 400);
    const found = (await opts.loadIndex()).get(id);
    if (found && !found.entry.sample) return await opts.bundleResponse(c, found, id);
    if (found?.entry.sample) return c.json({ error: `${id} is sample/fixture data, not a live run` }, 404);
    const run = tracker.get(id);
    if (!run) return c.json({ error: `unknown run ${id}` }, 404);
    if (run.state === "running") return c.json({ runId: id, state: "running" }, 202);
    if (run.state === "finished") return c.json({ error: `run ${id} finished but its bundle is not in the index`, runId: id, state: run.state }, 404);
    return c.json({ runId: id, state: run.state, error: run.error ?? `run ${id} ${run.state}` }, run.state === "blocked" ? 503 : 500);
  });

  // ------------------------------------------------------------------ GET /api/runs/:id/events
  /** The run's recorded timeline: runs/<id>/timeline.jsonl, else the published one; [] if none yet. */
  const fileEvents = async (id: string): Promise<TimelineEvent[]> => {
    const runDir = runsDir === null ? null : join(runsDir, id);
    if (runDir && existsSync(timelinePath(runDir))) return readTimeline(runDir);
    const f = (await opts.loadIndex()).get(id);
    if (f && !f.entry.sample) {
      const s = servedTimeline({ id, entry: f.entry, dir: f.dir, runsDir });
      if (s.ok) return s.file.events;
      if (s.status === 500) throw new Error(s.error);
    }
    return [];
  };

  app.get("/api/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_RUN_ID.test(id)) return c.json({ error: "invalid run id" }, 400);
    const found = (await opts.loadIndex()).get(id);
    if (found?.entry.sample) return c.json({ error: `${id} is sample/fixture data, not a live run` }, 404);
    if (!found && !tracker.get(id)) return c.json({ error: `unknown run ${id}` }, 404);
    try {
      await fileEvents(id);
    } catch (err) {
      return c.json({ error: `timeline for ${id} is invalid: ${clean((err as Error).message)}` }, 500);
    }
    const afterSeq = parseLastEventId(c.req.header("Last-Event-ID") ?? c.req.query("lastEventId"));

    return streamSSE(c, async (stream) => {
      type Item = { kind: "event"; event: TimelineEvent } | { kind: "ended" };
      const pending: Item[] = [];
      let wake: (() => void) | null = null;
      const push = (item: Item): void => {
        pending.push(item);
        wake?.();
      };
      // Subscribe first, then replay the file, then dedupe by seq: no gap at the seam.
      const unsubscribeBus = opts.bus.subscribe((ev) => {
        if (ev.type !== "timeline") return;
        const p = TimelineEventSchema.safeParse(ev.payload);
        if (p.success && p.data.runId === id) push({ kind: "event", event: p.data });
      });
      const tracked = tracker.get(id);
      const unsubscribeEnd = tracked?.state === "running" ? tracker.onEnd(id, () => push({ kind: "ended" })) : () => undefined;
      const stop = (): void => {
        unsubscribeBus();
        unsubscribeEnd();
        wake?.();
      };
      stream.onAbort(stop);
      c.req.raw.signal.addEventListener("abort", () => stream.abort(), { once: true });

      let lastSeq = afterSeq ?? -1;
      const sendFinal = async (e: TimelineEvent): Promise<void> => {
        if (e.seq <= lastSeq) return;
        await stream.writeSSE({ event: "timeline", id: String(e.seq), data: JSON.stringify(e) });
        lastSeq = e.seq;
      };
      const replayFile = async (): Promise<void> => {
        let events: TimelineEvent[];
        try {
          events = await fileEvents(id);
        } catch (err) {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ error: clean((err as Error).message) }) });
          return;
        }
        for (const e of events) await sendFinal(e);
      };
      const end = async (seen?: "finished"): Promise<void> => {
        const r = tracker.get(id);
        // run.finished was sent: the run is finished even if its runner has not returned yet.
        const state = seen ?? (r?.state === "running" ? "finished" : (r?.state ?? "finished"));
        await stream.writeSSE({ event: "end", data: JSON.stringify({ runId: id, state, ...(r?.error ? { error: r.error } : {}) }) });
      };

      try {
        await stream.write(`retry: 3000\n: connected\n\n`);
        await replayFile();
        if (tracker.get(id)?.state !== "running") {
          await end();
          return;
        }
        while (!stream.aborted && !stream.closed) {
          while (pending.length > 0 && !stream.aborted) {
            const item = pending.shift()!;
            if (item.kind === "ended") {
              await replayFile();
              await end();
              return;
            }
            const e = item.event;
            if (e.data?.live === true) {
              // Best-effort live event: provisional seq, no id (the file's events supersede it).
              await stream.writeSSE({ event: "timeline", data: JSON.stringify(e) });
            } else {
              await sendFinal(e);
              if (e.type === "run.finished") {
                // The file is written before the final events are emitted: send anything still missing.
                await replayFile();
                await end("finished");
                return;
              }
            }
          }
          if (stream.aborted) break;
          let timer: NodeJS.Timeout | undefined;
          const timedOut = await new Promise<boolean>((res) => {
            wake = () => res(false);
            timer = setTimeout(() => res(true), opts.keepAliveMs);
          });
          wake = null;
          clearTimeout(timer);
          if (timedOut && pending.length === 0 && !stream.aborted) await stream.write(": keep-alive\n\n");
        }
      } finally {
        unsubscribeBus();
        unsubscribeEnd();
      }
    });
  });

  return { tracker };
}
