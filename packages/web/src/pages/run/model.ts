// The Run page's pure logic: the transcript row model (titles, marks, durations, costs), row
// details (every statement tagged "Model said" or "Verified" through the trail model), stage
// progress, the budget line, auto-scroll rules, held-card gating, run grouping and the controls
// each mode offers. No React and no DOM here; test/run-page.test.ts runs it against the published
// fixture timelines and bundles.
//
// Honesty rules:
//   - Every title is built here from the event and the records it names; no sample text.
//   - Model names come from the recorded adversary review; nothing assumes a model.
//   - A number shown is a recorded value or a count of recorded events. A price nobody recorded
//     is "unknown", never $0; a cap nobody recorded is "no cap recorded".
//   - Details never show a record's future: a row only reads the record its event names.
import {
  BudgetSnapshotSchema,
  RoleSchema,
  RunStatusSchema,
  TimelineStageSchema,
  ToolSchema,
} from "../../../../core/src/schema";
import type {
  ApprovalRecord,
  ApprovalsList,
  Belief,
  BudgetSnapshot,
  Certificate,
  Decision,
  PendingApproval,
  Probe,
  RunBundle,
  StartRunRequest,
  TimelineEvent,
  TimelineEventType,
  TimelineStage,
} from "../../../../core/src/schema";
import { canonicalJson, sha256Hex } from "../../../../core/src/bundle/hash";
import {
  certificateScopeLines,
  formatValue,
  hypothesisSource,
  modelTextsOf,
  requiredStatus,
  separateModelWords,
  trailLine,
  type RecordRef,
  type TrailLine,
} from "../../components/trail/model";
import { ReplayOnlyError, approvalId, safeLink, type CertificateView, type DataMode, type RunEntry } from "../../data";

/* ------------------------------------------------------------------------------------- stages */

/** Read → Test → Challenge → Certify → Enforce, in the schema's order. */
export const STAGES: readonly TimelineStage[] = TimelineStageSchema.options;

export const STAGE_LABEL: Record<TimelineStage, string> = {
  read: "Read",
  test: "Test",
  challenge: "Challenge",
  certify: "Certify",
  enforce: "Enforce",
};

/** Run statuses that mean the run did not complete (from the schema, not typed by hand: H-43). */
export const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(
  RunStatusSchema.options.filter((s) => s !== "completed"),
);

export type StepState = "idle" | "active" | "done" | "alert";

export type StageStep = {
  stage: TimelineStage;
  label: string;
  state: StepState;
  /** Events at this stage so far. */
  count: number;
  /** The run is at this stage now (latest event, run not finished). */
  current: boolean;
  /** Why the stage is marked: "1 unsafe action", "run failed". */
  alerts: string[];
};

/** Decision ids the deterministic grader marked unsafe. */
export function unsafeDecisionIds(bundle?: Pick<RunBundle, "decisions">): Set<string> {
  return new Set((bundle?.decisions ?? []).filter((d) => (d.grade?.unsafe.length ?? 0) > 0).map((d) => d.id));
}

/**
 * Why an event marks its stage, or null: a decision the grader marked unsafe, a failed approval,
 * or a run that finished failed / stopped on budget / blocked. Revocations and unlearned beliefs
 * are the system working, not a stage failure; their rows carry their own red mark.
 */
export function alertOf(e: TimelineEvent, unsafe: ReadonlySet<string>): string | null {
  const d = e.data ?? {};
  if (e.type === "decision") return e.recordIds.some((id) => unsafe.has(id)) ? "unsafe action" : null;
  if (e.type === "approval.decided") return d.status === "failed" ? "approval failed" : null;
  if (e.type === "run.finished" && typeof d.status === "string" && FAILED_RUN_STATUSES.has(d.status))
    return `run ${words(d.status)}`;
  return null;
}

export const isFinished = (events: readonly TimelineEvent[]) => events.some((e) => e.type === "run.finished" && !isLiveEvent(e));

/**
 * The five-step bar. A step is idle without events, alert when one of its events is an alert
 * (sticky), active while the run is at it, done otherwise. `current` is the latest event's stage
 * while no run.finished has arrived.
 */
export function stageProgress(
  events: readonly TimelineEvent[],
  unsafe: ReadonlySet<string> = new Set(),
): { steps: StageStep[]; current: TimelineStage | null; finished: boolean } {
  const finished = isFinished(events);
  const current = finished ? null : (events.at(-1)?.stage ?? null);
  const steps = STAGES.map((stage): StageStep => {
    const mine = events.filter((e) => e.stage === stage);
    const alertCounts = new Map<string, number>();
    for (const e of mine) {
      const why = alertOf(e, unsafe);
      if (why) alertCounts.set(why, (alertCounts.get(why) ?? 0) + 1);
    }
    const alerts = [...alertCounts].map(([why, n]) => (why.startsWith("run ") ? why : `${n} ${why}${n === 1 ? "" : "s"}`));
    const isCurrent = current === stage;
    const state: StepState = alerts.length ? "alert" : mine.length === 0 ? "idle" : isCurrent ? "active" : "done";
    return { stage, label: STAGE_LABEL[stage], state, count: mine.length, current: isCurrent, alerts };
  });
  return { steps, current, finished };
}

/* -------------------------------------------------------------------------------- live merges */

export const isLiveEvent = (e: TimelineEvent) => e.data?.live === true;

/**
 * Merge stream events into a run's events (sorted by seq). Provisional live events
 * (`data.live: true`) never replace a final event with the same seq; final events replace
 * whatever holds their seq. Events of other runs are ignored.
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

/* --------------------------------------------------------------------------------- formatting */

const words = (s: string) => s.replaceAll("_", " ");

const fmt = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n);
const fmtP = (n: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(n);
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

export const usdText = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n);

/** "USD 29.00" from minor units, using the currency's own number of decimals (Intl). */
export function moneyText(amount: number, currency?: string): string {
  if (!currency) return `${fmt(amount)} minor units (currency not recorded)`;
  try {
    const f = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code" });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(amount / 10 ** digits);
  } catch {
    return `${fmt(amount)} ${currency} minor units`;
  }
}

