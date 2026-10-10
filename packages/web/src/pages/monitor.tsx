// Monitor group: Overview, Runs (+ run detail), Probe log (+ probe detail).
// Mission control lives in ./mission-control/.
import { Link, useNavigate, useParams } from "react-router";
import { Overview } from "../Overview";
import { Comparison } from "../Comparison";
import { ProbeLog, ProbeRecord } from "../ProbeLog";
import { SelectControl } from "../components/SelectControl";
import { ArrowsLeftRightIcon as CompareIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import {
  Button,
  Card,
  EmptyState,
  FixtureBanner,
  KpiCard,
  PageHeader,
  StatusPill,
} from "../components/ui";
import { useData } from "../state/DataProvider";
import { recordPath, scenarioKey, withRun } from "../state/data-mode";
import { date, label, number, percent } from "../data";
import { RecordNotFound, useBundle, useRunPath } from "./shared";
import type { BundleIndexEntry, RunBundle } from "../../../core/src/schema";

export function OverviewPage() {
  const bundle = useBundle();
  const { baseline, bundles } = useData();
  const path = useRunPath();
  return (
    <>
      <PageHeader
        title="Overview"
        description="Money, decisions and trust for the selected run."
        actions={
          <Button variant="outline" asChild>
            <Link to={path("/app/runs", { baseline: baseline?.runId })}>
              Compare runs
            </Link>
          </Button>
        }
      />
      <Overview bundle={bundle} comparison={baseline} all={bundles} />
    </>
  );
}

function RunTable({
  title,
  runs,
  selected,
}: {
  title: string;
  runs: BundleIndexEntry[];
  selected?: string;
}) {
  return (
    <Card className="table-card">
      <div className="table-card-head">
        <h2>{title}</h2>
        <span className="muted">{number(runs.length)} runs</span>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Kind</th>
              <th>Mode</th>
              <th>Status</th>
              <th>Started (IST)</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.runId}
                aria-current={r.runId === selected ? "true" : undefined}
              >
                <td>
                  <Link to={withRun(recordPath.run(r.runId), selected)}>
                    {r.runId}
                  </Link>
                </td>
                <td>
                  {r.kind} / {r.variant}
                </td>
                {/* Fixture runs record mode "live" against simulated APIs; never show that bare. */}
                <td title={`Recorded mode: ${r.mode}`}>
                  {r.sample ? `fixture · ${r.mode}` : r.mode}
                </td>
                <td>
                  <StatusPill value={r.status} />
                </td>
                <td>{date(r.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function RunsPage() {
  const bundle = useBundle();
  const { runGroups, baseline, baselineCandidates, setBaseline } = useData();
  return (
    <>
      <PageHeader
        title="Runs"
        description="Every published run, and the selected run against a same-cohort baseline."
        actions={
          <label className="inline-label">
            Compare with
            <SelectControl
              icon={<CompareIcon size={16} />}
              aria-label="Compare with"
              value={baseline?.runId ?? ""}
              disabled={!baselineCandidates.length}
              onChange={(e) => setBaseline(e.target.value)}
            >
              {!baselineCandidates.length && (
                <option value="">No same-cohort baseline</option>
              )}
              {baselineCandidates.map((b) => (
                <option key={b.runId} value={b.runId}>
                  {label(b.variant)} · {b.runId}
                </option>
              ))}
            </SelectControl>
          </label>
        }
      />
      <Comparison bundle={bundle} comparison={baseline} />
      <div className="run-tables">
        {runGroups.map((g) => (
          <section key={g.kind} className="evidence-section">
            {g.kind === "fixture" && !bundle.sample && (
              <FixtureBanner variant="inline" />
            )}
            <RunTable title={g.label} runs={g.runs} selected={bundle.runId} />
          </section>
        ))}
      </div>
    </>
  );
}

export function RunDetailPage() {
  const { runId = "" } = useParams();
  const { bundles, bundle: selected } = useData();
  const navigate = useNavigate();
  const run = bundles.find((b) => b.runId === runId);
  if (!run)
    return (
      <EmptyState
        title={`Run ${runId} is not published`}
        actions={
          <Button asChild>
            <Link to={withRun("/app/runs", selected?.runId)}>All runs</Link>
          </Button>
        }
      >
        No hash-verified bundle with this run id is in the catalog.
      </EmptyState>
    );
  const m = run.metrics;
  return (
    <>
      {run.sample && !selected?.sample && <FixtureBanner variant="inline" />}
      <PageHeader
        eyebrow={`${run.kind} / ${run.variant} · ${run.sample ? "fixture" : run.mode}`}
        title={run.runId}
        description={`Started ${date(run.startedAt)} IST${run.finishedAt ? ` · finished ${date(run.finishedAt)} IST` : ""}`}
        actions={
          run.runId === selected?.runId ? (
            <StatusPill tone="info">Selected run</StatusPill>
          ) : (
            <Button onClick={() => navigate(withRun("/app", run.runId))}>
              Select this run
            </Button>
          )
        }
      />
      <div className="kpi-grid kpi-grid-3">
        <KpiCard label="Decisions" value={number(run.decisions.length)} />
        <KpiCard label="Probes" value={number(run.probes.length)} />
        <KpiCard
          label="Beliefs after run"
          value={number(run.beliefs.after.length)}
        />
        <KpiCard
          label="Unsafe actions"
          value={
            m.unsafe_actions_total == null
              ? null
              : number(m.unsafe_actions_total)
          }
          note={
            m.decision_accuracy == null
              ? "Accuracy not computable"
              : `${percent(m.decision_accuracy)} decision accuracy`
          }
        />
        <KpiCard
          label="Credits"
          value={number(run.credits.total)}
          note={`of ${number(run.credits.budget)} budgeted`}
        />
        <KpiCard
          label="Guards"
          value={number(run.guards.length)}
          note={`${number(run.guards.filter((g) => g.active).length)} active`}
        />
      </div>
      <Card className="provenance-card">
        <h2>Provenance</h2>
        <dl className="fields">
          <div>
            <dt>Status</dt>
            <dd>
              <StatusPill value={run.status} />
              {run.stopReason ? ` · ${run.stopReason}` : ""}
            </dd>
          </div>
          <div>
            <dt>Content hash</dt>
            <dd>
              <code>{run.contentHash}</code> (recomputed in this browser)
            </dd>
          </div>
          <div>
            <dt>Seed</dt>
            <dd>{run.seed}</dd>
          </div>
          {run.tool && (
            <div>
              <dt>Tool</dt>
              <dd>{run.tool}</dd>
            </div>
          )}
          {run.priorsFrom && (
            <div>
              <dt>Priors from</dt>
              <dd>{run.priorsFrom}</dd>
            </div>
          )}
          <div>
            <dt>Disclosure</dt>
            <dd>
              {run.disclosure.length
                ? run.disclosure.join(" · ")
                : "None recorded"}
            </dd>
          </div>
          <div>
            <dt>Cassettes</dt>
            <dd>{run.cassettes.length ? run.cassettes.join(", ") : "None"}</dd>
          </div>
        </dl>
      </Card>
    </>
  );
}

export function ProbesPage() {
  const bundle = useBundle();
  const { bundles } = useData();
  // Same cohort only; runs from the selected run's own fixture scenario first.
  const own = (b: RunBundle) => scenarioKey(b.runId) === scenarioKey(bundle.runId);
  const withProbes = bundles
    .filter((b) => b.sample === bundle.sample && b.probes.length)
    .sort((a, b) => Number(own(b)) - Number(own(a)));
  return (
    <>
      <PageHeader
        title="Probe log"
        description="Predictions first. Observations second."
      />
      {bundle.probes.length ? (
        <ProbeLog key={bundle.runId} bundle={bundle} />
      ) : (
        <EmptyState
          title={`${bundle.runId} recorded no probes`}
          actions={withProbes.map((b) => (
            <Button variant="outline" asChild key={b.runId}>
              <Link to={withRun("/app/probes", b.runId)}>
                {b.runId} · {number(b.probes.length)} probes
              </Link>
            </Button>
          ))}
        >
          {bundle.kind === "run"
            ? "Queue runs do not probe; notarization runs do."
            : "This bundle has no committed experiments."}
          {withProbes.length
            ? " These runs from the same cohort have probes:"
            : ""}
        </EmptyState>
      )}
    </>
  );
}

export function ProbeDetailPage() {
  const { probeId = "" } = useParams();
  const bundle = useBundle();
  const probe = bundle.probes.find((p) => p.id === probeId);
  if (!probe)
    return (
      <RecordNotFound
        kind="Probe"
        id={probeId}
        listPath="/app/probes"
        find={(b) => b.probes.some((p) => p.id === probeId)}
      />
    );
  return (
    <>
      <PageHeader
        eyebrow={`Probe · ${probe.claimId}`}
        title={probe.id}
        description={`${label(probe.template)} · committed ${date(probe.committedAt)} IST`}
      />
      <ProbeRecord bundle={bundle} probe={probe} />
    </>
  );
}
