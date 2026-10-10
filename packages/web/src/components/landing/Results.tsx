// Results: fixture numbers (clearly labelled) and real numbers, never in the same table.
// Fixture: the published fixture naive/guarded bundles + the fixture certificate report.
// Real: non-sample bundles + the real certificate report; with none, "not measured yet".
import { Link } from "react-router";
import type { CertificateReport, RunBundle } from "../../../../core/src/schema";
import { Button, Card, FixtureBanner } from "../ui";
import { number } from "../../data";
import { withRun } from "../../state/data-mode";
import { ResultsStrip } from "./ResultsStrip";

type Overall = CertificateReport["overall"];

function CertificateCounts({ overall }: { overall: Overall }) {
  const rows: [string, number][] = [
    ["Claims", overall.claimsTotal],
    ["Certified", overall.certified],
    ["Match the docs", overall.matchesDocs],
    ["Contradict the docs", overall.contradictsDocs],
    ["Unproven", overall.unproven],
    ["Revoked", overall.revoked],
  ];
  return (
    <dl className="cert-counts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{number(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Results({
  loading,
  error,
  fixture,
  real,
  fixtureReport,
  realReport,
  certError,
}: {
  loading: boolean;
  error: string;
  fixture: { naive?: RunBundle; guarded?: RunBundle };
  real: { total: number; queueRuns: number; notarizeRuns: number; naive?: RunBundle; guarded?: RunBundle };
  fixtureReport?: { scenario?: string; report: CertificateReport };
  realReport?: CertificateReport;
  certError: string;
}) {
  const hasFixture = !!(fixture.naive || fixture.guarded);
  const hasRealQueue = !!(real.naive || real.guarded);
  const queueSize = (fixture.guarded ?? fixture.naive)?.metrics.items_total;
  return (
    <section id="results" className="landing-section" aria-labelledby="results-title">
      <div className="chapter-heading">
        <span className="eyebrow">Results</span>
        <h2 id="results-title">Only numbers from data files.</h2>
        <p>
          Every value below is read from a hash-verified run bundle or a sealed
          certificate report. Fixture and real results are never combined.
        </p>
      </div>
      {loading ? (
        <div className="result-state" role="status">
          Verifying result bundles…
        </div>
      ) : error ? (
        <div className="result-state" role="alert">
          <h3>Results unavailable</h3>
          <p>{error}</p>
        </div>
      ) : (
        <div className="results-stack">
          <div className="results-block">
            <h3 className="results-block-title">Real results</h3>
            {hasRealQueue ? (
              <>
                <p className="cohort-label">
                  Recorded live runs{(!real.naive || !real.guarded) && " · counterpart pending"}
                </p>
                <ResultsStrip naive={real.naive} guarded={real.guarded} />
              </>
            ) : (
              <Card className="result-state real-empty">
                <strong className="real-empty-value">Not measured yet</strong>
                <p>
                  {number(real.total)} real run bundles are published (
                  {number(real.queueRuns)} queue runs, {number(real.notarizeRuns)}{" "}
                  notarize runs). Real numbers need live Crustdata, Dodo test-mode
                  and model credentials; until a run is recorded, nothing here is
                  filled in.
                </p>
                {realReport && (
                  <>
                    <p className="real-report-header">{realReport.header}</p>
                    <CertificateCounts overall={realReport.overall} />
                  </>
                )}
              </Card>
            )}
          </div>
          {hasFixture && (
            <div className="results-block">
              <h3 className="results-block-title">Fixture results</h3>
              <FixtureBanner variant="inline" />
              <p className="cohort-label">
                Simulated Crustdata and Dodo with planted quirks; deterministic
                model doubles. Naive vs guarded on the same seeded queue
                {queueSize != null ? ` (${number(queueSize)} requests)` : ""}.
              </p>
              <ResultsStrip naive={fixture.naive} guarded={fixture.guarded} />
              {fixtureReport && (
                <Card className="fixture-certs">
                  <h4>
                    Fixture certificates
                    {fixtureReport.scenario ? ` · scenario "${fixtureReport.scenario}"` : ""}
                  </h4>
                  <CertificateCounts overall={fixtureReport.report.overall} />
                </Card>
              )}
              {certError && (
                <p role="alert" className="landing-data-error">
                  {certError}
                </p>
              )}
              <div className="landing-actions">
                <Button variant="outline" asChild>
                  <Link
                    to={withRun("/app/runs", (fixture.guarded ?? fixture.naive)!.runId, {
                      baseline:
                        fixture.naive && fixture.guarded ? fixture.naive.runId : undefined,
                    })}
                  >
                    Inspect the fixture comparison
                  </Link>
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