/** "12 ms", "1.4 s", "2m 05s". */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** One line of text, cut to `max` characters with an ellipsis. */
export function clip(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Display name of a tool the data names ("crustdata" → "Crustdata"); unknown names stay as recorded. */
export function toolName(tool: unknown): string | undefined {
  if (typeof tool !== "string" || !tool) return undefined;
  return (ToolSchema.options as readonly string[]).includes(tool) ? tool.charAt(0).toUpperCase() + tool.slice(1) : tool;
}

/** The tool a claim id belongs to, when its prefix is a known tool ("dodo.refund.x" → "dodo"). */
const toolOfClaim = (claimId: unknown) => {
  if (typeof claimId !== "string") return undefined;
  const prefix = claimId.split(".")[0];
  return (ToolSchema.options as readonly string[]).includes(prefix ?? "") ? prefix : undefined;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/* ------------------------------------------------------------------------------------ records */

/** Record lookups for one bundle (built once per bundle). */
export type RecordIndex = {
  bundle: RunBundle;
  decisions: Map<string, Decision>;
  probes: Map<string, Probe>;
  beliefs: Map<string, Belief>;
};

export function indexBundle(bundle: RunBundle): RecordIndex {
  const beliefs = new Map<string, Belief>();
  for (const b of bundle.beliefs.before) beliefs.set(b.id, b);
  for (const b of bundle.beliefs.after) beliefs.set(b.id, b);
  return {
    bundle,
    decisions: new Map(bundle.decisions.map((d) => [d.id, d])),
    probes: new Map(bundle.probes.map((p) => [p.id, p])),
    beliefs,
  };
}

const claimOfBelief = (beliefId: string, idx?: RecordIndex) =>
  idx?.beliefs.get(beliefId)?.claimId ?? (beliefId.startsWith("belief-") ? beliefId.slice("belief-".length) : beliefId);

/* --------------------------------------------------------------------------------------- rows */

export type RowMark = "spinner" | "check" | "x";
/** Color only for meaning: unsafe/blocked red, safe/certified green, held amber. */
export type RowTone = "neutral" | "safe" | "unsafe" | "held";
export type ActorKind = "tool" | "model" | "code" | "human";
export type Actor = { kind: ActorKind; name: string };

export type RunRow = {
  key: string;
  /** null for the bundle-derived opening row. */
  seq: number | null;
  stage: TimelineStage;
  type: TimelineEventType | "intro";
  at: string;
  title: string;
  /** The record the row is about (claim id, request id), shown muted. */
  subject?: string;
  actor: Actor;
  durationMs?: number;
  cost?: string;
  mark: RowMark;
  tone: RowTone;
  /** A best-effort live event the final timeline will supersede. */
  provisional: boolean;
  /** A held decision: the row carries a held-action card. */
  held: boolean;
  decisionId?: string;
  certificateId?: string;
  event?: TimelineEvent;
};

export type RowContext = {
  /** The run's verified bundle; absent while a live run has not finished. */
  bundle?: RunBundle;
  index?: RecordIndex;
  /** The certificate world of this run (same world only). */
  world?: CertificateView | null;
};

const CODE: Actor = { kind: "code", name: "code" };

const VERDICT_PHRASE: Record<string, string> = {
  uphold: "upheld the belief",
  narrow: "narrowed the scope",
  downgrade: "downgraded the belief",
};

const REQUEST_TYPE: Record<string, string> = {
  refund: "Refund",
  partial_refund: "Partial refund",
  plan_change: "Plan change",
  credit: "Credit",
};

function introRow(bundle: RunBundle): RunRow | undefined {
  if (bundle.kind === "notarize" && bundle.claims.length) {
    const tools = [...new Set(bundle.claims.map((c) => c.tool))].map(toolName).join(" and ");
    return {
      key: "intro",
      seq: null,
      stage: "read",
      type: "intro",
      at: bundle.startedAt,
      title: `Read ${tools} docs — ${plural(bundle.claims.length, "documented claim")} to test`,
      actor: CODE,
      mark: "check",
      tone: "neutral",
      provisional: false,
      held: false,
    };
  }
  if (bundle.kind === "run" && bundle.queue.length)
    return {
      key: "intro",
      seq: null,
      stage: "enforce",
      type: "intro",
      at: bundle.startedAt,
      title: `Read the request queue — ${plural(bundle.queue.length, "request")} to decide`,
      subject: `${bundle.variant} run`,
      actor: CODE,
      mark: "check",
      tone: "neutral",
      provisional: false,
      held: false,
    };
}

function decisionTitle(e: TimelineEvent, d: Decision | undefined, idx?: RecordIndex): { title: string; tone: RowTone; mark: RowMark } {
  const data = e.data ?? {};
  const status = str(data.status) ?? d?.status ?? "decided";
  const type = str(data.requestType) ?? d?.requestType;
  const requestId = str(data.requestId) ?? d?.requestId ?? e.recordIds[0] ?? "request";
  const head = `${type ? (REQUEST_TYPE[type] ?? words(type)) : "Request"} ${requestId} ${words(status)}`;
  const action = str(data.action) ?? d?.action;
  const missing = Array.isArray(data.missingBeliefs)
    ? data.missingBeliefs.filter((x): x is string => typeof x === "string")
    : (d?.missingBeliefs ?? []);
  const guards = Array.isArray(data.guardsApplied)
    ? data.guardsApplied.filter((x): x is string => typeof x === "string")
    : (d?.guardsApplied ?? []);
  const unsafe = d?.grade?.unsafe ?? [];
  let tail: string;
  if (status === "executed") {
    const amount = num(data.amount) ?? d?.effects.find((ef) => ef.amount !== undefined)?.amount;
    const currency = str(data.currency);
    tail = amount !== undefined ? `${moneyText(amount, currency)} via ${action ?? "the recorded action"}` : (action ?? "action recorded");
  } else if (missing.length) {
    tail = `no certificate for ${missing.map((b) => claimOfBelief(b, idx)).join(", ")}`;
  } else if (guards.length) {
    const kinds = guards.map((g) => {
      const guard = idx?.bundle.guards.find((x) => x.id === g);
      return guard ? `${words(guard.kind)} guard ${g}` : `guard ${g}`;
    });
    tail = `${status === "executed" ? "under" : "stopped by"} ${kinds.join(", ")}`;
  } else {
    const outcome = str(data.policyOutcome) ?? d?.policyOutcome;
    const reason = d?.evidencePack?.reason ?? d?.error;
    tail = reason ? clip(reason, 64) : outcome ? `policy ${words(outcome)}` : (action ?? "recorded");
  }
  if (unsafe.length) return { title: `${head} — ${tail}`, tone: "unsafe", mark: "x" };
  if (status === "executed") return { title: `${head} — ${tail}`, tone: "neutral", mark: "check" };
  if (status === "held" || status === "escalated") return { title: `${head} — ${tail}`, tone: "held", mark: "x" };
  return { title: `${head} — ${tail}`, tone: "neutral", mark: "x" };
}

/**
 * The transcript: one row per event (plus, once the bundle is known, an opening row read from
 * its claims or queue). Rows are in seq order. Probe commitments show a spinner until their
 * verdict arrives (an x if the run finished without one).
 */
export function buildRows(events: readonly TimelineEvent[], ctx: RowContext = {}): RunRow[] {
  const idx = ctx.index ?? (ctx.bundle ? indexBundle(ctx.bundle) : undefined);
  const bundle = ctx.bundle;
  const finished = isFinished(events);
  const committedAt = new Map<string, string>();
  const verdicts = new Set<string>();
  for (const e of events) {
    if (e.type === "probe.committed" && e.recordIds[0]) committedAt.set(e.recordIds[0], e.at);
    if (e.type === "probe.verdict" && e.recordIds[0]) verdicts.add(e.recordIds[0]);
  }
  const certById = new Map((ctx.world?.certificates ?? []).map((c) => [c.id, c]));
  const rows: RunRow[] = [];
  const intro = bundle ? introRow(bundle) : undefined;
  if (intro) rows.push(intro);

  for (const e of events) {
    const data = e.data ?? {};
    const claimId = str(data.claimId);
    const base = {
      key: `e${e.seq}${isLiveEvent(e) ? "-live" : ""}`,
      seq: e.seq,
      stage: e.stage,
      type: e.type,
      at: e.at,
      provisional: isLiveEvent(e),
      held: false,
      event: e,
    } as const;
    switch (e.type) {
      case "anomaly.detected": {
        const tool = toolName(data.tool) ?? toolName(toolOfClaim(claimId)) ?? "the tool";
        rows.push({
          ...base,
          title: `Checked ${tool} responses against its docs — mismatch on ${claimId ?? "a documented claim"}`,
          subject: e.recordIds[0],
          actor: { kind: "code", name: "checker" },
          mark: "check",
          tone: "neutral",
        });
        break;
      }
      case "belief.changed": {
        const from = data.from === null ? null : str(data.from);
        const to = str(data.to) ?? "unknown";
        const p = num(data.confidence);
        const pText = p === undefined ? "" : `, P(holds) ${fmtP(p)}`;
        const claim = claimId ?? e.recordIds[1] ?? e.recordIds[0];
        const title =
          from === null
            ? `Opened belief — ${claim} starts as ${words(to)}${pText}`
            : from === to
              ? `Updated belief — ${claim} stays ${words(to)}${pText}`
              : `Belief ${words(from ?? "?")} → ${words(to)} — ${claim}${pText}`;
        const tone: RowTone = to === "unlearned" ? "unsafe" : to === "notarized" && from !== "notarized" ? "safe" : "neutral";
        rows.push({ ...base, title, actor: CODE, mark: to === "unlearned" ? "x" : "check", tone });
        break;
      }
      case "probe.committed": {
        const id = e.recordIds[0];
        const probe = id ? idx?.probes.get(id) : undefined;
        const template = str(data.template) ?? probe?.template;
        const n = num(data.hypotheses) ?? probe?.hypothesisIds.length;
        const done = !!id && verdicts.has(id);
        rows.push({
          ...base,
          title: `Committed prediction — ${claimId ?? "claim"}${template ? ` (${words(template)})` : ""}`,
          subject: [n !== undefined ? plural(n, "rival hypothesis", "rival hypotheses") : undefined, probe ? `sha256 ${probe.predictionHash.slice(0, 12)}…` : undefined]
            .filter(Boolean)
            .join(" · ") || undefined,
          actor: CODE,
          mark: done ? "check" : finished ? "x" : "spinner",
          tone: "neutral",
        });
        break;
      }
      case "probe.verdict": {
        const id = e.recordIds[0];
        const probe = id ? idx?.probes.get(id) : undefined;
        const tool = toolName(probe?.tool) ?? toolName(toolOfClaim(claimId)) ?? "the API";
        const verdict = str(data.verdict) ?? probe?.verdict;
        const cls = str(data.winningClass);
        const observed = probe && probe.observed !== undefined ? clip(formatValue(probe.observed), 56) : undefined;
        const started = id ? committedAt.get(id) : undefined;
        const credits = num(data.costCredits) ?? probe?.costCredits;
        const calls = num(data.calls) ?? probe?.calls;
        rows.push({
          ...base,
          title: observed
            ? `Called ${tool} — observed: ${observed}`
            : `Called ${tool} — ${verdict ? words(verdict) : "no verdict"}${cls ? ` (${words(cls)})` : ""}`,
          subject: [claimId, verdict ? `${words(verdict)}${cls ? `: ${words(cls)}` : ""}` : undefined].filter(Boolean).join(" · "),
          actor: { kind: "tool", name: tool },
          durationMs: started ? Date.parse(e.at) - Date.parse(started) : undefined,
          cost: [credits !== undefined ? plural(credits, "credit") : undefined, calls !== undefined ? plural(calls, "call") : undefined]
            .filter(Boolean)
            .join(" · ") || undefined,
          mark: verdict === "invalid" ? "x" : "check",
          tone: "neutral",
        });
        break;
      }
      case "adversary.verdict": {
        const beliefId = str(data.beliefId) ?? e.recordIds[0];
        const review = beliefId ? idx?.beliefs.get(beliefId)?.adversary : undefined;
        const model = str(data.model) ?? review?.model;
        const verdict = str(data.verdict) ?? review?.verdict;
        const to = str(data.to);
        rows.push({
          ...base,
          title: `Adversary${model ? ` (${model})` : ""} challenged — ${verdict ? (VERDICT_PHRASE[verdict] ?? `verdict ${words(verdict)}`) : "verdict not recorded"}`,
          subject: [claimId, to ? `belief → ${words(to)}` : undefined].filter(Boolean).join(" · "),
          actor: { kind: "model", name: model ?? "model not recorded" },
          mark: verdict === "failed" ? "x" : "check",
          tone: verdict === "failed" ? "unsafe" : "neutral",
        });
        break;
      }
      case "certificate.issued": {
        const certId = str(data.certificateId);
        const cert = certId ? certById.get(certId) : undefined;
        const scope = cert ? scopeShort(cert) : undefined;
        rows.push({
          ...base,
          title: `Certificate issued — ${claimId ?? "claim"}${scope ? ` (scope: ${scope})` : ""}`,
          subject: certId,
          actor: CODE,
          mark: "check",
          tone: "safe",
          certificateId: certId,
        });
        break;
      }
      case "certificate.revoked": {
        const certId = str(data.certificateId);
        const to = str(data.to);
        rows.push({
          ...base,
          title: `Certificate revoked — ${claimId ?? "claim"}${to ? ` is now ${words(to)}` : ""}`,
          subject: certId ?? "certificate id not computed for this bundle",
          actor: CODE,
          mark: "x",
          tone: "unsafe",
          certificateId: certId,
        });
        break;
      }
      case "decision": {
        const decisionId = e.recordIds[0];
        const d = decisionId ? idx?.decisions.get(decisionId) : undefined;
        const { title, tone, mark } = decisionTitle(e, d, idx);
        const status = str(data.status) ?? d?.status;
        const action = str(data.action) ?? d?.action;
        const effects = num(data.effects) ?? d?.effects.length;
        const times = (d?.effects ?? []).map((ef) => Date.parse(ef.at)).filter(Number.isFinite);
        const acts = action && action !== "none" ? action : undefined;
        const unsafe = d?.grade?.unsafe ?? [];
        const tier = d ? d.tier : str(data.tier);
        rows.push({
          ...base,
          title,
          subject: [
            unsafe.length ? `graded unsafe: ${unsafe.map(words).join(", ")}` : undefined,
            acts,
            tier ? `tier ${words(tier)}` : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
          actor: acts ? { kind: "tool", name: toolName(acts.split(".")[0]) ?? acts } : { kind: "code", name: "policy" },
          durationMs: times.length > 1 ? Math.max(...times) - Math.min(...times) : undefined,
          cost: effects !== undefined ? plural(effects, "call") : undefined,
          mark,
          tone,
          held: status === "held",
          decisionId,
        });
        break;
      }
      case "budget": {
        const snap = BudgetSnapshotSchema.safeParse(data.budget);
        rows.push({
          ...base,
          title: snap.success ? `Budget — ${budgetSentence(snap.data)}` : "Budget — snapshot does not match the schema",
          actor: CODE,
          mark: snap.success ? "check" : "x",
          tone: "neutral",
        });
        break;
      }
      case "approval.decided": {
        const decision = str(data.decision);
        const status = str(data.status);
        const decisionId = e.recordIds[1];
        const requestId = (decisionId ? idx?.decisions.get(decisionId)?.requestId : undefined) ?? decisionId ?? "held action";
        rows.push({
          ...base,
          title: `Human ${decision ?? "decision"} ${requestId}${status ? ` — ${words(status)}` : ""}`,
          subject: e.recordIds[0],
          actor: { kind: "human", name: "reviewer" },
          mark: status === "failed" ? "x" : "check",
          tone: status === "failed" ? "unsafe" : "neutral",
          decisionId,
        });
        break;
      }
      case "run.finished": {
        const status = str(data.status) ?? "finished";
        const failed = FAILED_RUN_STATUSES.has(status);
        const what = bundle?.kind === "notarize" ? "Notarization" : bundle?.kind === "run" ? "Run" : "Run";
        rows.push({
          ...base,
          title: `${what} finished — ${words(status)}${bundle?.stopReason ? `: ${clip(bundle.stopReason, 64)}` : ""}`,
          actor: CODE,
          mark: failed ? "x" : "check",
          tone: failed ? "unsafe" : "neutral",
        });
        break;
      }
    }
  }
  return rows;
}

/** Scope in a few words, from the as-probed scope code computed (never the adversary's text). */
export function scopeShort(c: Certificate): string {
  const ap = c.scope.asProbed;
  const ops = ap.operations.length ? ap.operations.join(", ") : c.claim.operation;
  return `${ops}${ap.currencies.length ? ` in ${ap.currencies.join(", ")}` : ""}`;
}

/* ------------------------------------------------------------------------------------- budget */

export function budgetSentence(s: BudgetSnapshot): string {
  const credits = `${fmt(s.credits.used)}${s.credits.cap === null ? "" : ` of ${fmt(s.credits.cap)}`} credits`;
  const calls = `${plural(s.toolCalls.used, "tool call")}`;
  return `${credits} · ${calls}`;
}

export type BudgetView = {
  /** Seq of the snapshot shown. */
  seq: number;
  credits: { used: number; cap: number | null };
  toolCalls: { used: number; cap: number | null };
  usd: {
    /** Sum of the recorded USD of the roles the snapshot lists. */
    recorded: number;
    /** "$0.0012 recorded", or "unknown — 10 model calls without a recorded price". */
    text: string;
    /** True when some model calls have no recorded price (the total is a lower bound). */
    unknown: boolean;
    cap: number | null;
    /** "of $0.50 (NOTARY_MAX_USD)" or "no cap recorded". */
    capText: string;
    roles: { role: string; text: string }[];
  };
};

/**
 * The latest budget snapshot among the events (budget events or run.finished's copy). Role usage
 * from the bundle (calls per role) is used only when the caller passes it — after run.finished —
 * to tell a real $0 (no calls) from an unknown price (calls recorded at $0, DECISIONS #143).
 * The cap is the snapshot's usdCap (set only when a USD cap stopped the run, #144); otherwise
 * "no cap recorded", never "no cap".
 */
export function budgetView(events: readonly TimelineEvent[], usage?: RunBundle["usageByRole"]): BudgetView | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "budget" && e.type !== "run.finished") continue;
    const parsed = BudgetSnapshotSchema.safeParse(e.data?.budget);
    if (!parsed.success) continue;
    const s = parsed.data;
    const roles = RoleSchema.options.map((role) => {
      const usd = s.usdByRole[role];
      const calls = usage?.[role].calls;
      if (usd === undefined) return { role, text: "not recorded", unknownCalls: 0, usd: 0 };
      if (calls !== undefined && calls > 0 && usd === 0)
        return { role, text: `unknown price · ${plural(calls, "call")}`, unknownCalls: calls, usd };
      return { role, text: `${usdText(usd)}${calls !== undefined ? ` · ${plural(calls, "call")}` : ""}`, unknownCalls: 0, usd };
    });
    const recorded = roles.reduce((sum, r) => sum + r.usd, 0);
    const unknownCalls = roles.reduce((n, r) => n + r.unknownCalls, 0);
    return {
      seq: e.seq,
      credits: s.credits,
      toolCalls: s.toolCalls,
      usd: {
        recorded,
        unknown: unknownCalls > 0,
        text:
          unknownCalls > 0
            ? `unknown — ${plural(unknownCalls, "model call")} without a recorded price${recorded > 0 ? ` (at least ${usdText(recorded)})` : ""}`
            : `${usdText(recorded)} recorded`,
        cap: s.usdCap,
        capText: s.usdCap === null ? "no cap recorded" : `of ${usdText(s.usdCap)} (NOTARY_MAX_USD)`,
        roles: roles.map(({ role, text }) => ({ role, text })),
      },
    };
  }
  return null;
}

