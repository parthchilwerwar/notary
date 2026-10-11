// Presentational pieces of the agent transcript: one compact row per event (status mark, title,
// actor, duration, cost), its expandable details (every statement tagged "Model said" or
// "Verified"), and the held-action card. No data loading here: the Run page and the landing pass
// rows built by `buildRows` (./model.ts).
import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { TAG_LABEL, type TrailLine } from "../../components/trail/model";
import { Button } from "../../components/ui/button";
import {
  clip,
  durationText,
  type HeldCard,
  type RowDetails,
  type RunRow,
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
    <div className="run-held" data-kind={card.kind}>
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
          <Button type="button" size="sm" onClick={onApprove}>
            Approve…
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onReject}>
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
    </div>
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

export function TranscriptRow({ row, expanded = false, onToggle, details, card, entering, certificateHref }: TranscriptRowProps) {
  const detailsId = useId();
  // Deterministic steps have no model or tool to name; only tools, models and humans are shown.
  const actor = row.actor.kind === "code" ? undefined : row.actor;
  const meta = [actor?.name, row.durationMs !== undefined ? durationText(row.durationMs) : undefined, row.cost].filter(Boolean);
  const head = (
    <>
      <StatusMark mark={row.mark} tone={row.tone} />
      <span className="run-row-main">
        <span className="run-row-title">{row.title}</span>
        {row.subject && <span className="run-row-subject">{clip(row.subject, 120)}</span>}
      </span>
      <span className="run-row-meta">
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
