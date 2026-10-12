// Notary Chat: pure logic behind the page (no React). The event reducer that turns a ChatEvent
// stream into one assistant message's view model, step titles and status words, the collapsed
// "Worked through …" summary, citation targets, step-data cards, suggested prompts and the
// auto-scroll rules. Tested in test/chat-page.test.ts.
import type {
  Certificate,
  ChatCitation,
  ChatEvent,
  ChatStepStatus,
  ChatToolName,
  RunBundle,
} from "../../../../core/src/schema";
import { recordPath, withRun } from "../../app/links";

export type ChatMode = "live" | "replay";
type DoneEvent = Extract<ChatEvent, { type: "done" }>;

// ------------------------------------------------------------------------------------ reducer

export type StepState = "running" | ChatStepStatus;

export type StepView = {
  id: string;
  tool: ChatToolName;
  title: string;
  input: string;
  state: StepState;
  durationMs?: number;
  costUsd?: number | null;
  credits?: number;
  output?: string;
  data?: unknown;
  fix?: string;
};

export type WorkItem = { kind: "step"; id: string } | { kind: "note"; key: string; text: string; source?: "model" | "replay" };

export type TurnStatus = "working" | "answering" | "done" | "error" | "stopped";

export type TurnView = {
  items: WorkItem[];
  steps: Record<string, StepView>;
  text: string;
  citations: ChatCitation[];
  done?: DoneEvent;
  error?: { message: string; fix?: string };
  status: TurnStatus;
};

export const EMPTY_TURN: TurnView = { items: [], steps: {}, text: "", citations: [], status: "working" };

const finishedStatus = (s: TurnStatus) => s === "done" || s === "error" || s === "stopped";

/** One event applied to a message (immutable). Events after done/error/stop are ignored. */
export function applyChatEvent(view: TurnView, e: ChatEvent): TurnView {
  if (finishedStatus(view.status)) return view;
  switch (e.type) {
    case "step_started":
      if (view.steps[e.id]) return view;
      return {
        ...view,
        items: [...view.items, { kind: "step", id: e.id }],
        steps: { ...view.steps, [e.id]: { id: e.id, tool: e.tool, title: e.title, input: e.input, state: "running" } },
      };
    case "step_finished": {
      const prev = view.steps[e.id];
      // A finish without a start still shows (titled from the tool is impossible: no tool) → skip.
      if (!prev) return view;
      return {
        ...view,
        steps: {
          ...view.steps,
          [e.id]: {
            ...prev,
            state: e.status,
            durationMs: e.durationMs,
            costUsd: e.costUsd,
            ...(e.credits !== undefined ? { credits: e.credits } : {}),
            output: e.output,
            ...(e.data !== undefined ? { data: e.data } : {}),
            ...(e.fix ? { fix: e.fix } : {}),
          },
        },
      };
    }
    case "note":
      return { ...view, items: [...view.items, { kind: "note", key: `n${view.items.length}`, text: e.text, source: e.source }] };
    case "text_delta":
      return { ...view, text: view.text + e.text, status: "answering" };
    case "citations":
      return { ...view, citations: e.items };
    case "done":
      return { ...view, done: e, status: "done" };
    case "error":
      return { ...view, error: { message: e.message, ...(e.fix ? { fix: e.fix } : {}) }, status: "error", steps: abortRunning(view.steps) };
  }
}

function abortRunning(steps: Record<string, StepView>): Record<string, StepView> {
  let changed = false;
  const next: Record<string, StepView> = {};
  for (const [id, s] of Object.entries(steps)) {
    if (s.state === "running") {
      changed = true;
      next[id] = { ...s, state: "aborted" };
    } else next[id] = s;
  }
  return changed ? next : steps;
}

/** Stop pressed (or a recorded turn that never finished): running steps become aborted. */
export function stopTurn(view: TurnView): TurnView {
  if (finishedStatus(view.status)) return view;
  return { ...view, status: "stopped", steps: abortRunning(view.steps) };
}

/**
 * The view model of one assistant message. `finished: true` = the stream is over (a stored
 * message, or Stop): a turn without done/error is shown as stopped.
 */
export function reduceChatEvents(events: readonly ChatEvent[], opts: { finished?: boolean } = {}): TurnView {
  const view = events.reduce(applyChatEvent, EMPTY_TURN);
  return opts.finished ? stopTurn(view) : view;
}

export const turnSteps = (view: TurnView): StepView[] =>
  view.items.flatMap((i) => (i.kind === "step" && view.steps[i.id] ? [view.steps[i.id]!] : []));

