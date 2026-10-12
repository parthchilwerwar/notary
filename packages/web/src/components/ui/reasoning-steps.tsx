// Reasoning Steps: an agent working before it answers. One compact header line carries a status
// glyph and the current stage (a shimmer runs across it while it is active); under it the stage's
// reasoning lines reveal one by one and the sources it consulted appear as chips. Once everything
// has been shown it settles into a one-line summary ("Reasoned in 3 steps") that expands into the
// full list of stages, each with its reasoning, sources and optional details.
//
// Original Notary component. Its public API mirrors Kobra's "Reasoning Steps" (stages, sources,
// reasoning, stageMs, reasonMs, onDone, className; built on Motion; data-slot attributes), but the
// implementation is our own: Kobra's source was never read or copied.
//
// Two ways to drive it:
// - Paced (default): stages appear one at a time, each held at least `stageMs`, reasoning lines at
//   `reasonMs` apart. Stages that have not arrived yet are never shown: pacing only slows display
//   down, it never runs ahead of the data. Used by Chat's replay mode.
// - `live`: follow the data. Every stage, line and source shows the moment it is in the props, and
//   each stage's mark follows its own `status`. Used by Chat's live mode and for finished messages.
// `running` says more may still arrive: it never settles while true. Reduced motion shows
// everything at once with no animation: the OS preference, or MotionConfig reducedMotion="always".
import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, MotionConfigContext, motion, useReducedMotion } from "motion/react";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { CircleNotchIcon as CircleNotch } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { MinusCircleIcon as MinusCircle } from "@phosphor-icons/react/dist/csr/MinusCircle";
import { StopCircleIcon as StopCircle } from "@phosphor-icons/react/dist/csr/StopCircle";
import { WarningIcon as Warning } from "@phosphor-icons/react/dist/csr/Warning";
import "./reasoning-steps.css";

/* -------------------------------------------------------------------------------- types */

/** pending = not started (never shown); active = working; skipped = could not run (e.g. not connected). */
export type ReasoningStageStatus = "pending" | "active" | "done" | "error" | "skipped" | "stopped";

export type ReasoningStageItem = {
  id?: string;
  label: string;
  /** Omitted: the stage counts as done once it has been shown (and nothing is still running). */
  status?: ReasoningStageStatus;
  /** Screen-reader words for the status mark (defaults from the status). */
  statusLabel?: string;
  /** Short facts after the label in the full list (duration, cost). */
  meta?: ReactNode;
  /** Always visible under the stage in the full list (a fix to apply, a warning). */
  note?: ReactNode;
  /** Expandable details (tool input, output, raw result). */
  detail?: ReactNode;
  /** Controlled detail toggle; uncontrolled when omitted. */
  expanded?: boolean;
  onToggle?: () => void;
  /** DOM id of the stage row (so a citation can scroll to it). */
  anchorId?: string;
  highlighted?: boolean;
};
export type ReasoningStage = string | ReasoningStageItem;

export type ReasoningSource = {
  id?: string;
  label: string;
  /** The record-kind glyph. */
  icon?: ReactNode;
  /** Tooltip / accessible detail, e.g. "Certificate cert-93e8…". */
  title?: string;
  href?: string;
  external?: boolean;
  onSelect?: () => void;
  /** The stage that consulted it (index or stage id). Omitted: shown once every stage has shown. */
  stage?: number | string;
};

export type ReasoningLineItem = {
  id?: string;
  text: ReactNode;
  /** A small pill before the line, e.g. who wrote it. */
  tag?: ReactNode;
  tagTone?: "neutral" | "accent";
  /** The stage it belongs to (index or stage id). Omitted: shown after the last stage. */
  stage?: number | string;
};
export type ReasoningLine = string | ReasoningLineItem;

