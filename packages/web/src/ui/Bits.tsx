// Small kit pieces: notes, fixture note, facts list, filter pills, select, table frame.
import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";
import { InfoIcon as Info } from "@phosphor-icons/react/dist/csr/Info";
import { WarningIcon as Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { FlaskIcon as Flask } from "@phosphor-icons/react/dist/csr/Flask";
import { FIXTURE_BANNER } from "../data/types";
import { cn } from "../lib/utils";

export type NoteTone = "info" | "warning" | "error";

const NOTE_ICON = { info: Info, warning: Warning, error: WarningCircle } as const;

/**
 * A short note on the page: a 16px icon (Info, Warning or WarningCircle) and the text on a quiet
 * tint. Replaces the old accent rule on the left. role="note" unless `role` says otherwise.
 */
export function Note({
  tone = "info",
  children,
  className,
  role = "note",
}: {
  tone?: NoteTone;
  children: ReactNode;
  className?: string;
  role?: "note" | "status" | "alert";
}) {
  const Icon = NOTE_ICON[tone];
  return (
    <div className={cn("ui-note", className)} data-tone={tone} role={role}>
      <Icon className="ui-note-icon" size={16} weight="regular" aria-hidden="true" />
      <div className="ui-note-text">{children}</div>
    </div>
  );
}

/**
 * The fixture disclosure: a quiet pill with the exact required text. Rendered only in the
 * development-only fixture view (`?fixtures=1`), where every run shown is fixture data.
 */
export function FixtureNote({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <p className={cn("ui-fixture", className)} role="note">
      <Flask className="ui-fixture-icon" size={14} weight="regular" aria-hidden="true" />
      <span>{children ?? FIXTURE_BANNER}</span>
    </p>
  );
}

/** Label-above-value facts. `columns` 2 or 3 on wide screens, one column on phones. */
export function Facts({
  items,
  columns = 2,
  className,
}: {
  items: { label: ReactNode; value: ReactNode; wide?: boolean; key?: string }[];
  columns?: 2 | 3;
  className?: string;
}) {
  return (
    <dl className={cn("ui-facts", `ui-facts-${columns}`, className)}>
      {items.map((it, i) => (
        <div key={it.key ?? i} className={it.wide ? "ui-facts-wide" : undefined}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Filter pills (links that keep state in the URL). The current one is filled. */
export function Pills({
  items,
  label,
  className,
}: {
  items: { key: string; label: ReactNode; to: string; current: boolean; count?: number }[];
  label: string;
  className?: string;
}) {
  return (
    <nav className={cn("ui-pills", className)} aria-label={label}>
      {items.map((it) => (
        <Link key={it.key} to={it.to} aria-current={it.current ? "page" : undefined} replace>
          {it.label}
          {it.count !== undefined && <span className="ui-pill-count">{it.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Native <select> with the kit border and a CSS chevron. */
export function Select({ children, className, ...props }: ComponentProps<"select">) {
  return (
    <span className={cn("ui-select", className)}>
      <select {...props}>{children}</select>
    </span>
  );
}

/** A flat, horizontally scrollable table: hairline rules above, below and between rows; no box. */
export function TableFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("ui-table-frame", className)}>{children}</div>;
}
