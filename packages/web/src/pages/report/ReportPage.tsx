// /app/report (sidebar footer): naive vs guarded within one world, cost per run, connections to
// the live integrations, and receipts (neatlogs traces, Entire checkpoints, tool evidence). Full-page
// layout: header, stat row, then full-width sections. Only one cohort is ever loaded (real runs, or
// fixture runs under the development-only ?fixtures=1, whose header carries the disclosure).
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { RunBundle } from "../../../../core/src/schema";
import {
  Button,
  DitherChart,
  EmptyState,
  Expander,
  NoRunsYet,
  Page,
  PageBody,
  PageHeader,
  PageSkeleton,
  ReplayBadge,
  Section,
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
import { NO_RUNS_COMMANDS, REPLAY_SPEND_TEXT, isReplayRun, recordPath, replayBadge, withRun } from "../../app/links";
import { dateTime } from "../../lib/time";
import {
  byWorld,
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
import { EntireSection } from "./EntireSection";
import "./report.css";

export function ReportPage() {
  const { loading, error, bundles, bundle, fixtures } = useData();
  const pair = loading || error ? undefined : pickPair(comparisonPairs(bundles), bundle);
  const root = usePageMotion([pair?.world, loading]);
  if (loading) return <PageSkeleton label="Verifying bundle integrity…" />;
  const rows = pair ? comparisonRows(pair) : [];
  const unsafe = rows.find((r) => r.key === "unsafe_actions_total");
  const holds = rows.find((r) => r.key === "holds");
  return (
    <Page ref={root} className="report">
      <PageHeader
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
        ) : !bundles.length ? (
          fixtures ? (
            <EmptyState title="No fixture runs published">
              The fixture view lists <code>sample: true</code> bundles only, and none are published.
            </EmptyState>
          ) : (
            <NoRunsYet commands={NO_RUNS_COMMANDS} />
          )
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

function Comparison({
  bundles,
  pair,
  rows,
}: {
  bundles: RunBundle[];
  pair?: ComparisonPair;
  rows: MetricRow[];
}) {
  const others = comparisonPairs(bundles).filter((p) => p.world !== pair?.world);
  return (
    <Section
      id="comparison"
      aria-labelledby="comparison-title"
      title={<span id="comparison-title">Naive vs guarded</span>}
      description="The same queue of money requests, run once without Notary and once with it. Same world only."
    >
      {!pair ? (
        <EmptyState title="Nothing to compare yet">
          No seed has both a naive and a guarded queue run yet. Run both variants with <code>pnpm notary run</code>, then{" "}
          <code>pnpm notary export</code>.
        </EmptyState>
      ) : (
        <>
          <figure className="report-figure" data-reveal>
            <figcaption className="report-figure-title">Money actions by request type</figcaption>
            <DitherChart rows={actionsByType(pair.naive, pair.guarded)} />
          </figure>
          <p className="report-note">
            From <Link to={recordPath.run(pair.naive.runId)}>{pair.naive.runId}</Link> and{" "}
            <Link to={recordPath.run(pair.guarded.runId)}>{pair.guarded.runId}</Link>, graded by deterministic code from each
            run’s recorded effects. Missing values are shown as missing, never as zero.
          </p>
          <Expander summary="Show every metric">
            <PairTable pair={pair} rows={rows} />
          </Expander>
        </>
      )}
      {others.length > 0 && (
        <p className="report-note">
          Other comparisons:{" "}
          {others.map((p, i) => (
            <span key={p.world}>
              {i > 0 && ", "}
              <Link to={withRun("/app/report", p.guarded.runId)}>
                {p.sample ? `fixture scenario ${p.world.slice("fixture:".length)}` : `seed ${p.world.slice(5)}`}
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

/** The "Cost per run" section (exported for render tests). */
export function Costs({ bundles, selected }: { bundles: RunBundle[]; selected?: RunBundle }) {
  const cohorts = byWorld(bundles);
  return (
    <Section
      id="cost"
      aria-labelledby="cost-title"
      title={<span id="cost-title">Cost per run</span>}
      description="API credits and model spend as each run recorded them. A model cost with no recorded price is unknown, not $0. Credits are never converted to dollars. A replay re-serves its original run's recording, so it adds no spend."
    >
      {!cohorts.length && (
        <EmptyState title="No runs published">
          Publish runs with <code>pnpm notary export</code>.
        </EmptyState>
      )}
      {cohorts.map((g) => (
        <div className="report-cohort" key={g.key}>
          <div className="report-cohort-head">
            <h3 className="report-cohort-title">
              {g.label} <span>{number(g.runs.length)}</span>
            </h3>
            {g.cohort === "synthetic" && <p className="report-cohort-note">{g.runs[0]!.disclosure[0] ?? "Synthetic sample data"}</p>}
          </div>
          <TableFrame className="report-runs">
            <table>
              <caption className="sr-only">{g.label}: cost per run</caption>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Mode</th>
                  <th scope="col" className="num">
                    Credits used
                  </th>
                  <th scope="col" className="num">
                    Credit budget
                  </th>
                  <th scope="col" className="num">
                    Model spend
                  </th>
                  <th scope="col" className="num">
                    Model calls
                  </th>
                </tr>
              </thead>
              <tbody>
                {g.runs.map((b) => {
                  const cost = runCost(b);
                  const current = b.runId === selected?.runId;
                  const replay = isReplayRun(b);
                  return (
                    <tr key={b.runId} data-selected={current || undefined} aria-current={current ? "true" : undefined}>
                      <th scope="row">
                        <Link className="report-run-id" to={recordPath.run(b.runId)}>
                          {b.runId}
                        </Link>
                      </th>
                      <td className="report-run-kind">
                        {b.kind}
                        {b.variant !== b.kind && ` / ${b.variant}`}
                      </td>
                      <td className="report-run-mode">
                        {replay ? (
                          <ReplayBadge>{replayBadge(b, bundles)}</ReplayBadge>
                        ) : (
                          "Live"
                        )}
                      </td>
                      {replay ? (
                        <td className="report-replay-spend" colSpan={4}>
                          {REPLAY_SPEND_TEXT}
                          {b.replayOf && (
                            <>
                              {" "}
                              (spend is on{" "}
                              <Link className="report-run-id" to={recordPath.run(b.replayOf)}>
                                {b.replayOf}
                              </Link>
                              )
                            </>
                          )}
                        </td>
                      ) : (
                        <>
                          <td className="num">{number(cost.creditsUsed)}</td>
                          <td className="num report-muted">{number(cost.creditsBudget)}</td>
                          <td className="num">
                            <UsdText cost={cost} />
                          </td>
                          <td className="num">{number(cost.calls)}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableFrame>
        </div>
      ))}
      {selected && (
        <div className="report-more">
          {isReplayRun(selected) ? (
            <p className="report-note">
              {selected.runId} is a replay
              {selected.replayOf ? (
                <>
                  {" "}
                  of{" "}
                  <Link className="report-run-id" to={recordPath.run(selected.replayOf)}>
                    {selected.replayOf}
                  </Link>
                </>
              ) : null}
              . {REPLAY_SPEND_TEXT}; the original run holds the real cost.
            </p>
          ) : (
            <Expander summary={<>Show costs by role and endpoint for {selected.runId}</>}>
              <SelectedCost bundle={selected} />
            </Expander>
          )}
          <Expander summary="Business plan">
            <CfoPlan />
          </Expander>
        </div>
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
      <div className="report-connections" data-reveal>
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
      </div>
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
        <div className="report-receipt" data-reveal>
          <h3 className="report-receipt-title">Traces</h3>
          {!selected ? (
            <p className="report-note">No run is selected.</p>
          ) : !traces.length ? (
            <p className="report-note">No trace id recorded on {selected.runId}.</p>
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
        </div>
        <div className="report-receipt" data-reveal>
          <h3 className="report-receipt-title">Review checkpoints</h3>
          <EntireSection />
          <EvidenceStatus evidence={evidence} name="Entire" />
        </div>
      </div>
      <div className="report-more">
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
      </div>
    </Section>
  );
}