/* ------------------------------------------------------------------------------- row details */

export type DetailColumn = { title: string; lines: TrailLine[] };
export type RowDetails = {
  /** Prediction vs observation (or docs vs observed), side by side. */
  compare?: { left: DetailColumn; right: DetailColumn };
  lines: TrailLine[];
};

const EXCERPT = 360;
const excerpt = (v: unknown) => clip(formatValue(v), EXCERPT);

/** The code-written event summary, when no record is available (a live provisional event). */
function summaryLine(e: TimelineEvent): TrailLine {
  return trailLine(e.type === "adversary.verdict" ? "adversary" : "record", {
    key: "summary",
    label: e.type === "adversary.verdict" ? "Adversary (recorded summary)" : "Recorded summary",
    text: e.summary,
    detail: isLiveEvent(e) ? "provisional live event; the final timeline supersedes it" : undefined,
  });
}

function traceOf(e: TimelineEvent, bundle?: RunBundle) {
  const id = e.traceIds[0];
  if (!id) return {};
  const url = safeLink(bundle?.traceLinks[id]);
  return url ? { traceId: id, traceUrl: url } : { traceId: id };
}

function predictionLines(probe: Probe, bundle: RunBundle, ref: RecordRef, trace: ReturnType<typeof traceOf>): TrailLine[] {
  const recomputed = sha256Hex(canonicalJson(probe.prediction));
  const ok = recomputed === probe.predictionHash;
  const committedFirst = probe.ranAt ? probe.committedAt <= probe.ranAt : undefined;
  const warn = [
    !ok && `prediction hash mismatch: recomputed ${recomputed.slice(0, 12)}…`,
    committedFirst === false && `committed at ${probe.committedAt}, after the call at ${probe.ranAt}`,
  ].filter(Boolean);
  const out: TrailLine[] = [];
  for (const [hid, predicted] of Object.entries(probe.prediction)) {
    const h = bundle.hypotheses.find((x) => x.id === hid);
    if (h)
      out.push(
        trailLine(hypothesisSource(h), {
          key: `hyp-${hid}`,
          label: `Hypothesis · ${words(h.class)}`,
          text: h.statement,
          detail: hid,
        }),
      );
    out.push(
      trailLine("prediction", {
        key: `pred-${hid}`,
        label: `Predicted${probe.winningHypothesisId === hid ? " · winner" : ""}`,
        text: excerpt(predicted),
        detail: hid,
        record: ref,
        ...trace,
      }),
    );
  }
  out.push(
    trailLine("prediction", {
      key: "pred-hash",
      label: "Commitment",
      text: `sha256 ${probe.predictionHash.slice(0, 12)}…${ok ? " (recomputed, matches)" : ""}`,
      detail: `committed ${probe.committedAt}${probe.ranAt ? ` · ran ${probe.ranAt}` : " · not run"}`,
      warning: warn.length ? warn.join("; ") : undefined,
      record: ref,
    }),
  );
  return out;
}

