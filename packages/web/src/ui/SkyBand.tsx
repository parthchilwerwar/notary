import { createContext, useContext, type ComponentPropsWithRef, type ReactNode } from "react";
import { Clouds } from "../components/brand/Clouds";
import { cn } from "../lib/utils";

/**
 * Set by the dashboard shell: inside it a SkyBand is the landing's sky (gradient + Clouds, 28px
 * radius) and `lead` (a record page's breadcrumb) sits above the title. Outside the shell (the
 * landing's embedded Run page, tests) the band renders as a plain header, so it never stacks a
 * second sky inside the landing hero.
 */
export const SkyBandContext = createContext<{ inShell: boolean; lead?: ReactNode }>({ inShell: false });

/**
 * Page header band: Instrument Serif title, a one-line summary built from real data, the page's
 * primary action on the right, and optional extra content along the bottom (the Run page's
 * five-step progress). Content that follows inside <PageBody> overlaps its bottom by 48px.
 */
export function SkyBand({
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
  const { inShell, lead } = useContext(SkyBandContext);
  return (
    <header className={cn("ui-band", inShell && "ui-band-sky", className)} {...rest}>
      {inShell && (
        <div className="ui-band-art" aria-hidden="true">
          <Clouds className="ui-band-clouds" base={false} />
        </div>
      )}
      <div className="ui-band-inner">
        <div className="ui-band-copy">
          {inShell && lead}
          {label && <span className="ui-band-label">{label}</span>}
          <h1 className="ui-title ui-title-page ui-band-title">{title}</h1>
          {summary && <p className="ui-band-summary">{summary}</p>}
        </div>
        {action && <div className="ui-band-action">{action}</div>}
      </div>
      {children && <div className="ui-band-extra">{children}</div>}
    </header>
  );
}

/** Page root (motion scope) and the content that overlaps the band. */
export function Page({ className, children, ...rest }: ComponentPropsWithRef<"div">) {
  return (
    <div className={cn("ui-page", className)} {...rest}>
      {children}
    </div>
  );
}

export function PageBody({ className, children, ...rest }: ComponentPropsWithRef<"div">) {
  return (
    <div className={cn("ui-page-body", className)} {...rest}>
      {children}
    </div>
  );
}
