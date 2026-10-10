import { CertificateIcon as Certificate } from "@phosphor-icons/react/dist/csr/Certificate";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { ProhibitIcon as Prohibit } from "@phosphor-icons/react/dist/csr/Prohibit";
import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { Link } from "react-router";
import type {
  Certificate as CertificateRecord,
  NoCertificate,
  ReportCounts,
  Revocation,
  RunBundle,
} from "../../core/src/schema";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { StatusPill } from "./components/ui/status-pill";
import { KpiCard } from "./components/ui/kpi-card";
import { hatchBackground } from "./components/ui/hatch";
import { Empty } from "./components";
import { date, label, number, percent, safeLink } from "./data";
import type { CertificateWorld } from "./state/certificates";
import { recordPath, withRun } from "./state/data-mode";
import "./certificates.css";
import { useEffect, useState, type ReactNode } from "react";

export function ReplaySequence({
  children,
  playing,
}: {
  children: ReactNode[];
  playing: boolean;
}) {
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    // Not replaying: every recorded step is visible. Replaying reveals them one by one.
    if (!playing || !children.length) {
      setRevealed(children.length);
      return;
    }
    setRevealed(0);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRevealed(children.length);
      return;
    }
    let next = 0;
    const timer = window.setInterval(() => {
      next += 1;
      setRevealed(next);
      if (next >= children.length) window.clearInterval(timer);
    }, 700);
    return () => window.clearInterval(timer);
  }, [playing, children.length]);
  return (
    <div className="revocation-sequence" aria-live="polite">
      {children.map((child, index) => (
        <div
          key={index}
          className={`revocation-step ${index < revealed ? "revealed" : "waiting"} ${index === revealed - 1 ? "active" : ""}`}
        >
          {child}
        </div>
      ))}
    </div>
  );
}

export function BadgePreview() {
  return (
    <Card className="badge-preview">
      <div>
        <span className="eyebrow">Embeddable badge</span>
        <h2>A receipt of certified behavior.</h2>
        <p>
          A badge links to its provider report. A preview is not a certificate.
        </p>
      </div>
      <div className="badge-preview-sample">
        <span className="notary-badge">
          <ShieldCheck size={18} aria-hidden="true" />
          Notarized by Notary
        </span>
        <small>Preview only</small>
      </div>
    </Card>
  );
}

/** The run (same cohort) that carries a probe record, for linking evidence to its probe page. */
export function runWithProbe(
  bundles: RunBundle[],
  probeId: string,
  sample: boolean,
): string | undefined {
  return bundles.find(
    (b) => b.sample === sample && b.probes.some((p) => p.id === probeId),
  )?.runId;
}

function ProbeChip({
  probeId,
  bundles,
  sample,
}: {
  probeId: string;
  bundles: RunBundle[];
  sample: boolean;
}) {
  const run = runWithProbe(bundles, probeId, sample);
  return run ? (
    <Link
      className="record-chip"
      to={withRun(recordPath.probe(probeId), run)}
    >
      <span>probe</span>
      {probeId}
    </Link>
  ) : (
    <code className="record-chip muted">
      <span>probe</span>
      {probeId}
    </code>
  );
}

export function CertificateCard({
  certificate,
  runId,
  link = true,
}: {
  certificate: CertificateRecord;
  runId?: string;
  link?: boolean;
}) {
  const revoked = certificate.status === "revoked";
  return (
    <Card className={`certificate-card ${revoked ? "revoked" : ""}`}>
      <div className="certificate-seal">
        {revoked ? (
          <Prohibit size={20} aria-hidden="true" />
        ) : (
          <Certificate size={20} aria-hidden="true" />
        )}
        <span>
          {certificate.tool} · {certificate.claim.operation}
        </span>
        <StatusPill value={certificate.status} />
      </div>
      <h2>{certificate.claimId}</h2>
      <div className="certificate-outcomes">
        <div>
          <span>Docs say</span>
          {certificate.docsSay}
        </div>
        <div>
          <span>Observed</span>
          {certificate.observed}
        </div>
      </div>
      <div className="certificate-meta">
        <span>
          <StatusPill
            value={certificate.verdictKind}
            tone={
              certificate.verdictKind === "matches_docs" ? "neutral" : "info"
            }
          />
          {certificate.verdict !== label(certificate.verdictKind) &&
            ` ${certificate.verdict}`}
        </span>
        <span>
          P(documentation holds) {percent(certificate.confidence)} · issued{" "}
          {date(certificate.issuedAt)} IST
        </span>
      </div>
      {link && (
        <div className="record-link-row">
          <Link to={withRun(recordPath.certificate(certificate.id), runId)}>
            Open certificate {certificate.id}
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </div>
      )}
    </Card>
  );
}

