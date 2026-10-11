import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Nothing to show (yet). Say what data would fill it and give one next action. */
export function EmptyState({
  title,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Ignored: decorative icons were removed in the redesign. */
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("empty state-card", className)}>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="state-actions">{actions}</div>}
    </div>
  );
}

export function LoadingState({
  title = "Verifying bundle integrity…",
  children = "Checking the shared schema and recomputing every content hash.",
}: {
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="loading state-card" role="status" aria-live="polite">
      <span className="loading-bar" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

/** Visible failure with the data withheld. */
export function ErrorState({
  title = "Data unavailable",
  children,
  actions,
}: {
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="error state-card" role="alert">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="state-actions">{actions}</div>}
    </div>
  );
}
