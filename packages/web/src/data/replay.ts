// ReplaySource: the published files under public/ (bundles, timelines, certificates, explain).
// Every bundle is hash-verified, every timeline is tied to its bundle's hash, every certificate
// seal is recomputed. Nothing live is invented: health is null, approvals are the held decisions
// of the recorded runs (read-only, testMode false, no amounts — only the server computes those),
// and every live-only operation throws ReplayOnlyError.
import type {
  ApprovalRecord,
  ApprovalsList,
  AskResponse,
  ExplainFile,
  PendingApproval,
  RunBundle,
  StartRunResponse,
  TimelineEvent,
} from "../../../core/src/schema";
import { PublishedFiles, type CertificateWorldDetail } from "./published";
import { realTimers, replayStream, type Timers } from "./stream";
import { approvalId } from "./verify";
import { ReplayOnlyError, type DataSource, type EventStreamOptions, type RunEntry } from "./types";

export class ReplaySource implements DataSource {
  readonly mode = "replay" as const;
  readonly published: PublishedFiles;
  private readonly timers: Timers;

  constructor(opts: { published?: PublishedFiles; timers?: Timers } = {}) {
    this.published = opts.published ?? new PublishedFiles();
    this.timers = opts.timers ?? realTimers;
  }

  async health(): Promise<null> {
    return null;
  }

  async listRuns(signal?: AbortSignal): Promise<RunEntry[]> {
    return (await this.published.catalog(signal)).map(({ dir: _dir, ...e }) => ({ ...e, state: "finished" as const }));
  }

  getRun(runId: string, signal?: AbortSignal): Promise<RunBundle> {
    return this.published.bundle(runId, signal);
  }

  async getTimeline(runId: string, signal?: AbortSignal): Promise<TimelineEvent[]> {
    return (await this.published.timeline(runId, signal)).events;
  }

  /** The recorded timeline at opts.speed (1×, 4× or instant; default 1×). */
  streamEvents(runId: string, onEvent: (e: TimelineEvent) => void, opts: EventStreamOptions = {}): () => void {
    return replayStream(() => this.getTimeline(runId), onEvent, opts, this.timers);
  }

  certificates(forRun?: RunEntry, signal?: AbortSignal): Promise<CertificateWorldDetail> {
    const sample = forRun?.state === "finished" && forRun.sample;
    return this.published.certificateWorld(sample, forRun?.runId, signal);
  }

  /**
   * Held decisions of every published run, as recorded. Read-only: testMode false, no `amount`
   * (the held amount is computed by `notary serve`, never guessed here) and no decided records
   * (no approvals file is published). Items of fixture runs are included; their run entry says
   * `sample: true` — group by it, never mix them with real runs.
   */
  async approvals(signal?: AbortSignal): Promise<ApprovalsList> {
    const runs = await this.listRuns(signal);
    const bundles = await Promise.all(runs.map((r) => this.getRun(r.runId, signal)));
    const pending: PendingApproval[] = bundles.flatMap((b) =>
      b.decisions
        .filter((d) => d.status === "held")
        .map((d) => ({
          id: approvalId(b.runId, d.id),
          runId: b.runId,
          decisionId: d.id,
          requestId: d.requestId,
          action: d.action,
          // Same rule the server uses for a pending item's reason.
          reason: d.error ?? d.evidencePack?.reason ?? "held",
          missingBeliefs: d.missingBeliefs,
        })),
    );
    return { testMode: false, pending, decided: [] };
  }

  explain(signal?: AbortSignal): Promise<ExplainFile | null> {
    return this.published.explain(signal);
  }

  async startRun(): Promise<StartRunResponse> {
    throw new ReplayOnlyError("Starting a run");
  }

  async approve(): Promise<ApprovalRecord> {
    throw new ReplayOnlyError("Approving a held action");
  }

  async reject(): Promise<ApprovalRecord> {
    throw new ReplayOnlyError("Rejecting a held action");
  }

  async ask(): Promise<AskResponse> {
    throw new ReplayOnlyError("Asking a free-form question");
  }
}
