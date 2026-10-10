// Adapted from UIAble block-statistics-1. MIT (c) 2026 CodedThemes; see docs/CREDITS.md.
import type { RunBundle } from "../../../../core/src/schema";
import { Card } from "../ui/card";
import { number, percent, usd } from "../../data";
import { totalUsd } from "../../analytics";
export function ResultsStrip({
  naive,
  guarded,
}: {
  naive?: RunBundle;
  guarded?: RunBundle;
}) {
  const metrics = [
    {
      name: "Unsafe money actions",
      value: (b: RunBundle) =>
        b.metrics.unsafe_actions_total == null
          ? "Not computable"
          : number(b.metrics.unsafe_actions_total),
      safety: true,
    },
    {
      name: "Decision accuracy",
      value: (b: RunBundle) =>
        b.metrics.decision_accuracy == null
          ? "Not computable"
          : percent(b.metrics.decision_accuracy),
    },
    {
      name: "Automation rate",
      value: (b: RunBundle) =>
        b.metrics.automation_rate == null
          ? "Not computable"
          : percent(b.metrics.automation_rate),
    },
    {
      name: "Credits consumed",
      value: (b: RunBundle) => number(b.credits.total),
    },
  ];
  return (
    <>
      <div className="results-strip">
        {metrics.map((metric) => (
          <Card className="result-tile" key={metric.name}>
            <h3>{metric.name}</h3>
            <div className="result-values">
              {[
                { name: "Naive", bundle: naive },
                { name: "Guarded", bundle: guarded },
              ].map((row) => (
                <div key={row.name}>
                  <span>{row.name}</span>
                  <strong className={metric.safety ? "safety-value" : ""}>
                    {row.bundle ? metric.value(row.bundle) : "Pending"}
                  </strong>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
      <div className="result-provenance">
        {[naive, guarded]
          .filter((b): b is RunBundle => !!b)
          .map((b) => (
            <p key={b.runId}>
              <strong>{b.runId}</strong>
              <span>Model USD {usd(totalUsd(b))} · hash verified</span>
              <code title={b.contentHash}>{b.contentHash.slice(0, 12)}…</code>
            </p>
          ))}
      </div>
      <p className="chart-note">
        Recorded outcomes, not a claim of live causation. API credits are
        separate from model USD.
      </p>
    </>
  );
}
