import type { ComponentProps } from "react";

/** Native <select> with the design-system border and a CSS chevron (no icon dependency). */
export function SelectControl({ children, ...props }: ComponentProps<"select">) {
  return (
    <span className="select-control">
      <select {...props}>{children}</select>
    </span>
  );
}
