import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";
import { cn } from "../lib/utils";

type Wash = "lavender" | "peach" | "mint" | "sky";

/** White card: 24px radius, hairline, the landing's soft floating shadow. */
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

/** The landing's feature card: 28px radius, hairline, a soft radial wash over the subtle surface. */
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
