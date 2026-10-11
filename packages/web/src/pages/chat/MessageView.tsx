// Presentational pieces of Notary Chat: a user message, and an assistant message (agent badge →
// work timeline with live steps and notes → streamed markdown answer with numbered citation chips
// → sources and footer). No data loading here: pass a TurnView built by `reduceChatEvents`
// (./model.ts), so other pages can show a recorded turn with the same components.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { ChatCitation } from "../../../../core/src/schema";
import { AgentBadge, Card, CertificateCard, TableFrame, Timeline, TimelineItem, TimelineMarker, slideIn, type TimelineMark, type TimelineTone } from "../../ui";
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
  unknownMarkers,
  workOpenByDefault,
  workSummary,
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

/* -------------------------------------------------------------------------------- step */

function StepRow({
  step,
  domId,
  expanded,
  highlighted,
  onToggle,
  runId,
}: {
  step: StepView;
  domId: string;
  expanded: boolean;
  highlighted: boolean;
  onToggle: () => void;
  runId?: string;
}) {
  const bodyId = `${domId}-body`;
  const meta = [
    step.durationMs !== undefined ? durationText(step.durationMs) : undefined,
    step.costUsd !== undefined && step.costUsd !== null ? costText(step.costUsd, "live") : undefined,
    step.credits !== undefined ? `${step.credits} credit${step.credits === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean);
  const data = classifyStepData(step.data);
  const expandable = step.state !== "running";
  const ref = useRef<HTMLLIElement>(null);
  // Rows slide in as they stream (kit motion; nothing under reduced motion). Once per row: a
  // second gsap.from (React StrictMode re-runs effects) would start from the first one's 0 opacity.
  useEffect(() => {
    const el = ref.current;
    if (!el || el.dataset.slid) return;
    el.dataset.slid = "1";
    slideIn(el);
  }, []);
  return (
    <TimelineItem
      ref={ref}
      {...MARK[step.state]}
      markLabel={statusLabel(step.state)}
      className="chat-step"
      id={domId}
      data-state={step.state}
      data-open={(expanded && expandable) || undefined}
      data-highlight={highlighted || undefined}
      tabIndex={-1}
      title={
        <button
          type="button"
          className="chat-step-head"
          aria-expanded={expandable ? expanded : undefined}
          aria-controls={expandable ? bodyId : undefined}
          disabled={!expandable}
          onClick={onToggle}
        >
          <span className="chat-step-title">{stepTitle(step)}</span>
          {expandable && <CaretRight className="chat-caret" />}
        </button>
      }
      meta={meta.length > 0 ? <span className="chat-step-meta">{meta.join(" · ")}</span> : undefined}
    >
      {step.fix && (step.state === "unavailable" || step.state === "error") && (
        <p className="chat-step-fix" data-state={step.state}>
          <CodeText text={step.fix} />
        </p>
      )}
      {expanded && expandable && (
        <div id={bodyId} className="chat-step-body">
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
      )}
    </TimelineItem>
  );
}

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
  const [workOpen, setWorkOpen] = useState(workOpenByDefault(view));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [highlight, setHighlight] = useState<string>();
  const [copied, setCopied] = useState(false);
  const wasFinished = useRef(finished);
  const workId = useId();
  // Collapse once the answer completes (the user can reopen it).
  useEffect(() => {
    if (finished && !wasFinished.current) setWorkOpen(false);
    wasFinished.current = finished;
  }, [finished]);
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

  const steps = view.items.filter((i) => i.kind === "step").length;
  const hasWork = view.items.length > 0;
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
        <section className="chat-work" data-open={workOpen || undefined} data-finished={finished || undefined}>
          <button type="button" className="chat-work-toggle" aria-expanded={workOpen} aria-controls={workId} onClick={() => setWorkOpen((v) => !v)}>
            {!finished && <span className="chat-spinner" aria-hidden="true" />}
            <span className="chat-work-label">{finished ? workSummary(view, mode) : steps ? `Working… ${steps} step${steps === 1 ? "" : "s"}` : "Working…"}</span>
            <CaretRight className="chat-caret" />
          </button>
          <Timeline id={workId} className="chat-steps" hidden={!workOpen} aria-live="polite" aria-relevant="additions" aria-label="Steps">
            {view.items.map((item) =>
              item.kind === "note" ? (
                <TimelineItem
                  key={item.key}
                  mark="dot"
                  className="chat-note"
                  title={
                    <span className="chat-note-line">
                      <span className="chat-note-tag" data-source={noteTag(mode, item.source) === "Replay engine" ? "replay" : "model"}>
                        {noteTag(mode, item.source)}
                      </span>{" "}
                      <span className="chat-note-text">{item.text}</span>
                    </span>
                  }
                />
              ) : view.steps[item.id] ? (
                <StepRow
                  key={item.id}
                  step={view.steps[item.id]!}
                  domId={domId(item.id)}
                  expanded={expanded.has(item.id)}
                  highlighted={highlight === item.id}
                  onToggle={() => toggle(item.id)}
                  runId={runId}
                />
              ) : null,
            )}
          </Timeline>
        </section>
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
