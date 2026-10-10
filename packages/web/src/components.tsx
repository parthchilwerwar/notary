import type { ReactNode } from "react";
import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import type { RunBundle } from "../../core/src/schema";
import { label, safeLink } from "./data";
import { Link } from "react-router";
import { StatusPill } from "./components/ui/status-pill";
import { recordPath, withRun } from "./state/data-mode";

export function Status({ value }: { value: string }) {
  return <StatusPill value={value}>{label(value)}</StatusPill>;
}

/** Links to other records of the same run (beliefs, probes, decisions); unknown ids stay plain text. */
export function RecordLinks({
  bundle,
  beliefs = [],
  probes = [],
  decisions = [],
}: {
  bundle: RunBundle;
  beliefs?: string[];
  probes?: string[];
  decisions?: string[];
}) {
  const known = {
    belief: new Set(
      [...bundle.beliefs.before, ...bundle.beliefs.after].map((b) => b.id),
    ),
    probe: new Set(bundle.probes.map((p) => p.id)),
    decision: new Set(bundle.decisions.map((d) => d.id)),
  };
  const items = [
    ...beliefs.map((id) => ["belief", id] as const),
    ...probes.map((id) => ["probe", id] as const),
    ...decisions.map((id) => ["decision", id] as const),
  ];
  if (!items.length) return null;
  return (
    <span className="record-links">
      {items.map(([kind, id]) =>
        known[kind].has(id) ? (
          <Link
            key={kind + id}
            className="record-chip"
            to={withRun(recordPath[kind](id), bundle.runId)}
          >
            <span>{kind}</span>
            {id}
          </Link>
        ) : (
          <code key={kind + id} className="record-chip muted">
            <span>{kind}</span>
            {id}
          </code>
        ),
      )}
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