export type ReasoningStepsProps = {
  stages: readonly ReasoningStage[];
  sources?: readonly ReasoningSource[];
  reasoning?: readonly ReasoningLine[];
  /** Minimum time each stage is shown while paced (ms). */
  stageMs?: number;
  /** Time between reasoning lines while paced (ms). */
  reasonMs?: number;
  /** Called once, when everything has been shown and nothing is running. */
  onDone?: () => void;
  className?: string;
  /** Follow the data: no pacing; marks follow each stage's status. */
  live?: boolean;
  /** More stages may still arrive: never settle while true. */
  running?: boolean;
  /** Controlled open state of the full list (it closes itself when the steps settle). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Facts after the settled summary ("1.2s · $0.004"). */
  meta?: ReactNode;
  /** Header text before the first stage arrives. */
  idleLabel?: string;
  /** Accessible name of the region. */
  label?: string;
};

type Stage = ReasoningStageItem & { key: string };
type Line = ReasoningLineItem & { key: string; at?: number };
type Source = ReasoningSource & { key: string; at?: number };
type Shown = { stages: number; lines: number; tail: number; dwell: boolean; since: number };

const STATUS_WORDS: Record<ReasoningStageStatus, string> = {
  pending: "Not started",
  active: "In progress",
  done: "Done",
  error: "Failed",
  skipped: "Skipped",
  stopped: "Stopped",
};

const EASE = [0.22, 1, 0.36, 1] as const;

/* ------------------------------------------------------------------------- normalizing */

function normalizeStages(stages: readonly ReasoningStage[]): Stage[] {
  const seen = new Set<string>();
  return stages.map((s, i) => {
    const item = typeof s === "string" ? { label: s } : s;
    let key = item.id ?? `stage-${i}`;
    if (seen.has(key)) key = `${key}-${i}`;
    seen.add(key);
    return { ...item, key };
  });
}

/** A stage reference (index or id) as an index, or undefined when it names no stage. */
function stageIndex(ref: number | string | undefined, stages: Stage[]): number | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === "number") return Number.isInteger(ref) && ref >= 0 && ref < stages.length ? ref : undefined;
  const i = stages.findIndex((s) => s.id === ref);
  return i >= 0 ? i : undefined;
}

/* ------------------------------------------------------------------------------ pacing */

const FULL: Shown = { stages: Infinity, lines: Infinity, tail: Infinity, dwell: true, since: 0 };
const START: Shown = { stages: 0, lines: 0, tail: 0, dwell: false, since: 0 };

/**
 * The paced reveal: a cursor over the stages that only moves forward, never past the data. The head
 * stage reveals its reasoning lines `reasonMs` apart, is held at least `stageMs`, then the next stage
 * that exists takes over; trailing lines (no stage) follow the last stage.
 */
function usePacedReveal(opts: { instant: boolean; available: number; headLines: (i: number) => number; tailLines: number; stageMs: number; reasonMs: number }): Shown {
  const { instant, available, headLines, tailLines, stageMs, reasonMs } = opts;
  const [shown, setShown] = useState<Shown>(() => (instant ? FULL : START));
  const head = shown.stages - 1;
  const linesForHead = head >= 0 && head < available ? headLines(head) : 0;
  useEffect(() => {
    if (instant) return;
    let wait = -1;
    let next: (s: Shown) => Shown = (s) => s;
    if (shown.stages > 0 && shown.lines < linesForHead) {
      wait = reasonMs;
      next = (s) => ({ ...s, lines: s.lines + 1 });
    } else if (shown.stages > 0 && !shown.dwell) {
      wait = Math.max(0, shown.since + stageMs - Date.now());
      next = (s) => ({ ...s, dwell: true });
    } else if (shown.stages < available) {
      wait = 0;
      next = (s) => ({ stages: s.stages + 1, lines: 0, tail: 0, dwell: false, since: Date.now() });
    } else if (shown.tail < tailLines) {
      wait = reasonMs;
      next = (s) => ({ ...s, tail: s.tail + 1 });
    }
    if (wait < 0) return;
    const t = setTimeout(() => setShown(next), wait);
    return () => clearTimeout(t);
  }, [instant, shown, available, linesForHead, tailLines, stageMs, reasonMs]);
  // Switching to live / reduced motion mid-way shows everything; switching back keeps it shown.
  useEffect(() => {
    if (instant) setShown(FULL);
  }, [instant]);
  return instant ? FULL : shown;
}

/* ---------------------------------------------------------------------------- component */

