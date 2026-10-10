import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { cn } from "@/lib/utils";

/** Exact disclosure required by AGENTS.md for any `sample: true` data. */
export const FIXTURE_TEXT = "Fixture data — simulated APIs, not a live run";

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
