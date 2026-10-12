// Desk pieces: one row per held action, between hairlines — request and customer on the left, the
// amount in Instrument Serif on the right, why it was held in one sentence, Approve / Reject — with
// the evidence pack and the decision trail behind a disclosure. Decided records and the token form.
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { LockSimpleIcon as LockSimple } from "@phosphor-icons/react/dist/csr/LockSimple";
import type { ApprovalRecord, Decision, RunBundle } from "../../../../core/src/schema";
import { AgentBadge, Button, Expander, Facts, RecordLinks, StatusPill, Trace } from "../../ui";
import { DecisionTrail } from "../../components/trail";
import { label, number } from "../../data";
import { dateTime as date } from "../../lib/time";
import { recordPath, withRun } from "../../app/links";
import { useData } from "../../app/catalog";
import { minorUnitsText, type DecidedRow, type Gate, type HistoryRow, type PendingRow } from "./model";

/** Reason, missing beliefs, related probes (linked), spans and trace ids (linked only via traceLinks). */
export function EvidencePackView({ bundle, decision }: { bundle: RunBundle; decision: Decision }) {
  const pack = decision.evidencePack;
  if (!pack)
    return (
      <section className="desk-evidence">
        <h4>Evidence pack</h4>
        <p className="desk-muted">No evidence pack recorded for this decision.</p>
      </section>
    );
  const traceIds = Object.keys(pack.traceLinks);
  return (
    <section className="desk-evidence">
      <h4>Evidence pack</h4>
      <p>{pack.reason}</p>
      <Facts
        items={[
          {
            label: "Missing beliefs",
            value: pack.missingBeliefs.length ? <RecordLinks bundle={bundle} beliefs={pack.missingBeliefs} /> : "None recorded",
          },
          {
            label: "Related probes",
            value: pack.relatedProbeIds.length ? <ProbeLinks bundle={bundle} ids={pack.relatedProbeIds} /> : "None recorded",
          },
          {
            label: "Spans",
            value: pack.spanIds.length
              ? pack.spanIds.map((id) => <Trace key={id} bundle={bundle} traceId={id} links={pack.traceLinks} />)
              : "None recorded",
          },
          {
            label: "Traces",
            value:
              traceIds.length || decision.traceId ? (
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
              ),
          },
        ]}
      />
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
    <span className="ui-record-links">
      {ids.map((id) => {
        const owner = cohort.find((b) => b.probes.some((p) => p.id === id));
        return owner ? (
          <Link key={id} className="ui-record-chip" to={withRun(recordPath.probe(id), owner.runId)}>
            <span>probe</span>
            {id}
          </Link>
        ) : (
          <code key={id} className="ui-record-chip" data-unknown>
            <span>probe</span>
            {id}
          </code>
        );
      })}
    </span>
  );
}

/** Evidence pack and decision trail behind one disclosure. */
function Details({ bundle, decision, open }: { bundle: RunBundle; decision: Decision; open?: boolean }) {
  return (
    <Expander summary="Show evidence and trail" defaultOpen={open}>
      <EvidencePackView bundle={bundle} decision={decision} />
      <div className="desk-trail">
        <h4>Decision trail</h4>
        <DecisionTrail bundle={bundle} decisionId={decision.id} />
      </div>
    </Expander>
  );
}

function DecisionLink({ runId, decisionId, requestId, known }: { runId: string; decisionId: string; requestId: string; known: boolean }) {
  return known ? <Link to={withRun(recordPath.decision(decisionId), runId)}>{requestId}</Link> : <>{requestId}</>;
}

