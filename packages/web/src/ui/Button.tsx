import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../lib/utils";

export type ButtonVariant = "primary" | "secondary" | "accent" | "ghost" | "danger";

/**
 * The landing's buttons (src/design/brand.css .btn*): primary = solid ink (#0B0F19, white text),
 * secondary = white with a hairline, accent = blue, ghost = text only, danger = red for rejecting.
 * `asChild` renders the styles on a child link.
 */
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg"; asChild?: boolean }
>(function Button({ variant = "primary", size = "md", asChild = false, className, type, ...rest }, ref) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      className={cn("btn", `ui-btn-${variant}`, `ui-btn-${size}`, className)}
      {...(asChild ? {} : { type: type ?? "button" })}
      {...rest}
    />
  );
});