export const isTurnFinished = (view: TurnView) => finishedStatus(view.status);

// ---------------------------------------------------------------------------------- wording

const TOOL_TITLE: Record<ChatToolName, string> = {
  search_certificates: "Searching certificates",
  get_certificate: "Checking a certificate",
  list_runs: "Listing runs",
  get_run: "Opening a run",
  get_run_events: "Reading run events",
  list_approvals: "Listing held actions",
  get_approval: "Opening a held action",
  fetch_doc: "Opening a docs page",
  crustdata_lookup: "Looking up a company in Crustdata",
  dodo_lookup: "Looking up a record in Dodo Payments",
  get_health: "Checking integrations",
  get_guard_coverage: "Checking guard coverage",
  explain_decision: "Explaining a decision",
};

/** The step's own plain title, else one built from the tool and its input. */
export function stepTitle(step: Pick<StepView, "tool" | "title" | "input">): string {
  if (step.title.trim()) return step.title.trim();
  const base = TOOL_TITLE[step.tool];
  return step.input.trim() ? `${base}: ${step.input.trim()}` : base;
}

/** Screen-reader words for a step's mark. */
export function statusLabel(state: StepState): string {
  switch (state) {
    case "running":
      return "In progress";
    case "ok":
      return "Done";
    case "error":
      return "Failed";
    case "unavailable":
      return "Unavailable";
    case "aborted":
      return "Stopped";
  }
}

export function durationText(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 4 });

/** Recorded cost: "$0.012"; null → "cost unknown"; replay (no model ran) says so. */
export function costText(costUsd: number | null | undefined, mode: ChatMode): string {
  if (mode === "replay") return "no model call";
  if (costUsd === null || costUsd === undefined) return "cost unknown";
  return USD.format(costUsd);
}

export function tokensText(tokens: DoneEvent["tokens"] | undefined): string {
  if (!tokens) return "";
  const total = tokens.input + tokens.output;
  return `${new Intl.NumberFormat("en-US").format(total)} tokens`;
}

/** Notes are model-written in live mode; the replay engine writes them by code (no model ran). */
/** A note's tag comes from who wrote it; `mode` covers notes stored before `source` had "replay". */
export const noteTag = (mode: ChatMode, source?: "model" | "replay") =>
  source === "replay" || (source === undefined && mode === "replay") ? "Replay engine" : "Model said";

/** "Checked 5 sources · 3.8s · $0.011" (collapsed work section): every step read one source. */
export function workSummary(view: TurnView, mode: ChatMode): string {
  const steps = turnSteps(view);
  const count = view.done?.steps ?? steps.length;
  const parts = [`Checked ${count} source${count === 1 ? "" : "s"}`];
  const ms = view.done?.durationMs ?? (steps.length ? steps.reduce((a, s) => a + (s.durationMs ?? 0), 0) : undefined);
  if (ms !== undefined) parts.push(durationText(ms));
  if (view.done) parts.push(costText(view.done.costUsd, view.done.mode));
  else if (view.status === "stopped") parts.push("stopped");
  else if (view.status === "error") parts.push("failed");
  else parts.push(costText(undefined, mode));
  return parts.join(" · ");
}

/** The work section is open while the agent works; it collapses once the answer is complete. */
export const workOpenByDefault = (view: TurnView) => !isTurnFinished(view);

// -------------------------------------------------------------------------------- citations

export type CitationTarget =
  | { kind: "step"; stepId: string; href?: string }
  | { kind: "link"; href: string }
  | { kind: "external"; href: string }
  | { kind: "none" };

/** The record page a citation names, when it has one. */
export function citationHref(c: Pick<ChatCitation, "type" | "id" | "url">, runId?: string): { href: string; external: boolean } | undefined {
  switch (c.type) {
    case "certificate":
      return { href: withRun(recordPath.certificate(c.id), runId), external: false };
    case "approval":
      return { href: withRun("/app/approvals", runId), external: false };
    case "run":
      return { href: recordPath.run(c.id), external: false };
    case "run_event": {
      const hash = c.id.lastIndexOf("#");
      if (hash <= 0) return undefined;
      return { href: `/app/run?run=${encodeURIComponent(c.id.slice(0, hash))}&event=${encodeURIComponent(c.id.slice(hash + 1))}`, external: false };
    }
    case "doc": {
      const url = c.url ?? c.id;
      return /^https?:\/\//i.test(url) ? { href: url, external: true } : undefined;
    }
    default:
      return undefined;
  }
}

