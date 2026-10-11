import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Color carries meaning only: green = safe / certified, red = unsafe / blocked, amber = held
 * (waiting for a human). Everything else is neutral black and white.
 */
export type StatusTone = "safe" | "unsafe" | "held" | "neutral";

const SAFE = new Set(["notarized", "uphold", "active", "certified", "matches_docs", "connected", "executed_safe"]);
const UNSAFE = new Set(["revoked", "unlearned", "refuted", "failed", "unsafe", "contradicts_docs", "blocked", "error", "missing", "rejected"]);
const HELD = new Set(["held", "escalated", "pending"]);

/** Tone for a recorded status value. Unknown values stay neutral. */
export function toneFor(value: string): StatusTone {
  const v = value.toLowerCase();
  if (SAFE.has(v)) return "safe";
  if (UNSAFE.has(v)) return "unsafe";
  if (HELD.has(v)) return "held";
  return "neutral";
}

/** Small rounded status word. Pass `tone` explicitly or let `toneFor(value)` pick it. */
export function StatusPill({
  value,
  tone,
  children,
  className,
}: {
  value?: string;
  /** "info" is accepted for older callers and renders as neutral. */
  tone?: StatusTone | "info";
  children?: ReactNode;
  className?: string;
}) {
  const picked = tone ?? (value ? toneFor(value) : "neutral");
  const resolved: StatusTone = picked === "info" ? "neutral" : picked;
  return (
    <span className={cn("status-pill", `tone-${resolved}`, className)} data-tone={resolved}>
      <span aria-hidden="true" className="status-dot" />
      {children ?? value?.replaceAll("_", " ")}
    </span>
  );
}
