// /app/certificates/:certificateId — one certificate and everything behind it: the finding, its
// scope, the probes (predictions, observations, verdicts), the adversary review, any revocation,
// trace receipts and the sponsor evidence that applies to it. Evidence lives here, not on a page.
import { Link, useParams } from "react-router";
import type { Certificate, Revocation, RunBundle } from "../../../../core/src/schema";
import { Button, EmptyState, PageHeader, StatusPill } from "../../components/ui";
import { CertificateTrail } from "../../components/trail";
import { label, number, percent, safeLink, type CertificateView } from "../../data";
import { useData } from "../../app/catalog";
import { recordPath, withRun } from "../../app/links";
import { dateTime } from "../../lib/time";
import { EvidenceFor, IntegrationLine, TraceRefView } from "../report/receipts";
import { WithCertificates } from "./WithCertificates";
import { certificateTraces, heldAfterRevocation, runWithProbe } from "./model";
import "./certificates.css";

export function CertificateDetailPage() {
  const { certificateId = "" } = useParams();
  const { selectedRunId } = useData();
  return (
    <WithCertificates>
      {(world) => {
        const cert = world.certificates.find((c) => c.id === certificateId);
        if (!cert)
          return (
            <EmptyState
              title={`Certificate ${certificateId} is not in this data world`}
              actions={
                <Button asChild>
                  <Link to={withRun("/app/certificates", selectedRunId)}>All certificates</Link>
                </Button>
              }
            >
              {world.sample
                ? `Fixture scenario "${world.scenario ?? "unknown"}" has no certificate with this id. Pick a run from another scenario to look there.`
                : "The recorded certificate export has no certificate with this id."}
            </EmptyState>
          );
        return <CertificateDetail certificate={cert} world={world} />;
      }}
    </WithCertificates>
  );
}

