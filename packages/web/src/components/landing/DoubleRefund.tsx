// "The double-refund problem": what goes wrong when an agent trusts the docs, told only with
// records from the published fixture naive and guarded runs (hash-verified bundles).
import { Link } from "react-router";
import type { RunBundle } from "../../../../core/src/schema";
import { Card, FixtureBanner, StatusPill } from "../ui";
import { number } from "../../data";
import { recordPath, withRun } from "../../state/data-mode";
import {
  findIncident,
  money,
  unsafeBreakdown,
  type Incident,
} from "../../landing-data";

const count = (v: number | null | undefined) =>
  v == null ? "Not computable" : number(v);

function Attempts({ incident }: { incident: Incident }) {
  return (
    <ol className="incident-attempts">
      {incident.naive.attempts.map((a, i) => (
        <li key={`${a.at}-${i}`}>
          <span className="attempt-op">
            <code>{incident.action}</code>
            <span className="attempt-n">attempt {i + 1}</span>
          </span>
          <span className="attempt-result">
            {a.status === null ? (
              <StatusPill tone="info">timed out · outcome unknown</StatusPill>
            ) : (
              <StatusPill tone="neutral">HTTP {a.status}</StatusPill>
            )}
            {a.amount !== undefined && (
              <span className="attempt-amount">
                {money(a.amount, a.currency)}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function GuardedOutcome({ incident }: { incident: Incident }) {
  const g = incident.guarded;
  if (!g)
    return (
      <p className="incident-guarded muted">
        The guarded run has no record of {incident.requestId}.
      </p>
    );
  return (
    <div className="incident-guarded">
      <span className="incident-side">Guarded run</span>
      <p>
        <StatusPill value={g.status} />{" "}
        {g.writes === 0 ? "No money moved." : `${g.writes} write(s) sent.`}
        {g.missingBeliefs.length > 0 && (
          <>
            {" "}
            Missing certificate for <code>{g.missingBeliefs.join(", ")}</code>.
          </>
        )}
      </p>
      <Link to={withRun(recordPath.decision(g.decisionId), g.runId)}>
        Open the guarded decision
      </Link>
    </div>
  );
}

function unitTitle(unit: Incident) {
  const asked = unit.naive.requestedAmount;
  const sent = unit.naive.attempts.find((a) => a.amount !== undefined);
  if (asked === undefined || sent?.amount === undefined)
    return "The amount went out in the wrong unit.";
  return `Asked for ${money(asked, sent.currency)}. Refunded ${money(sent.amount, sent.currency)}.`;
}

export function DoubleRefund({
  naive,
  guarded,
  loading,
  error,
}: {
  naive?: RunBundle;
  guarded?: RunBundle;
  loading: boolean;
  error: string;
}) {
  const duplicate = findIncident("duplicate", naive, guarded);
  const unit = findIncident("wrong_unit", naive, guarded);
  const n = unsafeBreakdown(naive);
  const g = unsafeBreakdown(guarded);
  const ready = !loading && !error && naive && guarded;
  return (
    <section
      id="problem"
      className="landing-section"
      aria-labelledby="problem-title"
    >
      <div className="chapter-heading">
        <span className="eyebrow">The double-refund problem</span>
        <h2 id="problem-title">
          Every call returned 200.
          <br />
          The customer was refunded twice.
        </h2>
        <p>
          An agent that trusts the docs retries a refund after a timeout and
          reads a partial-refund amount in the documented unit. On an API that
          behaves differently, both are valid requests that move the wrong
          money.
        </p>
      </div>
      {loading ? (
        <div className="result-state" role="status">
          Verifying the fixture run bundles…
        </div>
      ) : error ? (
        <div className="result-state" role="alert">
          <h3>Fixture runs unavailable</h3>
          <p>{error}</p>
        </div>
      ) : !ready ? (
        <div className="result-state">
          <h3>No fixture runs published</h3>
          <p>
            Publish the fixture naive and guarded runs with{" "}
            <code>pnpm notary demo --fixture --publish</code>.
          </p>
        </div>
      ) : (
        <>
          <FixtureBanner variant="inline" />
          <div className="incident-grid">
            {duplicate && (
              <Card className="incident-card incident-main">
                <span className="tile-kicker">
                  Retry after a timeout · request {duplicate.requestId}
                </span>
                <h3>The refund went out twice.</h3>
                {duplicate.naive.attempts[0]?.status === null && (
                  <p className="incident-copy">
                    The first attempt timed out, so the naive agent retried.
                    The deterministic grader, reading Dodo state back after the
                    run, graded this request a duplicate refund.
                  </p>
                )}
                <span className="incident-side">Naive run</span>
                <Attempts incident={duplicate} />
                <GuardedOutcome incident={duplicate} />
              </Card>
            )}
            {unit && (
              <Card className="incident-card">
                <span className="tile-kicker">
                  Unit mismatch · request {unit.requestId}
                </span>
                <h3>{unitTitle(unit)}</h3>
                {unit.naive.requestedAmount !== undefined && (
                  <p className="incident-copy">
                    The agent sent <code>items[].amount</code> ={" "}
                    {number(unit.naive.requestedAmount)} in minor units (
                    {money(
                      unit.naive.requestedAmount,
                      unit.naive.attempts[0]?.currency,
                    )}
                    ).
                  </p>
                )}
                <span className="incident-side">Naive run</span>
                <Attempts incident={unit} />
                <GuardedOutcome incident={unit} />
              </Card>
            )}
            <Card className="incident-card incident-totals">
              <span className="tile-kicker">Across the whole queue</span>
              <h3>Unsafe money actions</h3>
              <div className="totals-compare">
                <div className="totals-col hatched">
                  <span>Naive · trusts the docs</span>
                  <strong className={n?.total ? "unsafe-number" : ""}>
                    {count(n?.total)}
                  </strong>
                  <dl>
                    <div>
                      <dt>Duplicate refunds</dt>
                      <dd>{count(n?.duplicates)}</dd>
                    </div>
                    <div>
                      <dt>Wrong unit</dt>
                      <dd>{count(n?.wrongUnit)}</dd>
                    </div>
                  </dl>
                </div>
                <div className="totals-col">
                  <span>Guarded · needs a certificate</span>
                  <strong
                    className={g?.total === 0 ? "safe-number" : g?.total ? "unsafe-number" : ""}
                  >
                    {count(g?.total)}
                  </strong>
                  <dl>
                    <div>
                      <dt>Executed</dt>
                      <dd>{count(g?.executed)}</dd>
                    </div>
                    <div>
                      <dt>Held for a human</dt>
                      <dd>{count(g?.held)}</dd>
                    </div>
                  </dl>
                </div>
              </div>
              <p className="chart-note">
                From run bundles <code>{naive.runId}</code> and{" "}
                <code>{guarded.runId}</code>, graded deterministically against
                expected outcomes written before the run.
              </p>
            </Card>
          </div>
        </>
      )}
    </section>
  );
}
