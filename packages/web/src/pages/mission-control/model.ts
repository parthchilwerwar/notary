// Mission control's pure logic: timeline validation, stage counts, node states, edge
// transitions, the replay clock, feed filtering and links, budget formatting and live merges.
// No React and no DOM here, so every rule is unit-tested against the published timelines
// (test/mission-control.test.ts).
//
// Honesty rule: every number this module returns is a count of (or a value read from) timeline
// events the caller passes in — the events replayed so far, or received so far in live mode.
import {
  BudgetSnapshotSchema,
  RoleSchema,
  TimelineEventSchema,
  TimelineFileSchema,
  TimelineStageSchema,
} from "../../../../core/src/schema";
import type {
  BudgetMeter,
  BudgetSnapshot,
  RunBundle,
  TimelineEvent,
  TimelineEventType,
  TimelineFile,
  TimelineStage,
} from "../../../../core/src/schema";
import { recordPath, withRun } from "../../state/data-mode";
import { safeLink } from "../../data";

/* ------------------------------------------------------------------ stages */

/** Read → Test → Challenge → Certify → Enforce, in the schema's order. */
export const STAGES: readonly TimelineStage[] = TimelineStageSchema.options;

export const STAGE_LABEL: Record<TimelineStage, string> = {
  read: "Read",
  test: "Test",
  challenge: "Challenge",
  certify: "Certify",
  enforce: "Enforce",
};

/** What each stage's events are, in a few words (copy, not data). */
export const STAGE_NOTE: Record<TimelineStage, string> = {
  read: "Docs vs recorded responses",
  test: "Committed probes",
  challenge: "Adversary review",
  certify: "Beliefs and certificates",
  enforce: "Guarded money actions",
};

export const TYPE_LABEL: Record<TimelineEventType, [one: string, many: string]> = {
  "anomaly.detected": ["anomaly", "anomalies"],
  decision: ["decision", "decisions"],
  "probe.committed": ["probe committed", "probes committed"],
  "probe.verdict": ["verdict", "verdicts"],
  "adversary.verdict": ["review", "reviews"],
  "belief.changed": ["belief change", "belief changes"],
  "certificate.issued": ["certificate issued", "certificates issued"],
  "certificate.revoked": ["revoked", "revoked"],
  budget: ["budget snapshot", "budget snapshots"],
  "approval.decided": ["approval", "approvals"],
  "run.finished": ["run finished", "run finished"],
};

export const typeLabel = (type: TimelineEventType, n: number) =>
  TYPE_LABEL[type][n === 1 ? 0 : 1];

/* -------------------------------------------------------------- validation */

export type TimelineCheck =
  | { ok: true; file: TimelineFile }
  | { ok: false; error: string };

/**
 * A timeline is shown only when it passes the shared schema and belongs to the selected,
 * already hash-verified bundle: same runId, same sample flag, `bundleHash === contentHash`,
 * every event for this run and `seq` strictly increasing. Anything else withholds the data.
 */
export function checkTimeline(
  raw: unknown,
  bundle: Pick<RunBundle, "runId" | "sample" | "contentHash">,
): TimelineCheck {
  const parsed = TimelineFileSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      error: "The timeline does not match the shared timeline schema. Data withheld.",
    };
  const file = parsed.data;
  if (file.runId !== bundle.runId)
    return {
      ok: false,
      error: `The timeline is for run ${file.runId}, not ${bundle.runId}. Data withheld.`,
    };
  if (file.sample !== bundle.sample)
    return {
      ok: false,
      error: `The timeline's sample flag (${file.sample}) disagrees with the bundle (${bundle.sample}). Data withheld.`,
    };
  if (file.bundleHash !== bundle.contentHash)
    return {
      ok: false,
      error: `Timeline hash mismatch: it belongs to bundle ${file.bundleHash.slice(0, 12)}…, not the verified bundle ${bundle.contentHash.slice(0, 12)}…; data withheld.`,
    };
  for (let i = 0; i < file.events.length; i++) {
    const e = file.events[i]!;
    if (e.runId !== file.runId)
      return { ok: false, error: `Event ${e.seq} belongs to run ${e.runId}. Data withheld.` };
    if (i > 0 && e.seq <= file.events[i - 1]!.seq)
      return { ok: false, error: `Timeline events are out of order at seq ${e.seq}. Data withheld.` };
  }
  return { ok: true, file };
}

