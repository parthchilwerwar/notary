import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";
import { cn } from "../lib/utils";

type Wash = "lavender" | "peach" | "mint" | "sky";

/** A flat bordered panel (12px radius, hairline, no shadow) for content that needs a frame. */
export function Card<T extends ElementType = "div">({
  as,
  className,
  padding = "md",
  children,
  ...rest
}: { as?: T; padding?: "none" | "sm" | "md" | "lg"; children?: ReactNode } & Omit<ComponentPropsWithRef<T>, "as">) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag className={cn("ui-card", `ui-pad-${padding}`, className)} {...rest}>
      {children}
    </Tag>
  );
}

/** A flat panel with a soft tinted wash (e.g. peach for held actions); same geometry as Card. */
export function WashCard<T extends ElementType = "div">({
  as,
  wash = "sky",
  className,
  padding = "md",
  children,
  ...rest
}: { as?: T; wash?: Wash; padding?: "sm" | "md" | "lg"; children?: ReactNode } & Omit<ComponentPropsWithRef<T>, "as">) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag className={cn("ui-wash-card", "wash", `wash-${wash}`, `ui-pad-${padding}`, className)} {...rest}>
      {children}
    </Tag>
  );
}
