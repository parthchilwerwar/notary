// /app/report (sidebar footer): naive vs guarded within one world, cost per run, connections to
// the live integrations, and receipts (neatlogs traces, Entire checkpoints, tool evidence).
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { RunBundle } from "../../../../core/src/schema";
import {
  BrowserFrame,
  Button,
  Card,
  DitherChart,
  EmptyState,
  Expander,
  FixtureNote,
  Page,
  PageBody,
  PageSkeleton,
  Section,
  SkyBand,
  Stat,
  StatRow,
  StatusPill,
  TableFrame,
  Json,
  usePageMotion,
} from "../../ui";
import { AGENTS, type AgentId } from "../../../../core/src/schema/agents";
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
import { actionsByType } from "../../landing-data";
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
  const pair = loading || error ? undefined : pickPair(comparisonPairs(bundles), bundle);
  const root = usePageMotion([pair?.world, loading]);
  if (loading) return <PageSkeleton label="Verifying bundle integrity…" />;
  const rows = pair ? comparisonRows(pair) : [];
  const unsafe = rows.find((r) => r.key === "unsafe_actions_total");
  const holds = rows.find((r) => r.key === "holds");
  return (
    <Page ref={root} className="report">
      <SkyBand
        title="Report"
        summary={
          pair
            ? `Same queue, two agents: ${unsafe?.naive ?? "unrecorded"} unsafe actions without Notary, ${unsafe?.guarded ?? "unrecorded"} with it`
            : "Comparison, cost per run, connections and receipts"
        }
        action={
          pair ? (
            <Button asChild>
              <Link to={recordPath.run(pair.guarded.runId)}>Open the guarded run</Link>
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        {error ? (
          <EmptyState tone="error" title="Runs withheld">
            <p>A published run failed its integrity check in this browser, so the comparison and costs are not shown.</p>
            <p className="report-detail">{error}</p>
          </EmptyState>
        ) : (
          <>
            {pair && (
              <StatRow label="Naive vs guarded">
                <Stat label="Unsafe actions without Notary" value={unsafe?.naive ?? null} />
                <Stat label="Unsafe actions with Notary" value={unsafe?.guarded ?? null} />
                <Stat label="Held for a person" value={holds?.guarded ?? null} />
              </StatRow>
            )}
            <Comparison bundles={bundles} pair={pair} rows={rows} />
            <Costs bundles={bundles} selected={bundle} />
          </>
        )}
        <Connections />
        <Receipts selected={error ? undefined : bundle} />
      </PageBody>
    </Page>
  );
}

/// ------------------------------------------------------------------------------ comparison

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

function Comparison({ bundles, pair, rows }: { bundles: RunBundle[]; pair?: ComparisonPair; rows: MetricRow[] }) {
  const others = comparisonPairs(bundles).filter((p) => p.world !== pair?.world);
  return (
    <Section
      id="comparison"
      aria-labelledby="comparison-title"
      label="Proof"
      title={<span id="comparison-title">Naive vs guarded</span>}
      description="The same queue of money requests, run once without Notary and once with it. Same world only."
    >
      {!pair ? (
        <EmptyState title="Nothing to compare yet">
          No world has both a naive and a guarded queue run. Real runs pair by seed; fixture runs pair by scenario. Run
          both variants with <code>pnpm notary run</code>.
        </EmptyState>
      ) : (
        <>
          {pair.sample && <FixtureNote />}
          <BrowserFrame className="report-chart" title="Money actions by request type" tag={pair.sample ? "Fixture data" : undefined}>
            <DitherChart rows={actionsByType(pair.naive, pair.guarded)} />
          </BrowserFrame>
          <p className="report-note">
            From <Link to={recordPath.run(pair.naive.runId)}>{pair.naive.runId}</Link> and{" "}
            <Link to={recordPath.run(pair.guarded.runId)}>{pair.guarded.runId}</Link>, graded by deterministic code from each
            run’s recorded effects. Missing values are shown as missing, never as zero.
          </p>
          <Card data-reveal>
            <Expander summary="Show every metric">
              <PairTable pair={pair} rows={rows} />
            </Expander>
          </Card>
        </>
      )}
      {others.length > 0 && (
        <p className="report-note">
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
    </Section>
  );
}

function PairTable({ pair, rows }: { pair: ComparisonPair; rows: MetricRow[] }) {
  return (
    <TableFrame>
      <table>
        <caption className="sr-only">
          Naive run {pair.naive.runId} compared with guarded run {pair.guarded.runId}
        </caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col" className="num">
              Without Notary
            </th>
            <th scope="col" className="num">
              With Notary
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
              <td className={`num ${r.unsafe && r.naive ? "report-unsafe" : ""}`}>{formatMetric(r.naive, r.format)}</td>
              <td className={`num ${r.unsafe && r.guarded ? "report-unsafe" : ""}`}>{formatMetric(r.guarded, r.format)}</td>
              <td className="num">{formatDelta(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

// ------------------------------------------------------------------------------ costs

function UsdText({ cost }: { cost: ReturnType<typeof runCost> }) {
  if (cost.calls === 0 && cost.unknownRoles.length === 0) return <>{usd(0)}</>;
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
  if (role.price === "none") return <>No calls</>;
  if (role.price === "unknown") return <>Unknown, no price recorded</>;
  return <>{usd(role.usd)}</>;
}

function Costs({ bundles, selected }: { bundles: RunBundle[]; selected?: RunBundle }) {
  const cohorts = byCohort(bundles);
  return (
    <Section
      id="cost"
      aria-labelledby="cost-title"
      title={<span id="cost-title">Cost per run</span>}
      description="API credits and model spend as each run recorded them. A model cost with no recorded price is unknown, not $0. Credits are never converted to dollars."
    >
      {!cohorts.length && (
        <EmptyState title="No runs published">
          Publish runs with <code>pnpm notary export</code>.
        </EmptyState>
      )}
      {cohorts.map((g) => (
        <div className="report-cohort" key={String(g.sample)}>
          {g.sample && <FixtureNote />}
          <ul className="report-runs" aria-label={g.sample ? "Fixture runs: cost per run" : "Real runs: cost per run"}>
            {g.runs.map((b) => {
              const cost = runCost(b);
              return (
                <li key={b.runId}>
                  <Card padding="sm" className="report-run" data-selected={b.runId === selected?.runId || undefined}>
                    <Link className="report-run-id" to={recordPath.run(b.runId)}>
                      {b.runId}
                    </Link>
                    <span className="report-run-kind">
                      {b.kind}
                      {b.variant !== b.kind && ` / ${b.variant}`}
                    </span>
                    <span className="report-run-figure">
                      {number(cost.creditsUsed)} <span>of {number(cost.creditsBudget)} credits</span>
                    </span>
                    <span className="report-run-figure">
                      <UsdText cost={cost} /> <span>{number(cost.calls)} model calls</span>
                    </span>
                  </Card>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {selected && (
        <Card data-reveal className="report-more">
          <Expander summary={<>Show costs by role and endpoint for {selected.runId}</>}>
            <SelectedCost bundle={selected} />
          </Expander>
          <Expander summary="Business plan">
            <CfoPlan />
          </Expander>
        </Card>
      )}
    </Section>
  );
}

function SelectedCost({ bundle }: { bundle: RunBundle }) {
  const roles = roleCosts(bundle);
  const endpoints = Object.entries(bundle.credits.byEndpoint);
  return (
    <div className="report-split">
      <TableFrame>
        <table>
          <caption className="sr-only">Model usage by role, {bundle.runId}</caption>
          <thead>
            <tr>
              <th scope="col">Role</th>
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
                <th scope="row">{AGENTS[r.role as AgentId]?.name ?? label(r.role)}</th>
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
      </TableFrame>
      <TableFrame>
        <table>
          <caption className="sr-only">Credits by endpoint, {bundle.runId}</caption>
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
                <td colSpan={2}>No credits recorded.</td>
              </tr>
            )}
          </tbody>
        </table>
      </TableFrame>
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
  if (plan.status === "loading")
    return (
      <p className="report-note" role="status">
        Reading the published plan…
      </p>
    );
  if (plan.status === "error")
    return (
      <p className="report-unsafe" role="alert">
        The published plan could not be read: {plan.error}
      </p>
    );
  if (plan.status === "missing")
    return (
      <p className="report-note">
        No business plan is published (<code>{PUBLISHED_FILES.economics}</code>). The figures above come from the run bundles
        alone.
      </p>
    );
  return (
    <>
      <p className="report-note">Shown as published; no shared schema exists for this file yet.</p>
      <Json value={plan.plan} />
    </>
  );
}

// ------------------------------------------------------------------------------ connections

function Connections() {
  const { mode, hosted, error, ready } = useDataSource();
  const { health, recheckHealth } = useShellStatus();
  const latest = latestHealth(health);
  return (
    <Section
      id="connections"
      aria-labelledby="connections-title"
      title={<span id="connections-title">Connections</span>}
      description="What the local server reports for each integration, and the exact fix for anything missing."
      actions={
        mode === "live" ? (
          <Button variant="secondary" size="sm" onClick={recheckHealth} disabled={health.state === "checking"}>
            {health.state === "checking" ? "Checking…" : "Check again"}
          </Button>
        ) : undefined
      }
    >
      <Card data-reveal className="report-connections">
        {!ready ? (
          <p className="report-note" role="status">
            Looking for a local server…
          </p>
        ) : mode !== "live" ? (
          <div className="report-offline">
            <p>Live integrations aren’t checked in replay. This page reads published, hash-verified files.</p>
            {hosted ? (
              <p className="report-note">
                This hosted build always replays and never connects to a local server. To go live, clone the repository,
                run <code>pnpm notary serve</code>, then <code>pnpm --filter @notary/web dev</code> and open the local page.
              </p>
            ) : (
              <p className="report-note">
                Start the server to see live connections: run <code>pnpm notary serve</code> in the repository and reload
                this page.
              </p>
            )}
            {error && <p className="report-note">{error}</p>}
          </div>
        ) : (
          <>
            {health.state === "unreachable" && (
              <p className="report-unsafe" role="alert">
                The local server stopped answering at {dateTime(health.checkedAt)}. Restart <code>pnpm notary serve</code>;
                the states below are from the last successful check.
              </p>
            )}
            {latest ? (
              <ul className="report-conn-list">
                {latest.integrations.map((i) => (
                  <li key={i.name}>
                    <span className="report-conn-name" translate="no">
                      {i.name}
                    </span>
                    <StatusPill tone={integrationTone(i.state)}>{STATE_WORD[i.state]}</StatusPill>
                    <span className="report-conn-detail">
                      {i.state === "error" && i.detail ? i.detail : i.label}
                      {i.fix && (
                        <span className="report-conn-fix">
                          Fix: <CodeText text={i.fix} />
                        </span>
                      )}
                    </span>
                    <span className="report-conn-time">{dateTime(i.checkedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="report-note" role="status">
                Checking the local server…
              </p>
            )}
          </>
        )}
      </Card>
    </Section>
  );
}

// ------------------------------------------------------------------------------ receipts

function Receipts({ selected }: { selected?: RunBundle }) {
  const { evidence } = useData();
  const traces = selected ? runTraces(selected) : [];
  return (
    <Section
      id="receipts"
      aria-labelledby="receipts-title"
      title={<span id="receipts-title">Receipts</span>}
      description="neatlogs traces of the selected run, Entire review checkpoints, and the published tool evidence."
    >
      <div className="report-receipts">
        <Card data-reveal className="report-receipt">
          <h3 className="ui-title ui-title-card">Traces</h3>
          {!selected ? (
            <p className="report-note">No run is selected.</p>
          ) : !traces.length ? (
            <p className="report-note">No trace ids recorded: tracing was off for {selected.runId}.</p>
          ) : (
            <>
              <p className="report-note">
                {traces[0]!.source === "traceLinks"
                  ? `${number(traces.length)} traces of ${selected.runId} with a recorded receipt. Only http(s) receipts open as links.`
                  : `${number(traces.length)} trace ids on ${selected.runId}’s records; no receipt was recorded for them.`}
              </p>
              <Expander summary={`Show ${number(traces.length)} traces`}>
                <ul className="report-traces">
                  {traces.map((t) => (
                    <li key={t.traceId}>
                      <TraceRefView traceId={t.traceId} recorded={t.recorded} />
                    </li>
                  ))}
                </ul>
              </Expander>
            </>
          )}
          <EvidenceStatus evidence={evidence} name="neatlogs" />
        </Card>
        <Card data-reveal className="report-receipt">
          <h3 className="ui-title ui-title-card">Review checkpoints</h3>
          <p>
            Entire checkpoints recorded: <strong>none recorded</strong>.
          </p>
          <EvidenceStatus evidence={evidence} name="Entire" />
        </Card>
      </div>
      <Card data-reveal>
        <Expander summary="Tool evidence">
          {evidence.status === "loading" ? (
            <p className="report-note" role="status">
              Reading the published evidence file…
            </p>
          ) : evidence.status === "error" ? (
            <p className="report-unsafe" role="alert">
              The evidence file could not be read: {evidence.error}
            </p>
          ) : evidence.status === "missing" ? (
            <p className="report-note">
              No evidence file is published (<code>{PUBLISHED_FILES.evidence}</code>). It is built by{" "}
              <code>pnpm notary export --evidence</code>.
            </p>
          ) : (
            <ul className="report-evidence">
              {evidence.data.map((entry) => (
                <li key={entry.name}>
                  <EvidenceEntryView entry={entry} headingLevel={4} />
                </li>
              ))}
            </ul>
          )}
        </Expander>
      </Card>
    </Section>
  );
}
