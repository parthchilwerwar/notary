// /app/certificates: every certificate of the selected run's world as one list of rows (seal, claim,
// verdict and scope; status, P(docs hold), probes, issue date), filtered by status
// (?status=active|revoked) and provider (?tool=); claims without a certificate behind "Show".
// ?belief= (old belief links) opens that belief's certificate, or points at its claim when it has none.
import { Link, Navigate, useSearchParams } from "react-router";
import type { Certificate, NoCertificate, Revocation } from "../../../../core/src/schema";
import {
  Button,
  EmptyState,
  Expander,
  Page,
  PageBody,
  Pills,
  Seal,
  Section,
  SkyBand,
  Stat,
  StatRow,
  StatusPill,
  TableFrame,
  Note,
  usePageMotion,
} from "../../ui";
import { number, percent, type CertificateView } from "../../data";
import { dateTime as date } from "../../lib/time";
import { useData } from "../../app/catalog";
import { recordPath, withRun } from "../../app/links";
import { WithCertificates } from "./WithCertificates";
import { filterWorld, reasonText, resolveBelief, worldTools } from "./model";
import "./certificates.css";

type StatusFilter = "all" | "active" | "revoked";
const parseStatus = (v: string | null): StatusFilter => (v === "active" || v === "revoked" ? v : "all");

export function CertificatesPage() {
  return (
    <WithCertificates title="Certificates">
      {(world) => <CertificatesView world={world} />}
    </WithCertificates>
  );
}