export function ReasoningSteps({
  stages: stagesProp,
  sources: sourcesProp = [],
  reasoning: reasoningProp = [],
  stageMs = 1750,
  reasonMs = 650,
  onDone,
  className,
  live = false,
  running = false,
  open: openProp,
  onOpenChange,
  meta,
  idleLabel = "Working…",
  label = "Reasoning steps",
}: ReasoningStepsProps) {
  // The OS preference always counts (Motion's own default ignores it); MotionConfig
  // reducedMotion="always" forces it for a subtree.
  const prefersReduced = useReducedMotion() ?? false;
  const reduced = useContext(MotionConfigContext).reducedMotion === "always" || prefersReduced;
  const instant = live || reduced;
  const stages = normalizeStages(stagesProp);
  // A pending stage has not started: it and everything after it waits.
  const firstPending = stages.findIndex((s) => s.status === "pending");
  const available = firstPending === -1 ? stages.length : firstPending;

  const lines: Line[] = reasoningProp.map((l, i) => {
    const item = typeof l === "string" ? { text: l } : l;
    return { ...item, key: item.id ?? `line-${i}`, at: stageIndex(item.stage, stages) };
  });
  const sources: Source[] = sourcesProp.map((s, i) => ({ ...s, key: s.id ?? `source-${i}`, at: stageIndex(s.stage, stages) }));
  const linesOf = (i: number) => lines.filter((l) => l.at === i);
  const tail = lines.filter((l) => l.at === undefined || l.at >= available);

  const shown = usePacedReveal({ instant, available, headLines: (i) => linesOf(i).length, tailLines: tail.length, stageMs, reasonMs });
  const count = Math.min(shown.stages, available);
  const head = count - 1;
  const allShown = count === available;
  const visibleLines = (i: number) => (i === head && !instant ? linesOf(i).slice(0, shown.lines) : linesOf(i));
  const visibleTail = allShown ? tail.slice(0, shown.tail) : [];
  const visibleSources = sources.filter((s) => (s.at === undefined ? allShown : s.at < count));

  const statusOf = (i: number): ReasoningStageStatus => {
    const s = stages[i]!.status;
    if (s === "active" || s === "pending") return "active";
    if (i === head && !shown.dwell) return "active";
    if (s) return s;
    return i === head && running ? "active" : "done";
  };
  const anyActive = stages.slice(0, count).some((_, i) => statusOf(i) === "active");
  const settledNow =
    !running && allShown && available === stages.length && (count === 0 || shown.dwell) && visibleTail.length === tail.length && !anyActive;

  // Open state (controlled or not). Closes itself when the steps settle; starts closed.
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => {
    if (openProp === undefined) setOpenState(v);
    onOpenChange?.(v);
  };
  const wasSettled = useRef(settledNow);
  const doneCalled = useRef(false);
  useEffect(() => {
    if (settledNow && !wasSettled.current) setOpen(false);
    wasSettled.current = settledNow;
    if (settledNow && !doneCalled.current) {
      doneCalled.current = true;
      onDone?.();
    }
    // setOpen/onDone are read at the moment it settles; re-running on their identity would re-close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledNow]);

  const bodyId = useId();
  const n = stages.length;
  const problem = stages.some((s) => s.status === "error") ? "error" : stages.some((s) => s.status === "stopped") ? "stopped" : undefined;
  const glyph: "running" | "done" | "error" | "stopped" = !settledNow ? "running" : problem ?? "done";
  const headText = settledNow ? `Reasoned in ${n} step${n === 1 ? "" : "s"}` : head >= 0 ? stages[head]!.label : idleLabel;
  const headKey = settledNow ? "summary" : head >= 0 ? stages[head]!.key : "idle";
  const appear = reduced ? false : undefined;

  const stripLines = head >= 0 && !(allShown && visibleTail.length) ? visibleLines(head) : visibleTail;
  const showStrip = !open && !settledNow && (stripLines.length > 0 || visibleSources.length > 0);

  return (
    <section
      data-slot="reasoning-steps"
      data-state={settledNow ? "settled" : "running"}
      data-open={open || undefined}
      data-reduced={reduced || undefined}
      data-stage-count={count}
      className={className}
      aria-label={label}
    >
      <button
        type="button"
        data-slot="reasoning-steps-header"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span data-slot="reasoning-steps-glyph" data-glyph={glyph} aria-hidden="true">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={glyph}
              initial={reduced ? false : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduced ? undefined : { opacity: 0, scale: 0.6 }}
              transition={{ duration: 0.2, ease: EASE }}
            >
              <Glyph kind={glyph} />
            </motion.span>
          </AnimatePresence>
        </span>
        <span data-slot="reasoning-steps-label">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={headKey}
              data-slot="reasoning-steps-label-text"
              data-shimmer={!settledNow || undefined}
              initial={appear ?? { opacity: 0, y: 6, clipPath: "inset(0 100% 0 0)" }}
              animate={{ opacity: 1, y: 0, clipPath: "inset(0 0% 0 0)" }}
              exit={reduced ? undefined : { opacity: 0, y: -6 }}
              transition={{ duration: 0.32, ease: EASE, clipPath: { duration: 0.45, ease: "linear" } }}
            >
              {headText}
            </motion.span>
          </AnimatePresence>
        </span>
        {settledNow && meta ? <span data-slot="reasoning-steps-meta">{meta}</span> : null}
        {!settledNow && count > 1 ? (
          <span data-slot="reasoning-steps-meta" className="tabular">
            step {count}
          </span>
        ) : null}
        <CaretRight data-slot="reasoning-steps-caret" aria-hidden="true" weight="bold" />
      </button>

      <span className="sr-only" role="status" aria-live="polite">
        {settledNow ? headText : head >= 0 ? `${statusWord(stages[head]!, statusOf(head))}: ${stages[head]!.label}` : idleLabel}
      </span>

      {showStrip && (
        <div data-slot="reasoning-steps-strip">
          {stripLines.length > 0 && (
            <ul data-slot="reasoning-steps-reasoning" data-overflow={stripLines.length > 3 || undefined}>
              <AnimatePresence initial={false}>
                {stripLines.map((l) => (
                  <ReasonLine key={l.key} line={l} reduced={reduced} />
                ))}
              </AnimatePresence>
            </ul>
          )}
          {visibleSources.length > 0 && <SourceChips sources={visibleSources} reduced={reduced} />}
        </div>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            id={bodyId}
            data-slot="reasoning-steps-body"
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduced ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            <ol data-slot="reasoning-steps-list" aria-label="Steps">
              {stages.slice(0, count).map((s, i) => (
                <StageRow
                  key={s.key}
                  stage={s}
                  status={statusOf(i)}
                  lines={visibleLines(i)}
                  sources={visibleSources.filter((src) => src.at === i)}
                  reduced={reduced}
                  index={i}
                />
              ))}
            </ol>
            {visibleTail.length > 0 && (
              <ul data-slot="reasoning-steps-reasoning" data-tail="">
                {visibleTail.map((l) => (
                  <ReasonLine key={l.key} line={l} reduced={reduced} />
                ))}
              </ul>
            )}
            {visibleSources.some((s) => s.at === undefined) && (
              <SourceChips sources={visibleSources.filter((s) => s.at === undefined)} reduced={reduced} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

const statusWord = (s: Stage, status: ReasoningStageStatus) => (status === s.status && s.statusLabel ? s.statusLabel : STATUS_WORDS[status]);

/* ------------------------------------------------------------------------------- pieces */

function Glyph({ kind }: { kind: ReasoningStageStatus | "running" }) {
  switch (kind) {
    case "running":
    case "active":
      return <CircleNotch data-spin="" weight="bold" />;
    case "done":
      return <Check weight="bold" />;
    case "error":
      return <Warning weight="fill" />;
    case "stopped":
      return <StopCircle weight="bold" />;
    case "skipped":
      return <MinusCircle weight="bold" />;
    case "pending":
      return <MinusCircle weight="regular" />;
  }
}

function StageRow({
  stage,
  status,
  lines,
  sources,
  reduced,
  index,
}: {
  stage: Stage;
  status: ReasoningStageStatus;
  lines: Line[];
  sources: Source[];
  reduced: boolean;
  index: number;
}) {
  const [own, setOwn] = useState(false);
  const expanded = stage.expanded ?? own;
  const toggle = () => (stage.onToggle ? stage.onToggle() : setOwn((v) => !v));
  const detailId = useId();
  const canExpand = stage.detail !== undefined && stage.detail !== null && stage.detail !== false;
  const word = statusWord(stage, status);
  const label = (
    <>
      <span data-slot="reasoning-steps-stage-label" data-shimmer={status === "active" || undefined}>
        {stage.label}
      </span>
      {stage.meta ? <span data-slot="reasoning-steps-stage-meta">{stage.meta}</span> : null}
    </>
  );
  return (
    <motion.li
      data-slot="reasoning-steps-stage"
      data-status={status}
      data-open={(canExpand && expanded) || undefined}
      data-highlight={stage.highlighted || undefined}
      id={stage.anchorId}
      tabIndex={stage.anchorId ? -1 : undefined}
      initial={reduced ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE, delay: reduced ? 0 : Math.min(index, 8) * 0.03 }}
    >
      <span data-slot="reasoning-steps-stage-mark" data-glyph={status} role="img" aria-label={word}>
        <Glyph kind={status} />
      </span>
      <div data-slot="reasoning-steps-stage-main">
        {canExpand ? (
          <button type="button" data-slot="reasoning-steps-stage-head" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} onClick={toggle}>
            {label}
            <CaretRight data-slot="reasoning-steps-caret" aria-hidden="true" weight="bold" />
          </button>
        ) : (
          <div data-slot="reasoning-steps-stage-head">{label}</div>
        )}
        {lines.length > 0 && (
          <ul data-slot="reasoning-steps-reasoning">
            {lines.map((l) => (
              <ReasonLine key={l.key} line={l} reduced={reduced} />
            ))}
          </ul>
        )}
        {sources.length > 0 && <SourceChips sources={sources} reduced={reduced} />}
        {stage.note ? <div data-slot="reasoning-steps-stage-note">{stage.note}</div> : null}
        {canExpand && expanded && (
          <div id={detailId} data-slot="reasoning-steps-stage-detail">
            {stage.detail}
          </div>
        )}
      </div>
    </motion.li>
  );
}

function ReasonLine({ line, reduced }: { line: Line; reduced: boolean }) {
  return (
    <motion.li
      data-slot="reasoning-steps-reasoning-line"
      initial={reduced ? false : { opacity: 0, y: 6, filter: "blur(2px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={reduced ? undefined : { opacity: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
    >
      {line.tag ? (
        <span data-slot="reasoning-steps-reasoning-tag" data-tone={line.tagTone ?? "neutral"}>
          {line.tag}
        </span>
      ) : null}
      <span data-slot="reasoning-steps-reasoning-text">{line.text}</span>
    </motion.li>
  );
}

function SourceChips({ sources, reduced }: { sources: Source[]; reduced: boolean }) {
  return (
    <ul data-slot="reasoning-steps-sources" aria-label="Sources consulted">
      <AnimatePresence initial={false}>
        {sources.map((s) => (
          <motion.li
            key={s.key}
            initial={reduced ? false : { opacity: 0, scale: 0.94, y: 2 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            <SourceChip source={s} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function SourceChip({ source: s }: { source: Source }) {
  const body = (
    <>
      {s.icon ? (
        <span data-slot="reasoning-steps-source-icon" aria-hidden="true">
          {s.icon}
        </span>
      ) : null}
      <span data-slot="reasoning-steps-source-label">{s.label}</span>
    </>
  );
  if (s.href && s.external)
    return (
      <a data-slot="reasoning-steps-source" href={s.href} target="_blank" rel="noreferrer noopener" title={s.title}>
        {body}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  if (s.href)
    return (
      <Link data-slot="reasoning-steps-source" to={s.href} title={s.title}>
        {body}
      </Link>
    );
  if (s.onSelect)
    return (
      <button type="button" data-slot="reasoning-steps-source" onClick={s.onSelect} title={s.title}>
        {body}
      </button>
    );
  return (
    <span data-slot="reasoning-steps-source" data-static="" title={s.title}>
      {body}
    </span>
  );
}
