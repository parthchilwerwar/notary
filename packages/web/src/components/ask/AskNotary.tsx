// Ask Notary content, shared by the side panel (Ctrl+J) and the /app/ask page.
//  - Precomputed answers from public/content/explain.json, only from the selected run's world.
//  - With a local `notary serve` serving the selected run: free-form questions to POST /api/ask.
// Read-only: no approve/execute/refund controls and no links to approval actions.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "../ui/button";
import { ErrorState, LoadingState } from "../ui/states";
import { useData } from "../../app/catalog";
import { LocalApiError, useSessionToken } from "../../data";
import { useExplainAnswers, useLocalAsk, type LocalAskAvailability } from "./data";
import {
  READ_ONLY_NOTE,
  answersForRun,
  buildAskRequest,
  groupAnswers,
  parseAskResponse,
  worldKeyOf,
  worldLabel,
  type CitationContext,
} from "./model";
import { AnswerView, AskResultView, cssId } from "./views";
import type { AskResponse } from "../../../../core/src/schema";
import "./ask.css";

export function AskNotary({
  variant,
  selectedId,
  onSelect,
  onNavigate,
}: {
  variant: "panel" | "page";
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  /** Called when a citation link is followed (the panel closes). */
  onNavigate?: () => void;
}) {
  const { bundle, bundles, certificates } = useData();
  const explain = useExplainAnswers();
  const local = useLocalAsk();
  const runId = bundle?.runId;

  const ctx = useMemo<CitationContext>(() => {
    const revocations = certificates.status === "ready" ? certificates.data.revocations : [];
    return {
      fallbackRunId: runId,
      revocationCertificate: (id) => revocations.find((r) => r.id === id)?.certificateId,
    };
  }, [certificates, runId]);

  const scoped = useMemo(
    () =>
      explain.status === "ready" && runId
        ? answersForRun(explain.answers, bundles, runId)
        : { world: bundle ? worldKeyOf(bundle) : undefined, answers: [] },
    [explain, bundles, runId, bundle],
  );
  const groups = useMemo(() => groupAnswers(scoped.answers), [scoped.answers]);
  const selected = scoped.answers.find((a) => a.id === selectedId);

  // Keyboard focus follows the reader: into the answer after picking a question, back to that
  // question after "All questions". Only after a user action (never on load).
  const root = useRef<HTMLDivElement>(null);
  const moved = useRef<{ to: "answer" } | { to: "question"; id: string } | null>(null);
  useEffect(() => {
    const m = moved.current;
    moved.current = null;
    if (!m || !root.current) return;
    const target =
      m.to === "answer"
        ? root.current.querySelector<HTMLElement>(".ask-answer h3")
        : root.current.querySelector<HTMLElement>(`[data-answer-id="${CSS.escape(m.id)}"]`);
    if (!target) return;
    // In the side sheet, a new answer starts at the top of the panel (world line included).
    const sheet = root.current.closest<HTMLElement>(".ask-sheet-body");
    if (sheet && m.to === "answer") {
      sheet.scrollTop = 0;
      target.focus({ preventScroll: true });
    } else target.focus();
  }, [selectedId]);
  const pick = (id: string | undefined) => {
    moved.current = id ? { to: "answer" } : selectedId ? { to: "question", id: selectedId } : null;
    onSelect(id);
  };

  if (!bundle) return null;
  const world = scoped.world ?? worldKeyOf(bundle);

  return (
    <div ref={root} className={`ask ask-${variant}`} data-selected={selected ? "true" : "false"}>
      <p className="ask-world">
        {worldLabel(world)}. Questions about <strong>{bundle.runId}</strong>
      </p>

      <LocalAsk availability={local} ctx={ctx} onNavigate={onNavigate} />

      <section className="ask-suggested" aria-labelledby={`ask-suggested-${variant}`}>
        <h2 className="ask-section-title" id={`ask-suggested-${variant}`}>
          Precomputed answers
          {explain.status === "ready" && <span> ({scoped.answers.length})</span>}
        </h2>
        {explain.status === "loading" ? (
          <LoadingState title="Loading answers…">Reading the published explain file.</LoadingState>
        ) : explain.status === "error" ? (
          <ErrorState title="Answers withheld">{explain.error}</ErrorState>
        ) : explain.status === "missing" ? (
          <p className="ask-note">
            No explain file is published. Answers are generated from records by <code>pnpm notary export --explain</code>.
          </p>
        ) : !scoped.answers.length ? (
          <p className="ask-note">
            None of the {explain.answers.length} published answers come from this world ({worldLabel(world).toLowerCase()}).
            Answers are only shown for the world they were built from; <code>pnpm notary export --explain</code> builds
            them from records.
          </p>
        ) : (
          <div className="ask-browse">
            <div className="ask-list">
              {groups.map((g) => (
                <div className="ask-group" key={g.kind} role="group" aria-labelledby={`ask-${variant}-${g.kind}`}>
                  <h3 id={`ask-${variant}-${g.kind}`}>
                    {g.title} <span>({g.answers.length})</span>
                  </h3>
                  <ul>
                    {g.answers.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          className="ask-question"
                          aria-current={a.id === selected?.id ? "true" : undefined}
                          aria-controls={`ask-answer-${variant}`}
                          data-answer-id={a.id}
                          onClick={() => pick(a.id)}
                        >
                          <span>{a.question}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="ask-detail" id={`ask-answer-${variant}`} aria-live="polite">
              {selected ? (
                <>
                  <button type="button" className="ask-back" onClick={() => pick(undefined)}>
                    All questions
                  </button>
                  <AnswerView key={cssId(selected.id)} answer={selected} ctx={ctx} onNavigate={onNavigate} />
                </>
              ) : (
                <p className="ask-note ask-pick">Pick a question to read its answer and the records it cites.</p>
              )}
            </div>
          </div>
        )}
      </section>

      <p className="ask-footnote">
        {READ_ONLY_NOTE} It explains recorded evidence; it never approves, executes or refunds anything.
      </p>
    </div>
  );
}

type LocalResult =
  | { status: "idle" }
  | { status: "asking"; question: string }
  | { status: "error"; question: string; error: string; unauthorized: boolean }
  | { status: "done"; question: string; response: AskResponse };

function LocalAsk({
  availability,
  ctx,
  onNavigate,
}: {
  availability: LocalAskAvailability;
  ctx: CitationContext;
  onNavigate?: () => void;
}) {
  const { dataSource, bundle } = useData();
  const [token, setToken] = useSessionToken();
  const firstHeld = bundle?.decisions.find((d) => d.status === "held");
  const [draftToken, setDraftToken] = useState("");
  const [question, setQuestion] = useState("");
  const [inputError, setInputError] = useState<string>();
  const [result, setResult] = useState<LocalResult>({ status: "idle" });

  if (availability.status === "checking") return null;
  if (availability.status === "offline")
    return (
      <p className="ask-note ask-local-note">
        Free-form questions need a local <code>pnpm notary serve</code>; this site only has precomputed answers.
      </p>
    );
  if (availability.status === "not-served")
    return (
      <p className="ask-note ask-local-note">
        The local <code>notary serve</code> is connected but does not serve <code>{availability.runId}</code> (a static
        fixture file), so free-form questions about it are unavailable. Pick a run it serves to ask one.
      </p>
    );

  const runId = availability.runId;

  if (!token)
    return (
      <form
        className="ask-local ask-token"
        onSubmit={(e) => {
          e.preventDefault();
          if (draftToken.trim()) {
            setToken(draftToken.trim());
            setDraftToken("");
          }
        }}
      >
        <label htmlFor="ask-token-input">Session token</label>
        <p className="ask-note">
          Paste the token <code>notary serve</code> printed at startup. It stays in this tab only.
        </p>
        <div className="ask-input-row">
          <input
            id="ask-token-input"
            name="session-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draftToken}
            onChange={(e) => setDraftToken(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!draftToken.trim()}>
            Use token
          </Button>
        </div>
      </form>
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const req = buildAskRequest(question, runId);
    if (!req.ok) return setInputError(req.error);
    setInputError(undefined);
    setResult({ status: "asking", question: req.data.question });
    try {
      // LiveSource.ask validates the request and the answer with the shared schemas.
      const parsed = parseAskResponse(await dataSource.ask(req.data));
      setResult(
        parsed.ok
          ? { status: "done", question: req.data.question, response: parsed.data }
          : { status: "error", question: req.data.question, error: parsed.error, unauthorized: false },
      );
    } catch (err) {
      const unauthorized = err instanceof LocalApiError && err.status === 401;
      setResult({
        status: "error",
        question: req.data.question,
        error: err instanceof Error ? err.message : String(err),
        unauthorized,
      });
    }
  };

  return (
    <section className="ask-local" aria-labelledby="ask-local-title">
      <form onSubmit={submit}>
        <label id="ask-local-title" htmlFor="ask-question-input">
          Ask about <code>{runId}</code>
        </label>
        <textarea
          id="ask-question-input"
          rows={2}
          maxLength={2000}
          value={question}
          placeholder={firstHeld ? `Why was ${firstHeld.requestId} held?` : "Ask about this run…"}
          aria-invalid={inputError ? "true" : undefined}
          aria-describedby={inputError ? "ask-question-error" : undefined}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {inputError && (
          <p className="ask-input-error" id="ask-question-error">
            {inputError}
          </p>
        )}
        <div className="ask-local-actions">
          <span className="ask-note">Answered by the local executor model; every citation is checked by code.</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setToken(null)}>
            Forget token
          </Button>
          <Button type="submit" size="sm" disabled={result.status === "asking"}>
            {result.status === "asking" ? "Asking…" : "Ask"}
          </Button>
        </div>
      </form>
      {result.status !== "idle" && (
        <div className="ask-local-result">
          <p className="ask-asked">
            <span>Asked</span> {result.question}
          </p>
          {result.status === "asking" ? (
            <p className="ask-note" role="status">
              Waiting for the local API…
            </p>
          ) : result.status === "error" ? (
            <div className="ask-error" role="alert">
              <p>{result.error}</p>
              {result.unauthorized && (
                <Button type="button" variant="outline" size="sm" onClick={() => setToken(null)}>
                  Enter a new token
                </Button>
              )}
            </div>
          ) : (
            <AskResultView response={result.response} ctx={ctx} onNavigate={onNavigate} />
          )}
        </div>
      )}
    </section>
  );
}
