// The agent transcript. The Run page shows it as an event rail (`TranscriptTimeline`): Rare UI's
// Hook Sidebar (src/components/ui/hook-sidebar.tsx) lists the events of each stage (Read · Test ·
// Challenge · Certify · Enforce, or every event in recorded order), its dashed hook rail marks the
// selected event and follows the replay, and the panel beside it shows that event: tagged details
// (every statement "Model said" or "Verified"), the money action, the held-action panel and the
// recorded event itself. The landing keeps the compact `TranscriptRow`. No data loading here: the
// Run page and the landing pass rows built by `buildRows` (./model.ts).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { BookOpenTextIcon as BookOpenText } from "@phosphor-icons/react/dist/csr/BookOpenText";
import { BrainIcon as Brain } from "@phosphor-icons/react/dist/csr/Brain";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUpIcon as CaretUp } from "@phosphor-icons/react/dist/csr/CaretUp";
import { CircleNotchIcon as CircleNotch } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { CurrencyDollarIcon as CurrencyDollar } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { FlagCheckeredIcon as FlagCheckered } from "@phosphor-icons/react/dist/csr/FlagCheckered";
import { GaugeIcon as Gauge } from "@phosphor-icons/react/dist/csr/Gauge";
import { HandPalmIcon as HandPalm } from "@phosphor-icons/react/dist/csr/HandPalm";
import { ListChecksIcon as ListChecks } from "@phosphor-icons/react/dist/csr/ListChecks";
import { LockKeyIcon as LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PlugsConnectedIcon as PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { ReceiptIcon as Receipt } from "@phosphor-icons/react/dist/csr/Receipt";
import { SealCheckIcon as SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import { SealWarningIcon as SealWarning } from "@phosphor-icons/react/dist/csr/SealWarning";
import { SwordIcon as Sword } from "@phosphor-icons/react/dist/csr/Sword";
import { UserCheckIcon as UserCheck } from "@phosphor-icons/react/dist/csr/UserCheck";
import { TAG_LABEL, type TrailLine } from "../../components/trail/model";
import type { AgentId } from "../../../../core/src/schema/agents";
import type { TimelineStage } from "../../../../core/src/schema";
import { AgentBadge, Button, HookSidebar, Json, WashCard, type HookSidebarItem } from "../../ui";
import {
  STAGES,
  STAGE_LABEL,
  clip,
  durationText,
  moneyText,
  type HeldCard,
  type RowDetails,
  type RunRow,
  type StageStep,
} from "./model";
import "./run.css";

/** Text with `backticked` commands rendered as code (the data layer's ReplayOnlyError style). */
export function CodeText({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}
    </>
  );
}

/* ------------------------------------------------------------------------------- status mark */

/** The only icons on the page: spinner (in progress), check (done), x (stopped, held or failed). */
export function StatusMark({ mark, tone }: Pick<RunRow, "mark" | "tone">) {
  const label = mark === "spinner" ? "In progress" : mark === "check" ? "Done" : tone === "held" ? "Held" : "Stopped";
  return (
    <span className="run-mark" data-mark={mark} data-tone={tone} role="img" aria-label={label}>
      {mark === "spinner" ? (
        <span className="run-spinner" />
      ) : (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          {mark === "check" ? (
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          )}
        </svg>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------------------------- details */

function Tag({ line }: { line: TrailLine }) {
  return (
    <span className="run-tag" data-tag={line.tag}>
      {TAG_LABEL[line.tag]}
    </span>
  );
}

function DetailLine({ line }: { line: TrailLine }) {
  return (
    <li className="run-line" data-tag={line.tag} data-decisive={line.decisive || undefined}>
      <Tag line={line} />
      <div className="run-line-body">
        <p className="run-line-head">
          <span className="run-line-label">{line.label}</span>
          {line.status && (
            <span className="run-pill" data-status={line.status}>
              {line.status.replaceAll("_", " ")}
            </span>
          )}
        </p>
        <p className="run-line-text">{line.text}</p>
        {line.detail && <p className="run-line-detail">{line.detail}</p>}
        {line.warning && (
          <p className="run-line-warning" role="note">
            {line.warning}
          </p>
        )}
        {(line.traceId || line.href) && (
          <p className="run-line-refs">
            {line.traceId &&
              (line.traceUrl ? (
                <a href={line.traceUrl} target="_blank" rel="noreferrer">
                  trace {line.traceId.slice(0, 12)}…
                </a>
              ) : (
                <code title="No trace link was recorded">trace {line.traceId}</code>
              ))}
            {line.href && (
              <a href={line.href} target="_blank" rel="noreferrer">
                docs
              </a>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

export function RowDetailsView({ details }: { details: RowDetails }) {
  return (
    <div className="run-details">
      {details.compare && (
        <div className="run-compare">
          {[details.compare.left, details.compare.right].map((col) => (
            <section key={col.title} className="run-compare-col" aria-label={col.title}>
              <h4>{col.title}</h4>
              <ul className="run-lines">
                {col.lines.map((l) => (
                  <DetailLine key={l.key} line={l} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {details.lines.length > 0 && (
        <ul className="run-lines">
          {details.lines.map((l) => (
            <DetailLine key={l.key} line={l} />
          ))}
        </ul>
      )}
      {!details.compare && details.lines.length === 0 && <p className="run-muted">Nothing else is recorded for this step.</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------------- held card */

export function HeldCardView({
  card,
  onApprove,
  onReject,
}: {
  card: HeldCard;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  return (
    <WashCard wash="peach" padding="sm" className="run-held" data-kind={card.kind}>
      <p className="run-held-reason" title={card.reason}>
        <span className="run-held-label">Held</span> {card.reason}
      </p>
      {card.evidence.length > 0 && (
        <ul className="run-held-evidence">
          {card.evidence.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {card.kind === "actionable" && (
        <div className="run-held-actions">
          <span className="run-muted">Held amount {card.amountText}</span>
          <Button size="sm" onClick={onApprove}>
            Approve…
          </Button>
          <Button size="sm" variant="secondary" onClick={onReject}>
            Reject…
          </Button>
        </div>
      )}
      {card.kind === "readonly" && (
        <p className="run-muted run-held-why">
          <CodeText text={card.why} />
        </p>
      )}
      {card.kind === "decided" && (
        <p className="run-held-why">
          A human {card.record.decision} this action · {card.record.status.replaceAll("_", " ")}
          {card.record.error ? ` · ${card.record.error}` : ""}
        </p>
      )}
    </WashCard>
  );
}

/* ------------------------------------------------------------------------------------ rows */

export type TranscriptRowProps = {
  row: RunRow;
  expanded?: boolean;
  onToggle?: () => void;
  /** Rendered under the header when expanded. */
  details?: ReactNode;
  /** The held-action card (held decisions only). */
  card?: ReactNode;
  /** Plays the short entrance (new rows only; never under reduced motion — CSS). */
  entering?: boolean;
  /** Link for the row's certificate, when it has one. */
  certificateHref?: string;
};

/**
 * Which of the five named agents (core/src/schema/agents.ts) acted in a row. Only the Executor,
 * Reflector, Adversary and the Guard rule appear in a run; deterministic bookkeeping (beliefs,
 * certificates, budget) shows no badge. Model ids come only from the recorded event.
 */
export function rowAgents(row: Pick<RunRow, "type" | "actor" | "held">): { id: AgentId; model?: string }[] {
  switch (row.type) {
    case "adversary.verdict":
      return [{ id: "adversary", model: row.actor.kind === "model" && row.actor.name !== "model not recorded" ? row.actor.name : undefined }];
    case "probe.committed":
      return [{ id: "reflector" }];
    case "decision":
      return row.held ? [{ id: "executor" }, { id: "guard" }] : [{ id: "executor" }];
    default:
      return [];
  }
}

export function TranscriptRow({ row, expanded = false, onToggle, details, card, entering, certificateHref }: TranscriptRowProps) {
  const detailsId = useId();
  const agents = rowAgents(row);
  // Deterministic steps have no model or tool to name; tools and humans are named in text, agents
  // by badge (the model id lives in the badge, so it is not repeated).
  const actor = row.actor.kind === "code" || row.actor.kind === "model" ? undefined : row.actor;
  const meta = [actor?.name, row.durationMs !== undefined ? durationText(row.durationMs) : undefined, row.cost].filter(Boolean);
  const head = (
    <>
      <StatusMark mark={row.mark} tone={row.tone} />
      <span className="run-row-main">
        <span className="run-row-title">{row.title}</span>
        {row.subject && <span className="run-row-subject">{clip(row.subject, 120)}</span>}
      </span>
      <span className="run-row-meta">
        {agents.map((a) => (
          <AgentBadge key={a.id} agent={a.id} model={a.model} />
        ))}
        {row.provisional && <span className="run-pill" data-status="provisional">live</span>}
        {meta.map((m, i) => (
          <span key={i} data-actor={i === 0 && actor ? actor.kind : undefined}>
            {m}
          </span>
        ))}
      </span>
    </>
  );
  return (
    <div className="run-row" data-tone={row.tone} data-enter={entering || undefined} data-expanded={expanded || undefined}>
      {onToggle ? (
        <button type="button" className="run-row-head" aria-expanded={expanded} aria-controls={detailsId} onClick={onToggle}>
          {head}
        </button>
      ) : (
        <div className="run-row-head">{head}</div>
      )}
      {card}
      {expanded && (
        <div id={detailsId} className="run-row-body">
          {details}
          {certificateHref && (
            <p className="run-row-link">
              <Link to={certificateHref}>Open certificate {row.certificateId}</Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A plain (non-virtualized) transcript for short excerpts, e.g. the landing's looping replay:
 * `<TranscriptRows rows={buildRows(events, { bundle }).slice(0, 8)} />`. Read-only: no
 * expansion, no held actions.
 */
export function TranscriptRows({ rows, className }: { rows: readonly RunRow[]; className?: string }) {
  return (
    <ol className={["run-transcript-static", className].filter(Boolean).join(" ")}>
      {rows.map((r) => (
        <li key={r.key}>
          <TranscriptRow row={r} />
        </li>
      ))}
    </ol>
  );
}


/* ========================================================================= event rail */

export type TranscriptView = "stage" | "order";
export type TranscriptFilter = "all" | "money" | "held" | "issues";

export const TRANSCRIPT_VIEWS: readonly { value: TranscriptView; label: string }[] = [
  { value: "stage", label: "By stage" },
  { value: "order", label: "In order" },
];

export const TRANSCRIPT_FILTERS: readonly { value: TranscriptFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "money", label: "Money actions" },
  { value: "held", label: "Held" },
  { value: "issues", label: "Unsafe or revoked" },
];

export const parseView = (v: string | null | undefined): TranscriptView => (v === "order" ? "order" : "stage");

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const amountOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const words = (s: string) => s.replaceAll("_", " ");

export type MoneyAction = {
  /** The recorded action, e.g. "dodo.createRefund". */
  action: string;
  /** The recorded amount, formatted from minor units; undefined when the event recorded none. */
  amountText?: string;
  /** The decision's recorded status (executed, held, blocked, …). */
  status?: string;
};

/**
 * The money action a decision row names, read from its recorded event: the action, the amount and
 * the status. Null for rows that move no money (other event kinds, or a decision whose action is
 * "none" or not recorded).
 */
export function moneyOf(row: Pick<RunRow, "type" | "event">): MoneyAction | null {
  if (row.type !== "decision" || !row.event) return null;
  const data = row.event.data ?? {};
  const action = text(data.action);
  if (!action || action === "none") return null;
  const amount = amountOf(data.amount);
  return { action, amountText: amount === undefined ? undefined : moneyText(amount, text(data.currency)), status: text(data.status) };
}

export function matchesFilter(row: RunRow, filter: TranscriptFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "money":
      return moneyOf(row) !== null;
    case "held":
      return row.held || row.tone === "held";
    case "issues":
      return row.tone === "unsafe";
  }
}

/** How many rows each filter keeps (every count is a count of rows built from recorded events). */
export function filterCounts(rows: readonly RunRow[]): Record<TranscriptFilter, number> {
  const out = { all: 0, money: 0, held: 0, issues: 0 } as Record<TranscriptFilter, number>;
  for (const r of rows) for (const f of TRANSCRIPT_FILTERS) if (matchesFilter(r, f.value)) out[f.value]++;
  return out;
}

export type TranscriptGroup = { key: string; stage: TimelineStage | null; label: string; rows: RunRow[] };

/**
 * The rail's groups. "stage": one group per stage that has rows, in the schema's Read → Enforce
 * order, each in recorded order. "order": one group with every row in recorded order. Filters apply
 * to rows; empty groups are left out.
 */
export function transcriptGroups(
  rows: readonly RunRow[],
  { view, filter = "all" }: { view: TranscriptView; filter?: TranscriptFilter },
): TranscriptGroup[] {
  const kept = rows.filter((r) => matchesFilter(r, filter));
  if (view === "order") return kept.length ? [{ key: "all", stage: null, label: "Every event", rows: kept }] : [];
  return STAGES.flatMap((stage) => {
    const mine = kept.filter((r) => r.stage === stage);
    return mine.length ? [{ key: stage, stage, label: STAGE_LABEL[stage], rows: mine }] : [];
  });
}

/** "08:46:38.139" — the recorded timestamp's UTC clock time, to the millisecond. */
export function clockTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString().slice(11, 23);
}

/** Icon tone: color only for meaning (certified green, unsafe red, held amber); otherwise ink. */
export function rowTone(row: Pick<RunRow, "tone">): "neutral" | "success" | "danger" | "warning" {
  return row.tone === "safe" ? "success" : row.tone === "unsafe" ? "danger" : row.tone === "held" ? "warning" : "neutral";
}

/** What the icon says, for screen readers: the row's status. */
export function statusLabel(row: Pick<RunRow, "mark" | "tone">): string {
  if (row.mark === "spinner") return "In progress";
  if (row.tone === "held") return "Held";
  if (row.tone === "unsafe") return row.mark === "check" ? "Done, flagged" : "Stopped, flagged";
  if (row.tone === "safe") return "Done, certified";
  return row.mark === "check" ? "Done" : "Stopped";
}

/** The Phosphor icon for an event kind (a spinner while a committed probe waits for its verdict). */
export function RowIcon({ row, size = 16 }: { row: Pick<RunRow, "type" | "held" | "event" | "stage" | "mark">; size?: number }) {
  const p = { size, weight: "regular" as const, "aria-hidden": true };
  if (row.mark === "spinner") return <CircleNotch {...p} className="tx-spin" />;
  switch (row.type) {
    case "intro":
      return row.stage === "read" ? <BookOpenText {...p} /> : <ListChecks {...p} />;
    case "anomaly.detected":
      return <MagnifyingGlass {...p} />;
    case "belief.changed":
      return <Brain {...p} />;
    case "probe.committed":
      return <LockKey {...p} />;
    case "probe.verdict":
      return <PlugsConnected {...p} />;
    case "adversary.verdict":
      return <Sword {...p} />;
    case "certificate.issued":
      return <SealCheck {...p} />;
    case "certificate.revoked":
      return <SealWarning {...p} />;
    case "decision":
      return row.held ? <HandPalm {...p} /> : moneyOf(row) ? <CurrencyDollar {...p} /> : <Receipt {...p} />;
    case "budget":
      return <Gauge {...p} />;
    case "approval.decided":
      return <UserCheck {...p} />;
    case "run.finished":
      return <FlagCheckered {...p} />;
    default:
      return <Receipt {...p} />;
  }
}

/** The recorded event behind a row: kind, stage, seq, record and trace ids, and its data as JSON. */
function RecordedEvent({ row }: { row: RunRow }) {
  const e = row.event;
  if (!e) return null;
  return (
    <details className="tx-event">
      <summary>
        Recorded event <code>{e.type}</code>
      </summary>
      <dl className="tx-facts">
        <dt>Summary</dt>
        <dd>{e.summary}</dd>
        {e.recordIds.length > 0 && (
          <>
            <dt>Records</dt>
            <dd className="tx-ids">
              {e.recordIds.map((id) => (
                <code key={id}>{id}</code>
              ))}
            </dd>
          </>
        )}
        {e.traceIds.length > 0 && (
          <>
            <dt>Traces</dt>
            <dd className="tx-ids">
              {e.traceIds.map((id) => (
                <code key={id}>{id}</code>
              ))}
            </dd>
          </>
        )}
      </dl>
      {e.data && Object.keys(e.data).length > 0 && <Json value={e.data} />}
    </details>
  );
}

export type TranscriptTimelineProps = {
  rows: readonly RunRow[];
  /** More events may arrive (a replay or a live run in progress). */
  streaming: boolean;
  view: TranscriptView;
  onViewChange: (view: TranscriptView) => void;
  /** The five stages' progress, for the group headings (current stage, alerts). */
  steps?: readonly StageStep[];
  /** Row to select and scroll to (from ?event=, ?decision=, ?probe=). */
  targetKey?: string;
  /** When each streamed event arrived (performance.now()), for the entrance of new rows. */
  arrivals?: ReadonlyMap<number, number>;
  renderDetails: (row: RunRow) => ReactNode;
  renderCard?: (row: RunRow) => ReactNode;
  certificateHref?: (row: RunRow) => string | undefined;
  /** Shown when there are no rows yet. */
  emptyText: string;
};

const FRESH_MS = 600;
const ITEM = "[data-slot=hook-sidebar-item]";
/** A class naming the row on its rail item (the Hook Sidebar takes classes, not data attributes). */
const keyClass = (key: string) => `tx-k-${key.replace(/[^\w-]/g, "_")}`;

/** Scroll `el` into the middle of `box` when it is outside it (only the box scrolls, never the page). */
function reveal(box: HTMLElement | null, el: Element | null | undefined, smooth: boolean) {
  if (!box || !(el instanceof HTMLElement)) return;
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  const bottom = top + el.offsetHeight;
  if (top >= box.scrollTop + 8 && bottom <= box.scrollTop + box.clientHeight - 8) return;
  box.scrollTo({ top: Math.max(0, top - box.clientHeight / 2 + el.offsetHeight / 2), behavior: smooth ? "smooth" : "auto" });
}

/**
 * The Run page transcript: filters, the stage rails and the selected event's panel. While events
 * stream, "Follow" keeps the newest event selected and its rail item in view; choosing an event
 * stops following. Arrow keys (and j / k) move between events, Home and End jump to the ends.
 */
export function TranscriptTimeline({
  rows,
  streaming,
  view,
  onViewChange,
  steps,
  targetKey,
  arrivals,
  renderDetails,
  renderCard,
  certificateHref,
  emptyText,
}: TranscriptTimelineProps) {
  const [filter, setFilter] = useState<TranscriptFilter>("all");
  const [follow, setFollow] = useState(!targetKey);
  const [picked, setPicked] = useState<string | undefined>(targetKey);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const groups = useMemo(() => transcriptGroups(rows, { view, filter }), [rows, view, filter]);
  const visible = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const stepOf = useMemo(() => new Map((steps ?? []).map((s) => [s.stage, s])), [steps]);
  const latest = useMemo(
    () => visible.reduce<RunRow | undefined>((m, r) => (r.seq !== null && (!m || m.seq === null || r.seq > m.seq) ? r : m), undefined),
    [visible],
  );
  const pickedRow = picked ? visible.find((r) => r.key === picked) : undefined;
  const selected = (follow ? latest : pickedRow) ?? pickedRow ?? visible[0];
  const navRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const reduced = useRef(false);
  useEffect(() => {
    reduced.current = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  // A deep link selects its row (showing it under every filter) and stops following.
  useEffect(() => {
    if (!targetKey) return;
    setPicked(targetKey);
    setFollow(false);
    const row = rows.find((r) => r.key === targetKey);
    if (row && !matchesFilter(row, filter)) setFilter("all");
    // Only a new target re-applies; later row or filter changes keep the reader's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, rows.some((r) => r.key === targetKey)]);

  // Keep the selected rail item in view when following or arriving from a deep link.
  const userPick = useRef(false);
  useLayoutEffect(() => {
    if (!selected || userPick.current) {
      userPick.current = false;
      return;
    }
    reveal(navRef.current, navRef.current?.querySelector(`.${keyClass(selected.key)}`), !reduced.current && follow);
  }, [selected?.key, follow, view, filter]);
  // A new selection starts the panel at its top.
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [selected?.key]);

  const choose = (row: RunRow, { fromKeyboard = false } = {}) => {
    userPick.current = !fromKeyboard;
    setPicked(row.key);
    setFollow(false);
    if (!fromKeyboard && typeof matchMedia !== "undefined" && matchMedia("(max-width: 900px)").matches)
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: "start", behavior: reduced.current ? "auto" : "smooth" }));
  };
  const step = (delta: number | "start" | "end") => {
    if (!visible.length) return;
    const i = selected ? visible.indexOf(selected) : -1;
    const next = delta === "start" ? 0 : delta === "end" ? visible.length - 1 : Math.min(Math.max(i + delta, 0), visible.length - 1);
    const row = visible[next]!;
    choose(row, { fromKeyboard: true });
    requestAnimationFrame(() => {
      const el = navRef.current?.querySelector<HTMLElement>(`.${keyClass(row.key)}`);
      reveal(navRef.current, el, false);
      if (navRef.current?.contains(document.activeElement)) el?.focus({ preventScroll: true });
    });
  };
  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    const key = e.key;
    const delta =
      key === "ArrowDown" || key === "j" ? 1 : key === "ArrowUp" || key === "k" ? -1 : key === "Home" ? "start" : key === "End" ? "end" : null;
    if (delta === null || !(e.target as HTMLElement).closest(ITEM)) return;
    e.preventDefault();
    step(delta);
  };

  const now = typeof performance === "undefined" ? 0 : performance.now();
  const selectedIndex = selected ? visible.indexOf(selected) : -1;
  const money = selected ? moneyOf(selected) : null;

  const itemsOf = (group: TranscriptGroup): HookSidebarItem[] =>
    group.rows.map((row) => {
      const m = moneyOf(row);
      const arrived = row.seq !== null ? arrivals?.get(row.seq) : undefined;
      return {
        label: row.title,
        className: [
          "tx-item",
          keyClass(row.key),
          `tx-tone-${rowTone(row)}`,
          arrived !== undefined && now - arrived < FRESH_MS ? "tx-fresh" : "",
          row.provisional ? "tx-provisional" : "",
        ]
          .filter(Boolean)
          .join(" "),
        onClick: () => choose(row),
        badge: (
          <span className="tx-item-badge">
            <span className="tx-item-icon" role="img" aria-label={statusLabel(row)}>
              <RowIcon row={row} />
            </span>
            <span className="tx-item-side">
              {m?.amountText && <span className="tx-amount">{m.amountText}</span>}
              {view === "order" && <span className="tx-item-stage">{STAGE_LABEL[row.stage]}</span>}
              <time className="tx-item-time" dateTime={row.at}>
                {clockTime(row.at)}
              </time>
            </span>
          </span>
        ),
      };
    });

  return (
    <div className="tx">
      <div className="tx-toolbar">
        <div className="tx-filters" role="group" aria-label="Filter events">
          {TRANSCRIPT_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="tx-chip"
              aria-pressed={filter === f.value}
              disabled={f.value !== "all" && counts[f.value] === 0 && filter !== f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
              <span className="tx-num">{counts[f.value]}</span>
            </button>
          ))}
        </div>
        <div className="tx-toolbar-end">
          {streaming && (
            <button type="button" className="tx-chip" aria-pressed={follow} onClick={() => setFollow((f) => !f)}>
              Follow live
            </button>
          )}
          <div className="tx-views" role="group" aria-label="Group events">
            {TRANSCRIPT_VIEWS.map((v) => (
              <button key={v.value} type="button" className="tx-chip" aria-pressed={view === v.value} onClick={() => onViewChange(v.value)}>
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="run-muted run-empty">{rows.length && filter !== "all" ? "No event matches this filter." : emptyText}</p>
      ) : (
        <div className="tx-body">
          <nav className="tx-rail" ref={navRef} aria-label="Transcript events" onKeyDown={onNavKey} tabIndex={-1}>
            {groups.map((g) => {
              const st = g.stage ? stepOf.get(g.stage) : undefined;
              const state = st ? [st.current ? "running now" : undefined, ...st.alerts].filter(Boolean).join(" · ") : "";
              const headId = `${titleId}-${g.key}`;
              const index = selected ? g.rows.indexOf(selected) : -1;
              return (
                <section key={g.key} className="tx-group" aria-labelledby={headId}>
                  <h3 className="tx-group-head" id={headId}>
                    <span className="tx-group-label">{g.label}</span>
                    <span className="tx-num tx-group-count">{g.rows.length}</span>
                    <span className="sr-only">{g.rows.length === 1 ? " event" : " events"}</span>
                    {state && (
                      <span className="tx-group-state" data-alert={st?.state === "alert" || undefined}>
                        {state}
                      </span>
                    )}
                  </h3>
                  <HookSidebar as="div" items={itemsOf(g)} value={index} color="var(--accent)" className="tx-hook" />
                </section>
              );
            })}
            {streaming && (
              <p className="tx-waiting" role="status">
                <CircleNotch size={14} aria-hidden className="tx-spin" /> Waiting for the next event…
              </p>
            )}
          </nav>

          <article className="tx-panel" ref={panelRef} aria-labelledby={`${titleId}-panel`} tabIndex={-1}>
            {selected && (
              <>
                <header className="tx-panel-head">
                  <p className="tx-panel-kicker">
                    <span className={`tx-panel-icon tx-tone-${rowTone(selected)}`} role="img" aria-label={statusLabel(selected)}>
                      <RowIcon row={selected} size={18} />
                    </span>
                    <span>{STAGE_LABEL[selected.stage]}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      event <span className="tx-num">{selectedIndex + 1}</span> of <span className="tx-num">{visible.length}</span>
                      {filter !== "all" ? " shown" : ""}
                    </span>
                    <span className="tx-panel-nav">
                      <button type="button" aria-label="Previous event" disabled={selectedIndex <= 0} onClick={() => step(-1)}>
                        <CaretUp size={14} weight="bold" aria-hidden />
                      </button>
                      <button type="button" aria-label="Next event" disabled={selectedIndex >= visible.length - 1} onClick={() => step(1)}>
                        <CaretDown size={14} weight="bold" aria-hidden />
                      </button>
                    </span>
                  </p>
                  <h3 className="tx-panel-title" id={`${titleId}-panel`}>
                    {selected.title}
                  </h3>
                  <p className="tx-panel-meta">
                    <time dateTime={selected.at} title={`${selected.at} (UTC)`}>
                      {clockTime(selected.at)} UTC
                    </time>
                    <span>{selected.seq !== null ? `seq ${selected.seq}` : "read from the bundle"}</span>
                    {rowAgents(selected).map((a) => (
                      <AgentBadge key={a.id} agent={a.id} model={a.model} />
                    ))}
                    {(selected.actor.kind === "tool" || selected.actor.kind === "human") && (
                      <span data-actor={selected.actor.kind}>{selected.actor.name}</span>
                    )}
                    {selected.durationMs !== undefined && <span>{durationText(selected.durationMs)}</span>}
                    {selected.cost && <span>{selected.cost}</span>}
                    {selected.provisional && (
                      <span className="run-pill" data-status="provisional">
                        live
                      </span>
                    )}
                  </p>
                  {selected.subject && <p className="tx-panel-subject">{clip(selected.subject, 240)}</p>}
                </header>

                {money && (
                  <div className="tx-money" data-status={money.status}>
                    <span className="tx-money-amount" data-unknown={money.amountText ? undefined : ""}>
                      {money.amountText ?? "Amount not recorded"}
                    </span>
                    <span className="tx-money-what">
                      <code>{money.action}</code>
                      {money.status && (
                        <span className="run-pill" data-status={money.status}>
                          {words(money.status)}
                        </span>
                      )}
                    </span>
                  </div>
                )}

                {renderCard?.(selected)}
                <div className="tx-panel-details">{renderDetails(selected)}</div>
                <RecordedEvent row={selected} />
                {certificateHref?.(selected) && (
                  <p className="run-row-link">
                    <Link to={certificateHref(selected)!}>Open certificate {selected.certificateId}</Link>
                  </p>
                )}
              </>
            )}
          </article>
        </div>
      )}
      <p className="tx-credit">
        Event rail: Hook Sidebar by{" "}
        <a href="https://rareui.com" target="_blank" rel="noreferrer">
          Rare UI
        </a>
      </p>
    </div>
  );
}
