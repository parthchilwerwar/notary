// Approve / Reject confirmation. A native modal <dialog>: focus moves inside and is trapped by the
// browser, Esc cancels (unless a request is in flight), the title labels it and focus returns to
// the button that opened it. At phone width it is a full-width bottom sheet (approvals.css).
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ApprovalRecord, PendingApproval } from "../../../../core/src/schema";
import { Button } from "../../components/ui";
import { notify } from "../../components/shell/notify";
import { LocalApiError, label, number, type DataSource } from "../../data";
import { submitDecision } from "./api";
import {
  amountDigits,
  amountMatches,
  buildApproveRequest,
  buildRejectRequest,
  minorUnitsText,
  reasonValid,
} from "./model";

export type DialogKind = "approve" | "reject";

export function ConfirmDialog({
  source,
  kind,
  item,
  token,
  onClose,
  onDecided,
  onStale,
}: {
  /** The live data source the decision is sent through. */
  source: DataSource;
  kind: DialogKind;
  item: PendingApproval;
  /** Present when the desk offers actions; the data layer reads it from sessionStorage. */
  token: string | null;
  onClose: () => void;
  /** A validated record came back. */
  onDecided: (record: ApprovalRecord) => void;
  /** The server says the list is out of date (e.g. 409 already decided, 404 gone). */
  onStale: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();
  const fieldId = useId();
  const hintId = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    opener.current = document.activeElement;
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  const ready =
    kind === "approve" ? amountMatches(value, item.amount) : reasonValid(value);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    const built =
      kind === "approve"
        ? buildApproveRequest(item, value)
        : buildRejectRequest(item, value);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const record = await submitDecision(source, item, built.request);
      notify.success(
        `${record.requestId} ${record.decision} · ${record.status}`,
        { description: record.error ?? `Approval ${record.id} recorded.` },
      );
      onDecided(record);
      ref.current?.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (err instanceof LocalApiError && (err.status === 409 || err.status === 404))
        onStale();
    } finally {
      setBusy(false);
    }
  }

  const amountText =
    item.amount === undefined
      ? "unknown"
      : minorUnitsText(item.amount, item.currency, number);

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
      <form onSubmit={submit} noValidate>
        <span className="eyebrow">
          {item.runId} · {label(item.action)}
        </span>
        <h2 id={titleId}>
          {kind === "approve" ? "Approve" : "Reject"} {item.requestId}
        </h2>
        <p id={descId} className="muted">
          {kind === "approve"
            ? "Approving executes this held action once, through the guarded path in Dodo test mode, as a human override of the certificate gate. Every guard still applies."
            : "Rejecting closes this held action without any external call. The reason is recorded with the decision."}
        </p>

        {kind === "approve" ? (
          <>
            <div className="approval-held">
              <span className="eyebrow">Held amount</span>
              <strong>{amountText}</strong>
            </div>
            <label htmlFor={fieldId}>
              Type the held amount in minor units to confirm
            </label>
            <input
              id={fieldId}
              className="approval-input mono"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={value}
              aria-describedby={hintId}
              aria-invalid={value.trim() !== "" && !ready}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
            />
            <p id={hintId} className="approval-hint" aria-live="polite">
              {item.amount === undefined
                ? "The held amount is unknown, so this cannot be confirmed."
                : ready
                  ? "Matches the held amount."
                  : `Digits only, exactly ${amountDigits(item.amount)}.`}
            </p>
          </>
        ) : (
          <>
            <label htmlFor={fieldId}>Reason for rejecting</label>
            <textarea
              id={fieldId}
              className="approval-input"
              rows={3}
              autoFocus
              required
              value={value}
              aria-describedby={hintId}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
            />
            <p id={hintId} className="approval-hint" aria-live="polite">
              {ready ? "The reason will be recorded." : "A reason is required."}
            </p>
          </>
        )}

        {error && (
          <p className="approval-error" role="alert">
            {error}
          </p>
        )}

        <div className="approval-dialog-actions">
          <Button
            type="button"
            variant="outline"
            onClick={() => ref.current?.close()}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className={kind === "reject" ? "approval-reject" : undefined}
            disabled={!ready || busy}
          >
            {busy
              ? "Sending…"
              : kind === "approve"
                ? "Approve and execute"
                : "Reject"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
