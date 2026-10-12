// Start-run confirmation. Starting a run spends real money (model calls, Crustdata credits) and
// talks to Dodo Payments in test mode, so it never starts on one click: a native modal <dialog>
// (focus trapped by the browser, Esc cancels, focus returns to the opener) states what will run,
// the Dodo mode, and the USD cap as `notary serve` reports it — or that it reports none. Nothing
// here is assumed: the integration lines and the cap come from GET /api/health.
import { useEffect, useId, useRef } from "react";
import type { HealthResponse } from "../../../../core/src/schema";
import { Button } from "../../ui";
import "../approvals/approvals.css";

export type StartRunFacts = {
  /** "Queue run (guarded)", "Notarize Dodo Payments", … */
  label: string;
  /** The integration lines /api/health reported, verbatim. */
  integrations: { name: string; label: string }[];
  /** The USD cap line: from /api/health when it reports one, else "no USD cap reported". */
  usdCap: string;
};

/** What the dialog says, from the health response only (pure, unit-tested). */
export function startRunFacts(label: string, health: HealthResponse | null): StartRunFacts {
  const integrations = (health?.integrations ?? [])
    .filter((i) => i.name === "llm" || i.name === "crustdata" || i.name === "dodo")
    .map((i) => ({ name: i.name === "llm" ? "Models" : i.name === "dodo" ? "Dodo Payments" : "Crustdata", label: i.label }));
  // /api/health carries no budget fields today; a cap is never assumed (NOTARY_MAX_USD lives in .env).
  const cap = (health as (HealthResponse & { usdCap?: unknown }) | null)?.usdCap;
  const usdCap =
    typeof cap === "number" && Number.isFinite(cap)
      ? `$${cap} (NOTARY_MAX_USD)`
      : "No USD cap reported — /api/health does not expose one, so this page cannot confirm a spending limit.";
  return { label, integrations, usdCap };
}

export function StartRunDialog({
  facts,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  facts: StartRunFacts;
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    opener.current = document.activeElement;
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal?.();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="approval-dialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onConfirm();
        }}
        noValidate
      >
        <span className="approval-kicker">Start a run</span>
        <h2 id={titleId}>{facts.label}</h2>
        <p id={descId} className="desk-muted">
          This starts a real run on this machine's <code>notary serve</code>: model calls and Crustdata credits are spent. Dodo
          Payments is used in test mode only — no real money moves.
        </p>
        <dl className="run-start-facts">
          <div>
            <dt>Run</dt>
            <dd>{facts.label}</dd>
          </div>
          <div>
            <dt>Dodo Payments</dt>
            <dd>Test mode only</dd>
          </div>
          <div>
            <dt>USD cap</dt>
            <dd>{facts.usdCap}</dd>
          </div>
          {facts.integrations.map((i) => (
            <div key={i.name}>
              <dt>{i.name}</dt>
              <dd>{i.label}</dd>
            </div>
          ))}
        </dl>
        {error && (
          <p className="approval-error" role="alert">
            {error}
          </p>
        )}
        <div className="approval-dialog-actions">
          <Button type="button" variant="secondary" onClick={() => ref.current?.close()} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy} autoFocus>
            {busy && <span className="ui-spinner" aria-hidden="true" />}
            {busy ? "Starting…" : "Start the run"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