/** Clicking a chip: scroll to the step that produced it, else open the record. */
export function citationTarget(c: ChatCitation, view: TurnView, runId?: string): CitationTarget {
  const href = citationHref(c, runId);
  if (c.stepId && view.steps[c.stepId]) return { kind: "step", stepId: c.stepId, ...(href ? { href: href.href } : {}) };
  if (href) return href.external ? { kind: "external", href: href.href } : { kind: "link", href: href.href };
  return { kind: "none" };
}

/** Citation numbers that appear in the text but have no citation (shown flagged, like valid:false). */
export function unknownMarkers(text: string, citations: readonly ChatCitation[]): number[] {
  const known = new Set(citations.map((c) => c.n));
  return [...new Set([...text.matchAll(/\[(\d{1,3})\](?!\()/g)].map((m) => Number(m[1])))].filter((n) => !known.has(n));
}

/** A trace link only from a recorded http(s) URL for that trace id; never built or guessed. */
export function traceHref(traceId: string | undefined, links: Record<string, string> = {}): string | undefined {
  if (!traceId) return undefined;
  const url = links[traceId];
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

// -------------------------------------------------------------------------------- step data

export type CertificateCard = {
  id: string;
  claimId: string;
  tool?: string;
  status: string;
  verdict?: string;
  scope?: string;
  evidenceCount?: number;
  confidence?: number;
  docsSay?: string;
  observed?: string;
  docUrl?: string;
};

export type RunEventRow = { runId: string; seq: number; type?: string; summary: string; at?: string };

export type StepData =
  | { kind: "certificate"; card: CertificateCard }
  | { kind: "run_events"; runId?: string; total?: number; rows: RunEventRow[] }
  | { kind: "doc"; title?: string; url: string; passage?: string }
  | { kind: "table"; columns: string[]; rows: Record<string, unknown>[]; total?: number; note?: string }
  | { kind: "kv"; entries: [string, unknown][] }
  | { kind: "none" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function certificateCard(v: Record<string, unknown>): CertificateCard | undefined {
  const id = str(v.id);
  const claimId = str(v.claimId);
  const status = str(v.status);
  if (!id || !/^cert-/.test(id) || !claimId || !status) return undefined;
  const scope = isObj(v.scope) ? str((v.scope as { text?: unknown }).text) : str(v.scope);
  const evidence = Array.isArray(v.evidence) ? v.evidence.length : num(v.evidenceCount) ?? num(v.evidence);
  return {
    id,
    claimId,
    status,
    tool: str(v.tool),
    verdict: str(v.verdict),
    scope,
    evidenceCount: evidence,
    confidence: num(v.confidence),
    docsSay: str(v.docsSay),
    observed: str(v.observed),
    docUrl: str(v.docUrl),
  };
}

const LIST_KEYS = ["runs", "results", "items", "pending", "rows", "matches", "certificates", "integrations"];

/**
 * How to show a step's structured result. Known replay/live shapes first (certificate, run events,
 * fetched doc page), else duck-typed: the first array of objects becomes a compact table, any other
 * object a key-value card. The raw JSON is always one toggle away in the UI.
 */
export function classifyStepData(data: unknown): StepData {
  if (data === undefined || data === null) return { kind: "none" };
  if (Array.isArray(data))
    return data.every(isObj) && data.length ? table(data as Record<string, unknown>[]) : { kind: "kv", entries: [["items", data]] };
  if (!isObj(data)) return { kind: "kv", entries: [["value", data]] };
  const card = certificateCard(data);
  if (card) return { kind: "certificate", card };
  if (Array.isArray(data.events) && data.events.every((e) => isObj(e) && typeof e.seq === "number" && typeof e.summary === "string")) {
    const rows = (data.events as Record<string, unknown>[]).map((e) => ({
      runId: str(e.runId) ?? str(data.runId) ?? "",
      seq: e.seq as number,
      summary: e.summary as string,
      type: str(e.type),
      at: str(e.at),
    }));
    return { kind: "run_events", runId: str(data.runId), total: num(data.total), rows };
  }
  const url = str(data.url);
  if (url && /^https?:\/\//i.test(url) && (str(data.passage) || str(data.title) || str(data.text)))
    return { kind: "doc", url, title: str(data.title), passage: str(data.passage) ?? str(data.text) };
  for (const key of LIST_KEYS) {
    const list = data[key];
    if (Array.isArray(list) && list.length && list.every(isObj)) {
      const t = table(list as Record<string, unknown>[]);
      return { ...t, total: num(data.total) ?? list.length, ...(data.readOnly === true ? { note: "Read-only in replay" } : {}) };
    }
  }
  const entries = Object.entries(data).filter(([k, v]) => k !== "kind" && v !== undefined && !(Array.isArray(v) && v.length === 0));
  return entries.length ? { kind: "kv", entries } : { kind: "none" };
}

function table(rows: Record<string, unknown>[]): Extract<StepData, { kind: "table" }> {
  const columns: string[] = [];
  for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) if (!columns.includes(k) && columns.length < 6) columns.push(k);
  return { kind: "table", columns, rows: rows.slice(0, 20) };
}

/** A cell / value as short text (objects as compact JSON). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 10_000) / 10_000);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v.join(", ") || "—";
  return JSON.stringify(v);
}

export const humanKey = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();

// ------------------------------------------------------------------------------- suggestions

/** Fixed example questions (prompts, not data). */
export const FIXED_PROMPTS = ["Look up Acme Corp in Crustdata", "What did the adversary reject in the last run?"] as const;

/**
 * Four empty-state prompts: two built from data (the selected run's first held decision, a real
 * certificate of its world), then the fixed examples. Missing data → its prompt is skipped.
 */
export function buildSuggestions(bundle: Pick<RunBundle, "decisions"> | undefined, certificates: readonly Pick<Certificate, "tool" | "claimId" | "status">[] = []): string[] {
  const out: string[] = [];
  const held = bundle?.decisions.find((d) => d.status === "held");
  if (held) out.push(`Why was ${held.requestType.replaceAll("_", " ")} ${held.requestId} held?`);
  const cert = certificates.find((c) => c.status === "active") ?? certificates[0];
  if (cert) {
    const claim = cert.claimId.startsWith(`${cert.tool}.`) ? cert.claimId.slice(cert.tool.length + 1) : cert.claimId;
    out.push(`What do we know about ${cert.tool}'s ${claim}?`);
  }
  out.push(...FIXED_PROMPTS);
  return out.slice(0, 4);
}

export type SuggestionCard = { prompt: string; detail: string };

/**
 * The same four prompts as cards: the question, and one line saying what it reads. The data-built
 * cards describe their record (the held decision's reason, the certificate's verdict) from the
 * record itself; the fixed examples describe themselves.
 */
export function buildSuggestionCards(
  bundle: Pick<RunBundle, "decisions"> | undefined,
  certificates: readonly Pick<Certificate, "tool" | "claimId" | "status" | "verdictKind">[] = [],
): SuggestionCard[] {
  const prompts = buildSuggestions(bundle, certificates);
  const held = bundle?.decisions.find((d) => d.status === "held");
  const cert = certificates.find((c) => c.status === "active") ?? certificates[0];
  return prompts.map((prompt, i) => {
    if (held && i === 0) {
      const missing = held.missingBeliefs.length;
      const detail = held.evidencePack?.reason
        ? held.evidencePack.reason
        : missing
          ? `${missing} required certificate${missing === 1 ? "" : "s"} missing; ${held.action}`
          : `Held on the ${held.tier} tier; ${held.action}`;
      return { prompt, detail };
    }
    if (cert && i === (held ? 1 : 0))
      return { prompt, detail: `Certificate ${cert.status}, ${cert.verdictKind.replaceAll("_", " ")}` };
    return { prompt, detail: FIXED_DETAIL[prompt] ?? "" };
  });
}

const FIXED_DETAIL: Record<string, string> = {
  [FIXED_PROMPTS[0]]: "A company lookup through the Crustdata API",
  [FIXED_PROMPTS[1]]: "The claims the adversary refuted in the latest run",
};

/** "docs.dodopayments.com" for a fetched page's URL (empty when it is not a URL). */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------------------ auto-scroll

export const FOLLOW_THRESHOLD_PX = 80;
export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };
export type FollowState = { follow: boolean; unseen: boolean };
export const INITIAL_FOLLOW: FollowState = { follow: true, unseen: false };

export const isNearBottom = (m: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX) =>
  m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;

/** User scrolled: back near the bottom → follow; moved up → stop following until they return. */
export function afterScroll(state: FollowState, m: ScrollMetrics, previousTop: number): FollowState {
  if (isNearBottom(m)) return { follow: true, unseen: false };
  if (m.scrollTop < previousTop) return { follow: false, unseen: state.unseen };
  return state;
}

/** New content while streaming: following → scroll; scrolled up → show "Jump to latest". */
export function afterContentGrew(state: FollowState): FollowState {
  return state.follow ? state : { follow: false, unseen: true };
}

export const jumpToLatest = (): FollowState => ({ follow: true, unseen: false });