/** Model notes mark commands with backticks (`notary serve`); render those as code, never as raw ticks. */
export function NoteText({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

/** Why an action is not available: a lock icon and the reason, quiet text under the buttons. */
function GateText({ text }: { text: string }) {
  return (
    <p className="desk-gate">
      <LockSimple className="desk-gate-icon" size={16} weight="regular" aria-hidden="true" />
      <span>
        <NoteText text={text} />
      </span>
    </p>
  );
}

function GateNote({ gate }: { gate: Gate }) {
  return gate.allowed ? null : <GateText text={gate.reason} />;
}

/** The amount, big: digits in Instrument Serif, the unit beside it (never converted or guessed). */
function Amount({ amount, currency, missing }: { amount?: number; currency?: string; missing: string }) {
  if (amount === undefined) return <p className="desk-amount-missing">{missing}</p>;
  return (
    <p className="desk-amount" aria-label={minorUnitsText(amount, currency, number)}>
      <span className="desk-amount-value">{number(amount)}</span>
      <span className="desk-amount-unit">{currency ? `${currency} ` : ""}minor units</span>
    </p>
  );
}

function HeldShell({
  kicker,
  title,
  status,
  amount,
  why,
  children,
  footer,
  highlight,
}: {
  kicker: ReactNode;
  title: ReactNode;
  status: ReactNode;
  amount: ReactNode;
  why: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  highlight?: boolean;
}) {
  return (
    <article className="desk-item" data-highlight={highlight || undefined} data-reveal>
      <header className="desk-item-head">
        <div className="desk-item-id">
          <span className="desk-kicker">{kicker}</span>
          <h3 className="desk-title">{title}</h3>
          <div className="desk-pills">{status}</div>
        </div>
        {amount}
      </header>
      <p className="desk-why">{why}</p>
      {footer && <footer className="desk-item-foot">{footer}</footer>}
      {children}
    </article>
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
    <HeldShell
      kicker={`${item.runId} · ${label(item.action)}`}
      title={<DecisionLink runId={item.runId} decisionId={item.decisionId} requestId={item.requestId} known={Boolean(decision)} />}
      status={
        <>
          <AgentBadge agent="guard" />
          <StatusPill value="pending">Awaiting a human</StatusPill>
        </>
      }
      amount={<Amount amount={item.amount} currency={item.currency} missing="Held amount unknown: no seed manifest entry" />}
      why={item.reason}
      footer={
        <>
          <div className="desk-actions">
            <Button onClick={onApprove} disabled={!approve.allowed}>
              Approve…
            </Button>
            <Button variant="secondary" onClick={onReject} disabled={!reject.allowed}>
              Reject…
            </Button>
          </div>
          <GateNote gate={approve.allowed ? reject : approve} />
        </>
      }
    >
      {bundle && decision ? (
        <Details bundle={bundle} decision={decision} open={openTrail} />
      ) : (
        <p className="desk-muted">The bundle for {item.runId} is not loaded, so its evidence pack and trail can’t be shown.</p>
      )}
    </HeldShell>
  );
}

export function RecordView({ record, bundle }: { record: ApprovalRecord; bundle?: RunBundle }) {
  return (
    <>
      <Facts
        items={[
          { label: "Approval", value: <code>{record.id}</code> },
          { label: "Decided", value: date(record.decidedAt) },
          ...(record.confirmedAmount !== undefined
            ? [{ label: "Confirmed amount", value: minorUnitsText(record.confirmedAmount, record.currency, number) }]
            : []),
          ...(record.reason ? [{ label: "Reason", value: record.reason }] : []),
          ...(record.error ? [{ label: "Error", value: <span className="desk-error-text">{record.error}</span> }] : []),
          { label: "Trace", value: record.traceId ? <Trace bundle={bundle} traceId={record.traceId} /> : "Not recorded" },
        ]}
      />
      <section className="desk-effects">
        <h4>Effects</h4>
        {record.effects.length ? (
          <ul>
            {record.effects.map((e, i) => (
              <li key={`${e.op}-${i}`}>
                <code>{e.op}</code>{" "}
                <span className="desk-muted">
                  {e.status === null ? "outcome unknown" : `HTTP ${e.status}`}
                  {e.amount !== undefined && ` · ${minorUnitsText(e.amount, e.currency, number)}`}
                  {e.resultId && ` · ${e.resultId}`} · {date(e.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="desk-muted">
            {record.decision === "rejected" ? "None: a rejection makes no external call." : "No external calls were made."}
          </p>
        )}
      </section>
    </>
  );
}

export function DecidedItem({ row, highlight }: { row: DecidedRow; highlight?: boolean }) {
  const { record, bundle, decision } = row;
  return (
    <article className="desk-item desk-decided" data-highlight={highlight || undefined} data-reveal>
      <header className="desk-item-head">
        <div className="desk-item-id">
          <span className="desk-kicker">{`${record.runId} · ${label(record.action)} · human override`}</span>
          <h3 className="desk-title">
            <DecisionLink runId={record.runId} decisionId={record.decisionId} requestId={record.requestId} known={Boolean(decision)} />
          </h3>
        </div>
        <div className="desk-pills">
          <StatusPill value={record.decision} />
          <StatusPill value={record.status} />
        </div>
      </header>
      <RecordView record={record} bundle={bundle} />
      {bundle && decision && (
        <Expander summary="Show decision trail">
          <div className="desk-trail">
            <DecisionTrail bundle={bundle} decisionId={decision.id} />
          </div>
        </Expander>
      )}
    </article>
  );
}

/** `showNote` false when the list states the (shared) note once above its rows. */
export function HistoryItem({ row, openTrail, showNote = true }: { row: HistoryRow; openTrail?: boolean; showNote?: boolean }) {
  const { bundle, decision } = row;
  const request = bundle.queue.find((q) => q.id === decision.requestId);
  return (
    <HeldShell
      kicker={`${decision.customerId} · ${label(decision.requestType)} · ${decision.tier} tier`}
      title={<DecisionLink runId={bundle.runId} decisionId={decision.id} requestId={decision.requestId} known />}
      status={
        <>
          <AgentBadge agent="guard" />
          <StatusPill value={decision.status} />
        </>
      }
      amount={<Amount amount={request?.amount} currency={request?.currency} missing="No amount in the request" />}
      why={decision.evidencePack?.reason ?? `Policy ${label(decision.policyOutcome)}; held for a person.`}
      footer={
        showNote ? <GateText text={row.note} /> : undefined
      }
    >
      <Details bundle={bundle} decision={decision} open={openTrail} />
    </HeldShell>
  );
}

/** The per-session token `notary serve` printed. Kept in sessionStorage by the shared client. */
export function TokenForm({ token, setToken, error }: { token: string | null; setToken: (t: string | null) => void; error?: string }) {
  const [draft, setDraft] = useState("");
  if (token)
    return (
      <div className="desk-token saved">
        <span>Session token saved for this tab.</span>
        <Button variant="secondary" size="sm" onClick={() => setToken(null)}>
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
