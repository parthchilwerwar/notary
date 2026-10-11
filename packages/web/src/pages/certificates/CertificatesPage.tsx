// /app/certificates: every certificate of the selected run's world, its revocations and the claims
// that have none. ?tool= filters by provider; ?belief= (old belief links) opens that belief's
// certificate, or points at its claim when it has none.
import { Link, Navigate, useSearchParams } from "react-router";
import type { Certificate, NoCertificate, ReportCounts, Revocation } from "../../../../core/src/schema";
import { PageHeader, StatusPill } from "../../components/ui";
import { label, number, percent, type CertificateView } from "../../data";
import { dateTime as date } from "../../lib/time";
import { useData } from "../../app/catalog";
import { recordPath, withRun } from "../../app/links";
import { WithCertificates } from "./WithCertificates";
import { filterWorld, reasonText, resolveBelief, worldTools } from "./model";
import "./certificates.css";

export function CertificatesPage() {
  return (
    <>
      <PageHeader
        title="Certificates"
        description="What each API was proven to do, within the scope it was tested. A certificate is revoked when new evidence contradicts it."
      />
      <WithCertificates>{(world) => <CertificatesView world={world} />}</WithCertificates>
    </>
  );
}

function CertificatesView({ world }: { world: CertificateView }) {
  const [params] = useSearchParams();
  const { bundles, selectedRunId } = useData();
  const tools = worldTools(world);
  const requestedTool = params.get("tool");
  const tool = requestedTool && tools.includes(requestedTool) ? requestedTool : null;
  const beliefId = params.get("belief");
  const belief = beliefId ? resolveBelief(world, bundles, beliefId) : undefined;
  if (belief?.certificate)
    return <Navigate replace to={withRun(recordPath.certificate(belief.certificate.id), selectedRunId)} />;
  const view = filterWorld(world, tool);
  const filterPath = (t: string | null) => {
    const next = new URLSearchParams(params);
    next.delete("belief");
    if (t) next.set("tool", t);
    else next.delete("tool");
    return `/app/certificates?${next.toString()}`;
  };
  return (
    <div className="certs">
      <p className="world-note">
        {world.report.header}
        {world.scenarioReason && <> {world.scenarioReason}</>}
      </p>

      {beliefId && (
        <p className="notice" role="status">
          Belief <code>{beliefId}</code> has no certificate in this data world
          {belief?.claimId ? (
            <>
              . Its claim <code>{belief.claimId}</code> is highlighted under Not certified.
            </>
          ) : (
            ", and no run of this world records it."
          )}
        </p>
      )}
      {requestedTool && !tool && (
        <p className="notice" role="status">
          No provider named <code>{requestedTool}</code> in this data world. Showing every provider.
        </p>
      )}

      {tools.length > 1 && (
        <nav className="filter-links" aria-label="Filter by provider">
          <Link to={filterPath(null)} aria-current={tool === null ? "page" : undefined}>
            All providers
          </Link>
          {tools.map((t) => (
            <Link key={t} to={filterPath(t)} aria-current={tool === t ? "page" : undefined}>
              {t}
            </Link>
          ))}
        </nav>
      )}

      {view.counts && <Counts counts={view.counts} />}

      {view.revocations.length > 0 && <Revocations rows={view.revocations} />}

      <section className="section" aria-labelledby="certs-issued">
        <div className="section-head">
          <div>
            <h2 id="certs-issued">Certificates</h2>
            <p>Missing proof never gets a certificate. Revoked ones stay on record.</p>
          </div>
        </div>
        {view.certificates.length ? (
          <CertificateTable rows={view.certificates} />
        ) : (
          <p className="muted">No claim{tool ? ` of ${tool}` : ""} in this data world has settled evidence and a review.</p>
        )}
      </section>

      {view.noCertificates.length > 0 && (
        <NotCertified rows={view.noCertificates} highlight={belief?.claimId} />
      )}
    </div>
  );
}