function clipScope(text: string, max = 110) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function CertificatesView({ world }: { world: CertificateView }) {
  const [params] = useSearchParams();
  const { bundles, selectedRunId } = useData();
  const tools = worldTools(world);
  const requestedTool = params.get("tool");
  const tool = requestedTool && tools.includes(requestedTool) ? requestedTool : null;
  const status = parseStatus(params.get("status"));
  const beliefId = params.get("belief");
  const belief = beliefId ? resolveBelief(world, bundles, beliefId) : undefined;
  const view = filterWorld(world, tool);
  const root = usePageMotion([world, tool, status]);
  if (belief?.certificate)
    return <Navigate replace to={withRun(recordPath.certificate(belief.certificate.id), selectedRunId)} />;

  const shown = view.certificates.filter((c) => status === "all" || (status === "revoked") === (c.status === "revoked"));
  const active = view.certificates.filter((c) => c.status !== "revoked").length;
  const revoked = view.certificates.length - active;
  const revocationOf = new Map<string, Revocation>(view.revocations.map((r) => [r.certificateId, r]));
  const path = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    next.delete("belief");
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    return `/app/certificates?${next.toString()}`;
  };
  const counts = view.counts;
  const summary = [
    `${number(active)} active`,
    `${number(revoked)} revoked`,
    counts ? `${number(counts.unproven)} claims still unproven` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Page ref={root}>
      <SkyBand
        title="Certificates"
        summary={`${summary}${tool ? ` · ${tool}` : ""}`}
        action={
          <Button asChild>
            <Link to={withRun("/app/chat", selectedRunId, { q: "Which certificates were revoked, and why?" })}>Ask about these</Link>
          </Button>
        }
      />
      <PageBody>
        <StatRow label="Certificate counts">
          <Stat label="Active certificates" value={active} />
          <Stat label="Revoked" value={revoked} />
          <Stat label="Claims without a certificate" value={view.noCertificates.length} />
        </StatRow>

        {beliefId && !belief?.certificate && (
          <Note role="status" className="certs-note">
            Belief <code>{beliefId}</code> has no certificate for this run
            {belief?.claimId ? (
              <>
                . Its claim <code>{belief.claimId}</code> is highlighted under the claims without a certificate.
              </>
            ) : (
              ", and no run of this scenario records it."
            )}
          </Note>
        )}
        {requestedTool && !tool && (
          <Note role="status" className="certs-note">
            No provider named <code>{requestedTool}</code> for this run. Showing every provider.
          </Note>
        )}

        <Section aria-label="Certificates" title="Issued certificates" description="Missing proof never gets a certificate. Revoked ones stay on record.">
          <div className="certs-filters">
            <Pills
              label="Filter by status"
              items={[
                { key: "all", label: "All", to: path({ status: null }), current: status === "all", count: view.certificates.length },
                { key: "active", label: "Active", to: path({ status: "active" }), current: status === "active", count: active },
                { key: "revoked", label: "Revoked", to: path({ status: "revoked" }), current: status === "revoked", count: revoked },
              ]}
            />
            {tools.length > 1 && (
              <Pills
                label="Filter by provider"
                items={[
                  { key: "any", label: "All providers", to: path({ tool: null }), current: tool === null },
                  ...tools.map((t) => ({ key: t, label: t, to: path({ tool: t }), current: tool === t })),
                ]}
              />
            )}
          </div>
          {shown.length ? (
            <div className="certs-list">
              <div className="certs-row certs-head" aria-hidden="true">
                <span>Claim</span>
                <span>Status</span>
                <span className="num">P(docs hold)</span>
                <span className="num">Probes</span>
                <span>Issued</span>
              </div>
              <ul aria-label={`${number(shown.length)} certificates`}>
                {shown.map((c) => (
                  <CertificateRow
                    key={c.id}
                    certificate={c}
                    revocation={revocationOf.get(c.id)}
                    href={withRun(recordPath.certificate(c.id), selectedRunId)}
                  />
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState title={status === "revoked" ? "Nothing revoked" : "No certificates yet"}>
              {status === "revoked"
                ? "No certificate in this view was withdrawn by contrary evidence."
                : `No claim${tool ? ` of ${tool}` : ""} for this run has settled evidence and a review yet.`}
            </EmptyState>
          )}
        </Section>

        {view.noCertificates.length > 0 && (
          <Section
            aria-label="Claims without a certificate"
            title="Not certified"
            description={`${number(view.noCertificates.length)} claims have no certificate, each with the reason recorded.`}
          >
            <Expander summary={`Show ${number(view.noCertificates.length)} claims without a certificate`} defaultOpen={!!belief?.claimId}>
              <NotCertified rows={view.noCertificates} highlight={belief?.claimId} />
            </Expander>
          </Section>
        )}

        <Expander summary="Where these come from">
          <p className="certs-source">
            {world.report.header}
            {world.scenarioReason && <> {world.scenarioReason}</>}
          </p>
        </Expander>
      </PageBody>
    </Page>
  );
}

/**
 * One certificate as a list row: seal and claim (the whole row opens the detail page), provider,
 * verdict and scope on a second line, then status, P(docs hold), probe count and issue date as
 * columns. On phones the columns fold into a labelled meta line under the claim.
 */
function CertificateRow({ certificate: c, revocation, href }: { certificate: Certificate; revocation?: Revocation; href: string }) {
  const revoked = c.status === "revoked";
  return (
    <li className="certs-row certs-item" data-revoked={revoked || undefined} data-reveal>
      <div className="certs-main">
        <Seal revoked={revoked} className="certs-seal" />
        <div className="certs-text">
          <Link className="certs-claim" to={href}>
            <code>{c.claimId}</code>
          </Link>
          <p className="certs-sub">
            <span>{c.tool}</span>
            <span>{c.verdictKind === "matches_docs" ? "Matches the docs" : "Contradicts the docs"}</span>
          </p>
          <p className="certs-scope">{clipScope(c.scope.text)}</p>
          {revoked && revocation && (
            <p className="certs-revoked-line">
              Revoked {date(revocation.revokedAt)}: {clipScope(revocation.reason, 160)}
            </p>
          )}
        </div>
      </div>
      <div className="certs-cell certs-status">
        <StatusPill tone={revoked ? "revoked" : "safe"}>{revoked ? "Revoked" : "Certified"}</StatusPill>
      </div>
      <div className="certs-cell num">
        <span className="certs-k">P(docs hold) </span>
        {percent(c.confidence)}
      </div>
      <div className="certs-cell num">
        <span className="certs-k">Probes </span>
        {number(c.evidence.length)}
      </div>
      <div className="certs-cell certs-date">
        <span className="certs-k">Issued </span>
        <time dateTime={c.issuedAt}>{date(c.issuedAt)}</time>
      </div>
    </li>
  );
}

function NotCertified({ rows, highlight }: { rows: NoCertificate[]; highlight?: string }) {
  return (
    <TableFrame className="certs-table">
      <table>
        <caption className="sr-only">Claims without a certificate, and why</caption>
        <thead>
          <tr>
            <th scope="col">Claim</th>
            <th scope="col">Why</th>
            <th scope="col" className="num">
              P(docs hold)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.tool}-${row.claimId}`} data-highlight={row.claimId === highlight ? "true" : undefined}>
              <th scope="row" className="certs-claim-cell">
                <code>{row.claimId}</code>
              </th>
              <td>
                <span className="certs-why">
                  <StatusPill value={row.kind} />
                  {reasonText(row) && <span>{reasonText(row)}</span>}
                </span>
              </td>
              <td className="num">{row.confidence === undefined ? "Not tested" : percent(row.confidence)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}
