// /app/report (sidebar footer): naive vs guarded within one world, cost per run, connections to
// the live integrations, and receipts (neatlogs traces, Entire checkpoints, tool evidence).
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { RunBundle } from "../../../../core/src/schema";
import { Button, FixtureBanner, Json, LoadingState, ErrorState, PageHeader, StatusPill } from "../../components/ui";
import { latestHealth, useShellStatus } from "../../components/shell/status";
import {
  PUBLISHED_FILES,
  label,
  loadEconomicsPlan,
  number,
  percent,
  usd,
  useDataSource,
} from "../../data";
import { useData } from "../../app/catalog";
import { recordPath, withRun } from "../../app/links";
import { dateTime } from "../../lib/time";
import {
  byCohort,
  comparisonPairs,
  comparisonRows,
  pickPair,
  roleCosts,
  runCost,
  runTraces,
  type ComparisonPair,
  type MetricRow,
  type RoleCost,
} from "./model";
import { CodeText, EvidenceEntryView, EvidenceStatus, STATE_WORD, TraceRefView, integrationTone } from "./receipts";
import "./report.css";

export function ReportPage() {
  const { loading, error, bundles, bundle } = useData();
  return (
    <div className="report">
      <PageHeader
        title="Report"
        description="How the guarded agent compares with the naive one, what each run cost, and what Notary is connected to."
      />
      <nav className="report-toc" aria-label="On this page">
        <a href="#comparison">Comparison</a>
        <a href="#cost">Cost per run</a>
        <a href="#connections">Connections</a>
        <a href="#receipts">Receipts</a>
      </nav>
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState title="Runs withheld">{error}</ErrorState>
      ) : (
        <>
          <Comparison bundles={bundles} selected={bundle} />
          <Costs bundles={bundles} selected={bundle} />
        </>
      )}
      <Connections />
      <Receipts selected={loading || error ? undefined : bundle} />
    </div>
  );
}

// ------------------------------------------------------------------------------ comparison

function formatMetric(value: number | null, format: MetricRow["format"]) {
  if (value === null) return "Not recorded";
  return format === "ratio" ? percent(value) : number(value);
}

function formatDelta(row: MetricRow) {
  if (row.delta === null) return "Not computable";
  if (row.delta === 0) return "No change";
  const sign = row.delta > 0 ? "+" : "−";
  const abs = Math.abs(row.delta);
  return row.format === "ratio" ? `${sign}${number(abs)} pts` : `${sign}${number(abs)}`;
}

