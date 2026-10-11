// /app/certificates: every certificate of the selected run's world as cards (seal, status, scope,
// evidence), filtered by status (?status=active|revoked) and provider (?tool=); claims without a
// certificate behind "Show details". ?belief= (old belief links) opens that belief's certificate,
// or points at its claim when it has none.
import { Link, Navigate, useSearchParams } from "react-router";
import type { Certificate, NoCertificate, Revocation } from "../../../../core/src/schema";
import {
  Button,
  Card,
  CertificateCard,
  EmptyState,
  Expander,
  Page,
  PageBody,
  Pills,
  Section,
  SkyBand,
  Stat,
  StatRow,
  StatusPill,
  TableFrame,
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
          <Card padding="sm" role="status" className="certs-note">
            Belief <code>{beliefId}</code> has no certificate in this data world
            {belief?.claimId ? (
              <>
                . Its claim <code>{belief.claimId}</code> is highlighted under the claims without a certificate.
              </>
            ) : (
              ", and no run of this world records it."
            )}
          </Card>
        )}
        {requestedTool && !tool && (
          <Card padding="sm" role="status" className="certs-note">
            No provider named <code>{requestedTool}</code> in this data world. Showing every provider.
          </Card>
        )}

        <Section
          aria-label="Certificates"
          title="Issued certificates"
          description="Missing proof never gets a certificate. Revoked ones stay on record."
        >
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
            <div className="certs-grid">
              {shown.map((c) => (
                <CertificateItem key={c.id} certificate={c} revocation={revocationOf.get(c.id)} href={withRun(recordPath.certificate(c.id), selectedRunId)} />
              ))}
            </div>
          ) : (
            <EmptyState title={status === "revoked" ? "Nothing revoked" : "No certificates yet"}>
              {status === "revoked"
                ? "No certificate in this view was withdrawn by contrary evidence."
                : `No claim${tool ? ` of ${tool}` : ""} in this data world has settled evidence and a review.`}
            </EmptyState>
          )}
        </Section>

        {view.noCertificates.length > 0 && (
          <Card data-reveal>
            <Expander
              summary={`Show ${number(view.noCertificates.length)} claims without a certificate`}
              defaultOpen={!!belief?.claimId}
            >
              <NotCertified rows={view.noCertificates} highlight={belief?.claimId} />
            </Expander>
          </Card>
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

function CertificateItem({ certificate: c, revocation, href }: { certificate: Certificate; revocation?: Revocation; href: string }) {
  const revoked = c.status === "revoked";
  return (
    <CertificateCard
      tool={c.tool}
      claimId={c.claimId}
      revoked={revoked}
      href={href}
      verdict={c.verdictKind === "matches_docs" ? "Matches the docs" : "Contradicts the docs"}
      scope={clipScope(c.scope.text)}
      evidence={`${number(c.evidence.length)} ${c.evidence.length === 1 ? "probe" : "probes"} · P(docs hold) ${percent(c.confidence)}`}
      sha256={c.sha256}
      footer={
        revoked && revocation ? (
          <>Revoked {date(revocation.revokedAt)}: {clipScope(revocation.reason, 140)}</>
        ) : (
          <>Issued {date(c.issuedAt)}</>
        )
      }
    />
  );
}

function NotCertified({ rows, highlight }: { rows: NoCertificate[]; highlight?: string }) {
  return (
    <TableFrame>
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
              <th scope="row" className="certs-claim">
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
