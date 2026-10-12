import type { ComponentPropsWithRef, ReactNode } from "react";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import { cn } from "../lib/utils";

export type TimelineMark = "dot" | "check" | "x" | "spinner" | "pending";
export type TimelineTone = "neutral" | "active" | "safe" | "unsafe" | "held";

/** A vertical step list (the landing's "how it works" steps, the Run transcript, chat steps). */
export function Timeline({ className, children, ...rest }: ComponentPropsWithRef<"ol">) {
  return (
    <ol className={cn("ui-timeline", className)} {...rest}>
      {children}
    </ol>
  );
}

const MARK_LABEL: Record<TimelineMark, string> = {
  dot: "",
  check: "Done",
  x: "Stopped",
  spinner: "In progress",
  pending: "Waiting",
};

/** The status mark at the left of a step (exported for rows that build their own layout). */
export function TimelineMarker({ mark = "dot", tone = "neutral", label }: { mark?: TimelineMark; tone?: TimelineTone; label?: string }) {
  const text = label ?? MARK_LABEL[mark];
  return (
    <span className="ui-tl-mark" data-mark={mark} data-tone={tone} role={text ? "img" : undefined} aria-label={text || undefined} aria-hidden={text ? undefined : true}>
      {mark === "check" && <Check size={12} weight="bold" aria-hidden="true" />}
      {mark === "x" && <X size={12} weight="bold" aria-hidden="true" />}
      {mark === "spinner" && <span className="ui-spinner" aria-hidden="true" />}
    </span>
  );
}

/**
 * One step: a mark on the thread, a title, an optional meta line (agent badge, status, timing) and
 * optional body content. `active` highlights the step that is running now.
 */
export function TimelineItem({
  mark = "dot",
  tone = "neutral",
  markLabel,
  title,
  subtitle,
  meta,
  className,
  children,
  ...rest
}: {
  mark?: TimelineMark;
  tone?: TimelineTone;
  markLabel?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
} & Omit<ComponentPropsWithRef<"li">, "title">) {
  return (
    <li className={cn("ui-tl-item", className)} data-tone={tone} {...rest}>
      <TimelineMarker mark={mark} tone={tone} label={markLabel} />
      <div className="ui-tl-body">
        {(title || meta) && (
          <div className="ui-tl-head">
            {title && <span className="ui-tl-title">{title}</span>}
            {meta && <span className="ui-tl-meta">{meta}</span>}
          </div>
        )}
        {subtitle && <span className="ui-tl-sub">{subtitle}</span>}
        {children}
      </div>
    </li>
  );
}
