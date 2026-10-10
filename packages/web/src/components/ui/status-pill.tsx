import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "safe" | "unsafe" | "neutral" | "info";

/**
 * Tone for a recorded status value. Green and red are reserved for safety outcomes:
 * "safe" for settled, trusted states, "unsafe" for revoked or unsafe ones, "info" (blue) for
 * states that need a human, everything else stays neutral.
 */
export function toneFor(value: string): StatusTone {
  const v = value.toLowerCase();
  if (["notarized", "uphold", "active", "matches_docs", "live"].includes(v))
    return "safe";
  if (
    [
      "revoked",
      "unlearned",
      "refuted",
      "failed",
      "unsafe",
      "contradicts_docs",
    ].includes(v)
  )
    return "unsafe";
  if (["held", "escalated", "candidate", "downgrade", "pending"].includes(v))
    return "info";
  return "neutral";
}

/** Small rounded status label with a dot. Pass `tone` explicitly or let `toneFor(value)` pick it. */
export function StatusPill({
  value,
  tone,
  children,
  className,
}: {
  value?: string;
  tone?: StatusTone;
  children?: ReactNode;
  className?: string;
}) {
  const resolved = tone ?? (value ? toneFor(value) : "neutral");
  return (
    <span
      className={cn("status-pill", `tone-${resolved}`, className)}
      data-tone={resolved}
    >
      <span aria-hidden="true" className="status-dot" />
      {children ?? value?.replaceAll("_", " ")}
    </span>
  );
}
