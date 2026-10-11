// Ask Notary side sheet (Ctrl+J / Cmd+J, or the sidebar item). Modal dialog: focus moves in and
// is trapped, Esc or the backdrop closes it, focus returns to where it was. Full screen at phone width.
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { useData } from "../../app/catalog";
import { withRun } from "../../app/links";
import { ASK_SHORTCUT_LABEL, useAsk } from "./AskContext";
import { AskNotary } from "./AskNotary";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AskSheet() {
  const { open, setOpen, selectedId, setSelectedId } = useAsk();
  const { selectedRunId, bundle } = useData();
  const dialog = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      const root = dialog.current;
      const first = root?.querySelector<HTMLElement>("#ask-question-input, #ask-token-input") ?? root?.querySelector<HTMLElement>(".ask-sheet-close");
      first?.focus();
    });
    return () => {
      document.body.style.overflow = overflow;
      const back = restore.current;
      if (back && document.contains(back)) back.focus();
    };
  }, [open]);

  // Esc closes even when focus has fallen out of the dialog (e.g. onto <body>).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const close = () => setOpen(false);
  return (
    <div
      className="ask-sheet-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        className="ask-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-sheet-title"
        aria-describedby="ask-sheet-description"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
            return;
          }
          if (e.key !== "Tab") return;
          const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
            (el) => el.offsetParent !== null || el === document.activeElement,
          );
          if (!items.length) return;
          const first = items[0]!;
          const last = items[items.length - 1]!;
          if (e.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="ask-sheet-head">
          <div>
            <h2 id="ask-sheet-title">Ask</h2>
            <p id="ask-sheet-description">Answers from records, with citations. {ASK_SHORTCUT_LABEL} toggles this panel.</p>
          </div>
          <Link className="ask-sheet-full" to={withRun("/app/ask", selectedRunId, { answer: selectedId })} onClick={close}>
            Full page
          </Link>
          <button type="button" className="ask-sheet-close" onClick={close}>
            Close
          </button>
        </header>
        <div className="ask-sheet-body">
          {bundle ? (
            <AskNotary variant="panel" selectedId={selectedId} onSelect={setSelectedId} onNavigate={close} />
          ) : (
            <p className="ask-note">Answers appear once the selected run has loaded and its hash is verified.</p>
          )}
        </div>
      </div>
    </div>
  );
}