function requestLines(probe: Probe, ref: RecordRef, trace: ReturnType<typeof traceOf>): TrailLine[] {
  const out = [
    trailLine("probe.request", {
      key: "params",
      label: `Request · ${words(probe.template)}`,
      text: excerpt(probe.params),
      detail: `${plural(probe.calls, "call")} · ${plural(probe.costCredits, "credit")}`,
      record: ref,
      ...trace,
    }),
  ];
  if (probe.control)
    out.push(
      trailLine("probe.request", { key: "control", label: "Control request", text: excerpt(probe.control.params), record: ref }),
      trailLine("observation", {
        key: "control-observed",
        label: "Control observed",
        text: probe.control.observed === undefined ? "not recorded" : excerpt(probe.control.observed),
        record: ref,
      }),
    );
  return out;
}

/** The status change reason, with an adversary's own words moved out of the Verified line. */
function beliefReasonLine(reason: string, belief: Belief | undefined, ref: RecordRef, modelTexts: readonly string[]): TrailLine {
  const own = [belief?.adversary?.reason, belief?.adversary?.scope].filter((t): t is string => !!t && t.length >= 12);
  const split = separateModelWords("belief.event", reason, [...own, ...modelTexts]);
  // An adversary event whose words could not be separated is "Model said" as a whole.
  const source = split.text === reason && reason.startsWith("adversary ") ? "adversary" : split.source;
  return trailLine(source, { key: "reason", label: "Reason recorded", text: split.text, record: ref });
}

