import type { ReactNode } from "react";
import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import type { RunBundle } from "../../core/src/schema";
import { label, safeLink } from "./data";

export function Status({ value }: { value: string }) {
  const tone = ["executed", "notarized", "uphold", "completed"].includes(value)
    ? "good"
    : ["failed", "refuted", "unlearned", "downgrade"].includes(value)
      ? "bad"
      : [
            "held",
            "escalated",
            "candidate",
            "narrow",
            "stopped_budget",
            "blocked",
          ].includes(value)
        ? "warn"
        : "neutral";
  return (
    <span className={`status ${tone}`}>
      <span aria-hidden="true" className="status-dot" />
      {label(value)}
    </span>
  );
}

export function Trace({
  bundle,
  traceId,
  spanId,
  links,
}: {
  bundle: RunBundle;
  traceId: string;
  spanId?: string;
  links?: Record<string, string>;
}) {
  const href = safeLink(links?.[traceId] ?? bundle.traceLinks[traceId]);
  return href ? (
    <a className="trace" href={href} target="_blank" rel="noreferrer">
      {spanId || traceId}
      <ArrowUpRight size={14} aria-hidden="true" />
    </a>
  ) : (
    <code className="trace muted">
      {spanId || traceId || "Trace not recorded"}
    </code>
  );
}

export function Json({ value }: { value: unknown }) {
  return (
    <pre className="json">
      {JSON.stringify(value, null, 2) ?? "Not recorded"}
    </pre>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <ShieldCheck size={30} aria-hidden="true" />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export function Fields({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="fields">
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <dt>{label(key)}</dt>
          <dd>
            {item === undefined ? (
              "Not recorded"
            ) : typeof item === "object" && item !== null ? (
              <Json value={item} />
            ) : (
              String(item)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
