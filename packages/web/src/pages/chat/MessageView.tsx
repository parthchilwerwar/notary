// Presentational pieces of Notary Chat: a user message, and an assistant message (agent badge →
// Reasoning Steps fed by the turn's real steps, notes and cited records → streamed markdown answer
// with numbered citation chips → sources and footer). No data loading here: pass a TurnView built
// by `reduceChatEvents` (./model.ts), so other pages can show a recorded turn with the same
// components.
import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { BracketsCurlyIcon as BracketsCurly } from "@phosphor-icons/react/dist/csr/BracketsCurly";
import { FileTextIcon as FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { HandPalmIcon as HandPalm } from "@phosphor-icons/react/dist/csr/HandPalm";
import { ListBulletsIcon as ListBullets } from "@phosphor-icons/react/dist/csr/ListBullets";
import { PathIcon as Path } from "@phosphor-icons/react/dist/csr/Path";
import { SealCheckIcon as SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import type { ChatCitation } from "../../../../core/src/schema";
import { AgentBadge, Card, CertificateCard, TableFrame, TimelineMarker, type TimelineMark, type TimelineTone } from "../../ui";
import { ReasoningSteps, type ReasoningLineItem, type ReasoningSource, type ReasoningStageItem, type ReasoningStageStatus } from "../../ui/reasoning-steps";
import { CaretRight, CheckIcon, CopyIcon, External } from "./icons";
import { Markdown } from "./MarkdownView";
import {
  cellText,
  citationHref,
  citationTarget,
  classifyStepData,
  costText,
  domainOf,
  durationText,
  humanKey,
  isTurnFinished,
  noteTag,
  statusLabel,
  stepTitle,
  tokensText,
  traceHref,
  turnSteps,
  unknownMarkers,
  type ChatMode,
  type StepData,
  type StepState,
  type StepView,
  type TurnView,
} from "./model";
import "./chat-tokens.css";
import "./chat.css";

/* ------------------------------------------------------------------------------- marks */

const MARK: Record<StepState, { mark: TimelineMark; tone: TimelineTone }> = {
  running: { mark: "spinner", tone: "active" },
  ok: { mark: "check", tone: "active" },
  error: { mark: "x", tone: "unsafe" },
  unavailable: { mark: "pending", tone: "neutral" },
  aborted: { mark: "x", tone: "neutral" },
};

/** One timeline node: spinner while running, blue check when done, red x on failure, neutral otherwise. */
export function StepMark({ state }: { state: StepState }) {
  return <TimelineMarker {...MARK[state]} label={statusLabel(state)} />;
}

/* --------------------------------------------------------------------------- step data */

function JsonToggle({ data }: { data: unknown }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="chat-json">
      <button type="button" className="chat-text-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <CaretRight className="chat-caret" />
        Raw JSON
      </button>
      {open && (
        <pre id={id} tabIndex={0} aria-label="Step result as JSON">
          <code translate="no">{JSON.stringify(data, null, 2)}</code>
        </pre>
      )}
    </div>
  );
}

function KeyValues({ entries }: { entries: [string, ReactNode][] }) {
  return (
    <dl className="chat-kv">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function StepDataView({ data, runId }: { data: StepData; runId?: string }) {
  switch (data.kind) {
    case "none":
      return null;
    case "certificate": {
      const c = data.card;
      return (
        <CertificateCard
          className="chat-cert"
          tool={c.tool ?? c.claimId.split(".")[0] ?? "API"}
          claimId={c.claimId}
          revoked={c.status === "revoked"}
          verdict={c.verdict}
          scope={c.scope}
          evidence={c.evidenceCount !== undefined ? `${c.evidenceCount} probe${c.evidenceCount === 1 ? "" : "s"}` : undefined}
          href={citationHref({ type: "certificate", id: c.id }, runId)!.href}
          footer={
            <span className="chat-cert-id">
              Certificate <code translate="no">{c.id}</code>
            </span>
          }
        />
      );
    }
    case "run_events":
      return (
        <Card padding="none" className="chat-card-flush">
          <ol className="chat-events">
            {data.rows.map((r) => (
              <li key={`${r.runId}#${r.seq}`}>
                <Link to={citationHref({ type: "run_event", id: `${r.runId}#${r.seq}` })!.href}>
                  <span className="chat-event-seq tabular">#{r.seq}</span>
                  <span className="chat-event-summary">{r.summary}</span>
                  <CaretRight className="chat-event-go" />
                </Link>
              </li>
            ))}
            {data.total !== undefined && data.total > data.rows.length && (
              <li className="chat-events-more">
                {data.total - data.rows.length} more in{" "}
                {data.runId ? <Link to={citationHref({ type: "run", id: data.runId })!.href}>the run</Link> : "the run"}
              </li>
            )}
          </ol>
        </Card>
      );
    case "doc": {
      const domain = domainOf(data.url);
      return (
        <Card padding="sm" className="chat-doc">
          <a className="chat-doc-title" href={data.url} target="_blank" rel="noreferrer noopener">
            <span>{data.title ?? data.url}</span>
            <External />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          {domain && <p className="chat-doc-domain">{domain}</p>}
          {data.passage && <blockquote className="chat-passage">{data.passage}</blockquote>}
        </Card>
      );
    }
    case "table":
      return (
        <div className="chat-table-block">
          <TableFrame className="chat-table-frame">
            <table className="chat-table" tabIndex={0} aria-label="Step result table">
              <thead>
                <tr>
                  {data.columns.map((c) => (
                    <th key={c} scope="col">
                      {humanKey(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={i}>
                    {data.columns.map((c) => (
                      <td key={c}>{cellText(r[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
          {(data.note || (data.total !== undefined && data.total > data.rows.length)) && (
            <p className="chat-table-note">
              {[data.note, data.total !== undefined && data.total > data.rows.length ? `${data.rows.length} of ${data.total} shown` : undefined]
                .filter(Boolean)
                .join(". ")}
            </p>
          )}
        </div>
      );
    case "kv":
      return (
        <Card padding="sm" className="chat-kv-card">
          <KeyValues entries={data.entries.map(([k, v]) => [humanKey(k), cellText(v)])} />
        </Card>
      );
  }
}

/* ------------------------------------------------------------------- reasoning (steps) */

/** A step's state as a Reasoning Steps status. */
const STAGE_STATUS: Record<StepState, ReasoningStageStatus> = {
  running: "active",
  ok: "done",
  error: "error",
  unavailable: "skipped",
  aborted: "stopped",
};

/** Recorded facts of one step: duration, cost, Crustdata credits (only what was recorded). */
function stepMeta(step: StepView): string {
  return [
    step.durationMs !== undefined ? durationText(step.durationMs) : undefined,
    step.costUsd !== undefined && step.costUsd !== null ? costText(step.costUsd, "live") : undefined,
    step.credits !== undefined ? `${step.credits} credit${step.credits === 1 ? "" : "s"}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "4.2s · $0.0123" after the settled summary: total duration and cost, or how the turn ended. */
function workFacts(view: TurnView, mode: ChatMode): string {
  const steps = turnSteps(view);
  const ms = view.done?.durationMs ?? (steps.length ? steps.reduce((a, s) => a + (s.durationMs ?? 0), 0) : undefined);
  const parts = ms !== undefined ? [durationText(ms)] : [];
  if (view.done) parts.push(costText(view.done.costUsd, view.done.mode));
  else if (view.status === "stopped") parts.push("stopped");
  else if (view.status === "error") parts.push("failed");
  else parts.push(costText(undefined, mode));
  return parts.join(" · ");
}

/** A finished step's details: its output and input, the result card, and the raw JSON. */
function StepDetail({ step, runId }: { step: StepView; runId?: string }) {
  const data = classifyStepData(step.data);
  return (
    <div className="chat-step-body">
      {(step.output || step.input) && (
        <p className="chat-step-output">
          {step.output}
          {step.input && (
            <span className="chat-step-input">
              Input <code translate="no">{step.input}</code>
            </span>
          )}
        </p>
      )}
      <StepDataView data={data} runId={runId} />
      {step.data !== undefined && <JsonToggle data={step.data} />}
    </div>
  );
}

const KIND_ICON: Record<ChatCitation["type"], () => ReactNode> = {
  certificate: () => <SealCheck weight="bold" />,
  run_event: () => <ListBullets weight="bold" />,
  run: () => <Path weight="bold" />,
  approval: () => <HandPalm weight="bold" />,
  doc: () => <FileText weight="bold" />,
  api_response: () => <BracketsCurly weight="bold" />,
};

/**
 * The turn as Reasoning Steps input, from its recorded data only: every step is a stage (title,
 * status, duration/cost, fix, details), every note a reasoning line attached to the step it comes
 * before (a note explains the next step; a trailing one stays unattached), and every valid cited
 * record a source chip on the step that produced it. Flagged citations stay out (they are listed,
 * flagged, under the answer).
 */
export function reasoningInput(
  view: TurnView,
  mode: ChatMode,
  ui: { domId: (id: string) => string; expanded: Set<string>; highlight?: string; toggle: (id: string) => void; showStep: (id: string) => void; runId?: string },
) {
  const stages: ReasoningStageItem[] = turnSteps(view).map((step) => {
    const meta = stepMeta(step);
    const hasDetail = step.state !== "running" && (!!step.output || !!step.input || step.data !== undefined);
    return {
      id: step.id,
      label: stepTitle(step),
      status: STAGE_STATUS[step.state],
      statusLabel: statusLabel(step.state),
      meta: meta || undefined,
      note:
        step.fix && (step.state === "unavailable" || step.state === "error") ? (
          <p className="chat-step-fix" data-state={step.state}>
            <CodeText text={step.fix} />
          </p>
        ) : undefined,
      detail: hasDetail ? <StepDetail step={step} runId={ui.runId} /> : undefined,
      expanded: ui.expanded.has(step.id),
      onToggle: () => ui.toggle(step.id),
      anchorId: ui.domId(step.id),
      highlighted: ui.highlight === step.id,
    };
  });

  const reasoning: ReasoningLineItem[] = [];
  let pending: Extract<TurnView["items"][number], { kind: "note" }>[] = [];
  const line = (n: (typeof pending)[number], stage?: string): ReasoningLineItem => {
    const tag = noteTag(mode, n.source);
    return { id: n.key, text: n.text, tag, tagTone: tag === "Replay engine" ? "accent" : "neutral", ...(stage ? { stage } : {}) };
  };
  for (const item of view.items) {
    if (item.kind === "note") pending.push(item);
    else if (view.steps[item.id]) {
      reasoning.push(...pending.map((n) => line(n, item.id)));
      pending = [];
    }
  }
  reasoning.push(...pending.map((n) => line(n)));

  const seen = new Set<string>();
  const sources: ReasoningSource[] = view.citations.flatMap((c) => {
    const key = `${c.type}:${c.id}`;
    if (!c.valid || seen.has(key)) return [];
    seen.add(key);
    const href = citationHref(c, ui.runId);
    const stage = c.stepId && view.steps[c.stepId] ? c.stepId : undefined;
    return [
      {
        id: key,
        label: c.label,
        icon: KIND_ICON[c.type](),
        title: `${TYPE_LABEL[c.type]} ${c.id}`,
        ...(href ? { href: href.href, external: href.external } : stage ? { onSelect: () => ui.showStep(stage) } : {}),
        ...(stage ? { stage } : {}),
      },
    ];
  });
  return { stages, reasoning, sources };
}

/** Replay paces what the steps show (the engine's own events are near-instant); live follows the data. */
const REPLAY_PACE = { stageMs: 600, reasonMs: 260 };

/** Text with `backticked` commands as code. */
export function CodeText({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 ? (
          <code key={i} translate="no">
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------ message */

export function UserMessage({ text }: { text: string }) {
  return (
    <div className="chat-msg chat-msg-user">
      <h2 className="sr-only">You said</h2>
      <p className="chat-user-bubble">{text}</p>
    </div>
  );
}

export type MessageViewProps = {
  view: TurnView;
  mode: ChatMode;
  /** Unique per message on the page (DOM ids of steps derive from it). */
  messageKey: string;
  /** Run kept in ?run= for record links. */
  runId?: string;
  /** Recorded trace id → URL links, when any exist (never built). */
  traceLinks?: Record<string, string>;
  /** Hide the footer actions (an embedded excerpt). */
  compact?: boolean;
};

export function MessageView({ view, mode, messageKey, runId, traceLinks, compact = false }: MessageViewProps) {
  const finished = isTurnFinished(view);
  // The full step list starts closed (the running strip shows the current step) and closes itself
  // once the steps settle; a citation chip opens it.
  const [workOpen, setWorkOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [highlight, setHighlight] = useState<string>();
  const [copied, setCopied] = useState(false);
  // A message that was already finished when it mounted (history) shows its steps settled at once.
  const [finishedAtMount] = useState(finished);
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(undefined), 2200);
    return () => clearTimeout(t);
  }, [highlight]);

  const domId = (stepId: string) => `chat-${messageKey}-${stepId}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const showStep = (stepId: string) => {
    setWorkOpen(true);
    setExpanded((s) => new Set(s).add(stepId));
    setHighlight(stepId);
    requestAnimationFrame(() => {
      const el = document.getElementById(domId(stepId));
      if (!el) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      el.focus({ preventScroll: true });
    });
  };

  const byN = new Map(view.citations.map((c) => [c.n, c]));
  const missing = new Set(unknownMarkers(view.text, view.citations));
  const renderCite = (n: number, key: string): ReactNode => {
    const c = byN.get(n);
    // While streaming, citations arrive with the final event: a marker is pending, not flagged.
    if (!c && !finished)
      return (
        <span key={key} className="chat-cite" data-static="" data-pending="">
          {n}
          <span className="sr-only"> (citation {n})</span>
        </span>
      );
    if (!c || !c.valid)
      return (
        <span key={key} className="chat-cite" data-invalid="" title={c ? "This citation did not match any step of this answer" : "No citation was recorded for this number"}>
          {n}
          <span className="sr-only">{c ? ` (citation ${n}, flagged: not found in this answer's steps)` : ` (citation ${n}, missing)`}</span>
        </span>
      );
    return <CiteChip key={key} c={c} view={view} runId={runId} onStep={showStep} />;
  };

  const reasoning = reasoningInput(view, mode, { domId, expanded, highlight, toggle, showStep, runId });
  const hasWork = reasoning.stages.length > 0 || reasoning.reasoning.length > 0;
  const live = mode === "live" || finishedAtMount;
  const trace = view.done?.traceId;
  const traceUrl = traceHref(trace, traceLinks);
  const copy = () => {
    void navigator.clipboard?.writeText(view.text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };
  return (
    <article className="chat-msg chat-msg-assistant" aria-label="Notary Chat's answer" aria-busy={!finished || undefined}>
      <div className="chat-msg-who">
        <AgentBadge agent="chat" />
      </div>
      {(hasWork || !finished) && (
        <ReasoningSteps
          className="chat-work"
          stages={reasoning.stages}
          reasoning={reasoning.reasoning}
          sources={reasoning.sources}
          live={live}
          running={!finished}
          stageMs={REPLAY_PACE.stageMs}
          reasonMs={REPLAY_PACE.reasonMs}
          open={workOpen}
          onOpenChange={setWorkOpen}
          meta={workFacts(view, mode)}
          label="Notary Chat's steps"
        />
      )}
      {view.text && (
        <div className="chat-answer-wrap" aria-live="polite" aria-busy={!finished || undefined}>
          <Markdown className="chat-answer" text={view.text} renderCite={renderCite} />
        </div>
      )}
      {view.error && (
        <div className="chat-error" role="alert">
          <p className="chat-error-title">{view.error.message}</p>
          {view.error.fix && (
            <p className="chat-error-fix">
              <CodeText text={view.error.fix} />
            </p>
          )}
        </div>
      )}
      {view.status === "stopped" && <p className="chat-stopped">Stopped before the answer finished.</p>}
      {(view.citations.length > 0 || missing.size > 0) && finished && (
        <Sources citations={view.citations} missing={[...missing]} view={view} runId={runId} onStep={showStep} />
      )}
      {view.done && !compact && (
        <footer className="chat-footer">
          <span className="chat-footer-fact">{costText(view.done.costUsd, view.done.mode)}</span>
          {view.done.mode === "live" && tokensText(view.done.tokens) && <span className="chat-footer-fact">{tokensText(view.done.tokens)}</span>}
          {trace &&
            (traceUrl ? (
              <a className="chat-footer-action" href={traceUrl} target="_blank" rel="noreferrer noopener">
                <External />
                View trace<span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <span className="chat-footer-fact">
                Trace <code translate="no" title="No trace link was recorded">{trace}</code>
              </span>
            ))}
          <button type="button" className="chat-footer-action" onClick={copy} aria-label={copied ? "Answer copied" : "Copy answer"}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </button>
          <span className="sr-only" role="status">
            {copied ? "Answer copied" : ""}
          </span>
        </footer>
      )}
    </article>
  );
}

function CiteChip({ c, view, runId, onStep }: { c: ChatCitation; view: TurnView; runId?: string; onStep: (id: string) => void }) {
  const target = citationTarget(c, view, runId);
  const label = `Citation ${c.n}: ${c.label}`;
  if (target.kind === "step")
    return (
      <button type="button" className="chat-cite" aria-label={`${label}. Show the step that produced it`} title={c.label} onClick={() => onStep(target.stepId)}>
        {c.n}
      </button>
    );
  if (target.kind === "link")
    return (
      <Link className="chat-cite" to={target.href} aria-label={label} title={c.label}>
        {c.n}
      </Link>
    );
  if (target.kind === "external")
    return (
      <a className="chat-cite" href={target.href} target="_blank" rel="noreferrer noopener" aria-label={`${label} (opens in a new tab)`} title={c.label}>
        {c.n}
      </a>
    );
  return (
    <span className="chat-cite" data-static="" title={c.label}>
      {c.n}
      <span className="sr-only"> ({label})</span>
    </span>
  );
}

const TYPE_LABEL: Record<ChatCitation["type"], string> = {
  certificate: "Certificate",
  run_event: "Run event",
  run: "Run",
  approval: "Held action",
  doc: "Docs page",
  api_response: "API response",
};

function Sources({
  citations,
  missing,
  view,
  runId,
  onStep,
}: {
  citations: ChatCitation[];
  missing: number[];
  view: TurnView;
  runId?: string;
  onStep: (id: string) => void;
}) {
  const flagged = citations.filter((c) => !c.valid).length + missing.length;
  return (
    <details className="chat-sources">
      <summary>
        <CaretRight className="chat-caret" />
        {citations.length} source{citations.length === 1 ? "" : "s"}
        {flagged ? <span className="chat-flag-count"> · {flagged} flagged</span> : null}
      </summary>
      <ol>
        {citations.map((c) => {
          const href = citationHref(c, runId);
          const step = c.stepId && view.steps[c.stepId] ? c.stepId : undefined;
          return (
            <li key={c.n} data-invalid={!c.valid || undefined}>
              <span className="chat-cite" data-static="" data-invalid={!c.valid ? "" : undefined} aria-hidden="true">
                {c.n}
              </span>
              <span className="chat-source-body">
                <span className="chat-source-type">{TYPE_LABEL[c.type]}</span>
                {href ? (
                  href.external ? (
                    <a href={href.href} target="_blank" rel="noreferrer noopener">
                      {c.label}
                    </a>
                  ) : (
                    <Link to={href.href}>{c.label}</Link>
                  )
                ) : (
                  <span>{c.label}</span>
                )}
                {!c.valid && <span className="chat-flag">Flagged: did not match any step of this answer</span>}
                {step && (
                  <button type="button" className="chat-text-button" onClick={() => onStep(step)}>
                    Show step
                  </button>
                )}
              </span>
            </li>
          );
        })}
        {missing.map((n) => (
          <li key={`m${n}`} data-invalid>
            <span className="chat-cite" data-static="" data-invalid="" aria-hidden="true">
              {n}
            </span>
            <span className="chat-flag">[{n}] appears in the answer but no citation was recorded for it</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
