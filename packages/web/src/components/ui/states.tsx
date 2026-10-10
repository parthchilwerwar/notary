import type { ReactNode } from "react";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { cn } from "@/lib/utils";

/** Nothing to show (yet). Copy should say what data would fill it, never promise a future phase. */
export function EmptyState({
  title,
  children,
  actions,
  icon,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("empty state-card", className)}>
      {icon ?? <ShieldCheck size={30} aria-hidden="true" />}
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
      <WarningCircle size={30} aria-hidden="true" />
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="state-actions">{actions}</div>}
    </div>
  );
}