function CertificateDetail({ certificate: c, world }: { certificate: Certificate; world: CertificateView }) {
  const { bundles, evidence } = useData();
  const revocation = world.revocations.find((r) => r.certificateId === c.id);
  const docs = safeLink(c.docUrl);
  const traces = certificateTraces(c, bundles);
  const revoked = c.status === "revoked";
  return (
    <article className="cert-detail">
      <PageHeader
        eyebrow={`${c.tool}, ${c.claim.operation}`}
        title={c.claimId}
        actions={
          revoked ? <StatusPill tone="unsafe">Revoked</StatusPill> : <StatusPill tone="safe">Certified</StatusPill>
        }
      />

      <section className="finding" aria-label="Finding">
        <div>
          <span className="eyebrow">The docs say</span>
          <p>{c.docsSay}</p>
        </div>
        <div>
          <span className="eyebrow">Observed</span>
          <p>{c.observed}</p>
        </div>
      </section>
      <p className="finding-verdict">
        {c.verdict && c.verdict.toLowerCase().startsWith(label(c.verdictKind).toLowerCase())
          ? c.verdict
          : `${label(c.verdictKind)}${c.verdict ? `: ${c.verdict}` : ""}`}
      </p>

      <dl className="facts cert-facts">
        <div>
          <dt>P(docs hold)</dt>
          <dd className="figure">{percent(c.confidence)}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd className="figure">
            α {number(c.alpha)}, β {number(c.beta)}
          </dd>
        </div>
        <div>
          <dt>Issued</dt>
          <dd>
            {dateTime(c.issuedAt)}
            <span className="muted"> ({c.issuedFrom === "event" ? "notarized event" : "belief snapshot"})</span>
          </dd>
        </div>
        <div>
          <dt>Source run</dt>
          <dd>
            <SourceRun runId={c.sourceBundle.runId} bundles={bundles} />{" "}
            <code title={c.sourceBundle.contentHash}>{c.sourceBundle.contentHash.slice(0, 12)}…</code>
          </dd>
        </div>
        <div className="span-all">
          <dt>Seal (recomputed in this browser)</dt>
          <dd>
            <code>{c.sha256}</code>
          </dd>
        </div>
      </dl>

      {revocation && <RevocationBlock revocation={revocation} bundles={bundles} />}

      <section className="section" aria-labelledby="cert-scope">
        <div className="section-head">
          <div>
            <h2 id="cert-scope">Scope</h2>
            <p>The certificate holds only where it was tested.</p>
          </div>
        </div>
        <p className="lead-text">{c.scope.text}</p>
        <dl className="facts">
          <div>
            <dt>Operations</dt>
            <dd>{c.scope.asProbed.operations.join(", ") || "None recorded"}</dd>
          </div>
          <div>
            <dt>Currencies</dt>
            <dd>{c.scope.asProbed.currencies.join(", ") || "None recorded"}</dd>
          </div>
          <div>
            <dt>Parameter</dt>
            <dd>
              <code>{c.scope.asProbed.param}</code>
            </dd>
          </div>
          <div>
            <dt>Values tested</dt>
            <dd>{c.scope.asProbed.values.join(", ") || "None recorded"}</dd>
          </div>
          <div>
            <dt>Probes</dt>
            <dd className="figure">{number(c.scope.asProbed.probes)}</dd>
          </div>
        </dl>
        {c.scope.narrowed && (
          <p className="notice">
            Narrowed by review: {c.scope.narrowed.text}
            {c.scope.narrowed.parsed === null && " Not machine-checkable as written."}
          </p>
        )}
      </section>

      <section className="section" aria-labelledby="cert-docs">
        <div className="section-head">
          <div>
            <h2 id="cert-docs">Documentation</h2>
          </div>
          {docs && (
            <a href={docs} target="_blank" rel="noreferrer">
              Source documentation<span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>
        <blockquote className="doc-quote">{c.docText}</blockquote>
      </section>

      <section className="section" aria-labelledby="cert-evidence">
        <div className="section-head">
          <div>
            <h2 id="cert-evidence">Probes behind it</h2>
            <p>Each probe committed a prediction before the call, then recorded what came back.</p>
          </div>
          <span className="muted">{number(c.evidence.length)} probes</span>
        </div>
        <div className="table-scroll">
          <table className="data-table stack">
            <thead>
              <tr>
                <th scope="col">Probe</th>
                <th scope="col">Template</th>
                <th scope="col">Verdict</th>
                <th scope="col">Observed</th>
              </tr>
            </thead>
            <tbody>
              {c.evidence.map((e) => {
                const run = runWithProbe(bundles, e.probeId, c.sample);
                return (
                  <tr key={e.probeId}>
                    <td className="stack-title" data-label="Probe">
                      {run ? (
                        <Link className="record-chip" to={withRun(recordPath.probe(e.probeId), run.runId)}>
                          {e.probeId}
                        </Link>
                      ) : (
                        <code className="record-chip muted" title="No loaded run records this probe">
                          {e.probeId}
                        </code>
                      )}
                    </td>
                    <td data-label="Template">{e.template ? label(e.template) : "Not recorded"}</td>
                    <td data-label="Verdict">
                      {e.verdict ? <StatusPill value={e.verdict} /> : "Not recorded"}
                      {e.valid === false && <span className="text-unsafe"> evidence check failed</span>}
                    </td>
                    <td data-label="Observed">{e.observed ?? "Not recorded"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" aria-labelledby="cert-review">
        <div className="section-head">
          <div>
            <h2 id="cert-review">Adversary review</h2>
            <p>A second model tries to break the claim before a certificate is issued.</p>
          </div>
        </div>
        {c.adversary ? (
          <div className="review">
            <p className="review-head">
              <StatusPill value={c.adversary.verdict} />
              <span>
                <code>{c.adversary.model}</code>
                {c.adversary.backend && <span className="muted"> via {c.adversary.backend}</span>}
                {c.adversary.reviewedAt && <span className="muted">, {dateTime(c.adversary.reviewedAt)}</span>}
              </span>
            </p>
            <p>{c.adversary.reason}</p>
          </div>
        ) : (
          <p className="muted">No adversary review recorded.</p>
        )}
      </section>

      <details className="section cert-trail">
        <summary>
          <span className="cert-trail-title">Full trail</span>
          <span className="muted">From the documented claim to enforcement, every step tagged as verified or model said.</span>
        </summary>
        <CertificateTrail certificateId={c.id} />
      </details>

      <section className="section" aria-labelledby="cert-receipts">
        <div className="section-head">
          <div>
            <h2 id="cert-receipts">Receipts</h2>
            <p>Traces of the probes above, and the tools that record them.</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table stack">
            <thead>
              <tr>
                <th scope="col">Probe</th>
                <th scope="col">Trace</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => (
                <tr key={t.probeId}>
                  <td className="stack-title" data-label="Probe">
                    <code>{t.probeId}</code>
                  </td>
                  <td data-label="Trace">
                    <TraceRefView traceId={t.traceId} spanId={t.spanId} recorded={t.recorded} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="receipt-grid">
          <div className="panel">
            <h3 className="receipt-title">Traces</h3>
            <EvidenceFor evidence={evidence} name="neatlogs" headingLevel={4} />
            <IntegrationLine name="neatlogs" />
          </div>
          <div className="panel">
            <h3 className="receipt-title">Review checkpoints</h3>
            <p>
              Checkpoints recorded for this review: <strong>none recorded</strong>.
            </p>
            <EvidenceFor evidence={evidence} name="Entire" headingLevel={4} />
            <IntegrationLine name="entire" />
          </div>
        </div>
      </section>
    </article>
  );
}

function SourceRun({ runId, bundles }: { runId: string; bundles: RunBundle[] }) {
  const known = bundles.some((b) => b.runId === runId);
  return known ? <Link to={recordPath.run(runId)}>{runId}</Link> : <code>{runId}</code>;
}

function RevocationBlock({ revocation: r, bundles }: { revocation: Revocation; bundles: RunBundle[] }) {
  const held = heldAfterRevocation(r, bundles);
  return (
    <section className="revocation-block" aria-labelledby="cert-revocation">
      <div className="section-head">
        <div>
          <h2 id="cert-revocation">Revoked {dateTime(r.revokedAt)}</h2>
          <p>{r.reason}</p>
        </div>
      </div>
      <dl className="facts">
        <div>
          <dt>Belief</dt>
          <dd>
            {label(r.from)} to {label(r.to)}
          </dd>
        </div>
        <div>
          <dt>P(docs hold) after</dt>
          <dd className="figure">{percent(r.confidence)}</dd>
        </div>
        <div>
          <dt>Guards retired</dt>
          <dd>
            {r.guardsRetired.length
              ? r.guardsRetired.map((g) => `${g.id} (${label(g.kind)}, ${g.operation})`).join("; ")
              : "None"}
          </dd>
        </div>
        <div>
          <dt>Contrary probes</dt>
          <dd>
            <span className="record-links">
              {r.triggerProbeIds.map((id) => {
                const run = runWithProbe(bundles, id, r.sample);
                return run ? (
                  <Link key={id} className="record-chip" to={withRun(recordPath.probe(id), run.runId)}>
                    {id}
                  </Link>
                ) : (
                  <code key={id} className="record-chip muted">
                    {id}
                  </code>
                );
              })}
            </span>
          </dd>
        </div>
        <div className="span-all">
          <dt>Held afterwards in {r.sourceBundle.runId}</dt>
          <dd>
            {!held ? (
              "That run is not loaded."
            ) : held.decisionIds.length ? (
              <span className="record-links">
                {held.decisionIds.map((id, i) => (
                  <Link key={id} className="record-chip" to={withRun(recordPath.decision(id), held.run.runId)}>
                    {held.requestIds[i]}
                  </Link>
                ))}
              </span>
            ) : (
              "No decision was held for lack of this belief."
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
