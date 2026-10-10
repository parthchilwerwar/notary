import type { RunBundle } from "../../core/src/schema";
import { Bars } from "./charts";
import { Panel, Delta } from "./Overview";
import { comparable, totalUsd, unsafeDelta } from "./analytics";
import { Empty, Trace } from "./components";
import { number, percent, usd } from "./data";

/** Difference of two ratios in percentage points (rounded to 0.1), or null when either is missing. */
export function pointDelta(
  focus: number | null | undefined,
  baseline: number | null | undefined,
): number | null {
  if (focus == null || baseline == null) return null;
  return Math.round((focus - baseline) * 1000) / 10;
}

export function Comparison({
  bundle,
  comparison,
}: {
  bundle: RunBundle;
  comparison?: RunBundle;
}) {
  if (!comparison || !comparable(bundle, comparison))
    return (
      <Empty title="Choose a baseline">
        The compare picker only offers bundles from the same fixture or live
        cohort.
      </Empty>
    );
  const metrics = [
    { name: "Unsafe actions", key: "unsafe_actions_total", format: number },
    { name: "Decision accuracy", key: "decision_accuracy", format: percent },
    { name: "Automation rate", key: "automation_rate", format: percent },
  ];
  return (
    <>
      <div className="comparison-identities">
        <div>
          <span>Focus · solid fill</span>
          <h2>{bundle.runId}</h2>
        </div>
        <div>
          <span>Baseline · diagonal hatch</span>
          <h2>{comparison.runId}</h2>
        </div>
      </div>
      <div className="comparison-grid">
        {metrics.map((metric) => (
          <Panel
            key={metric.key}
            title={metric.name}
            note="Focus compared with the selected baseline"
          >
            <div className="kpi-line">
              <span className="kpi-value compact">
                {bundle.metrics[metric.key] == null
                  ? "—"
                  : metric.format(bundle.metrics[metric.key]!)}
              </span>
              {metric.key === "unsafe_actions_total" ? (
                <Delta value={unsafeDelta(bundle, comparison)} safety />
              ) : (
                <Delta
                  value={pointDelta(
                    bundle.metrics[metric.key],
                    comparison.metrics[metric.key],
                  )}
                  suffix=" pts"
                />
              )}
            </div>
            <Bars
              data={[
                {
                  name: metric.name,
                  value: bundle.metrics[metric.key] ?? null,
                  comparison: comparison.metrics[metric.key] ?? null,
                },
              ]}
              comparison
              focusName={bundle.runId}
              comparisonName={comparison.runId}
              unit={metric.key === "unsafe_actions_total" ? "" : "ratio"}
            />
            <p className="chart-note">
              Baseline:{" "}
              {comparison.metrics[metric.key] == null
                ? "Not computable"
                : metric.format(comparison.metrics[metric.key]!)}
              . Missing values are omitted, never plotted as zero.
            </p>
          </Panel>
        ))}
        <Panel title="Credits consumed">
          <div className="kpi-line">
            <span className="kpi-value compact">
              {number(bundle.credits.total)}
            </span>
            <Delta value={bundle.credits.total - comparison.credits.total} />
          </div>
          <Bars
            data={[
              {
                name: "Credits",
                value: bundle.credits.total,
                comparison: comparison.credits.total,
              },
            ]}
            comparison
            focusName={bundle.runId}
            comparisonName={comparison.runId}
          />
        </Panel>
        <Panel
          title="USD by model role"
          note={`Focus ${usd(totalUsd(bundle))} · baseline ${usd(totalUsd(comparison))}`}
          className="wide-card"
        >
          {(totalUsd(bundle) > 0 || totalUsd(comparison) > 0) && (
            <Bars
              data={Object.entries(bundle.usageByRole).map(([name, role]) => ({
                name,
                value: role.usd,
                comparison:
                  comparison.usageByRole[
                    name as keyof typeof comparison.usageByRole
                  ].usd,
              }))}
              comparison
              focusName={bundle.runId}
              comparisonName={comparison.runId}
              unit="USD"
            />
          )}
          <table className="data-table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Focus USD</th>
                <th>Baseline USD</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(bundle.usageByRole).map(([role, cost]) => (
                <tr key={role}>
                  <td>{role}</td>
                  <td>{usd(cost.usd)}</td>
                  <td>
                    {usd(
                      comparison.usageByRole[
                        role as keyof typeof comparison.usageByRole
                      ].usd,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <Panel
        title="Trace receipts"
        note="Only recorded links are used. Local receipts require the run files to be served."
      >
        <div className="trace-columns">
          {[bundle, comparison].map((run) => (
            <section key={run.runId}>
              <h3>{run.runId}</h3>
              {Object.keys(run.traceLinks).length ? (
                Object.keys(run.traceLinks).map((id) => (
                  <Trace key={id} bundle={run} traceId={id} />
                ))
              ) : (
                <p className="muted">
                  {run.probes.length
                    ? run.probes.map((p) => (
                        <Trace
                          key={p.id}
                          bundle={run}
                          traceId={p.traceId}
                          spanId={p.spanId}
                        />
                      ))
                    : run.decisions.length
                      ? [...new Set(run.decisions.map((d) => d.traceId))].map(
                          (id) => <Trace key={id} bundle={run} traceId={id} />,
                        )
                      : "No trace links or identifiers recorded."}
                </p>
              )}
            </section>
          ))}
        </div>
      </Panel>
    </>
  );
}
