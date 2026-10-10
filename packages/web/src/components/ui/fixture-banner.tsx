import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { cn } from "@/lib/utils";

import { FIXTURE_BANNER } from "@/data/types";

/** Exact disclosure required by AGENTS.md for any `sample: true` data (src/data FIXTURE_BANNER). */
export const FIXTURE_TEXT = FIXTURE_BANNER;

/**
 * Fixture disclosure. `sticky` pins it to the top of the scrolling column (the shell uses this);
 * `inline` is for a fixture section inside an otherwise real page.
 */
export function FixtureBanner({
  variant = "sticky",
  className,
}: {
  variant?: "sticky" | "inline";
  className?: string;
}) {
  return (
    <div
      className={cn("fixture-banner", variant === "inline" && "inline", className)}
      role="note"
    >
      <ShieldCheck size={18} aria-hidden="true" />
      <span>{FIXTURE_TEXT}</span>
    </div>
  );
}
