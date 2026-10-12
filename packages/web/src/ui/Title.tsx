import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../lib/utils";

/** Instrument Serif heading. `size`: page (40px header title), section (26px), card (20px). */
export function Title({
  level = 2,
  size = "section",
  className,
  children,
  ...rest
}: { level?: 1 | 2 | 3 | 4; size?: "page" | "section" | "card"; children: ReactNode } & ComponentPropsWithRef<"h2">) {
  const Tag = `h${level}` as "h2";
  return (
    <Tag className={cn("ui-title", `ui-title-${size}`, className)} {...rest}>
      {children}
    </Tag>
  );
}

/** The landing's section label: 12px, uppercase, tracked, accent blue (brand.css .section-label). */
export function SectionLabel({ className, children, ...rest }: ComponentPropsWithRef<"p">) {
  return (
    <p className={cn("section-label", "ui-section-label", className)} {...rest}>
      {children}
    </p>
  );
}

/** A section: optional label, serif title, one-line description, actions on the right, content. */
export function Section({
  title,
  label,
  description,
  actions,
  className,
  children,
  ...rest
}: {
  title?: ReactNode;
  label?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
} & Omit<ComponentPropsWithRef<"section">, "title">) {
  return (
    <section className={cn("ui-section", className)} {...rest}>
      {(title || label || actions) && (
        <header className="ui-section-head">
          <div>
            {label && <SectionLabel>{label}</SectionLabel>}
            {title && <Title size="section">{title}</Title>}
            {description && <p className="ui-section-desc">{description}</p>}
          </div>
          {actions && <div className="ui-section-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
