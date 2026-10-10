// LiveSource: a local `notary serve` over REST + SSE (contract: core/src/schema/api.ts).
// Every response is validated with the shared schemas; every bundle is hash-verified here too,
// even though the server verified it. Fixture runs, fixture certificates and the precomputed
// explain answers are not served by the API (it serves real data only), so they come from the
// published files — still labelled sample: true, never merged into a real-run list or world.
import {
  ApprovalRecordSchema,
  ApprovalsListSchema,
  ApproveBodySchema,
  AskRequestSchema,
  AskResponseSchema,
  CertificatesResponseSchema,
  HealthResponseSchema,
  RejectBodySchema,
  RunsListResponseSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  TimelineEventSchema,
} from "../../../core/src/schema";
import type {
  ApprovalRecord,
  ApprovalsList,
  AskRequest,
  AskResponse,
  BundleIndexEntry,
  ExplainFile,
  HealthResponse,
  RunBundle,
  StartRunRequest,
  StartRunResponse,
  TimelineEvent,
} from "../../../core/src/schema";
import { canonicalJson, sha256Hex } from "../../../core/src/bundle/hash";
import { globalFetch, type FetchImpl } from "./http";
import { apiRequest, LocalApiError, readToken } from "./local-api";
import { PublishedFiles, TimelineMissingError } from "./published";
import { replayStream } from "./stream";
import { byNewest, validateBundle, verifyTimelineFile, verifyToolRecords } from "./verify";
import type { CertificateWorld, DataSource, EventStreamOptions, RunEntry } from "./types";

