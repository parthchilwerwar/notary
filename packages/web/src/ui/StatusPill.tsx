import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * Color carries meaning only: green = certified / safe, red = unsafe / blocked, amber = held
 * (waiting for a human), gray with a struck-through word = revoked. Everything else is neutral.
 */
export type StatusTone = "safe" | "unsafe" | "held" | "revoked" | "neutral" | "active";

const SAFE = new Set(["notarized", "uphold", "active", "certified", "matches_docs", "connected", "executed_safe", "approved", "completed"]);
const UNSAFE = new Set(["unlearned", "refuted", "failed", "unsafe", "contradicts_docs", "blocked", "error", "missing", "rejected", "stopped_budget"]);
const HELD = new Set(["held", "escalated", "pending"]);
const REVOKED = new Set(["revoked"]);
const ACTIVE = new Set(["running"]);

/** Tone for a recorded status value. Unknown values stay neutral. */
export function toneFor(value: string): StatusTone {
  const v = value.toLowerCase();
  if (REVOKED.has(v)) return "revoked";
  if (SAFE.has(v)) return "safe";
  if (UNSAFE.has(v)) return "unsafe";
  if (HELD.has(v)) return "held";
  if (ACTIVE.has(v)) return "active";
  return "neutral";
}

/** The landing's status pill (brand.css .status): a dot and a word on a tinted pill. */
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
    <span className={cn("status", "ui-status", `ui-status-${resolved}`, className)} data-tone={resolved}>
      <span className="status-word">{children ?? value?.replaceAll("_", " ")}</span>
    </span>
  );
}
