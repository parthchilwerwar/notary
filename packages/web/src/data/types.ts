// Redesign R1 contract: the ONE data layer every component goes through.
//
//   LiveSource   — talks to a local `notary serve` (REST + SSE), schemas in core/src/schema/api.ts
//   ReplaySource — reads exported bundles / timelines / certificates from public/
//
// No file outside src/data/ may fetch public/bundles, public/certificates, public/content or any
// fixture path directly (enforced by test/data-boundary.test.ts). Every bundle is hash-verified in
// the browser before it is returned. Replay never invents live-only data: live-only operations
// throw ReplayOnlyError with a user-facing message.
import type {
  ApprovalRecord,
  ApprovalsList,
  AskRequest,
  AskResponse,
  BundleIndexEntry,
  ChatConversation,
  ChatEvent,
  ConversationDetail,
  CertificateReport,
  ExplainFile,
  HealthResponse,
  RunBundle,
  StartRunRequest,
  StartRunResponse,
  TimelineEvent,
  ToolCertificates,
} from "../../../core/src/schema";

export type DataMode = "live" | "replay";

/** One run as the run selector lists it. `sample: true` = fixture (simulated APIs) — always labelled. */
export type RunEntry =
  | (BundleIndexEntry & { state: "finished" })
  | { runId: string; state: "running"; kind: "run" | "notarize"; startedAt: string };

/** Certificates of one data world (real runs, or one fixture scenario). Never mixed. */
export type CertificateWorld = {
  world: "real" | `fixture:${string}`;
  sample: boolean;
  tools: ToolCertificates[];
  report: CertificateReport | null;
};

export type EventStreamOptions = {
  /** Replay only: events per real second multiplier; "instant" emits everything at once. Live ignores it. */
  speed?: 1 | 4 | "instant";
  /** Called once when the stream has delivered run.finished (or the recorded file ended). */
  onEnd?: () => void;
  onError?: (message: string) => void;
};

export interface DataSource {
  readonly mode: DataMode;
  /** Live: GET /api/health. Replay: null (the UI says the hosted/replay build has no live integrations). */
  health(signal?: AbortSignal): Promise<HealthResponse | null>;
  listRuns(signal?: AbortSignal): Promise<RunEntry[]>;
  /** Hash-verified bundle; throws on mismatch (the UI shows the error, never the data). */
  getRun(runId: string, signal?: AbortSignal): Promise<RunBundle>;
  /** Recorded events (timeline.jsonl / published timeline), validated and hash-tied to the bundle. */
  getTimeline(runId: string, signal?: AbortSignal): Promise<TimelineEvent[]>;
  /** Live: SSE /api/runs/:id/events. Replay: the recorded timeline at `speed`. Returns unsubscribe. */
  streamEvents(runId: string, onEvent: (e: TimelineEvent) => void, opts?: EventStreamOptions): () => void;
  /** Certificates for the world of the given run (real runs → real certificates; fixture → its scenario). */
  certificates(forRun?: RunEntry, signal?: AbortSignal): Promise<CertificateWorld>;
  /** Live: GET /api/approvals. Replay: held decisions of recorded runs, read-only (testMode false). */
  approvals(signal?: AbortSignal): Promise<ApprovalsList>;
  /** Precomputed explain answers (public/content/explain.json), or null if not published. */
  explain(signal?: AbortSignal): Promise<ExplainFile | null>;
  // ---- live only (ReplaySource throws ReplayOnlyError) ----
  startRun(req: StartRunRequest): Promise<StartRunResponse>;
  approve(id: string, confirmedAmount: number): Promise<ApprovalRecord>;
  reject(id: string, reason: string): Promise<ApprovalRecord>;
  ask(req: AskRequest): Promise<AskResponse>;
  /** Notary Chat (C1–C3). Live: /api/chat (sqlite on the server, real tools). Replay: the same event
   *  shapes from a deterministic engine over the exported bundles (sessionStorage conversations;
   *  fetch_doc / crustdata_lookup / dodo_lookup emit step_finished status "unavailable"). */
  readonly chat: ChatSource;
}

export interface ChatSource {
  listConversations(signal?: AbortSignal): Promise<ChatConversation[]>;
  getConversation(id: string, signal?: AbortSignal): Promise<ConversationDetail>;
  createConversation(): Promise<ChatConversation>;
  deleteConversation(id: string): Promise<void>;
  /** Streams ChatEvents in order until `done` or `error`; aborting `signal` is the Stop button. */
  sendMessage(conversationId: string, content: string, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void>;
  /** Replay only: the run selected in the dashboard. A new replay conversation is pinned to that
   *  run's world (worlds never mix). Live ignores it (`notary serve` serves real runs only). */
  setContext?(ctx: { runId?: string }): void;
}

/** Shown on the Chat page in replay mode. */
export const REPLAY_CHAT_BANNER = "Replay — answers come from the recorded run, no live lookups";

export class ReplayOnlyError extends Error {
  constructor(action: string) {
    super(`${action} needs live mode — start \`pnpm notary serve\` and reload.`);
    this.name = "ReplayOnlyError";
  }
}

/** Shown whenever the data on screen came from sample: true bundles (simulated APIs). */
export const FIXTURE_BANNER = "Fixture data — simulated APIs, not a live run";