/* ----------------------------------------------------------- live merging */

export const isLiveEvent = (e: TimelineEvent) => e.data?.live === true;

/**
 * Merge stream events into a run's events (sorted by seq). Live events (`data.live: true`) are
 * provisional: they never replace a recorded event with the same seq. Recorded events (the
 * timeline file's, re-emitted when a run finishes, or an appended approval) replace whatever
 * holds their seq. Events for other runs are ignored.
 */
export function mergeEvents(
  base: readonly TimelineEvent[],
  incoming: readonly TimelineEvent[],
  runId: string,
): TimelineEvent[] {
  const bySeq = new Map(base.map((e) => [e.seq, e]));
  for (const e of incoming) {
    if (e.runId !== runId) continue;
    const held = bySeq.get(e.seq);
    if (held && isLiveEvent(e) && !isLiveEvent(held)) continue;
    bySeq.set(e.seq, e);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** SSE `timeline` message data (`{ at, payload }`) → a schema-valid TimelineEvent, else null. */
export function parseStreamData(data: string): TimelineEvent | null {
  try {
    const message = JSON.parse(data) as { payload?: unknown };
    const parsed = TimelineEventSchema.safeParse(message?.payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------- stage counts/states */

export type NodeState = "idle" | "active" | "done" | "failed";

export type StageStats = {
  stage: TimelineStage;
  /** Events at this stage so far. */
  count: number;
  byType: Partial<Record<TimelineEventType, number>>;
  /** Decision / approval events by recorded status (executed, held, …). */
  byStatus: Record<string, number>;
  /** Failure events at this stage, by reason ("certificate revoked": 1). */
  failures: Record<string, number>;
  last?: TimelineEvent;
};

const FAILED_RUN_STATUSES = new Set(["failed", "stopped_budget", "blocked"]);

/**
 * Why an event marks its stage failed, or null. The rules (all read from recorded data):
 *   - certificate.revoked                      → "certificate revoked"
 *   - belief.changed to "unlearned"            → "belief unlearned"
 *   - adversary.verdict with verdict "failed"  → "adversary review failed"
 *   - decision whose bundle record the grader marked unsafe (grade.unsafe) → "unsafe action"
 *   - approval.decided with status "failed"    → "approval failed"
 *   - run.finished with status failed / stopped_budget / blocked → "run <status>"
 */
export function failureOf(
  e: TimelineEvent,
  unsafeDecisionIds: ReadonlySet<string> = new Set(),
): string | null {
  const d = e.data ?? {};
  switch (e.type) {
    case "certificate.revoked":
      return "certificate revoked";
    case "belief.changed":
      return d.to === "unlearned" ? "belief unlearned" : null;
    case "adversary.verdict":
      return d.verdict === "failed" ? "adversary review failed" : null;
    case "decision":
      return e.recordIds.some((id) => unsafeDecisionIds.has(id)) ? "unsafe action" : null;
    case "approval.decided":
      return d.status === "failed" ? "approval failed" : null;
    case "run.finished":
      return typeof d.status === "string" && FAILED_RUN_STATUSES.has(d.status)
        ? `run ${d.status.replaceAll("_", " ")}`
        : null;
    default:
      return null;
  }
}

/** Decision ids the deterministic grader marked unsafe (grade.unsafe non-empty). */
export function unsafeDecisionIds(bundle: Pick<RunBundle, "decisions">): Set<string> {
  return new Set(
    bundle.decisions.filter((d) => (d.grade?.unsafe.length ?? 0) > 0).map((d) => d.id),
  );
}

export function stageStats(
  events: readonly TimelineEvent[],
  unsafe: ReadonlySet<string> = new Set(),
): Record<TimelineStage, StageStats> {
  const out = Object.fromEntries(
    STAGES.map((s) => [s, { stage: s, count: 0, byType: {}, byStatus: {}, failures: {} }]),
  ) as Record<TimelineStage, StageStats>;
  for (const e of events) {
    const s = out[e.stage];
    s.count++;
    s.byType[e.type] = (s.byType[e.type] ?? 0) + 1;
    if ((e.type === "decision" || e.type === "approval.decided") && typeof e.data?.status === "string")
      s.byStatus[e.data.status] = (s.byStatus[e.data.status] ?? 0) + 1;
    const why = failureOf(e, unsafe);
    if (why) s.failures[why] = (s.failures[why] ?? 0) + 1;
    s.last = e;
  }
  return out;
}

/**
 * Node state per stage, from the events so far:
 *   failed — the stage has at least one failure event (failureOf); sticky.
 *   idle   — no events at this stage yet (or none in this run once it finished).
 *   active — the run has not finished and the latest event is at this stage.
 *   done   — the stage had events and the run moved past it (a later event is at another
 *            stage) or the run finished.
 * "Finished" = a run.finished event is among the events.
 */
export function nodeStates(
  events: readonly TimelineEvent[],
  stats: Record<TimelineStage, StageStats>,
): Record<TimelineStage, NodeState> {
  const finished = events.some((e) => e.type === "run.finished");
  const latest = events.at(-1);
  return Object.fromEntries(
    STAGES.map((s) => {
      const st = stats[s];
      const state: NodeState =
        Object.keys(st.failures).length > 0
          ? "failed"
          : st.count === 0
            ? "idle"
            : !finished && latest?.stage === s
              ? "active"
              : "done";
      return [s, state];
    }),
  ) as Record<TimelineStage, NodeState>;
}

/** Short count lines for a stage node, e.g. ["20 decisions", "6 held"]. Counts only. */
export function stageLines(st: StageStats): string[] {
  const lines = (Object.entries(st.byType) as [TimelineEventType, number][])
    .filter(([t]) => t !== "budget" && t !== "run.finished")
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${typeLabel(t, n)}`);
  for (const status of ["held", "escalated"])
    if (st.byStatus[status]) lines.push(`${st.byStatus[status]} ${status}`);
  return lines;
}

export const failureLine = (st: StageStats) =>
  Object.entries(st.failures)
    .map(([why, n]) => `${n} ${why}`)
    .join(" · ");

/* ------------------------------------------------------------------ edges */

export type StageEdge = { id: string; source: TimelineStage; target: TimelineStage };

export const STAGE_EDGES: StageEdge[] = STAGES.slice(1).map((target, i) => ({
  id: `${STAGES[i]}->${target}`,
  source: STAGES[i]!,
  target,
}));

/** Chain edges spanned by a hand-off between two stages (either direction; none when equal). */
export function transitionEdges(from: TimelineStage, to: TimelineStage): string[] {
  const a = STAGES.indexOf(from);
  const b = STAGES.indexOf(to);
  if (a === b) return [];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return STAGE_EDGES.slice(lo, hi).map((e) => e.id);
}

/**
 * Edges to animate after events[prevCount..] arrived: every stage hand-off between consecutive
 * events among the new ones (and from the last old event to the first new one).
 */
export function edgesForNewEvents(
  events: readonly TimelineEvent[],
  prevCount: number,
): string[] {
  const lit = new Set<string>();
  for (let i = Math.max(1, prevCount); i < events.length; i++)
    for (const id of transitionEdges(events[i - 1]!.stage, events[i]!.stage)) lit.add(id);
  return [...lit];
}

/* ------------------------------------------------------------ replay clock */

/**
 * Replay timing: the display gap before each event is its real gap since the previous event,
 * clamped to [REPLAY_MIN_STEP_MS, REPLAY_MAX_STEP_MS], then divided by the speed. Recorded runs
 * have millisecond gaps (too fast to see) and live runs can have minute-long ones (too slow), so
 * small gaps are stretched to the floor and long ones capped; order is unchanged and a longer
 * real gap never displays shorter. The first event appears after one floor step. The feed always
 * shows the real recorded timestamps.
 */
export const REPLAY_MIN_STEP_MS = 200;
export const REPLAY_MAX_STEP_MS = 1600;
export const REPLAY_SPEEDS = [1, 2, 4, 8] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export function displayGap(realGapMs: number): number {
  const gap = Number.isFinite(realGapMs) ? Math.max(0, realGapMs) : 0;
  return Math.min(REPLAY_MAX_STEP_MS, Math.max(REPLAY_MIN_STEP_MS, gap));
}

/** Time (ms at 1×) at which each event appears; offsets[i] is when events[i] is replayed. */
export function replayOffsets(events: readonly Pick<TimelineEvent, "at">[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < events.length; i++) {
    t += i === 0 ? REPLAY_MIN_STEP_MS : displayGap(Date.parse(events[i]!.at) - Date.parse(events[i - 1]!.at));
    out.push(t);
  }
  return out;
}

/** Number of events replayed once `elapsed` ms (at 1×) have passed: offsets ≤ elapsed. */
export function cursorAt(offsets: readonly number[], elapsed: number): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid]! <= elapsed) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Elapsed time (ms at 1×) at which exactly `cursor` events have been replayed. */
export function elapsedAtCursor(offsets: readonly number[], cursor: number): number {
  const c = Math.max(0, Math.min(offsets.length, Math.round(cursor)));
  return c === 0 ? 0 : offsets[c - 1]!;
}

export const replayDuration = (offsets: readonly number[]) => offsets.at(-1) ?? 0;

/** Advance the clock by `dtMs` of wall time at `speed`, never past the end. */
export function advance(elapsed: number, dtMs: number, speed: number, duration: number): number {
  return Math.min(duration, elapsed + Math.max(0, dtMs) * speed);
}

/* ------------------------------------------------------------------- feed */

/** Events of one stage (or all), newest first. */
export function filterFeed(
  events: readonly TimelineEvent[],
  stage: TimelineStage | null,
): TimelineEvent[] {
  const out = stage ? events.filter((e) => e.stage === stage) : [...events];
  return out.reverse();
}

export type RecordLink = {
  kind: "decision" | "probe" | "belief" | "certificate" | "run";
  id: string;
  path: string;
};

/**
 * The record page an event is about, only when the record exists: decisions, probes and
 * beliefs must be in the selected bundle; certificate ids come from the event (they are
 * computed exactly as the certificate export does); budget / run.finished link to the run.
 * Anomalies link to their claim's belief when the bundle has one. `?run=` is always kept.
 */
export function recordLinkFor(
  e: TimelineEvent,
  bundle: Pick<RunBundle, "runId" | "decisions" | "probes" | "beliefs">,
): RecordLink | undefined {
  const run = bundle.runId;
  const decision = (id: string | undefined): RecordLink | undefined =>
    id && bundle.decisions.some((d) => d.id === id)
      ? { kind: "decision", id, path: withRun(recordPath.decision(id), run) }
      : undefined;
  const beliefIds = new Set([...bundle.beliefs.before, ...bundle.beliefs.after].map((b) => b.id));
  const belief = (id: unknown): RecordLink | undefined =>
    typeof id === "string" && beliefIds.has(id)
      ? { kind: "belief", id, path: withRun(recordPath.belief(id), run) }
      : undefined;
  const d = e.data ?? {};
  switch (e.type) {
    case "decision":
      return decision(e.recordIds.find((id) => bundle.decisions.some((x) => x.id === id)));
    case "approval.decided":
      return decision(e.recordIds.find((id) => bundle.decisions.some((x) => x.id === id)));
    case "probe.committed":
    case "probe.verdict": {
      const id = e.recordIds[0];
      return id && bundle.probes.some((p) => p.id === id)
        ? { kind: "probe", id, path: withRun(recordPath.probe(id), run) }
        : undefined;
    }
    case "belief.changed":
    case "adversary.verdict":
      return belief(d.beliefId ?? e.recordIds[0]);
    case "anomaly.detected": {
      const claimId = d.claimId;
      const b = [...bundle.beliefs.after, ...bundle.beliefs.before].find((x) => x.claimId === claimId);
      return belief(b?.id);
    }
    case "certificate.issued":
    case "certificate.revoked":
      return typeof d.certificateId === "string" && d.certificateId
        ? {
            kind: "certificate",
            id: d.certificateId,
            path: withRun(recordPath.certificate(d.certificateId), run),
          }
        : undefined;
    case "budget":
    case "run.finished":
      return { kind: "run", id: run, path: withRun(recordPath.run(run), run) };
  }
}

/** Display form of a record id: without the run prefix ("<runId>:q01", "<runId>-s004") or "belief-". */
export function shortRecordId(link: RecordLink, runId: string): string {
  let id = link.id;
  for (const sep of [":", "-"]) if (id.startsWith(`${runId}${sep}`)) id = id.slice(runId.length + 1);
  if (link.kind === "belief" && id.startsWith("belief-")) id = id.slice("belief-".length);
  return id;
}

export type TraceRef = { id: string; href?: string };

/** The event's traces: a link only when the bundle recorded one (traceLinks), else the id as text. */
export function traceRefs(
  e: Pick<TimelineEvent, "traceIds">,
  bundle: Pick<RunBundle, "traceLinks">,
): TraceRef[] {
  return e.traceIds.map((id) => ({ id, href: safeLink(bundle.traceLinks[id]) }));
}

/** HH:MM:SS.mmm in IST, the timezone every other page uses. */
export function eventTime(at: string): string {
  const d = new Date(at);
  const hms = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  }).format(d);
  return `${hms}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
}

/* ----------------------------------------------------------------- budget */

export type BudgetAt = { snapshot: BudgetSnapshot; seq: number };

/** The latest budget snapshot among the events (budget events, or run.finished's copy). */
export function latestBudget(events: readonly TimelineEvent[]): BudgetAt | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "budget" && e.type !== "run.finished") continue;
    const parsed = BudgetSnapshotSchema.safeParse(e.data?.budget);
    if (parsed.success) return { snapshot: parsed.data, seq: e.seq };
  }
  return undefined;
}

/** First event in the full timeline that carries a budget snapshot (for "arrives at event #n"). */
export const firstBudgetSeq = (events: readonly TimelineEvent[]) =>
  events.find(
    (e) => (e.type === "budget" || e.type === "run.finished") && BudgetSnapshotSchema.safeParse(e.data?.budget).success,
  )?.seq;

export type MeterView = {
  used: string;
  /** "of 200" or "no cap configured". */
  capText: string;
  /** used / cap in [0, 1]; null without a cap. */
  ratio: number | null;
  over: boolean;
};

const count = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n);
export const usdText = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(n);

export function meterView(meter: BudgetMeter, format: (n: number) => string = count): MeterView {
  if (meter.cap === null)
    return { used: format(meter.used), capText: "no cap configured", ratio: null, over: false };
  return {
    used: format(meter.used),
    capText: `of ${format(meter.cap)}`,
    ratio: meter.cap === 0 ? (meter.used > 0 ? 1 : 0) : Math.min(1, meter.used / meter.cap),
    over: meter.used > meter.cap,
  };
}

export const ROLES = RoleSchema.options;

/** USD spend per model role (executor, reflector, adversary) and the total, against usdCap. */
export function usdView(s: BudgetSnapshot): {
  roles: { role: (typeof ROLES)[number]; usd: string; share: number | null }[];
  total: MeterView;
} {
  const total = ROLES.reduce((sum, r) => sum + (s.usdByRole[r] ?? 0), 0);
  return {
    roles: ROLES.map((role) => ({
      role,
      usd: usdText(s.usdByRole[role] ?? 0),
      share: total > 0 ? (s.usdByRole[role] ?? 0) / total : null,
    })),
    total: meterView({ used: total, cap: s.usdCap }, usdText),
  };
}

/* ----------------------------------------------------------------- status */

/** data.status of the latest run.finished event, if one is among the events. */
export function finishedStatus(events: readonly TimelineEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "run.finished" && typeof e.data?.status === "string") return e.data.status;
  }
  return undefined;
}

/* ------------------------------------------------------------ live toasts */

export type LiveToast = {
  tone: "info" | "success" | "error";
  title: string;
  description: string;
  /**
   * Stable per record, not per seq: a live event and its recorded re-emission when the run
   * finishes share it, so one held decision toasts once.
   */
  id: string;
};

/** Which live events deserve a toast: a held decision, a revoked certificate, a finished run, an approval. */
export function toastFor(e: TimelineEvent): LiveToast | null {
  const id = `${e.runId}|${e.type}|${e.recordIds[0] ?? e.seq}`;
  const description = `${e.runId}: ${e.summary}`;
  if (e.type === "decision" && e.data?.status === "held")
    return { tone: "info", title: "Decision held", description, id };
  if (e.type === "certificate.revoked")
    return { tone: "error", title: "Certificate revoked", description, id };
  if (e.type === "approval.decided")
    return { tone: "info", title: "Approval recorded", description, id };
  if (e.type === "run.finished") {
    const status = typeof e.data?.status === "string" ? e.data.status : "finished";
    return {
      tone: FAILED_RUN_STATUSES.has(status) ? "error" : "success",
      title: `Run finished: ${status.replaceAll("_", " ")}`,
      description,
      id,
    };
  }
  return null;
}
