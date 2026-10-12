import { createContext, useContext, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * Set by the dashboard shell: `lead` (a record page's breadcrumb) sits above the title and `note`
 * (the fixture disclosure, only when the selected run is fixture data) sits on the summary line.
 * Outside the shell (tests, embeds) both are absent.
 */
export const PageHeaderContext = createContext<{ inShell: boolean; lead?: ReactNode; note?: ReactNode }>({ inShell: false });

/**
 * Editorial page header, directly on the page background: Instrument Serif title, a one-line
 * summary built from real data, the page's primary action on the right, and optional content
 * under it (the Run page's stepper). A hairline closes it; no band, no gradient, no overlap.
 */
export function PageHeader({
  title,
  summary,
  label,
  action,
  children,
  className,
  ...rest
}: {
  title: ReactNode;
  summary?: ReactNode;
  label?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
} & Omit<ComponentPropsWithRef<"header">, "title">) {
  const { inShell, lead, note } = useContext(PageHeaderContext);
  const shownNote = inShell ? note : undefined;
  return (
    <header className={cn("ui-band", "ui-header", className)} {...rest}>
      {inShell && lead}
      <div className="ui-band-inner">
        <div className="ui-band-copy">
          {label && <span className="ui-band-label">{label}</span>}
          <h1 className="ui-title ui-title-page ui-band-title">{title}</h1>
          {(summary || shownNote) && (
            <div className="ui-band-meta">
              {summary && <p className="ui-band-summary">{summary}</p>}
              {shownNote}
            </div>
          )}
        </div>
        {action && <div className="ui-band-action">{action}</div>}
      </div>
      {children && <div className="ui-band-extra">{children}</div>}
    </header>
  );
}

/** Page root (motion scope): the header, then the body. */
export function Page({ className, children, ...rest }: ComponentPropsWithRef<"div">) {
  return (
    <div className={cn("ui-page", className)} {...rest}>
      {children}
    </div>
  );
}

/** The page's content under the header: full-width sections separated by hairlines and space. */
export function PageBody({ className, children, ...rest }: ComponentPropsWithRef<"div">) {
  return (
    <div className={cn("ui-page-body", className)} {...rest}>
      {children}
    </div>
  );
}

/** Former names, kept so every page keeps compiling: SkyBand is the PageHeader. */
export const SkyBand = PageHeader;
export const SkyBandContext = PageHeaderContext;