/**
 * The expanded row: what happened, as tagged statements. Model output (reflector hypotheses,
 * adversary reasons, narrowed scope text) is "Model said"; anything computed by code or observed
 * from an API is "Verified". Raw chain-of-thought is never recorded, so never shown.
 */
export function rowDetails(row: RunRow, ctx: RowContext = {}): RowDetails {
  const bundle = ctx.bundle;
  const idx = ctx.index ?? (bundle ? indexBundle(bundle) : undefined);
  const e = row.event;
  if (row.type === "intro" && bundle) {
    if (bundle.kind === "notarize")
      return {
        lines: bundle.claims.map((c) =>
          trailLine("claim", {
            key: `claim-${c.id}`,
            label: c.id,
            text: c.docText,
            detail: [c.operation, c.endpoint, `expect ${formatValue(c.expect)}`].filter(Boolean).join(" · "),
            href: safeLink(c.docUrl),
          }),
        ),
      };
    return {
      lines: bundle.queue.map((q) =>
        trailLine("request", {
          key: `req-${q.id}`,
          label: q.id,
          text: `${REQUEST_TYPE[q.type] ?? words(q.type)} · plan ${q.plan}${q.amount !== undefined ? ` · ${moneyText(q.amount, q.currency)}` : ""}`,
          detail: q.companyDomain,
        }),
      ),
    };
  }
  if (!e) return { lines: [] };
  const data = e.data ?? {};
  const trace = traceOf(e, bundle);

  switch (e.type) {
    case "anomaly.detected": {
      const anomaly = bundle?.anomalies.find((a) => a.id === e.recordIds[0]);
      const claim = bundle?.claims.find((c) => c.id === (anomaly?.claimId ?? data.claimId));
      if (!anomaly) return { lines: [summaryLine(e)] };
      return {
        compare: {
          left: {
            title: "Docs say",
            lines: [
              ...(claim ? [trailLine("claim", { key: "doc", label: "Documented", text: claim.docText, href: safeLink(claim.docUrl) })] : []),
              trailLine("anomaly", { key: "expected", label: "Expected", text: excerpt(anomaly.expected) }),
            ],
          },
          right: {
            title: "Recorded response",
            lines: [trailLine("anomaly", { key: "observed", label: "Observed", text: excerpt(anomaly.observed), ...trace })],
          },
        },
        lines: [
          trailLine("anomaly", {
            key: "checker",
            label: "Checker",
            text: `The deterministic checker compared the recorded ${anomaly.tool} exchange with ${anomaly.claimId}.`,
            detail: anomaly.exchangeId ? `exchange ${anomaly.exchangeId}` : undefined,
          }),
        ],
      };
    }
    case "probe.committed":
    case "probe.verdict": {
      const probe = e.recordIds[0] ? idx?.probes.get(e.recordIds[0]) : undefined;
      if (!probe || !bundle) return { lines: [summaryLine(e)] };
      const ref: RecordRef = { kind: "probe", id: probe.id, runId: bundle.runId };
      const predicted = predictionLines(probe, bundle, ref, trace);
      if (e.type === "probe.committed")
        return { lines: [...predicted, ...requestLines(probe, ref, trace)] };
      const winner = probe.winningHypothesisId ? bundle.hypotheses.find((h) => h.id === probe.winningHypothesisId) : undefined;
      return {
        compare: {
          left: { title: "Predicted (committed first)", lines: predicted },
          right: {
            title: "Observed",
            lines: [
              trailLine("observation", {
                key: "observed",
                label: `Observed · ${words(probe.template)}`,
                text: probe.observed === undefined ? "Not observed (the probe did not run)." : excerpt(probe.observed),
                record: ref,
                ...trace,
              }),
              trailLine("verdict", {
                key: "verdict",
                label: "Verdict",
                text: probe.verdict
                  ? `${words(probe.verdict)}${probe.winningHypothesisId ? ` → ${probe.winningHypothesisId}${winner ? ` (${words(winner.class)})` : ""}` : ""}`
                  : "No verdict recorded.",
                status: probe.verdict,
                record: ref,
              }),
            ],
          },
        },
        lines: requestLines(probe, ref, trace),
      };
    }
    case "belief.changed": {
      const beliefId = str(data.beliefId) ?? e.recordIds[0] ?? "";
      const belief = idx?.beliefs.get(beliefId);
      const ref: RecordRef = { kind: "belief", id: beliefId, runId: bundle?.runId };
      const alpha = num(data.alpha);
      const beta = num(data.beta);
      const p = num(data.confidence);
      const lines: TrailLine[] = [
        trailLine("belief.math", {
          key: "math",
          label: "Belief",
          text: `${alpha !== undefined && beta !== undefined ? `Beta(${fmt(alpha)}, ${fmt(beta)}) · ` : ""}P(holds) = ${p === undefined ? "not recorded" : fmt(p)}`,
          status: str(data.to),
          detail: belief?.statement,
          record: ref,
        }),
      ];
      const ev = bundle?.beliefEvents.find(
        (x) => x.beliefId === beliefId && x.at === e.at && x.to === data.to && (data.probeId === undefined || x.probeId === data.probeId),
      );
      if (ev) lines.push(beliefReasonLine(ev.reason, belief, ref, bundle ? modelTextsOf([bundle], ctx.world ?? undefined) : []));
      else lines.push(summaryLine(e));
      return { lines };
    }
    case "adversary.verdict": {
      const beliefId = str(data.beliefId) ?? e.recordIds[0] ?? "";
      const belief = idx?.beliefs.get(beliefId);
      const review = belief?.adversary;
      const ref: RecordRef = { kind: "belief", id: beliefId, runId: bundle?.runId };
      const lines: TrailLine[] = [];
      if (review)
        lines.push(
          trailLine("adversary", {
            key: "review",
            label: `Adversary · ${words(review.verdict)}`,
            text: review.reason,
            status: review.verdict,
            detail: [`model ${review.model}`, review.backend && `backend ${review.backend}`, review.scope && `scope ${review.scope}`]
              .filter(Boolean)
              .join(" · "),
            record: ref,
          }),
        );
      else lines.push(summaryLine(e));
      if (str(data.to))
        lines.push(
          trailLine("belief.event", {
            key: "applied",
            label: "Applied by code",
            text: `Belief status set to ${words(str(data.to)!)} from the Adversary's verdict.`,
            record: ref,
          }),
        );
      return { lines };
    }
    case "certificate.issued":
    case "certificate.revoked": {
      const certId = str(data.certificateId);
      const cert = certId ? ctx.world?.certificates.find((c) => c.id === certId) : undefined;
      const ref: RecordRef | undefined = certId ? { kind: "certificate", id: certId, runId: bundle?.runId } : undefined;
      const lines: TrailLine[] = [];
      if (e.type === "certificate.revoked") {
        const rev = ctx.world?.revocations.find((r) => r.id === data.revocationId);
        const reason = rev ? separateModelWords("revocation", rev.reason, modelTextsOf(bundle ? [bundle] : [], ctx.world ?? undefined)) : undefined;
        if (rev && reason)
          lines.push(
            trailLine(reason.source, {
              key: "revocation",
              label: `Revoked ${rev.id}`,
              text: reason.text,
              status: rev.to,
              detail: `revoked ${rev.revokedAt} · Beta(${fmt(rev.alpha)}, ${fmt(rev.beta)}) · trigger probes ${rev.triggerProbeIds.join(", ")}${rev.guardsRetired.length ? ` · guards retired ${rev.guardsRetired.map((g) => g.id).join(", ")}` : ""}`,
              record: ref,
              ...trace,
            }),
          );
        else lines.push(summaryLine(e));
      }
      if (cert) {
        lines.push(
          trailLine("certificate", {
            key: "certificate",
            label: `Certificate ${cert.id}`,
            text: cert.verdict,
            status: cert.status,
            detail: `${words(cert.side)} · Beta(${fmt(cert.alpha)}, ${fmt(cert.beta)}) · issued ${cert.issuedAt} · seal ${cert.sha256.slice(0, 12)}…`,
            record: ref,
          }),
          ...certificateScopeLines(cert, bundle ? [bundle] : [], ref),
        );
      } else if (e.type === "certificate.issued") {
        lines.push(summaryLine(e));
      }
      return { lines };
    }
    case "decision": {
      const d = e.recordIds[0] ? idx?.decisions.get(e.recordIds[0]) : undefined;
      if (!d || !bundle) return { lines: [summaryLine(e)] };
      const ref: RecordRef = { kind: "decision", id: d.id, runId: bundle.runId };
      const request = bundle.queue.find((q) => q.id === d.requestId);
      const lines: TrailLine[] = [];
      if (request)
        lines.push(
          trailLine("request", {
            key: "request",
            label: "Request",
            text: `${REQUEST_TYPE[request.type] ?? words(request.type)} · plan ${request.plan}${request.amount !== undefined ? ` · ${moneyText(request.amount, request.currency)}` : ""} · ${request.companyDomain}`,
            detail: request.reason,
            record: ref,
          }),
        );
      lines.push(
        trailLine("tier", {
          key: "tier",
          label: "Tier",
          text: words(d.tier),
          detail: typeof d.enrichment?.tierBasis === "string" ? `basis ${d.enrichment.tierBasis}` : "basis not recorded",
          record: ref,
        }),
        trailLine("policy", {
          key: "policy",
          label: "Policy",
          text: `${words(d.policyOutcome)} · action ${d.action} · ${words(d.status)}`,
          status: d.status,
          record: ref,
          ...trace,
        }),
      );
      const modelTexts = modelTextsOf([bundle], ctx.world ?? undefined);
      for (const b of d.requiredBeliefs) {
        const s = requiredStatus(ctx.world ?? undefined, b, idx?.beliefs.get(b)?.claimId);
        const missing = d.missingBeliefs.includes(b);
        const noCert = s.noCertificate ? separateModelWords("certificate", s.noCertificate.reason, modelTexts) : undefined;
        lines.push(
          trailLine(!ctx.world ? "record" : !s.certificate && noCert ? noCert.source : "certificate", {
            key: `req-${b}`,
            label: `Needs ${claimOfBelief(b, idx)}`,
            text: !ctx.world
              ? "Certificate status unavailable for this run's world."
              : s.certificate
                ? `${s.certificate.id}: ${s.certificate.verdict}`
                : (noCert?.text ?? "No certificate and no certificate record for this belief."),
            status: ctx.world ? s.status : undefined,
            detail: missing ? "missing at decision time" : "present at decision time",
            record: s.certificate ? { kind: "certificate", id: s.certificate.id, runId: bundle.runId } : undefined,
            decisive: missing,
          }),
        );
      }
      for (const gid of d.guardsApplied) {
        const g = bundle.guards.find((x) => x.id === gid);
        lines.push(
          trailLine("guard", {
            key: `guard-${gid}`,
            label: g ? `Guard ${gid} · ${words(g.kind)}` : `Guard ${gid}`,
            text: g ? g.reason : "Guard definition not included in this bundle.",
            detail: g ? `${g.operation} · ${g.active ? "active" : "retired"}` : undefined,
            record: ref,
          }),
        );
      }
      if (d.evidencePack)
        lines.push(trailLine("evidence-pack", { key: "pack", label: "Reason recorded", text: d.evidencePack.reason, record: ref }));
      if (d.error && d.error !== d.evidencePack?.reason)
        lines.push(trailLine("evidence-pack", { key: "error", label: "Error recorded", text: d.error, record: ref }));
      d.effects.forEach((ef, i) =>
        lines.push(
          trailLine("effect", {
            key: `effect-${i}`,
            label: `Call ${i + 1} · ${ef.op}`,
            text: `${ef.status === null ? "outcome unknown (no response)" : `HTTP ${ef.status}`}${ef.amount !== undefined ? ` · ${moneyText(ef.amount, ef.currency)}` : ""}${ef.resultId ? ` · ${ef.resultId}` : ""}`,
            detail: `${ef.at} · request ${excerpt(ef.params)}`,
            record: ref,
          }),
        ),
      );
      if (d.grade)
        lines.push(
          trailLine("grade", {
            key: "grade",
            label: "Grade",
            text: `${d.grade.correct ? "correct" : "not correct"} · expected ${words(d.grade.expectedOutcome)}`,
            status: d.grade.unsafe.length ? "unsafe" : undefined,
            warning: d.grade.unsafe.length ? `Graded unsafe: ${d.grade.unsafe.map(words).join(", ")}` : undefined,
            record: ref,
          }),
        );
      return { lines };
    }
    case "budget": {
      const view = budgetView([e]);
      if (!view) return { lines: [summaryLine(e)] };
      return {
        lines: [
          trailLine("budget", {
            key: "credits",
            label: "Credits",
            text: `${fmt(view.credits.used)} ${view.credits.cap === null ? "(no credit cap recorded)" : `of ${fmt(view.credits.cap)}`}`,
          }),
          trailLine("budget", {
            key: "calls",
            label: "Tool calls",
            text: `${fmt(view.toolCalls.used)} (probe calls + decision effects)${view.toolCalls.cap === null ? "" : ` of ${fmt(view.toolCalls.cap)}`}`,
          }),
          ...view.usd.roles.map((r) =>
            trailLine("budget", { key: `usd-${r.role}`, label: `Model spend · ${r.role}`, text: r.text }),
          ),
        ],
      };
    }
    case "approval.decided":
      return {
        lines: [
          trailLine("approval", {
            key: "approval",
            label: "Human override",
            text: `${str(data.decision) ?? "decided"} · ${str(data.status) ?? "status not recorded"}${num(data.amount) !== undefined ? ` · confirmed ${moneyText(num(data.amount)!, str(data.currency))}` : ""}`,
            detail: e.recordIds.join(" · "),
            ...trace,
          }),
        ],
      };
    case "run.finished":
      return {
        lines: [
          trailLine("run", {
            key: "status",
            label: "Status",
            text: words(str(data.status) ?? "not recorded"),
            detail: bundle?.stopReason,
            status: str(data.status),
          }),
          ...(bundle && bundle.disclosure.length
            ? bundle.disclosure.map((text, i) => trailLine("record", { key: `disclosure-${i}`, label: "Disclosure", text }))
            : []),
        ],
      };
  }
  return { lines: [summaryLine(e)] };
}

