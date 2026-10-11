// Record references shared by the app pages: links to other records of a run, and trace ids.
import { Link } from "react-router";
import type { RunBundle } from "../../../core/src/schema";
import { recordPath, withRun } from "../app/links";

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
    belief: new Set([...bundle.beliefs.before, ...bundle.beliefs.after].map((b) => b.id)),
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
    <span className="ui-record-links">
      {items.map(([kind, id]) =>
        known[kind].has(id) ? (
          <Link key={kind + id} className="ui-record-chip" to={withRun(recordPath[kind](id), bundle.runId)}>
            <span>{kind}</span>
            {id}
          </Link>
        ) : (
          <code key={kind + id} className="ui-record-chip" data-unknown>
            <span>{kind}</span>
            {id}
          </code>
        ),
      )}
    </span>
  );
}

/** An http(s) trace URL as recorded, else undefined (local receipts are not browsable here). */
export function traceUrl(value: string | undefined): string | undefined {
  return value && /^https?:\/\//i.test(value) ? value : undefined;
}

/**
 * A trace or span id. Linked only when the run recorded an http(s) URL for it (e.g. a neatlogs
 * trace URL); otherwise the id is shown as text, with the recorded local receipt as its title.
 */
export function Trace({
  bundle,
  traceId,
  spanId,
  links,
}: {
  bundle?: Pick<RunBundle, "traceLinks">;
  traceId: string;
  spanId?: string;
  links?: Record<string, string>;
}) {
  const recorded = links?.[traceId] ?? bundle?.traceLinks[traceId];
  const href = traceUrl(recorded);
  const text = spanId || traceId || "Trace not recorded";
  return href ? (
    <a className="ui-trace" href={href} target="_blank" rel="noreferrer">
      {text}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : (
    <code className="ui-trace" title={recorded ? `Local receipt: ${recorded}` : "No trace link recorded"}>
      {text}
    </code>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="ui-json">{JSON.stringify(value, null, 2) ?? "Not recorded"}</pre>;
}
