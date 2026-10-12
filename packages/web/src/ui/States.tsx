import type { ReactNode } from "react";
// clsx, not cn: kit classes never conflict, and main.tsx renders these states without pulling
// tailwind-merge into the landing's first chunk (K4).
import { clsx as cn } from "clsx";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { TrayIcon as Tray } from "@phosphor-icons/react/dist/csr/Tray";

/**
 * Nothing to show, or something failed: a title, the fix in plain words and one next action. Flat
 * on the page (no box); an error leads its title with a red WarningCircle icon.
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
    <div className={cn("ui-empty", className)} data-tone={tone} role={tone === "error" ? "alert" : undefined}>
      <div className="ui-empty-head">
        {tone === "error" && <WarningCircle className="ui-empty-icon" size={20} weight="regular" aria-hidden="true" />}
        <h2 className="ui-title ui-title-card">{title}</h2>
      </div>
      {children && <div className="ui-empty-text">{children}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

/**
 * No real run is published yet. The dashboard and the landing never fall back to fixture data;
 * they show this and the two commands that record and publish a run.
 */
export function NoRunsYet({
  commands,
  className,
  action,
  title = "No runs recorded yet",
}: {
  commands: readonly string[];
  className?: string;
  action?: ReactNode;
  title?: ReactNode;
}) {
  return (
    <div className={cn("ui-empty ui-empty-runs", className)} data-tone="empty">
      <div className="ui-empty-head">
        <Tray className="ui-empty-icon" size={20} weight="regular" aria-hidden="true" />
        <h2 className="ui-title ui-title-card">{title}</h2>
      </div>
      <div className="ui-empty-text">
        <p>Record a run against the real APIs, then publish it. Its verified bundle shows up here.</p>
        <ol className="ui-empty-steps">
          {commands.map((c, i) => (
            <li key={c}>
              <span className="ui-empty-step-n" aria-hidden="true">
                {i + 1}
              </span>
              <code>{c}</code>
            </li>
          ))}
        </ol>
      </div>
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

/** A loading shape. Compose them to match the final layout (see PageSkeleton). */
export function Skeleton({ className, shape = "line", width }: { className?: string; shape?: "line" | "block" | "stat" | "card"; width?: string }) {
  return <span className={cn("ui-skeleton", `ui-skeleton-${shape}`, className)} style={width ? { width } : undefined} aria-hidden="true" />;
}

/** A page loading: the header lines, an inline stat row and one content block, with a polite status line. */
export function PageSkeleton({ label = "Loading…", stats = 3 }: { label?: string; stats?: number }) {
  return (
    <div className="ui-page-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="ui-skeleton-band" aria-hidden="true">
        <Skeleton shape="line" width="22%" />
        <Skeleton shape="line" width="48%" />
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
