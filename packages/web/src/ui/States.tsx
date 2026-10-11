import type { ReactNode } from "react";
// clsx, not cn: kit classes never conflict, and main.tsx renders these states without pulling
// tailwind-merge into the landing's first chunk (K4).
import { clsx as cn } from "clsx";

/**
 * Nothing to show, or something failed: a title, the fix in plain words and one next action.
 * `tone="error"` announces it (role="alert"); never pass raw error text as the title.
 */
export function EmptyState({
  title,
  children,
  action,
  tone = "empty",
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  tone?: "empty" | "error";
  className?: string;
}) {
  return (
    <div className={cn("ui-card ui-pad-lg ui-empty", className)} data-tone={tone} role={tone === "error" ? "alert" : undefined}>
      <h2 className="ui-title ui-title-card">{title}</h2>
      {children && <div className="ui-empty-text">{children}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

/** A loading shape. Compose them to match the final layout (see PageSkeleton). */
export function Skeleton({ className, shape = "line", width }: { className?: string; shape?: "line" | "block" | "stat" | "card"; width?: string }) {
  return <span className={cn("ui-skeleton", `ui-skeleton-${shape}`, className)} style={width ? { width } : undefined} aria-hidden="true" />;
}

/** A page loading: a band, three stat cards and one large card, with a polite status line. */
export function PageSkeleton({ label = "Loading…", stats = 3 }: { label?: string; stats?: number }) {
  return (
    <div className="ui-page-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="ui-skeleton-band" aria-hidden="true">
        <Skeleton shape="line" width="38%" />
        <Skeleton shape="line" width="56%" />
      </div>
      <div className="ui-page-body">
        {stats > 0 && (
          <div className="ui-stat-row" aria-hidden="true">
            {Array.from({ length: stats }, (_, i) => (
              <Skeleton key={i} shape="stat" />
            ))}
          </div>
        )}
        <Skeleton shape="card" />
      </div>
    </div>
  );
}

/** Secondary detail behind a "Show details" disclosure. */
export function Expander({
  summary = "Show details",
  children,
  className,
  defaultOpen,
}: {
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className={cn("ui-expander", className)} open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="ui-expander-body">{children}</div>
    </details>
  );
}
