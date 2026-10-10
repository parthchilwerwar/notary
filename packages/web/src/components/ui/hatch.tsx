import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Diagonal hatching marks comparison (baseline) series; focus series use solid fills.
 * - `HatchDefs` goes once inside an <svg>; fill shapes with `url(#<id>)`.
 * - `HatchSwatch` is the legend key; `hatchBackground` is the CSS equivalent for HTML bars.
 */
export const HATCH_ID = "notary-hatch";

export const hatchBackground = (step = 4): CSSProperties["background"] =>
  `repeating-linear-gradient(125deg, var(--hatch-bg) 0 ${step - 1}px, var(--hatch-line) ${step - 1}px ${step}px)`;

export function HatchDefs({ id = HATCH_ID }: { id?: string }) {
  return (
    <defs>
      <pattern
        id={id}
        width="5"
        height="5"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(35)"
      >
        <rect width="5" height="5" fill="var(--hatch-bg)" />
        <line x1="0" y1="0" x2="0" y2="5" stroke="var(--hatch-line)" strokeWidth="1.5" />
      </pattern>
    </defs>
  );
}

export function HatchSwatch({
  solid = false,
  className,
}: {
  solid?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("hatch-swatch", solid && "solid", className)}
      style={solid ? undefined : { background: hatchBackground() }}
    />
  );
}