function RevocationCard({
  revocation,
  bundles,
  runId,
}: {
  revocation: Revocation;
  bundles: RunBundle[];
  runId?: string;
}) {
  return (
    <Card className="certificate-card revoked">
      <div className="certificate-seal">
        <Prohibit size={20} aria-hidden="true" />
        <span>
          {revocation.tool} · revoked {date(revocation.revokedAt)} IST
        </span>
        <StatusPill value="revoked" />
      </div>
      <h2>{revocation.claimId}</h2>
      <p className="certificate-scope">{revocation.reason}</p>
      <div className="certificate-meta">
        <span>
          Belief {label(revocation.from)} → {label(revocation.to)} · P(documentation
          holds) {percent(revocation.confidence)}
        </span>
        <span>
          Guards retired:{" "}
          {revocation.guardsRetired.length
            ? revocation.guardsRetired
                .map((g) => `${g.id} (${label(g.kind)} · ${g.operation})`)
                .join(", ")
            : "none"}
        </span>
        <span>Source run: {revocation.sourceBundle.runId}</span>
      </div>
      <div className="certificate-evidence">
        {revocation.triggerProbeIds.map((id) => (
          <ProbeChip
            key={id}
            probeId={id}
            bundles={bundles}
            sample={revocation.sample}
          />
        ))}
      </div>
      <div className="record-link-row">
        <Link
          to={withRun(recordPath.certificate(revocation.certificateId), runId)}
        >
          Open revoked certificate {revocation.certificateId}
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </Card>
  );
}

export function WorldNote({ world }: { world: CertificateWorld }) {
  return (
    <p className="world-note">
      {world.report.header}
      {world.scenarioReason && <> {world.scenarioReason}</>}
    </p>
  );
}

export function CountsRow({ counts }: { counts: ReportCounts }) {
  return (
    <div className="kpi-grid counts-row">
      <KpiCard label="Claims" value={number(counts.claimsTotal)} />
      <KpiCard
        label="Certified"
        value={number(counts.certified)}
        note={`${number(counts.matchesDocs)} match docs · ${number(counts.contradictsDocs)} contradict docs`}
      />
      <KpiCard label="Unproven" value={number(counts.unproven)} />
      <KpiCard label="Revoked" value={number(counts.revoked)} />
    </div>
  );
}

export function CertificatesView({
  world,
  bundles,
  runId,
}: {
  world: CertificateWorld;
  bundles: RunBundle[];
  runId?: string;
}) {
  return (
    <div className="certificate-workspace">
      <WorldNote world={world} />
      <CountsRow counts={world.report.overall} />
      {world.revocations.length > 0 && (
        <section className="evidence-section">
          <div className="section-heading">
            <h2>Revocations</h2>
            <p>
              Certificates withdrawn after contrary evidence. Guards built on
              them were retired.
            </p>
          </div>
          <div className="certificate-grid">
            {world.revocations.map((r) => (
              <RevocationCard
                key={r.id}
                revocation={r}
                bundles={bundles}
                runId={runId}
              />
            ))}
          </div>
        </section>
      )}
      <section className="evidence-section">
        <div className="section-heading">
          <h2>Certificates</h2>
          <p>
            Behavior certified within the scope it was probed. Missing proof
            never receives a seal. <SealCount certificates={world.certificates} />
          </p>
        </div>
        {world.certificates.length ? (
          <div className="certificate-grid">
            {world.certificates.map((c) => (
              <CertificateCard key={c.id} certificate={c} runId={runId} />
            ))}
          </div>
        ) : (
          <Empty title="No certificates issued">
            No claim in this data world has settled evidence and a review.
          </Empty>
        )}
      </section>
      <NoCertificateTable rows={world.noCertificates} />
    </div>
  );
}

