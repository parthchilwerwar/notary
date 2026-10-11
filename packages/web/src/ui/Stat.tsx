import type { ReactNode } from "react";
import { cn } from "../lib/utils";

const fmt = new Intl.NumberFormat("en-US");

/**
 * The landing's proof number in a card: a big Instrument Serif value and a small label. Numbers
 * count up once (motion.ts); the final value is always in the DOM and in a screen-reader copy.
 * `null` renders "Not recorded" (never a stand-in number). `of` adds a quiet "of N" (e.g. a cap).
 */
export function Stat({
  label,
  value,
  of,
  display,
  decimals,
  note,
  children,
  className,
}: {
  label: ReactNode;
  value: number | null;
  /** Text shown instead of the formatted number (e.g. "$0.42"); still counts only when numeric. */
  display?: string;
  decimals?: number;
  of?: ReactNode;
  note?: ReactNode;
  /** Optional art under the number (a sparkline). */
  children?: ReactNode;
  className?: string;
}) {
  const text = value === null ? null : (display ?? (decimals !== undefined ? value.toFixed(decimals) : fmt.format(value)));
  const counts = value !== null && display === undefined;
  return (
    <div className={cn("ui-card ui-pad-md ui-stat", className)} data-reveal>
      <dt className="ui-stat-label">{label}</dt>
      <dd className="ui-stat-value">
        {text === null ? (
          <span className="ui-stat-missing">Not recorded</span>
        ) : (
          <>
            <span
              className={counts ? "ui-count" : undefined}
              data-count={counts ? value : undefined}
              data-decimals={counts && decimals !== undefined ? decimals : undefined}
              aria-hidden="true"
            >
              {text}
            </span>
            <span className="sr-only">{text}</span>
          </>
        )}
        {of && text !== null && <span className="ui-stat-of">{of}</span>}
      </dd>
      {note && <dd className="ui-stat-note">{note}</dd>}
      {children && <dd className="ui-stat-art">{children}</dd>}
    </div>
  );
}

/** A row of up to three Stats (a <dl>). */
export function StatRow({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <dl className={cn("ui-stat-row", className)} aria-label={label}>
      {children}
    </dl>
  );
}
