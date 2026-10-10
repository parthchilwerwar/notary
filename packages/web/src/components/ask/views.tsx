// Presentational pieces of Ask Notary (no data fetching): citation chips, a precomputed answer,
// and a local ask response. None of them renders an action control.
import { Link } from "react-router";
import type { AskResponse, Citation, ExplainAnswer } from "../../../../core/src/schema";
import {
  ASK_FAILED_TEXT,
  citationKindLabel,
  citationTarget,
  groupCitations,
  type CitationContext,
} from "./model";

export function CitationList({
  citations,
  ctx,
  onNavigate,
}: {
  citations: readonly Pick<Citation, "kind" | "id" | "runId">[];
  ctx: CitationContext;
  onNavigate?: () => void;
}) {
  const groups = groupCitations(citations);
  const total = groups.reduce((n, g) => n + g.citations.length, 0);
  return (
    <section className="ask-citations" aria-label={`${total} cited records`}>
      <h4>Cited records · {total}</h4>
      {groups.map((g) => (
        <div className="ask-citation-group" key={g.kind}>
          <span className="ask-citation-kind">
            {citationKindLabel(g.kind)} · {g.citations.length}
          </span>
          <div className="record-links">
            {g.citations.map((c) => {
              const t = citationTarget(c, ctx);
              const key = `${c.kind}-${c.id}-${c.runId ?? ""}`;
              return t.type === "link" ? (
                <Link className="record-chip" key={key} to={t.to} title={t.title} onClick={onNavigate}>
                  {c.id}
                </Link>
              ) : (
                <code className="record-chip muted" key={key} title={t.title}>
                  {c.id}
                </code>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

export function AnswerView({
  answer,
  ctx,
  onNavigate,
}: {
  answer: ExplainAnswer;
  ctx: CitationContext;
  onNavigate?: () => void;
}) {
  return (
    <article className="ask-answer" aria-labelledby={`ask-q-${cssId(answer.id)}`}>
      <span className="eyebrow">Runs · {answer.runIds.join(", ")}</span>
      <h3 id={`ask-q-${cssId(answer.id)}`} tabIndex={-1}>
        {answer.question}
      </h3>
      <p className="ask-answer-text">{answer.answer}</p>
      <CitationList citations={answer.citations} ctx={ctx} onNavigate={onNavigate} />
    </article>
  );
}

/** A schema-valid /api/ask response. The failure text and the server's reason are shown verbatim. */
export function AskResultView({
  response,
  ctx,
  onNavigate,
}: {
  response: AskResponse;
  ctx: CitationContext;
  onNavigate?: () => void;
}) {
  if (!response.ok)
    return (
      <div className="ask-result ask-result-failed" role="status">
        <p className="ask-failed-text">{ASK_FAILED_TEXT}</p>
        <p className="ask-reason">
          <span>Reason</span> <code>{response.reason}</code>
        </p>
        {response.traceId && <p className="ask-trace">Trace {response.traceId}</p>}
      </div>
    );
  return (
    <div className="ask-result" role="status">
      <p className="ask-answer-text">{response.answer}</p>
      <CitationList citations={response.citations} ctx={ctx} onNavigate={onNavigate} />
      {response.traceId && <p className="ask-trace">Trace {response.traceId}</p>}
    </div>
  );
}

export const cssId = (id: string) => id.replace(/[^A-Za-z0-9_-]+/g, "-");
