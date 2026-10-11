// Receipts shared by the Report and certificate pages: tool evidence entries (public evidence
// file, through the data layer), live integration states (/api/health) and trace references.
import type { IntegrationName, IntegrationStatus } from "../../../../core/src/schema";
import { StatusPill, traceUrl } from "../../ui";
import { PUBLISHED_FILES, safeLink, useDataSource, type EvidenceEntry } from "../../data";
import { latestHealth, useShellStatus } from "../../components/shell/status";
import type { Loadable } from "../../app/catalog";
import { dateTime } from "../../lib/time";

/** Text with `backticked` commands rendered as code. */
export function CodeText({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}</>;
}

/** One entry of the published evidence file, as recorded: status, purpose, links, notes. */
export function EvidenceEntryView({ entry, headingLevel = 3 }: { entry: EvidenceEntry; headingLevel?: 3 | 4 }) {
  const H = `h${headingLevel}` as "h3" | "h4";
  return (
    <article className="evidence-entry">
      <div className="evidence-entry-head">
        <H translate="no">{entry.name}</H>
        <StatusPill tone={entry.status === "live" ? "safe" : "neutral"}>
          {entry.status === "live" ? "Live" : "Pending"}
        </StatusPill>
      </div>
      <p>
        <CodeText text={entry.purpose} />
      </p>
      {entry.notes && (
        <p className="report-note">
          <CodeText text={entry.notes} />
        </p>
      )}
      {entry.links.length > 0 && (
        <div className="tool-links">
          {entry.links.map((link) => {
            const href = safeLink(link.url);
            return href && /^https?:/i.test(href) ? (
              <a key={link.url} href={href} target="_blank" rel="noreferrer">
                {link.label}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <span key={link.url}>{link.label}</span>
            );
          })}
        </div>
      )}
    </article>
  );
}

/** The evidence entry for one tool name (case-insensitive), with the right empty/error state. */
export function EvidenceFor({
  evidence,
  name,
  headingLevel,
}: {
  evidence: Loadable<EvidenceEntry[]>;
  name: string;
  headingLevel?: 3 | 4;
}) {
  if (evidence.status === "loading") return <p className="report-note">Reading the published evidence file…</p>;
  if (evidence.status === "error") return <p className="report-unsafe">{evidence.error}</p>;
  const entry =
    evidence.status === "ready" ? evidence.data.find((e) => e.name.toLowerCase() === name.toLowerCase()) : undefined;
  if (!entry)
    return (
      <p className="report-note">
        No <span translate="no">{name}</span> entry in <code>{PUBLISHED_FILES.evidence}</code>.
      </p>
    );
  return <EvidenceEntryView entry={entry} headingLevel={headingLevel} />;
}

/** One line: the tool's status in the published evidence file (details are listed under Tool evidence). */
export function EvidenceStatus({ evidence, name }: { evidence: Loadable<EvidenceEntry[]>; name: string }) {
  if (evidence.status !== "ready") return null;
  const entry = evidence.data.find((e) => e.name.toLowerCase() === name.toLowerCase());
  return (
    <p className="report-note">
      <span translate="no">{name}</span> in the evidence file:{" "}
      {entry ? (entry.status === "live" ? "live" : "pending") : `no entry in ${PUBLISHED_FILES.evidence}`}. Details
      under Tool evidence below.
    </p>
  );
}

const STATE_WORD: Record<IntegrationStatus["state"], string> = {
  connected: "Connected",
  configured: "Configured, not verified",
  missing: "Missing",
  error: "Error",
};

/** Tone of an integration state: green only for a real successful check. */
export const integrationTone = (state: IntegrationStatus["state"]) =>
  state === "connected" ? "safe" : state === "configured" ? "neutral" : "unsafe";

/** One integration from the latest live health check, or why it is unknown. */
export function IntegrationLine({ name }: { name: IntegrationName }) {
  const { mode } = useDataSource();
  const { health } = useShellStatus();
  const latest = latestHealth(health);
  if (mode !== "live" || !latest)
    return (
      <p className="report-note">
        Live status not checked: replay mode has no live integrations. Start <code>pnpm notary serve</code> and reload.
      </p>
    );
  const status = latest.integrations.find((i) => i.name === name);
  if (!status) return <p className="report-note">Not reported by notary serve.</p>;
  return (
    <p className="integration-line">
      <StatusPill tone={integrationTone(status.state)}>{STATE_WORD[status.state]}</StatusPill>
      <span>
        {status.state === "error" && status.detail ? status.detail : status.label}
        {status.fix && (
          <>
            {" "}
            Fix: <CodeText text={status.fix} />
          </>
        )}
      </span>
      <span className="report-note">Checked {dateTime(status.checkedAt)}</span>
    </p>
  );
}

export { STATE_WORD };

/** A trace id: linked only when an http(s) URL was recorded for it, else text plus the receipt. */
export function TraceRefView({ traceId, spanId, recorded }: { traceId?: string; spanId?: string; recorded?: string }) {
  if (!traceId) return <span className="report-note">Tracing was off</span>;
  const href = traceUrl(recorded);
  return (
    <span className="trace-ref">
      {href ? (
        <a className="ui-trace" href={href} target="_blank" rel="noreferrer">
          {traceId}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <code className="ui-trace">{traceId}</code>
      )}
      {spanId && <span className="report-note">span <code>{spanId}</code></span>}
      {!href && (
        <span className="report-note">
          {recorded ? (
            <>
              local receipt <code>{recorded}</code>
            </>
          ) : (
            "no link recorded"
          )}
        </span>
      )}
    </span>
  );
}