/** "9 active · 1 revoked": counted from the certificate records shown below. */
function SealCount({ certificates }: { certificates: CertificateRecord[] }) {
  if (!certificates.length) return null;
  const revoked = certificates.filter((c) => c.status === "revoked").length;
  const active = certificates.length - revoked;
  return (
    <>
      {number(active)} active
      {revoked > 0 && <> · {number(revoked)} revoked, kept on record</>}.
    </>
  );
}

/** The recorded reason, without repeating the status pill beside it. */
export function reasonText(row: Pick<NoCertificate, "kind" | "reason">): string {
  const kind = label(row.kind).toLowerCase();
  const reason = row.reason.trim();
  if (reason.toLowerCase() === kind) return "";
  const prefix = `${kind}: `;
  return reason.toLowerCase().startsWith(prefix) ? reason.slice(prefix.length) : reason;
}

export function NoCertificateTable({ rows }: { rows: NoCertificate[] }) {
  if (!rows.length) return null;
  return (
    <section className="evidence-section">
      <div className="section-heading">
        <h2>Not certified</h2>
        <p>Claims without a certificate, and why.</p>
      </div>
      <Card className="table-card">
        <div className="table-scroll">
          <table className="data-table cert-table">
            <thead>
              <tr>
                <th>Claim</th>
                <th>Tool</th>
                <th>Why</th>
                <th className="num">P(holds)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.tool}-${row.claimId}`}>
                  <td data-label="Claim">
                    <code>{row.claimId}</code>
                  </td>
                  <td data-label="Tool">{row.tool}</td>
                  <td data-label="Why">
                    <span>
                      <StatusPill value={row.kind} />
                      {reasonText(row) && <span className="why"> {reasonText(row)}</span>}
                    </span>
                  </td>
                  <td className="num" data-label="P(holds)">
                    {row.confidence === undefined
                      ? "Not tested"
                      : percent(row.confidence)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

export function CertificateDetail({
  certificate,
  world,
  bundles,
  runId,
}: {
  certificate: CertificateRecord;
  world: CertificateWorld;
  bundles: RunBundle[];
  runId?: string;
}) {
  const revocation = world.revocations.find(
    (r) => r.certificateId === certificate.id,
  );
  const docs = safeLink(certificate.docUrl);
  const beliefRun = bundles.find(
    (b) =>
      b.runId === certificate.sourceBundle.runId &&
      [...b.beliefs.after, ...b.beliefs.before].some(
        (x) => x.id === certificate.beliefId,
      ),
  )?.runId;
  return (
    <div className="certificate-workspace">
      <CertificateCard
        certificate={certificate}
        runId={runId}
        link={false}
      />
      {revocation && (
        <RevocationCard
          revocation={revocation}
          bundles={bundles}
          runId={runId}
        />
      )}
      <Card className="certificate-card">
        <span className="eyebrow">Documentation</span>
        <p className="certificate-scope">{certificate.docText}</p>
        {docs && (
          <a href={docs} target="_blank" rel="noreferrer">
            Source documentation ↗
          </a>
        )}
        <span className="eyebrow">Scope</span>
        <p className="certificate-scope">
          {certificate.scope.text}
          {certificate.scope.narrowed &&
            ` · narrowed: ${certificate.scope.narrowed.text}`}
        </p>
        <span className="eyebrow">Adversary review</span>
        <p className="certificate-scope">
          {certificate.adversary
            ? `${label(certificate.adversary.verdict)} (${certificate.adversary.model}): ${certificate.adversary.reason}`
            : "No adversary review recorded."}
        </p>
        <div className="certificate-meta">
          <span>
            Belief:{" "}
            {beliefRun ? (
              <Link
                to={withRun(recordPath.belief(certificate.beliefId), beliefRun)}
              >
                {certificate.beliefId}
              </Link>
            ) : (
              <code>{certificate.beliefId}</code>
            )}
          </span>
          <span>
            Evidence α {number(certificate.alpha)} · β{" "}
            {number(certificate.beta)} · issued from {certificate.issuedFrom}
          </span>
          <span>
            Source bundle {certificate.sourceBundle.runId} ·{" "}
            <code>{certificate.sourceBundle.contentHash.slice(0, 12)}…</code>
          </span>
          <span>
            Seal <code>{certificate.sha256}</code> (recomputed in this browser)
          </span>
        </div>
      </Card>
      <section className="evidence-section">
        <div className="section-heading">
          <h2>Cited evidence</h2>
          <p>Probes the certificate rests on.</p>
        </div>
        <Card className="table-card">
          <div className="table-scroll">
            <table className="data-table cert-table">
              <thead>
                <tr>
                  <th>Probe</th>
                  <th>Template</th>
                  <th>Verdict</th>
                  <th>Observed</th>
                </tr>
              </thead>
              <tbody>
                {certificate.evidence.map((e) => (
                  <tr key={e.probeId}>
                    <td data-label="Probe">
                      <ProbeChip
                        probeId={e.probeId}
                        bundles={bundles}
                        sample={certificate.sample}
                      />
                    </td>
                    <td data-label="Template">{e.template ? label(e.template) : "Not recorded"}</td>
                    <td data-label="Verdict">
                      <span>
                        {e.verdict ? <StatusPill value={e.verdict} /> : "Not recorded"}
                      </span>
                    </td>
                    <td data-label="Observed">{e.observed ?? "Not recorded"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </div>
  );
}

function Segments({ counts }: { counts: ReportCounts }) {
  const total = counts.claimsTotal || 1;
  const parts = [
    { name: "Matches docs", value: counts.matchesDocs, solid: true },
    { name: "Contradicts docs", value: counts.contradictsDocs, solid: true },
    { name: "Unproven", value: counts.unproven, solid: false },
  ];
  return (
    <>
      <div className="report-segments" aria-hidden="true">
        {parts.map((p, i) =>
          p.value ? (
            <span
              key={p.name}
              style={{
                width: `${(p.value / total) * 100}%`,
                background: p.solid
                  ? i === 0
                    ? "var(--blue)"
                    : "var(--fg)"
                  : hatchBackground(),
              }}
            />
          ) : null,
        )}
      </div>
      <div className="report-legend">
        {parts.map((p) => (
          <span key={p.name}>
            {p.name} {number(p.value)}
          </span>
        ))}
        <span>Revoked {number(counts.revoked)}</span>
      </div>
    </>
  );
}

export function ReportsView({
  world,
  runId,
}: {
  world: CertificateWorld;
  runId?: string;
}) {
  return (
    <>
      <WorldNote world={world} />
      <CountsRow counts={world.report.overall} />
      <div className="provider-reports">
        {world.report.tools.map((t) => (
          <Card className="provider-report" key={t.tool}>
            <div className="provider-report-heading">
              <h2>{t.tool}</h2>
              <StatusPill
                value={t.counts.certified ? "certified" : "unproven"}
                tone="neutral"
              />
            </div>
            <p className="report-headline">
              {number(t.counts.certified)}{" "}
              <small>of {number(t.counts.claimsTotal)} claims certified</small>
            </p>
            <Segments counts={t.counts} />
            <p className="world-note">{t.header}</p>
            <Button variant="outline" asChild>
              <Link to={withRun(recordPath.report(t.tool), runId)}>
                Open {t.tool} report
              </Link>
            </Button>
          </Card>
        ))}
      </div>
      <BadgePreview />
    </>
  );
}

export function ReportToolView({
  world,
  tool,
  bundles,
  runId,
}: {
  world: CertificateWorld;
  tool: string;
  bundles: RunBundle[];
  runId?: string;
}) {
  const file = world.tools.find((t) => t.tool === tool);
  const entry = world.report.tools.find((t) => t.tool === tool);
  if (!file || !entry)
    return (
      <Empty title={`No report for ${tool}`}>
        This data world has no certificate file for that provider.
      </Empty>
    );
  return (
    <div className="certificate-workspace">
      <p className="world-note">{file.header}</p>
      <CountsRow counts={entry.counts} />
      {file.revocations.length > 0 && (
        <div className="certificate-grid">
          {file.revocations.map((r) => (
            <RevocationCard
              key={r.id}
              revocation={r}
              bundles={bundles}
              runId={runId}
            />
          ))}
        </div>
      )}
      {file.certificates.length ? (
        <div className="certificate-grid">
          {file.certificates.map((c) => (
            <CertificateCard key={c.id} certificate={c} runId={runId} />
          ))}
        </div>
      ) : (
        <Empty title="No certificates issued">
          No {tool} claim has settled evidence and a review in this data world.
        </Empty>
      )}
      <NoCertificateTable rows={file.noCertificates} />
      <section className="evidence-section">
        <div className="section-heading">
          <h2>Source bundles</h2>
          <p>The hash-verified runs this report was derived from.</p>
        </div>
        {file.sourceBundles.length ? (
          <div className="record-links">
            {file.sourceBundles.map((s) => (
              <Link
                key={s.runId}
                className="record-chip"
                to={recordPath.run(s.runId) + `?run=${encodeURIComponent(runId ?? s.runId)}`}
              >
                <span>run</span>
                {s.runId}
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted">No source bundles: no runs have been recorded.</p>
        )}
      </section>
    </div>
  );
}

/**
 * Fixture-only replay of a revocation: certificate issued, contrary probes, revocation, guards
 * retired, then the decisions held afterwards for lack of that belief. Every step is a record.
 */
export function RevocationSteps({
  world,
  bundles,
  playing,
}: {
  world: CertificateWorld;
  bundles: RunBundle[];
  playing: boolean;
}) {
  return (
    <>
      {world.revocations.map((r) => {
        const cert = world.certificates.find((c) => c.id === r.certificateId);
        const run = bundles.find((b) => b.runId === r.sourceBundle.runId);
        const held =
          run?.decisions.filter(
            (d) =>
              d.status === "held" && d.missingBeliefs.includes(r.beliefId),
          ) ?? [];
        return (
          <section className="evidence-section" key={r.id}>
            <div className="section-heading">
              <h2>{r.claimId}</h2>
              <p>
                {r.tool} · source run {r.sourceBundle.runId}
              </p>
            </div>
            <ReplaySequence playing={playing}>
              {[
                <div key="issued">
                  <span className="eyebrow">1 · Certified</span>
                  <h3>{cert ? label(cert.verdictKind) : "Certificate record"}</h3>
                  <p>
                    {cert
                      ? `Issued ${date(cert.issuedAt)} IST · docs say ${cert.docsSay}; observed ${cert.observed}`
                      : r.certificateId}
                  </p>
                </div>,
                <div key="probes">
                  <span className="eyebrow">2 · Contrary probes</span>
                  <h3>{number(r.triggerProbeIds.length)} probes</h3>
                  <div className="record-links">
                    {r.triggerProbeIds.map((id) => (
                      <ProbeChip
                        key={id}
                        probeId={id}
                        bundles={bundles}
                        sample={r.sample}
                      />
                    ))}
                  </div>
                </div>,
                <div key="revoked">
                  <span className="eyebrow">3 · Revoked</span>
                  <h3>
                    {label(r.from)} → {label(r.to)}
                  </h3>
                  <p>{r.reason}</p>
                </div>,
                <div key="enforced">
                  <span className="eyebrow">4 · Enforced</span>
                  <h3>
                    {number(r.guardsRetired.length)} guards retired ·{" "}
                    {number(held.length)} held
                  </h3>
                  <div className="record-links">
                    {held.map((d) => (
                      <Link
                        key={d.id}
                        className="record-chip"
                        to={withRun(recordPath.decision(d.id), run!.runId)}
                      >
                        <span>decision</span>
                        {d.requestId}
                      </Link>
                    ))}
                  </div>
                </div>,
              ]}
            </ReplaySequence>
          </section>
        );
      })}
    </>
  );
}