/* --------------------------------------------------------------------------------- held cards */

export type HeldCard =
  | {
      kind: "actionable";
      pending: PendingApproval;
      id: string;
      amountText: string;
      reason: string;
      evidence: string[];
    }
  | { kind: "readonly"; reason: string; why: string; evidence: string[] }
  | { kind: "decided"; record: ApprovalRecord; reason: string; evidence: string[] };

export type HeldContext = {
  mode: DataMode;
  sample: boolean;
  bundle?: RunBundle;
  world?: CertificateView | null;
  /** The approvals list, or null when it is not loaded (yet, or it failed). */
  approvals: ApprovalsList | null;
  /** Why the approvals list is not loaded (shown on read-only cards). */
  approvalsError?: string;
};

/** Evidence summary for a held decision: what was missing, which guards stopped it, as recorded. */
export function heldEvidence(d: Decision | undefined, ctx: Pick<HeldContext, "bundle" | "world">, idx?: RecordIndex): string[] {
  if (!d) return [];
  const out: string[] = [];
  for (const b of d.missingBeliefs) {
    const s = requiredStatus(ctx.world ?? undefined, b, idx?.beliefs.get(b)?.claimId);
    const claim = claimOfBelief(b, idx);
    out.push(
      !ctx.world
        ? `No notarized belief for ${claim} at decision time.`
        : s.status === "revoked"
          ? `Certificate ${s.certificate!.id} for ${claim} was revoked.`
          : s.status === "certified"
            ? `${claim} was not notarized at decision time (certificate ${s.certificate!.id} is active now).`
            : `No certificate for ${claim}${s.noCertificate ? ` (${words(s.noCertificate.kind)})` : ""}.`,
    );
  }
  for (const gid of d.guardsApplied) {
    const g = ctx.bundle?.guards.find((x) => x.id === gid);
    out.push(g ? `Guard ${gid} (${words(g.kind)}) on ${g.operation}.` : `Guard ${gid}.`);
  }
  return out;
}