function Comparison({ bundles, selected }: { bundles: RunBundle[]; selected?: RunBundle }) {
  const pairs = comparisonPairs(bundles);
  const pair = pickPair(pairs, selected);
  const others = pairs.filter((p) => p !== pair);
  return (
    <section className="section" id="comparison" aria-labelledby="comparison-title">
      <div className="section-head">
        <div>
          <h2 id="comparison-title">Naive vs guarded</h2>
          <p>The same queue of money requests, run once without Notary and once with it. Same world only.</p>
        </div>
      </div>
      {!pair ? (
        <p className="muted">
          No world has both a naive and a guarded queue run, so there is nothing to compare. Real runs pair by seed;
          fixture runs pair by scenario.
        </p>
      ) : (
        <PairTable pair={pair} />
      )}
      {others.length > 0 && (
        <p className="muted other-pairs">
          Other comparisons:{" "}
          {others.map((p, i) => (
            <span key={p.world}>
              {i > 0 && ", "}
              <Link to={withRun("/app/report", p.guarded.runId)}>
                {p.sample ? `fixture scenario ${p.world.slice("fixture:".length)}` : `real runs, seed ${p.world.slice(5)}`}
              </Link>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function PairTable({ pair }: { pair: ComparisonPair }) {
  const rows = comparisonRows(pair);
  return (
    <div className="pair">
      {pair.sample && <FixtureBanner variant="inline" />}
      <div className="table-scroll">
        <table className="data-table stack">
          <caption className="sr-only">
            Naive run {pair.naive.runId} compared with guarded run {pair.guarded.runId}
          </caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col" className="num">
                Naive
                <span className="th-run">{pair.naive.runId}</span>
              </th>
              <th scope="col" className="num">
                Guarded
                <span className="th-run">{pair.guarded.runId}</span>
              </th>
              <th scope="col" className="num">
                Difference
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                <td data-label="Naive" className={`num ${r.unsafe && r.naive ? "text-unsafe" : ""}`}>
                  {formatMetric(r.naive, r.format)}
                </td>
                <td data-label="Guarded" className={`num ${r.unsafe && r.guarded ? "text-unsafe" : ""}`}>
                  {formatMetric(r.guarded, r.format)}
                </td>
                <td data-label="Difference" className="num">
                  {formatDelta(r)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="chart-note">
        Graded by deterministic code from each run's recorded effects. Missing values are shown as missing, never as
        zero.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------------------ costs

function UsdCell({ cost }: { cost: ReturnType<typeof runCost> }) {
  if (cost.calls === 0 && cost.unknownRoles.length === 0) return <>{usd(0)}<span className="muted"> no calls</span></>;
  if (cost.unknownRoles.length === 0) return <>{usd(cost.recordedUsd)}</>;
  const roles = cost.unknownRoles.join(", ");
  return cost.recordedUsd > 0 ? (
    <span title={`No price recorded for ${roles}`}>
      {usd(cost.recordedUsd)} + unknown<span className="sr-only">: no price recorded for {roles}</span>
    </span>
  ) : (
    <span title={`No price recorded for ${roles}`}>
      Unknown<span className="sr-only">: no price recorded for {roles}</span>
    </span>
  );
}

function RoleUsd({ role }: { role: RoleCost }) {
  if (role.price === "none") return <span className="muted">No calls</span>;
  if (role.price === "unknown") return <>Unknown, no price recorded</>;
  return <>{usd(role.usd)}</>;
}

function Costs({ bundles, selected }: { bundles: RunBundle[]; selected?: RunBundle }) {
  const cohorts = byCohort(bundles);
  return (
    <section className="section" id="cost" aria-labelledby="cost-title">
      <div className="section-head">
        <div>
          <h2 id="cost-title">Cost per run</h2>
          <p>
            API credits and model usage as each run recorded them. A model cost with no recorded price is shown as
            unknown, not $0. Credits are never converted to dollars.
          </p>
        </div>
      </div>
      {!cohorts.length && <p className="muted">No runs are published.</p>}
      {cohorts.map((g) => (
        <div className="pair" key={String(g.sample)}>
          {g.sample && <FixtureBanner variant="inline" />}
          <div className="table-scroll">
            <table className="data-table stack">
              <caption className="sr-only">{g.sample ? "Fixture runs" : "Real runs"}: cost per run</caption>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="num">
                    Credits used
                  </th>
                  <th scope="col" className="num">
                    Model calls
                  </th>
                  <th scope="col" className="num">
                    Tokens in / out
                  </th>
                  <th scope="col" className="num">
                    Model cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {g.runs.map((b) => {
                  const cost = runCost(b);
                  return (
                    <tr key={b.runId} data-highlight={b.runId === selected?.runId ? "true" : undefined}>
                      <th scope="row">
                        <Link to={recordPath.run(b.runId)}>{b.runId}</Link>
                      </th>
                      <td data-label="Kind">
                        {b.kind}
                        {b.variant !== b.kind && ` / ${b.variant}`}
                      </td>
                      <td data-label="Credits used" className="num">
                        {number(cost.creditsUsed)} <span className="muted">of {number(cost.creditsBudget)}</span>
                      </td>
                      <td data-label="Model calls" className="num">
                        {number(cost.calls)}
                      </td>
                      <td data-label="Tokens in / out" className="num">
                        {number(cost.inputTokens)} / {number(cost.outputTokens)}
                      </td>
                      <td data-label="Model cost" className="num">
                        <UsdCell cost={cost} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {selected && <SelectedCost bundle={selected} />}
      <CfoPlan />
    </section>
  );
}

function SelectedCost({ bundle }: { bundle: RunBundle }) {
  const roles = roleCosts(bundle);
  const endpoints = Object.entries(bundle.credits.byEndpoint);
  return (
    <div className="cost-detail">
      <h3>
        By role, <code>{bundle.runId}</code>
      </h3>
      <div className="cost-detail-grid">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Model role</th>
                <th scope="col" className="num">
                  Calls
                </th>
                <th scope="col" className="num">
                  Tokens in / out
                </th>
                <th scope="col" className="num">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.role}>
                  <th scope="row">{label(r.role)}</th>
                  <td className="num">{number(r.calls)}</td>
                  <td className="num">
                    {number(r.inputTokens)} / {number(r.outputTokens)}
                  </td>
                  <td className="num">
                    <RoleUsd role={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Endpoint</th>
                <th scope="col" className="num">
                  Credits
                </th>
              </tr>
            </thead>
            <tbody>
              {endpoints.length ? (
                endpoints.map(([name, value]) => (
                  <tr key={name}>
                    <th scope="row">
                      <code>{name}</code>
                    </th>
                    <td className="num">{number(value)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2} className="muted">
                    No credits recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

type PlanState = { status: "loading" } | { status: "ready"; plan: unknown } | { status: "missing" } | { status: "error"; error: string };

function CfoPlan() {
  const [plan, setPlan] = useState<PlanState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    loadEconomicsPlan(controller.signal)
      .then((raw) => {
        if (!controller.signal.aborted) setPlan(raw === undefined ? { status: "missing" } : { status: "ready", plan: raw });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setPlan({ status: "error", error: e.message });
      });
    return () => controller.abort();
  }, []);
  return (
    <div className="cost-detail">
      <h3>Business plan</h3>
      {plan.status === "loading" ? (
        <p className="muted" role="status">
          Reading the published plan…
        </p>
      ) : plan.status === "error" ? (
        <p className="text-unsafe" role="alert">
          {plan.error}
        </p>
      ) : plan.status === "missing" ? (
        <p className="muted">
          No business plan is published (<code>{PUBLISHED_FILES.economics}</code>). The figures above come from the run
          bundles alone.
        </p>
      ) : (
        <>
          <p className="muted">Shown as published; no shared schema exists for this file yet.</p>
          <Json value={plan.plan} />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------ connections

function Connections() {
  const { mode, hosted, error, ready } = useDataSource();
  const { health, recheckHealth } = useShellStatus();
  const latest = latestHealth(health);
  return (
    <section className="section" id="connections" aria-labelledby="connections-title">
      <div className="section-head">
        <div>
          <h2 id="connections-title">Connections</h2>
          <p>What the local server reports for each integration, and the exact fix for anything missing.</p>
        </div>
        {mode === "live" && (
          <Button variant="outline" size="sm" onClick={recheckHealth} disabled={health.state === "checking"}>
            {health.state === "checking" ? "Checking…" : "Check again"}
          </Button>
        )}
      </div>
      {!ready ? (
        <p className="muted" role="status">
          Looking for a local server…
        </p>
      ) : mode !== "live" ? (
        <div className="notice">
          <p>
            Live integrations aren't available in replay. This page is reading published, hash-verified files.
          </p>
          {hosted ? (
            <p className="muted">
              This hosted build always replays and never connects to a local server. To go live, clone the repository,
              run <code>pnpm notary serve</code>, then <code>pnpm --filter @notary/web dev</code> and open the local
              page.
            </p>
          ) : (
            <p className="muted">
              To go live, run <code>pnpm notary serve</code> in the repository and reload this page.
            </p>
          )}
          {error && <p className="text-unsafe">{error}</p>}
        </div>
      ) : (
        <>
          {health.state === "unreachable" && (
            <p className="notice text-unsafe" role="alert">
              The local server stopped answering at {dateTime(health.checkedAt)}: {health.error} The states below are
              from the last successful check.
            </p>
          )}
          {latest ? (
            <div className="table-scroll">
              <table className="data-table stack">
                <thead>
                  <tr>
                    <th scope="col">Integration</th>
                    <th scope="col">State</th>
                    <th scope="col">Detail and fix</th>
                    <th scope="col">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.integrations.map((i) => (
                    <tr key={i.name}>
                      <th scope="row" translate="no">
                        {i.name}
                      </th>
                      <td data-label="State">
                        <StatusPill tone={integrationTone(i.state)}>{STATE_WORD[i.state]}</StatusPill>
                      </td>
                      <td data-label="Detail">
                        <p>{i.state === "error" && i.detail ? i.detail : i.label}</p>
                        {i.fix && (
                          <p className="fix">
                            <CodeText text={i.fix} />
                          </p>
                        )}
                      </td>
                      <td data-label="Checked" className="nowrap">
                        {dateTime(i.checkedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted" role="status">
              Checking the local server…
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------ receipts

function Receipts({ selected }: { selected?: RunBundle }) {
  const { evidence } = useData();
  const traces = selected ? runTraces(selected) : [];
  return (
    <section className="section" id="receipts" aria-labelledby="receipts-title">
      <div className="section-head">
        <div>
          <h2 id="receipts-title">Receipts</h2>
          <p>Traces of the selected run, review checkpoints, and the published tool evidence.</p>
        </div>
      </div>
      <div className="receipt-grid">
        <div className="panel">
          <h3 className="receipt-title">Traces{selected && <> of <code>{selected.runId}</code></>}</h3>
          {!selected ? (
            <p className="muted">No run is selected.</p>
          ) : !traces.length ? (
            <p className="muted">No trace ids recorded: tracing was off for this run.</p>
          ) : (
            <>
              <p className="muted">
                {traces[0]!.source === "traceLinks"
                  ? `${number(traces.length)} traces with a recorded receipt. Only http(s) receipts open as links.`
                  : `${number(traces.length)} trace ids on the run's records; no receipt was recorded for them.`}
              </p>
              <ul className="trace-list">
                {traces.map((t) => (
                  <li key={t.traceId}>
                    <TraceRefView traceId={t.traceId} recorded={t.recorded} />
                  </li>
                ))}
              </ul>
            </>
          )}
          <EvidenceStatus evidence={evidence} name="neatlogs" />
        </div>
        <div className="panel">
          <h3 className="receipt-title">Review checkpoints</h3>
          <p>
            Checkpoints recorded: <strong>none recorded</strong>.
          </p>
          <EvidenceStatus evidence={evidence} name="Entire" />
        </div>
      </div>
      <div className="cost-detail">
        <h3>Tool evidence</h3>
        {evidence.status === "loading" ? (
          <p className="muted" role="status">
            Reading the published evidence file…
          </p>
        ) : evidence.status === "error" ? (
          <p className="text-unsafe" role="alert">
            {evidence.error}
          </p>
        ) : evidence.status === "missing" ? (
          <p className="muted">
            No evidence file is published (<code>{PUBLISHED_FILES.evidence}</code>). It is built by{" "}
            <code>pnpm notary export --evidence</code>.
          </p>
        ) : (
          <ul className="evidence-list">
            {evidence.data.map((entry) => (
              <li key={entry.name}>
                <EvidenceEntryView entry={entry} headingLevel={4} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
