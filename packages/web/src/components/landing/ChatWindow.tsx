import type { ReactNode } from "react";
import type { ChatCitation } from "../../../../core/src/schema";
import { citedNumbers, tokenize, tokenLength, type TurnStep, type Token } from "./chat-turn";

// Presentational chat turn for the landing: the question, the steps (one row each: status mark,
// plain-language title, one-line output), the cited answer and its sources. It renders whatever
// part of the recorded turn the caller says is visible (`steps`, `chars`), so the showcase can
// replay it step by step. No data loading here.

const STATUS_WORD: Record<NonNullable<TurnStep["status"]>, string> = {
  ok: "Done",
  error: "Failed",
  unavailable: "Unavailable here",
  aborted: "Stopped",
};

function StepMark({ status }: { status?: TurnStep["status"] }) {
  if (!status)
    return (
      <span className="l-chat-mark" data-state="running" role="img" aria-label="Running">
        <span className="l-chat-spinner" />
      </span>
    );
  return (
    <span className="l-chat-mark" data-state={status} role="img" aria-label={STATUS_WORD[status]}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        {status === "ok" ? (
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        )}
      </svg>
    </span>
  );
}

/** Tokens split at `budget` visible characters: [shown, not yet shown]. */
function split(tokens: readonly Token[], budget: number): [Token[], Token[]] {
  const shown: Token[] = [];
  const rest: Token[] = [];
  let left = budget;
  for (const t of tokens) {
    if (left <= 0) rest.push(t);
    else if (t.kind === "cite") {
      shown.push(t);
      left -= 1;
    } else if (t.s.length <= left) {
      shown.push(t);
      left -= t.s.length;
    } else {
      shown.push({ ...t, s: t.s.slice(0, left) });
      rest.push({ ...t, s: t.s.slice(left) });
      left = 0;
    }
  }
  return [shown, rest];
}

function Rich({ tokens }: { tokens: readonly Token[] }) {
  return (
    <>
      {tokens.map((t, i) =>
        t.kind === "cite" ? (
          <sup key={i} className="l-cite">
            {t.n}
          </sup>
        ) : t.kind === "code" ? (
          <code key={i}>{t.s}</code>
        ) : t.kind === "strong" ? (
          <strong key={i}>{/^`[^`]+`$/.test(t.s) ? <code>{t.s.slice(1, -1)}</code> : t.s}</strong>
        ) : (
          <span key={i}>{t.s}</span>
        ),
      )}
    </>
  );
}

export function ChatWindow({
  question,
  steps,
  paragraphs,
  citations,
  visibleSteps = steps.length,
  chars = Infinity,
  disclosure,
  header,
  footer,
  compact = false,
}: {
  question: string;
  steps: readonly TurnStep[];
  paragraphs: readonly string[];
  citations: readonly ChatCitation[];
  visibleSteps?: number;
  /** Visible answer characters (Infinity = the whole answer). */
  chars?: number;
  disclosure?: string;
  header?: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
}) {
  // Everything is laid out from the start; what isn't "visible" yet is hidden in place
  // (visibility / transparent text), so replaying the turn never shifts the page.
  const tokenized = paragraphs.map(tokenize);
  const totalChars = tokenized.reduce((n, t) => n + tokenLength(t), 0);
  const answerShown = visibleSteps >= steps.length && chars > 0;
  let budget = answerShown ? chars : 0;
  const parts = tokenized.map((t) => {
    const r = split(t, budget);
    budget -= tokenLength(t);
    return r;
  });
  const used = citedNumbers(paragraphs);
  const sources = citations.filter((c) => used.has(c.n));
  const complete = answerShown && chars >= totalChars;
  return (
    <div className="l-chat" data-compact={compact || undefined}>
      {header}
      <div className="l-chat-turn">
        <p className="l-chat-q">
          <span className="sr-only">Question: </span>
          {question}
        </p>
        <ol className="l-chat-steps" aria-label="Steps">
          {steps.map((s, i) => {
            const visible = i < visibleSteps;
            // A step is shown finished once the next one (or the answer) has appeared.
            const done = i < visibleSteps - 1 || answerShown ? s.status : undefined;
            return (
              <li key={s.id} className="l-chat-step" data-status={done ?? "running"} data-pending={!visible || undefined}>
                <StepMark status={done} />
                <span className="l-chat-step-main">
                  <span className="l-chat-step-title">{s.title}</span>
                  {s.output && (
                    <span className="l-chat-step-out" data-pending={!done || undefined}>
                      {s.output}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
        <div className="l-chat-answer">
          {disclosure && !compact && (
            <p className="l-chat-disclosure" data-pending={!answerShown || undefined}>
              {disclosure}
            </p>
          )}
          {parts.map(([shown, rest], i) => (
            <p key={i} data-item={paragraphs[i]?.startsWith("• ") || undefined}>
              <Rich tokens={shown} />
              {rest.length > 0 && (
                <span className="l-ghost" aria-hidden="true">
                  <Rich tokens={rest} />
                </span>
              )}
            </p>
          ))}
          {sources.length > 0 && (
            <ol className="l-chat-sources" aria-label="Sources" data-pending={!complete || undefined}>
              {sources.map((c) => (
                <li key={c.n} title={c.label}>
                  <span className="l-cite">{c.n}</span>
                  <span className="l-chat-source-label">{c.label}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
      {footer}
    </div>
  );
}
