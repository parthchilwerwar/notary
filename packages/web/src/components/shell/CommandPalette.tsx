import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Command } from "cmdk";
import { useData } from "../../app/catalog";
import { paletteEntries, withRun } from "../../app/links";
import { routes } from "../../routes";
import { ASK_SHORTCUT_LABEL, useAsk } from "../ask";

/** Pages that can be opened without a record id (no `:param`). */
export const paletteRoutes = () => routes.filter((r) => !r.path.includes(":"));

/**
 * Ctrl+K / Cmd+K palette: jump to any page, or to any decision, probe, belief or certificate of
 * the selected run. A small modal around cmdk's <Command> (no extra dialog dependency).
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const { bundle, certificates, selectedRunId } = useData();
  const [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const ask = useAsk();
  // One overlay at a time: opening Ask (Ctrl+J) closes the palette, and opening the palette closes Ask.
  useEffect(() => {
    if (ask.open) onOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.open]);
  useEffect(() => {
    if (open) ask.setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const records = useMemo(
    () => paletteEntries(bundle, certificates.status === "ready" ? certificates.data.certificates : []),
    [bundle, certificates],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSearch("");
    requestAnimationFrame(() => input.current?.focus());
    return () => {
      const back = restore.current;
      if (back && document.contains(back)) back.focus();
    };
  }, [open]);
  if (!open) return null;
  const go = (path: string) => {
    restore.current = null;
    onOpenChange(false);
    navigate(path);
  };
  const groups = ["Decisions", "Probes", "Beliefs", "Certificates"] as const;
  return (
    <div
      className="palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search pages and records"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onOpenChange(false);
          }
        }}
      >
        <Command label="Search pages and records" loop>
          <div className="palette-input">
            <Command.Input
              ref={input}
              value={search}
              onValueChange={setSearch}
              placeholder={bundle ? `Search pages and records of ${bundle.runId}…` : "Search pages…"}
            />
            <kbd aria-hidden="true">Esc</kbd>
          </div>
          <Command.List>
            <Command.Empty>No page or record matches.</Command.Empty>
            <Command.Group heading="Pages">
              {paletteRoutes().map((r) => (
                <Command.Item
                  key={r.id}
                  value={`page ${r.title} ${r.description}`}
                  onSelect={() => go(withRun(r.path, selectedRunId))}
                >
                  <span className="palette-label">{r.title}</span>
                  <small>{r.description}</small>
                </Command.Item>
              ))}
              <Command.Item
                value="ask panel question answer explain why held"
                onSelect={() => {
                  restore.current = null;
                  onOpenChange(false);
                  ask.setOpen(true);
                }}
              >
                <span className="palette-label">Open the Ask panel</span>
                <small>{ASK_SHORTCUT_LABEL}</small>
              </Command.Item>
            </Command.Group>
            {groups.map((group) => {
              const items = records.filter((e) => e.group === group);
              return items.length ? (
                <Command.Group key={group} heading={`${group} (${items.length})`}>
                  {items.map((e) => (
                    <Command.Item
                      key={`${group}-${e.id}`}
                      value={`${group} ${e.id} ${e.label} ${e.hint}`}
                      onSelect={() => go(e.path)}
                    >
                      <span className="palette-label">{e.label}</span>
                      <small>{e.hint}</small>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null;
            })}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
