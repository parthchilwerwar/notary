import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Command } from "cmdk";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useData } from "../../state/DataProvider";
import { paletteEntries, withRun } from "../../state/data-mode";
import { routes } from "../../routes";

/** Pages that can be opened without a record id (no `:param`). */
export const paletteRoutes = () => routes.filter((r) => !r.path.includes(":"));

/**
 * Ctrl+K / Cmd+K palette: jump to any page, or to any decision, probe, belief or certificate of
 * the selected run. A small modal around cmdk's <Command> (no extra dialog dependency).
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { bundle, certificates, selectedRunId } = useData();
  const [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const records = useMemo(
    () =>
      paletteEntries(
        bundle,
        certificates.status === "ready" ? certificates.data.certificates : [],
      ),
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
    if (open) {
      setSearch("");
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);
  if (!open) return null;
  const go = (path: string) => {
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
        aria-label="Command palette"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onOpenChange(false);
          }
        }}
      >
        <Command label="Jump to a page or record" loop>
          <div className="palette-input">
            <MagnifyingGlass size={18} aria-hidden="true" />
            <Command.Input
              ref={input}
              value={search}
              onValueChange={setSearch}
              placeholder={
                bundle
                  ? `Search pages and records in ${bundle.runId}…`
                  : "Search pages…"
              }
            />
            <kbd>Esc</kbd>
          </div>
          <Command.List>
            <Command.Empty>No page or record matches.</Command.Empty>
            <Command.Group heading="Pages">
              {paletteRoutes().map((r) => (
                <Command.Item
                  key={r.id}
                  value={`page ${r.title} ${r.group ?? ""}`}
                  onSelect={() => go(withRun(r.path, selectedRunId))}
                >
                  <r.icon size={16} aria-hidden="true" />
                  <span>{r.title}</span>
                  {r.group && <small>{r.group}</small>}
                </Command.Item>
              ))}
            </Command.Group>
            {groups.map((group) => {
              const items = records.filter((e) => e.group === group);
              return items.length ? (
                <Command.Group key={group} heading={`${group} · ${items.length}`}>
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