/**
 * The card under a held decision row. Only held decisions get one. Approve / Reject exist only in
 * live mode, for a real (non-fixture) run whose decision is in the server's pending list, with Dodo
 * in test mode; everything else is read-only and says why. A decided record replaces the buttons.
 */
export function heldCard(row: RunRow, ctx: HeldContext): HeldCard | null {
  if (!row.held || !row.decisionId) return null;
  const idx = ctx.bundle ? indexBundle(ctx.bundle) : undefined;
  const d = idx?.decisions.get(row.decisionId);
  const runId = row.event?.runId ?? ctx.bundle?.runId ?? "";
  const pending = ctx.approvals?.pending.find((p) => p.runId === runId && p.decisionId === row.decisionId);
  const reason = pending?.reason ?? d?.error ?? d?.evidencePack?.reason ?? row.event?.summary ?? "held";
  const evidence = heldEvidence(d, ctx, idx);
  if (ctx.mode === "replay")
    return { kind: "readonly", reason, evidence, why: new ReplayOnlyError("Approving or rejecting a held action").message };
  if (ctx.sample)
    return { kind: "readonly", reason, evidence, why: "Recorded fixture: approvals exist only for real runs on a local `notary serve`." };
  const decided = ctx.approvals?.decided.find((r) => r.runId === runId && r.decisionId === row.decisionId);
  if (decided) return { kind: "decided", record: decided, reason, evidence };
  if (!ctx.approvals)
    return { kind: "readonly", reason, evidence, why: ctx.approvalsError ?? "Loading the approval list…" };
  if (!ctx.approvals.testMode)
    return { kind: "readonly", reason, evidence, why: "The server is not in Dodo test mode, so approvals are disabled." };
  if (!pending)
    return { kind: "readonly", reason, evidence, why: "Not in the server's pending list (already decided elsewhere, or not approvable)." };
  return {
    kind: "actionable",
    pending,
    id: pending.id ?? approvalId(pending.runId, pending.decisionId),
    amountText: pending.amount === undefined ? "unknown" : moneyText(pending.amount, pending.currency),
    reason,
    evidence,
  };
}

