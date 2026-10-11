// Presentational pieces of Notary Chat: a user message, and an assistant message (work section
// with live steps and notes → streamed markdown answer → numbered citation chips → sources and
// footer). No data loading here: pass a TurnView built by `reduceChatEvents` (./model.ts), so the
// landing can show a recorded excerpt with the same components.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { ChatCitation } from "../../../../core/src/schema";
import { Markdown } from "./MarkdownView";
import {
  cellText,
  citationHref,
  citationTarget,
  classifyStepData,
  costText,
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
import "./chat.css";

/* ------------------------------------------------------------------------------- marks */

export function StepMark({ state }: { state: StepState }) {
  return (
    <span className="chat-mark" data-state={state} role="img" aria-label={statusLabel(state)}>
      {state === "running" ? (
        <span className="chat-spinner" />
      ) : (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          {state === "ok" ? (
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          ) : state === "error" ? (
            <path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          ) : state === "unavailable" ? (
            <>
              <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5.5 8h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </>
          ) : (
            <rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor" />
          )}
        </svg>
      )}
    </span>
  );
}

/* --------------------------------------------------------------------------- step data */

function JsonToggle({ data }: { data: unknown }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="chat-json">
      <button type="button" className="chat-link-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide JSON" : "Show JSON"}
      </button>
      {open && (
        <pre id={id} tabIndex={0} aria-label="Step result as JSON">
          <code translate="no">{JSON.stringify(data, null, 2)}</code>
        </pre>
      )}
    </div>
  );
}

