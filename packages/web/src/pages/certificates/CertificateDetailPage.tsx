// /app/certificates/:certificateId — one certificate and what stands behind it, laid out like the
// landing: "Predict, then test" (what the docs say vs what was observed, then each probe's committed
// prediction and result), "Challenge" (the Adversary's review and any revocation), the scope it
// holds in, and receipts, documentation and the full trail behind "Show details".
import { Link, useParams } from "react-router";
import type { Certificate, Revocation, RunBundle } from "../../../../core/src/schema";
import {
  AgentBadge,
  Button,
  Card,
  EmptyState,
  Expander,
  Facts,
  Page,
  PageBody,
  Section,
  Seal,
  SkyBand,
  Stat,
  StatRow,
  StatusPill,
  TableFrame,
  Timeline,
  TimelineItem,
  WashCard,
  usePageMotion,
} from "../../ui";
import { CertificateTrail } from "../../components/trail";
import { label, number, percent, safeLink, type CertificateView } from "../../data";
import { useData } from "../../app/catalog";
import { recordPath, withRun } from "../../app/links";
import { dateTime } from "../../lib/time";
import { CodeText, EvidenceFor, IntegrationLine, TraceRefView } from "../report/receipts";
import { WithCertificates } from "./WithCertificates";
import { certificateTraces, heldAfterRevocation, runWithProbe } from "./model";
import "./certificates.css";

export function CertificateDetailPage() {
  const { certificateId = "" } = useParams();
  const { selectedRunId } = useData();
  return (
    <WithCertificates title="Certificate">
      {(world) => {
        const cert = world.certificates.find((c) => c.id === certificateId);
        if (!cert)
          return (
            <Page>
              <SkyBand title="Certificate not found" />
              <PageBody>
                <EmptyState
                  title={`Certificate ${certificateId} is not in this data world`}
                  action={
                    <Button asChild>
                      <Link to={withRun("/app/certificates", selectedRunId)}>All certificates</Link>
                    </Button>
                  }
                >
                  {world.sample
                    ? `Fixture scenario "${world.scenario ?? "unknown"}" has no certificate with this id. Pick a run from another scenario to look there.`
                    : "The recorded certificate export has no certificate with this id."}
                </EmptyState>
              </PageBody>
            </Page>
          );
        return <CertificateDetail certificate={cert} world={world} />;
      }}
    </WithCertificates>
  );
}