/** Minimal EventSource surface LiveSource uses (the browser's, or a test double). */
export type EventSourceLike = {
  onmessage: ((ev: MessageEvent<string>) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onopen: ((ev: Event) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
};
export type EventSourceCtor = new (url: string) => EventSourceLike;

/** GET /api/runs/:id answered 202: the run has no bundle yet. */
export class RunStillRunningError extends Error {
  constructor(readonly runId: string) {
    super(`${runId} is still running; its bundle is written when it finishes.`);
    this.name = "RunStillRunningError";
  }
}

const invalid = (what: string) =>
  new Error(`The local API returned ${what} that does not match the shared schema. Data withheld.`);

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown, what: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw invalid(what);
  return r.data;
}

const toIndexEntry = ({ state: _s, ...e }: BundleIndexEntry & { state: string }): BundleIndexEntry => e;

export class LiveSource implements DataSource {
  readonly mode = "live" as const;
  readonly base: string;
  private readonly fetchImpl: FetchImpl;
  private readonly EventSourceImpl?: EventSourceCtor;
  private readonly published: PublishedFiles;
  private readonly token: () => string | null;
  /** runId → its finished entry, from the last listRuns ("api" or the published fixture). */
  private known = new Map<string, { from: "api" | "fixture"; entry?: BundleIndexEntry }>();

  constructor(opts: {
    base: string;
    fetchImpl?: FetchImpl;
    EventSourceImpl?: EventSourceCtor;
    published?: PublishedFiles;
    token?: () => string | null;
  }) {
    this.base = opts.base;
    this.fetchImpl = opts.fetchImpl ?? globalFetch;
    this.EventSourceImpl = opts.EventSourceImpl;
    this.published = opts.published ?? new PublishedFiles({ fetchImpl: this.fetchImpl });
    this.token = opts.token ?? readToken;
  }

  private async get(path: string, signal?: AbortSignal, auth: "required" | "optional" = "optional") {
    return apiRequest(this.base, path, { signal }, { auth, token: this.token(), fetchImpl: this.fetchImpl });
  }

  private async post(path: string, body: unknown) {
    return apiRequest(
      this.base,
      path,
      { method: "POST", body: JSON.stringify(body) },
      { auth: "required", token: this.token(), fetchImpl: this.fetchImpl },
    );
  }

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    return parse(HealthResponseSchema, (await this.get("/api/health", signal)).body, "a health response");
  }

  /** Runs this server serves (real runs: finished and running). No fixture runs. */
  async servedRuns(signal?: AbortSignal): Promise<RunEntry[]> {
    const { runs } = parse(RunsListResponseSchema, (await this.get("/api/runs", signal)).body, "a run list");
    if (new Set(runs.map((r) => r.runId)).size !== runs.length)
      throw new Error("Duplicate run identifiers in the local API's run list. Data withheld.");
    return runs.map((r): RunEntry => {
      if ("contentHash" in r) {
        if (r.state === "finished") return { ...toIndexEntry(r), state: "finished" };
        return { runId: r.runId, state: "running", kind: r.kind === "notarize" ? "notarize" : "run", startedAt: r.startedAt };
      }
      return r;
    });
  }

  /** The API's runs, then the published fixture runs it does not serve (sample: true, labelled). */
  async listRuns(signal?: AbortSignal): Promise<RunEntry[]> {
    const [served, fixture] = await Promise.all([this.servedRuns(signal), this.published.fixtureCatalog(signal)]);
    const known = new Map<string, { from: "api" | "fixture"; entry?: BundleIndexEntry }>();
    for (const r of served) known.set(r.runId, { from: "api", entry: r.state === "finished" ? toIndexEntry(r) : undefined });
    const extra: RunEntry[] = [];
    for (const { dir: _dir, ...e } of fixture) {
      if (known.has(e.runId)) continue;
      known.set(e.runId, { from: "fixture", entry: e });
      extra.push({ ...e, state: "finished" });
    }
    this.known = known;
    return [...served, ...extra].sort(byNewest);
  }

  private async origin(runId: string, signal?: AbortSignal) {
    if (!this.known.has(runId)) await this.listRuns(signal);
    return this.known.get(runId) ?? { from: "api" as const };
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<RunBundle> {
    const where = await this.origin(runId, signal);
    if (where.from === "fixture") return this.published.bundle(runId, signal);
    const { status, body } = await this.get(`/api/runs/${encodeURIComponent(runId)}`, signal);
    if (status === 202) throw new RunStillRunningError(runId);
    return validateBundle(body, where.entry);
  }

  /**
   * The recorded timeline, tied to the verified bundle. Real runs: GET /api/bundles/:id/timeline
   * (the TimelineFile `notary serve` already serves; api.ts names no other timeline endpoint).
   */
  async getTimeline(runId: string, signal?: AbortSignal): Promise<TimelineEvent[]> {
    const where = await this.origin(runId, signal);
    if (where.from === "fixture") return (await this.published.timeline(runId, signal)).events;
    const bundle = await this.getRun(runId, signal);
    let raw: unknown;
    try {
      raw = (await this.get(`/api/bundles/${encodeURIComponent(runId)}/timeline`, signal)).body;
    } catch (e) {
      if (e instanceof LocalApiError && e.status === 404) throw new TimelineMissingError(runId);
      throw e;
    }
    return verifyTimelineFile(raw, bundle).events;
  }

  /**
   * SSE GET /api/runs/:id/events: the file first, then live events, `event: end` after
   * run.finished. Every event is schema-checked and must belong to the run; final events only move
   * forward by seq (a reconnect replays the file — duplicates are dropped); best-effort events
   * (data.live, provisional seq) pass through for the UI to merge. Fixture runs replay their published
   * timeline (at opts.speed, default instant): nothing simulated is ever streamed as live.
   */
  streamEvents(runId: string, onEvent: (e: TimelineEvent) => void, opts: EventStreamOptions = {}): () => void {
    if (this.known.get(runId)?.from === "fixture")
      return replayStream(() => this.getTimeline(runId), onEvent, { ...opts, speed: opts.speed ?? "instant" });
    const Ctor = this.EventSourceImpl ?? (globalThis.EventSource as unknown as EventSourceCtor | undefined);
    if (!Ctor) {
      opts.onError?.("This browser has no EventSource; live events are unavailable.");
      return () => {};
    }
    const source = new Ctor(`${this.base}/api/runs/${encodeURIComponent(runId)}/events`);
    let lastFinalSeq = -1;
    let ended = false;
    const handle = (message: MessageEvent<string>) => {
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch {
        opts.onError?.("Dropped a live event that is not valid JSON.");
        return;
      }
      const parsed = TimelineEventSchema.safeParse(data);
      if (!parsed.success || parsed.data.runId !== runId) {
        opts.onError?.("Dropped a live event that does not match the shared timeline schema.");
        return;
      }
      // Best-effort events (data.live) carry a provisional seq that the file's final event of the
      // same seq supersedes later, so only final events are de-duplicated by seq.
      if (parsed.data.data?.live !== true) {
        if (parsed.data.seq <= lastFinalSeq) return;
        lastFinalSeq = parsed.data.seq;
      }
      onEvent(parsed.data);
    };
    // `notary serve` names its events `timeline`; unnamed messages are accepted too.
    source.addEventListener("timeline", handle);
    source.onmessage = handle;
    source.addEventListener("end", () => {
      ended = true;
      source.close();
      opts.onEnd?.();
    });
    source.onerror = (ev) => {
      if (ended) return;
      // A server-sent `event: error` carries {error}; a transport error carries no data.
      const data = (ev as MessageEvent<string>).data;
      let message = "The live event stream was interrupted; reconnecting.";
      if (typeof data === "string" && data) {
        try {
          const body = JSON.parse(data) as { error?: unknown };
          if (typeof body.error === "string") message = `The local API reported: ${body.error}`;
        } catch {
          // keep the generic message
        }
      }
      opts.onError?.(message);
    };
    return () => {
      ended = true;
      source.close();
    };
  }

  /**
   * Real runs (or no run): GET /api/certificates, seals and report pins re-checked. A fixture run:
   * its published fixture scenario (never mixed with the real world).
   */
  async certificates(forRun?: RunEntry, signal?: AbortSignal): Promise<CertificateWorld> {
    if (forRun?.state === "finished" && forRun.sample)
      return this.published.certificateWorld(true, forRun.runId, signal);
    const res = parse(CertificatesResponseSchema, (await this.get("/api/certificates", signal)).body, "certificates");
    const tools = res.tools.map((t) => verifyToolRecords(t, false, `${t.tool} certificates`));
    if (res.report) {
      if (res.report.sample) throw new Error("The local API's certificate report is fixture data. Data withheld.");
      for (const entry of res.report.tools) {
        const tool = tools.find((t) => t.tool === entry.tool);
        if (!tool || sha256Hex(canonicalJson(tool)) !== res.report.toolFileHashes[entry.file])
          throw new Error(`${entry.file} does not match the hash pinned in its report. Data withheld.`);
      }
    }
    return { world: "real", sample: false, tools, report: res.report };
  }

  async approvals(signal?: AbortSignal): Promise<ApprovalsList> {
    const { body } = await this.get("/api/approvals", signal, "required");
    return parse(ApprovalsListSchema, body, "an approvals list");
  }

  /** Precomputed answers are published files in both modes (no API serves them). */
  async explain(signal?: AbortSignal): Promise<ExplainFile | null> {
    return this.published.explain(signal);
  }

  async startRun(req: StartRunRequest): Promise<StartRunResponse> {
    const body = parse(StartRunRequestSchema, req, "a start-run request");
    return parse(StartRunResponseSchema, (await this.post("/api/runs", body)).body, "a start-run response");
  }

  async approve(id: string, confirmedAmount: number): Promise<ApprovalRecord> {
    const body = parse(ApproveBodySchema, { confirmedAmount }, "an approve body");
    const { body: res } = await this.post(`/api/approvals/${encodeURIComponent(id)}/approve`, body);
    return parseRecord(res);
  }

  async reject(id: string, reason: string): Promise<ApprovalRecord> {
    const body = RejectBodySchema.safeParse({ reason });
    if (!body.success) throw new Error("A rejection needs a reason.");
    const { body: res } = await this.post(`/api/approvals/${encodeURIComponent(id)}/reject`, body.data);
    return parseRecord(res);
  }

  async ask(req: AskRequest): Promise<AskResponse> {
    const body = AskRequestSchema.safeParse(req);
    if (!body.success) throw new Error("The question is empty or longer than 2000 characters.");
    return parse(AskResponseSchema, (await this.post("/api/ask", body.data)).body, "an answer");
  }
}

function parseRecord(raw: unknown): ApprovalRecord {
  const parsed = ApprovalRecordSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "The local API answered with an approval record that does not match the shared schema. Treat the outcome as unknown and reload the list.",
    );
  return parsed.data;
}