function StepDataView({ data, runId }: { data: StepData; runId?: string }) {
  switch (data.kind) {
    case "none":
      return null;
    case "certificate": {
      const c = data.card;
      return (
        <div className="chat-card">
          <p className="chat-card-head">
            <span className="chat-pill" data-status={c.status}>
              {c.status}
            </span>
            <code translate="no">{c.claimId}</code>
          </p>
          <dl className="chat-kv">
            {c.verdict && (
              <div>
                <dt>Verdict</dt>
                <dd>{c.verdict}</dd>
              </div>
            )}
            {c.scope && (
              <div>
                <dt>Scope</dt>
                <dd>{c.scope}</dd>
              </div>
            )}
            {c.evidenceCount !== undefined && (
              <div>
                <dt>Evidence</dt>
                <dd className="tabular">
                  {c.evidenceCount} probe{c.evidenceCount === 1 ? "" : "s"}
                </dd>
              </div>
            )}
          </dl>
          <p className="chat-card-link">
            <Link to={citationHref({ type: "certificate", id: c.id }, runId)!.href}>Open certificate {c.id}</Link>
          </p>
        </div>
      );
    }
    case "run_events":
      return (
        <ol className="chat-events">
          {data.rows.map((r) => (
            <li key={`${r.runId}#${r.seq}`}>
              <Link to={citationHref({ type: "run_event", id: `${r.runId}#${r.seq}` })!.href}>
                <span className="chat-event-seq tabular">#{r.seq}</span>
                <span className="chat-event-summary">{r.summary}</span>
              </Link>
            </li>
          ))}
          {data.total !== undefined && data.total > data.rows.length && (
            <li className="chat-muted">
              {data.total - data.rows.length} more in{" "}
              {data.runId ? <Link to={citationHref({ type: "run", id: data.runId })!.href}>the run</Link> : "the run"}
            </li>
          )}
        </ol>
      );
    case "doc":
      return (
        <div className="chat-card">
          <p className="chat-card-head">
            <a href={data.url} target="_blank" rel="noreferrer noopener">
              {data.title ?? data.url}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
          <p className="chat-muted chat-break">{data.url}</p>
          {data.passage && <blockquote className="chat-passage">{data.passage}</blockquote>}
        </div>
      );
    case "table":
      return (
        <div className="chat-table-wrap" tabIndex={0} role="region" aria-label="Step result table">
          <table className="chat-table">
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
          {(data.note || (data.total !== undefined && data.total > data.rows.length)) && (
            <p className="chat-muted">
              {[data.note, data.total !== undefined && data.total > data.rows.length ? `${data.rows.length} of ${data.total} shown` : undefined]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
      );
    case "kv":
      return (
        <dl className="chat-kv">
          {data.entries.map(([k, v]) => (
            <div key={k}>
              <dt>{humanKey(k)}</dt>
              <dd className="chat-break">{cellText(v)}</dd>
            </div>
          ))}
        </dl>
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
  return (
    <li className="chat-step" id={domId} data-state={step.state} data-highlight={highlighted || undefined} tabIndex={-1}>
      <button
        type="button"
        className="chat-step-head"
        aria-expanded={expandable ? expanded : undefined}
        aria-controls={expandable ? bodyId : undefined}
        disabled={!expandable}
        onClick={onToggle}
      >
        <StepMark state={step.state} />
        <span className="chat-step-title">{stepTitle(step)}</span>
        {meta.length > 0 && <span className="chat-step-meta tabular">{meta.join(" · ")}</span>}
      </button>
      {step.fix && (step.state === "unavailable" || step.state === "error") && (
        <p className="chat-step-fix" data-state={step.state}>
          <CodeText text={step.fix} />
        </p>
      )}
      {expanded && expandable && (
        <div id={bodyId} className="chat-step-body">
          {step.output && <p className="chat-step-output">{step.output}</p>}
          {step.input && (
            <p className="chat-muted chat-break">
              Input <code translate="no">{step.input}</code>
            </p>
          )}
          <StepDataView data={data} runId={runId} />
          {step.data !== undefined && <JsonToggle data={step.data} />}
        </div>
      )}
    </li>
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
  /** Hide the footer actions (landing excerpt). */
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
    const t = setTimeout(() => setHighlight(undefined), 2000);
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
  return (
    <article className="chat-msg chat-msg-assistant" aria-label="Notary's answer" aria-busy={!finished || undefined}>
      {(hasWork || !finished) && (
        <section className="chat-work" data-open={workOpen || undefined}>
          <button type="button" className="chat-work-toggle" aria-expanded={workOpen} aria-controls={workId} onClick={() => setWorkOpen((v) => !v)}>
            {!finished && <StepMark state="running" />}
            <span>{finished ? workSummary(view, mode) : steps ? `Working… ${steps} step${steps === 1 ? "" : "s"}` : "Working…"}</span>
            <svg className="chat-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <ol id={workId} className="chat-steps" hidden={!workOpen} aria-live="polite" aria-relevant="additions" aria-label="Steps">
            {view.items.map((item) =>
              item.kind === "note" ? (
                <li key={item.key} className="chat-note">
                  <span className="chat-note-tag" data-mode={mode}>
                    {noteTag(mode, item.source)}
                  </span>
                  <span>{item.text}</span>
                </li>
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
          </ol>
        </section>
      )}
      {view.text && <Markdown className="chat-answer" text={view.text} renderCite={renderCite} />}
      {view.error && (
        <div className="chat-error" role="alert">
          <p>{view.error.message}</p>
          {view.error.fix && (
            <p className="chat-muted">
              <CodeText text={view.error.fix} />
            </p>
          )}
        </div>
      )}
      {view.status === "stopped" && <p className="chat-muted chat-stopped">Stopped.</p>}
      {(view.citations.length > 0 || missing.size > 0) && finished && (
        <Sources citations={view.citations} missing={[...missing]} view={view} runId={runId} onStep={showStep} />
      )}
      {view.done && !compact && (
        <footer className="chat-footer">
          <span className="tabular">{costText(view.done.costUsd, view.done.mode)}</span>
          <span className="tabular">{tokensText(view.done.tokens)}</span>
          {trace &&
            (traceUrl ? (
              <a href={traceUrl} target="_blank" rel="noreferrer noopener">
                View trace<span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <span>
                Trace <code translate="no" title="No trace link was recorded">{trace}</code>
              </span>
            ))}
          <button
            type="button"
            className="chat-link-button"
            onClick={() => {
              void navigator.clipboard?.writeText(view.text).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => setCopied(false),
              );
            }}
          >
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
    <span className="chat-cite" title={c.label}>
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
  return (
    <details className="chat-sources">
      <summary>
        {citations.length} source{citations.length === 1 ? "" : "s"}
        {citations.some((c) => !c.valid) || missing.length ? ` · ${citations.filter((c) => !c.valid).length + missing.length} flagged` : ""}
      </summary>
      <ol>
        {citations.map((c) => {
          const href = citationHref(c, runId);
          const step = c.stepId && view.steps[c.stepId] ? c.stepId : undefined;
          return (
            <li key={c.n} data-invalid={!c.valid || undefined}>
              <span className="chat-cite" data-invalid={!c.valid ? "" : undefined} aria-hidden="true">
                {c.n}
              </span>
              <span className="chat-source-body">
                <span className="chat-source-type">{TYPE_LABEL[c.type]}</span>{" "}
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
                {!c.valid && <span className="chat-flag"> Flagged: did not match any step of this answer</span>}
                {step && (
                  <>
                    {" "}
                    <button type="button" className="chat-link-button" onClick={() => onStep(step)}>
                      Show step
                    </button>
                  </>
                )}
              </span>
            </li>
          );
        })}
        {missing.map((n) => (
          <li key={`m${n}`} data-invalid>
            <span className="chat-cite" data-invalid="" aria-hidden="true">
              {n}
            </span>
            <span className="chat-flag">[{n}] appears in the answer but no citation was recorded for it</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