function CertificateDetail({ certificate: c, world }: { certificate: Certificate; world: CertificateView }) {
  const { bundles, evidence, selectedRunId } = useData();
  const revocation = world.revocations.find((r) => r.certificateId === c.id);
  const docs = safeLink(c.docUrl);
  const traces = certificateTraces(c, bundles);
  const revoked = c.status === "revoked";
  const root = usePageMotion([c.id]);
  const verdictLine =
    c.verdict && c.verdict.toLowerCase().startsWith(label(c.verdictKind).toLowerCase())
      ? c.verdict
      : `${label(c.verdictKind)}${c.verdict ? `: ${c.verdict}` : ""}`;
  return (
    <Page ref={root} className="cert-detail">
      <SkyBand
        label={`${c.tool} · ${c.claim.operation}`}
        title={<span className="cert-title">{c.claimId}</span>}
        summary={
          revoked && revocation
            ? `Revoked ${dateTime(revocation.revokedAt)} after contrary evidence · issued ${dateTime(c.issuedAt)}`
            : `Certified ${dateTime(c.issuedAt)} · ${verdictLine}`
        }
        action={
          <>
            <StatusPill tone={revoked ? "revoked" : "safe"}>{revoked ? "Revoked" : "Certified"}</StatusPill>
            <Button asChild>
              <Link to={withRun("/app/chat", selectedRunId, { q: `Why is ${c.claimId} ${revoked ? "revoked" : "certified"}?` })}>Ask about it</Link>
            </Button>
          </>
        }
      />
      <PageBody>
        <StatRow label="Certificate figures">
          <Stat label="P(docs hold)" value={c.confidence * 100} display={percent(c.confidence)} />
          <Stat label="Probes behind it" value={c.evidence.length} />
        </StatRow>

        <Section label="Predict, then test" title="What the docs say, and what came back">
          <div className="cert-pair">
            <Card data-reveal>
              <p className="cert-pair-label">The docs say</p>
              <p className="cert-pair-text">
                <CodeText text={c.docsSay} />
              </p>
            </Card>
            <Card data-reveal>
              <p className="cert-pair-label">Observed</p>
              <p className="cert-pair-text">
                <CodeText text={c.observed} />
              </p>
            </Card>
          </div>
          <Card data-reveal>
            <Timeline aria-label="Probes behind this certificate">
              {c.evidence.map((e) => {
                const run = runWithProbe(bundles, e.probeId, c.sample);
                const probe = run?.probes.find((p) => p.id === e.probeId);
                return (
                  <TimelineItem
                    key={e.probeId}
                    mark={e.valid === false ? "x" : "check"}
                    tone={e.valid === false ? "unsafe" : "neutral"}
                    markLabel={e.valid === false ? "Evidence check failed" : "Probe recorded"}
                    title={e.observed ?? "Observation not recorded"}
                    meta={e.verdict ? <StatusPill value={e.verdict} /> : undefined}
                    subtitle={
                      <>
                        {e.template ? label(e.template) : "Template not recorded"}
                        {probe && <> · prediction committed {dateTime(probe.committedAt)}, sha256 {probe.predictionHash.slice(0, 12)}…</>}
                        {" · "}
                        {run ? (
                          <Link to={withRun(recordPath.probe(e.probeId), run.runId)}>{e.probeId}</Link>
                        ) : (
                          <code title="No loaded run records this probe">{e.probeId}</code>
                        )}
                      </>
                    }
                  />
                );
              })}
            </Timeline>
          </Card>
        </Section>

        <Section label="Challenge" title="Reviewed before it was issued">
          {c.adversary ? (
            <Card data-reveal className="cert-review">
              <div className="cert-review-head">
                <AgentBadge agent="adversary" model={c.adversary.model} />
                <StatusPill value={c.adversary.verdict} />
                {c.adversary.reviewedAt && <span className="cert-muted">{dateTime(c.adversary.reviewedAt)}</span>}
              </div>
              <p>{c.adversary.reason}</p>
              {c.adversary.backend && <p className="cert-muted">Reviewed via {c.adversary.backend}</p>}
            </Card>
          ) : (
            <EmptyState title="No review recorded">The Adversary's review is missing from this certificate's record.</EmptyState>
          )}
          {revocation && <RevocationCard revocation={revocation} bundles={bundles} />}
        </Section>

        <Section label="Scope" title="Where it holds">
          <Card data-reveal className="cert-scope">
            <p className="cert-scope-text">{c.scope.text}</p>
            {c.scope.narrowed && (
              <p className="cert-muted">
                Narrowed by review: {c.scope.narrowed.text}
                {c.scope.narrowed.parsed === null && " Not machine-checkable as written."}
              </p>
            )}
            <Expander>
              <Facts
                columns={3}
                items={[
                  { label: "Operations", value: c.scope.asProbed.operations.join(", ") || "None recorded" },
                  { label: "Currencies", value: c.scope.asProbed.currencies.join(", ") || "None recorded" },
                  { label: "Parameter", value: <code>{c.scope.asProbed.param}</code> },
                  { label: "Values tested", value: c.scope.asProbed.values.join(", ") || "None recorded", wide: true },
                  { label: "Evidence", value: `α ${number(c.alpha)}, β ${number(c.beta)}` },
                  { label: "Issued from", value: c.issuedFrom === "event" ? "Notarized event" : "Belief snapshot" },
                  {
                    label: "Source run",
                    value: (
                      <>
                        <SourceRun runId={c.sourceBundle.runId} bundles={bundles} />{" "}
                        <code title={c.sourceBundle.contentHash}>{c.sourceBundle.contentHash.slice(0, 12)}…</code>
                      </>
                    ),
                  },
                  { label: "Seal (recomputed in this browser)", value: <Seal sha256={c.sha256} revoked={revoked} />, wide: true },
                ]}
              />
            </Expander>
          </Card>
        </Section>

        <Card data-reveal className="cert-more">
          <Expander summary="Documentation">
            {docs && (
              <a href={docs} target="_blank" rel="noreferrer">
                Source documentation<span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
            <blockquote className="cert-quote">{c.docText}</blockquote>
          </Expander>
          <Expander summary="Receipts">
            <TableFrame>
              <table>
                <caption className="sr-only">Trace receipts of the probes</caption>
                <thead>
                  <tr>
                    <th scope="col">Probe</th>
                    <th scope="col">Trace</th>
                  </tr>
                </thead>
                <tbody>
                  {traces.map((t) => (
                    <tr key={t.probeId}>
                      <th scope="row">
                        <code>{t.probeId}</code>
                      </th>
                      <td>
                        <TraceRefView traceId={t.traceId} spanId={t.spanId} recorded={t.recorded} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
            <div className="cert-receipts">
              <div>
                <h3 className="cert-receipt-title">Traces</h3>
                <EvidenceFor evidence={evidence} name="neatlogs" headingLevel={4} />
                <IntegrationLine name="neatlogs" />
              </div>
              <div>
                <h3 className="cert-receipt-title">Review checkpoints</h3>
                <p>
                  Checkpoints recorded for this review: <strong>none recorded</strong>.
                </p>
                <EvidenceFor evidence={evidence} name="Entire" headingLevel={4} />
                <IntegrationLine name="entire" />
              </div>
            </div>
          </Expander>
          <Expander summary="Full trail">
            <p className="cert-muted">From the documented claim to enforcement, every step tagged as verified or model said.</p>
            <CertificateTrail certificateId={c.id} />
          </Expander>
        </Card>
      </PageBody>
    </Page>
  );
}

function SourceRun({ runId, bundles }: { runId: string; bundles: RunBundle[] }) {
  const known = bundles.some((b) => b.runId === runId);
  return known ? <Link to={recordPath.run(runId)}>{runId}</Link> : <code>{runId}</code>;
}

function RevocationCard({ revocation: r, bundles }: { revocation: Revocation; bundles: RunBundle[] }) {
  const held = heldAfterRevocation(r, bundles);
  return (
    <WashCard wash="peach" className="revocation-block" aria-labelledby="cert-revocation" as="section" data-reveal>
      <div className="cert-review-head">
        <StatusPill tone="revoked">Revoked</StatusPill>
        <span className="cert-muted">{dateTime(r.revokedAt)}</span>
      </div>
      <h3 id="cert-revocation" className="ui-title ui-title-card">
        Contrary evidence withdrew it
      </h3>
      <p>{r.reason}</p>
      <Facts
        items={[
          { label: "Belief", value: `${label(r.from)} to ${label(r.to)}` },
          { label: "P(docs hold) after", value: percent(r.confidence) },
          {
            label: "Guards retired",
            value: r.guardsRetired.length
              ? r.guardsRetired.map((g) => `${g.id} (${label(g.kind)}, ${g.operation})`).join("; ")
              : "None",
          },
          {
            label: "Contrary probes",
            value: (
              <span className="cert-links">
                {r.triggerProbeIds.map((id) => {
                  const run = runWithProbe(bundles, id, r.sample);
                  return run ? (
                    <Link key={id} to={withRun(recordPath.probe(id), run.runId)}>
                      {id}
                    </Link>
                  ) : (
                    <code key={id}>{id}</code>
                  );
                })}
              </span>
            ),
          },
          {
            label: `Held afterwards in ${r.sourceBundle.runId}`,
            wide: true,
            value: !held ? (
              "That run is not loaded."
            ) : held.decisionIds.length ? (
              <span className="cert-links">
                {held.decisionIds.map((id, i) => (
                  <Link key={id} to={withRun(recordPath.decision(id), held.run.runId)}>
                    {held.requestIds[i]}
                  </Link>
                ))}
              </span>
            ) : (
              "No decision was held for lack of this belief."
            ),
          },
        ]}
      />
    </WashCard>
  );
}
