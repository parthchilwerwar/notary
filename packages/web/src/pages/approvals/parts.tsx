// Desk pieces: evidence pack, decision trail, pending / decided / history items, token form.
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import type {
  ApprovalRecord,
  Decision,
  RunBundle,
} from "../../../../core/src/schema";
import { Button, RecordLinks, StatusPill, Trace } from "../../components/ui";
import { DecisionTrail } from "../../components/trail";
import { label, number } from "../../data";
import { dateTime as date } from "../../lib/time";
import { recordPath, withRun } from "../../app/links";
import { useData } from "../../app/catalog";
import {
  minorUnitsText,
  type DecidedRow,
  type Gate,
  type HistoryRow,
  type PendingRow,
} from "./model";

/** Reason, missing beliefs, related probes (linked), spans and trace ids (linked only via traceLinks). */
export function EvidencePackView({
  bundle,
  decision,
}: {
  bundle: RunBundle;
  decision: Decision;
}) {
  const pack = decision.evidencePack;
  if (!pack)
    return (
      <section className="desk-evidence">
        <h4>Evidence pack</h4>
        <p className="muted">No evidence pack recorded for this decision.</p>
      </section>
    );
  const traceIds = Object.keys(pack.traceLinks);
  return (
    <section className="desk-evidence">
      <h4>Evidence pack</h4>
      <p>{pack.reason}</p>
      <dl className="desk-facts">
        <div>
          <dt>Missing beliefs</dt>
          <dd>
            {pack.missingBeliefs.length ? (
              <RecordLinks bundle={bundle} beliefs={pack.missingBeliefs} />
            ) : (
              "None recorded"
            )}
          </dd>
        </div>
        <div>
          <dt>Related probes</dt>
          <dd>
            {pack.relatedProbeIds.length ? (
              <ProbeLinks bundle={bundle} ids={pack.relatedProbeIds} />
            ) : (
              "None recorded"
            )}
          </dd>
        </div>
        <div>
          <dt>Spans</dt>
          <dd>
            {pack.spanIds.length
              ? pack.spanIds.map((id) => (
                  <Trace key={id} bundle={bundle} traceId={id} links={pack.traceLinks} />
                ))
              : "None recorded"}
          </dd>
        </div>
        <div>
          <dt>Traces</dt>
          <dd>
            {traceIds.length || decision.traceId ? (
              <>
                {traceIds.map((id) => (
                  <Trace key={id} bundle={bundle} traceId={id} links={pack.traceLinks} />
                ))}
                {decision.traceId && !traceIds.includes(decision.traceId) && (
                  <Trace bundle={bundle} traceId={decision.traceId} links={pack.traceLinks} />
                )}
              </>
            ) : (
              "Tracing was off for this decision"
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * Related probes usually live in a notarize run, not the queue run that held the action. Each id
 * links to the run that recorded it (this run first, then same-cohort runs); unknown ids stay text.
 */
function ProbeLinks({ bundle, ids }: { bundle: RunBundle; ids: string[] }) {
  const { bundles } = useData();
  const cohort = [bundle, ...bundles.filter((b) => b.runId !== bundle.runId && b.sample === bundle.sample)];
  return (
    <span className="record-links">
      {ids.map((id) => {
        const owner = cohort.find((b) => b.probes.some((p) => p.id === id));
        return owner ? (
          <Link key={id} className="record-chip" to={withRun(recordPath.probe(id), owner.runId)}>
            <span>probe</span>
            {id}
          </Link>
        ) : (
          <code key={id} className="record-chip muted">
            <span>probe</span>
            {id}
          </code>
        );
      })}
    </span>
  );
}

export function TrailBlock({
  bundle,
  decision,
  open,
}: {
  bundle: RunBundle;
  decision: Decision;
  open?: boolean;
}) {
  return (
    <details className="desk-trail" open={open}>
      <summary>Decision trail</summary>
      <DecisionTrail bundle={bundle} decisionId={decision.id} />
    </details>
  );
}

function DecisionLink({
  runId,
  decisionId,
  requestId,
  known,
}: {
  runId: string;
  decisionId: string;
  requestId: string;
  known: boolean;
}) {
  return known ? (
    <Link to={withRun(recordPath.decision(decisionId), runId)}>{requestId}</Link>
  ) : (
    <>{requestId}</>
  );
}

function ItemShell({
  eyebrow,
  title,
  pills,
  children,
  footer,
  highlight,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  pills: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  highlight?: boolean;
}) {
  return (
    <article className={highlight ? "desk-item highlight" : "desk-item"}>
      <header className="desk-item-head">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h3>{title}</h3>
        </div>
        <div className="desk-pills">{pills}</div>
      </header>
      {children}
      {footer && <footer className="desk-item-foot">{footer}</footer>}
    </article>
  );
}

/** Model notes mark commands with backticks (`notary serve`); render those as code, never as raw ticks. */
export function NoteText({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 ? <code key={i}>{part}</code> : part,
      )}
    </>
  );
}

function GateNote({ gate }: { gate: Gate }) {
  return gate.allowed ? null : (
    <p className="desk-gate">
      <NoteText text={gate.reason} />
    </p>
  );
}

export function PendingItem({
  row,
  approve,
  reject,
  onApprove,
  onReject,
  openTrail,
}: {
  row: PendingRow;
  approve: Gate;
  reject: Gate;
  onApprove: () => void;
  onReject: () => void;
  openTrail?: boolean;
}) {
  const { item, bundle, decision } = row;
  return (
    <ItemShell
      eyebrow={`${item.runId} · ${label(item.action)}`}
      title={
        <DecisionLink
          runId={item.runId}
          decisionId={item.decisionId}
          requestId={item.requestId}
          known={Boolean(decision)}
        />
      }
      pills={<StatusPill value="pending">Awaiting a human</StatusPill>}
      footer={
        <>
          <div className="desk-actions">
            <Button onClick={onApprove} disabled={!approve.allowed}>
              Approve…
            </Button>
            <Button variant="outline" onClick={onReject} disabled={!reject.allowed}>
              Reject…
            </Button>
          </div>
          <GateNote gate={approve.allowed ? reject : approve} />
        </>
      }
    >
      <dl className="desk-facts">
        <div>
          <dt>Held amount (computed by Notary)</dt>
          <dd>
            {item.amount === undefined
              ? "Unknown: no seed manifest entry"
              : minorUnitsText(item.amount, item.currency, number)}
          </dd>
        </div>
        <div>
          <dt>Why held</dt>
          <dd>{item.reason}</dd>
        </div>
      </dl>
      {bundle && decision ? (
        <>
          <EvidencePackView bundle={bundle} decision={decision} />
          <TrailBlock bundle={bundle} decision={decision} open={openTrail} />
        </>
      ) : (
        <p className="muted">
          The bundle for {item.runId} is not loaded, so its evidence pack and trail can't be shown.
        </p>
      )}
    </ItemShell>
  );
}

export function RecordView({
  record,
  bundle,
}: {
  record: ApprovalRecord;
  bundle?: RunBundle;
}) {
  return (
    <>
      <dl className="desk-facts">
        <div>
          <dt>Approval</dt>
          <dd className="mono">{record.id}</dd>
        </div>
        <div>
          <dt>Decided</dt>
          <dd>{date(record.decidedAt)}</dd>
        </div>
        {record.confirmedAmount !== undefined && (
          <div>
            <dt>Confirmed amount</dt>
            <dd>{minorUnitsText(record.confirmedAmount, record.currency, number)}</dd>
          </div>
        )}
        {record.reason && (
          <div>
            <dt>Reason</dt>
            <dd>{record.reason}</dd>
          </div>
        )}
        {record.error && (
          <div>
            <dt>Error</dt>
            <dd className="desk-error-text">{record.error}</dd>
          </div>
        )}
        <div>
          <dt>Trace</dt>
          <dd>
            {record.traceId ? (
              <Trace bundle={bundle} traceId={record.traceId} />
            ) : (
              "Not recorded"
            )}
          </dd>
        </div>
      </dl>
      <section className="desk-effects">
        <h4>Effects</h4>
        {record.effects.length ? (
          <ul>
            {record.effects.map((e, i) => (
              <li key={`${e.op}-${i}`}>
                <code>{e.op}</code>{" "}
                <span className="muted">
                  {e.status === null ? "outcome unknown" : `HTTP ${e.status}`}
                  {e.amount !== undefined &&
                    ` · ${minorUnitsText(e.amount, e.currency, number)}`}
                  {e.resultId && ` · ${e.resultId}`} · {date(e.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            {record.decision === "rejected"
              ? "None: a rejection makes no external call."
              : "No external calls were made."}
          </p>
        )}
      </section>
    </>
  );
}

export function DecidedItem({ row, highlight }: { row: DecidedRow; highlight?: boolean }) {
  const { record, bundle, decision } = row;
  return (
    <ItemShell
      highlight={highlight}
      eyebrow={`${record.runId} · ${label(record.action)} · human override`}
      title={
        <DecisionLink
          runId={record.runId}
          decisionId={record.decisionId}
          requestId={record.requestId}
          known={Boolean(decision)}
        />
      }
      pills={
        <>
          <StatusPill value={record.decision} />
          <StatusPill value={record.status} />
        </>
      }
    >
      <RecordView record={record} bundle={bundle} />
      {bundle && decision && <TrailBlock bundle={bundle} decision={decision} />}
    </ItemShell>
  );
}

export function HistoryItem({ row, openTrail }: { row: HistoryRow; openTrail?: boolean }) {
  const { bundle, decision } = row;
  const request = bundle.queue.find((q) => q.id === decision.requestId);
  return (
    <ItemShell
      eyebrow={`${bundle.runId} · ${label(decision.action)} · ${decision.customerId}`}
      title={
        <DecisionLink
          runId={bundle.runId}
          decisionId={decision.id}
          requestId={decision.requestId}
          known
        />
      }
      pills={<StatusPill value={decision.status} />}
      footer={
        <p className="desk-gate">
          <NoteText text={row.note} />
        </p>
      }
    >
      <dl className="desk-facts">
        <div>
          <dt>Requested amount (as recorded)</dt>
          <dd>
            {request?.amount !== undefined
              ? minorUnitsText(request.amount, request.currency, number)
              : "Not in the request"}
          </dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd>
            {label(decision.requestType)} · {decision.tier} tier · policy {label(decision.policyOutcome)}
          </dd>
        </div>
      </dl>
      <EvidencePackView bundle={bundle} decision={decision} />
      <TrailBlock bundle={bundle} decision={decision} open={openTrail} />
    </ItemShell>
  );
}

/** The per-session token `notary serve` printed. Kept in sessionStorage by the shared client. */
export function TokenForm({
  token,
  setToken,
  error,
}: {
  token: string | null;
  setToken: (t: string | null) => void;
  error?: string;
}) {
  const [draft, setDraft] = useState("");
  if (token)
    return (
      <div className="desk-token saved">
        <span>Session token saved for this tab.</span>
        <Button variant="outline" size="sm" onClick={() => setToken(null)}>
          Forget token
        </Button>
      </div>
    );
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) setToken(draft.trim());
    setDraft("");
  };
  return (
    <form className="desk-token" onSubmit={save}>
      <label htmlFor="approvals-token">
        Session token (printed once by <code>pnpm notary serve</code>)
      </label>
      <div className="desk-token-row">
        <input
          id="approvals-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" disabled={!draft.trim()}>
          Use token
        </Button>
      </div>
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