/* ---------------------------------------------------------------------------- certificates rail */

export type TouchedCertificate = {
  id: string;
  claimId?: string;
  tool?: string;
  /** What happened to it in this run's events so far. */
  inRun: "issued" | "revoked" | "issued, then revoked";
  /** Its status in the certificate world now; undefined when the world does not list it. */
  current?: Certificate["status"];
  seq: number;
};

/** Certificates this run's events issued or revoked (so far), with their status in the world. */
export function certificatesTouched(events: readonly TimelineEvent[], world?: CertificateView | null): TouchedCertificate[] {
  const out = new Map<string, TouchedCertificate>();
  for (const e of events) {
    if (e.type !== "certificate.issued" && e.type !== "certificate.revoked") continue;
    const id = str(e.data?.certificateId);
    if (!id) continue;
    const prev = out.get(id);
    const kind = e.type === "certificate.issued" ? "issued" : "revoked";
    const inRun: TouchedCertificate["inRun"] = prev && prev.inRun !== kind ? "issued, then revoked" : kind;
    const cert = world?.certificates.find((c) => c.id === id);
    out.set(id, {
      id,
      claimId: str(e.data?.claimId) ?? cert?.claimId,
      tool: str(e.data?.tool) ?? cert?.tool,
      inRun,
      current: cert?.status,
      seq: prev?.seq ?? e.seq,
    });
  }
  return [...out.values()].sort((a, b) => a.seq - b.seq);
}

/* ------------------------------------------------------------------------------- auto-scroll */

/** How close to the bottom (px) still counts as "at the latest row". */
export const FOLLOW_THRESHOLD_PX = 48;

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };
export type FollowState = { follow: boolean; unseen: number };

export const INITIAL_FOLLOW: FollowState = { follow: true, unseen: 0 };

export const isAtBottom = (m: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX) =>
  m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;

/**
 * A scroll happened. Back at the bottom → follow again. Moved up (scrollTop decreased) and not at
 * the bottom → the user is reading: stop following. Anything else (the list re-measuring rows,
 * a programmatic scroll down) keeps the current state.
 */
export function afterScroll(state: FollowState, m: ScrollMetrics, previousTop: number): FollowState {
  if (isAtBottom(m)) return { follow: true, unseen: 0 };
  if (m.scrollTop < previousTop) return { follow: false, unseen: state.unseen };
  return state;
}

/** Rows arrived: following → stay at the bottom; scrolled up → count them for "Jump to latest". */
export function afterRowsAdded(state: FollowState, added: number): FollowState {
  if (added <= 0) return state;
  return state.follow ? state : { follow: false, unseen: state.unseen + added };
}

export const jumpToLatest = (): FollowState => ({ follow: true, unseen: 0 });

/* --------------------------------------------------------------------------- replay speeds */

export const REPLAY_SPEEDS = [1, 4, "instant"] as const;
export type Speed = (typeof REPLAY_SPEEDS)[number];

export const speedLabel = (s: Speed) => (s === "instant" ? "Instant" : `${s}×`);

export function parseSpeed(value: string | null | undefined): Speed {
  if (value === "4") return 4;
  if (value === "instant") return "instant";
  return 1;
}

/* ---------------------------------------------------------------------------- runs, controls */

export type RunGroups = { real: RunEntry[]; fixture: RunEntry[] };

/** Real runs (finished and running) and fixture runs, never mixed in one group. */
export function groupRuns(runs: readonly RunEntry[]): RunGroups {
  return {
    real: runs.filter((r) => r.state === "running" || !r.sample),
    fixture: runs.filter((r) => r.state === "finished" && r.sample),
  };
}

export const isFixtureRun = (r?: RunEntry) => r?.state === "finished" && r.sample;

export function runLabel(r: RunEntry): string {
  if (r.state === "running") return `${r.runId} · ${r.kind} · running`;
  return `${r.runId} · ${r.kind === "run" ? `${r.variant} run` : r.kind} · ${words(r.status)}`;
}

/** The ?run= run when listed, else the newest real run, else the newest fixture run. */
export function pickRun(runs: readonly RunEntry[], requested: string | null): RunEntry | undefined {
  if (requested) {
    const hit = runs.find((r) => r.runId === requested);
    if (hit) return hit;
  }
  const { real, fixture } = groupRuns(runs);
  return real[0] ?? fixture[0];
}

export type RunControls = {
  start: { visible: boolean; note?: string };
  /** Replay speed buttons: replay mode, or a fixture run (always a recorded replay). */
  speed: { visible: boolean; note?: string };
  approvals: { actionable: boolean; note?: string };
};

/** Which controls a mode offers. Live-only controls do not render in replay. */
export function runControls(mode: DataMode, entry?: RunEntry): RunControls {
  if (mode === "replay")
    return {
      start: { visible: false, note: new ReplayOnlyError("Starting a run").message },
      speed: { visible: true },
      approvals: { actionable: false, note: new ReplayOnlyError("Approving a held action").message },
    };
  const fixture = isFixtureRun(entry);
  return {
    start: { visible: true },
    speed: fixture
      ? { visible: true, note: "Recorded fixtures replay their timeline." }
      : { visible: false, note: "Live stream from notary serve." },
    approvals: fixture
      ? { actionable: false, note: "Recorded fixtures cannot be approved." }
      : { actionable: true },
  };
}

/** Start-run choices: a guarded queue run, or a notarization per tool the schema knows. */
export type StartChoice = { value: string; label: string; req: StartRunRequest };
export const START_CHOICES: readonly StartChoice[] = [
  { value: "queue:guarded", label: "Queue run (guarded)", req: { kind: "queue", variant: "guarded" } },
  ...ToolSchema.options.map(
    (tool): StartChoice => ({ value: `notarize:${tool}`, label: `Notarize ${toolName(tool)}`, req: { kind: "notarize", tool } }),
  ),
];