function Counts({ counts }: { counts: ReportCounts }) {
  return (
    <dl className="figures" aria-label="Claim counts">
      <div className="figure-cell">
        <dt className="figure-label">Claims</dt>
        <dd className="figure-value">{number(counts.claimsTotal)}</dd>
      </div>
      <div className="figure-cell">
        <dt className="figure-label">Certified</dt>
        <dd className="figure-value">{number(counts.certified)}</dd>
      </div>
      <div className="figure-cell">
        <dt className="figure-label">Unproven</dt>
        <dd className="figure-value">{number(counts.unproven)}</dd>
      </div>
      <div className="figure-cell">
        <dt className="figure-label">Revoked</dt>
        <dd className={`figure-value ${counts.revoked > 0 ? "text-unsafe" : ""}`}>{number(counts.revoked)}</dd>
      </div>
    </dl>
  );
}

function CertificateTable({ rows }: { rows: Certificate[] }) {
  const { selectedRunId } = useData();
  return (
    <div className="table-scroll">
      <table className="data-table stack">
        <thead>
          <tr>
            <th scope="col">Claim</th>
            <th scope="col">Provider</th>
            <th scope="col">Finding</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              P(docs hold)
            </th>
            <th scope="col">Issued</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td data-label="Claim" className="stack-title">
                <Link className="row-link" to={withRun(recordPath.certificate(c.id), selectedRunId)}>
                  {c.claimId}
                </Link>
              </td>
              <td data-label="Provider">{c.tool}</td>
              <td data-label="Finding">{label(c.verdictKind)}</td>
              <td data-label="Status">
                {c.status === "revoked" ? (
                  <StatusPill tone="unsafe">Revoked</StatusPill>
                ) : (
                  <StatusPill tone="safe">Certified</StatusPill>
                )}
              </td>
              <td className="num" data-label="P(docs hold)">{percent(c.confidence)}</td>
              <td className="nowrap" data-label="Issued">{date(c.issuedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Revocations({ rows }: { rows: Revocation[] }) {
  const { selectedRunId } = useData();
  return (
    <section className="section" aria-labelledby="certs-revoked">
      <div className="section-head">
        <div>
          <h2 id="certs-revoked">Revocations</h2>
          <p>Certificates withdrawn after contrary evidence. Guards built on them were retired.</p>
        </div>
      </div>
      <ul className="revocation-list">
        {rows.map((r) => (
          <li key={r.id}>
            <div className="revocation-head">
              <StatusPill tone="unsafe">Revoked</StatusPill>
              <Link className="row-link" to={withRun(recordPath.certificate(r.certificateId), selectedRunId)}>
                {r.claimId}
              </Link>
            </div>
            <p>{r.reason}</p>
            <p className="muted">
              {r.tool}, {date(r.revokedAt)}. Belief {label(r.from)} to {label(r.to)}, P(docs hold){" "}
              {percent(r.confidence)}. {number(r.guardsRetired.length)} guards retired.
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NotCertified({ rows, highlight }: { rows: NoCertificate[]; highlight?: string }) {
  return (
    <section className="section" aria-labelledby="certs-none">
      <div className="section-head">
        <div>
          <h2 id="certs-none">Not certified</h2>
          <p>Claims without a certificate, and why.</p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table stack">
          <thead>
            <tr>
              <th scope="col">Claim</th>
              <th scope="col">Provider</th>
              <th scope="col">Why</th>
              <th scope="col" className="num">
                P(docs hold)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.tool}-${row.claimId}`} data-highlight={row.claimId === highlight ? "true" : undefined}>
                <td className="claim-cell stack-title" data-label="Claim">
                  <code>{row.claimId}</code>
                </td>
                <td data-label="Provider">{row.tool}</td>
                <td data-label="Why">
                  <span className="why">
                    <StatusPill value={row.kind} />
                    {reasonText(row) && <span> {reasonText(row)}</span>}
                  </span>
                </td>
                <td className="num" data-label="P(docs hold)">{row.confidence === undefined ? "Not tested" : percent(row.confidence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
