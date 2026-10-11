// Small kit pieces: fixture note, facts list, filter pills, select, table frame.
import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";
import { FIXTURE_BANNER } from "../data/types";
import { cn } from "../lib/utils";

/** The fixture disclosure as the landing shows it: a quiet pill with the exact required text. */
export function FixtureNote({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <p className={cn("ui-fixture", className)} role="note">
      {children ?? FIXTURE_BANNER}
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

/** Scrollable frame for the few tables kept behind "Show details". */
export function TableFrame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("ui-table-frame", className)}>{children}</div>;
}
