import type { ReactNode } from "react";
import type { RunBundle } from "../../core/src/schema";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./components/ui/card";
import { Bars, Segments, StepTrend } from "./charts";
import {
  beliefBreakdown,
  comparable,
  insight,
  queueFlow,
  totalUsd,
  unsafeDelta,
} from "./analytics";
import { label, number, percent, usd } from "./data";

export function Panel({
  title,
  note,
  children,
  className = "",
}: {
  title: string;
  note?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`analytics-card ${className}`}>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        {note && <CardDescription>{note}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
export function Delta({
  value,
  safety = false,
  suffix = "",
}: {
  value: number | null;
  safety?: boolean;
  suffix?: string;
}) {
  return value === null ? null : (
    <span
      className={`delta ${safety && value < 0 ? "safe" : safety && value > 0 ? "unsafe" : "neutral"}`}
    >
      {value > 0 ? "+" : ""}
      {number(value)}
      {suffix} <span>vs baseline</span>
    </span>
  );
}
export function ProbesMatrix({ bundle }: { bundle: RunBundle }) {
  const groups = [...new Set(bundle.probes.map((p) => p.template))]
    .map((template) => ({
      template,
      probes: bundle.probes.filter((p) => p.template === template),
    }))
    .sort((a, b) => b.probes.length - a.probes.length);
  return groups.length ? (
    <div className="dot-matrix">
      {groups.map((group, i) => (
        <div key={group.template} className={i === 0 ? "most-used" : ""}>
          <div className="matrix-label">
            <span>{label(group.template)}</span>
            <strong>{number(group.probes.length)}</strong>
          </div>
          <div className="matrix-dots">
            {group.probes.map((probe) => (
              <span
                key={probe.id}
                title={`${probe.id} · ${probe.verdict ?? "pending"}`}
                aria-label={`${probe.id} ${probe.verdict ?? "pending"}`}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  ) : (
    <p className="muted">No probes were recorded in this bundle.</p>
  );
}
export function CostBreakdown({ bundle }: { bundle: RunBundle }) {
  return (
    <>
      <div className="cost-heading">
        <span className="kpi-value compact">{usd(totalUsd(bundle))}</span>
        <span>
          Recorded model USD
          <br />
          Credits are reported separately.
        </span>
      </div>
      <Bars
        data={Object.entries(bundle.usageByRole).map(([name, role]) => ({
          name: label(name),
          value: role.usd,
        }))}
        unit="USD"
      />
      <div className="endpoint-list">
        {Object.entries(bundle.credits.byEndpoint).map(([name, value]) => (
          <div key={name}>
            <code>{name}</code>
            <span>{number(value)} credits</span>
          </div>
        ))}
      </div>
    </>
  );
}
export function Overview({
  bundle,
  comparison,
  all,
}: {
  bundle: RunBundle;
  comparison?: RunBundle;
  all: RunBundle[];
}) {
  const delta = unsafeDelta(bundle, comparison);
  const unsafe = bundle.metrics.unsafe_actions_total;
  const probeSource = bundle.probes.length
    ? bundle
    : (all
        .filter(
          (b) =>
            comparable(bundle, b) && b.probes.length && b.kind === "notarize",
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? bundle);
  const trend = all
    .filter(
      (b) =>
        comparable(bundle, b) &&
        b.kind === "run" &&
        b.metrics.unsafe_actions_total != null,
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return (
    <div className="overview-grid">
      <Panel
        title="Unsafe money actions"
        note="Deterministically graded outcomes"
        className="safety-card"
      >
        <div className="kpi-line">
          <span className="kpi-value">
            {unsafe == null ? "—" : number(unsafe)}
          </span>
          <Delta value={delta} safety />
        </div>
        <p className="metric-context">
          {label(bundle.variant)}
          {comparison && (
            <>
              {" "}
              against {label(comparison.variant)}{" "}
              <strong>
                {comparison.metrics.unsafe_actions_total == null
                  ? "Not computable"
                  : number(comparison.metrics.unsafe_actions_total)}{" "}
                unsafe actions
              </strong>
            </>
          )}
        </p>
        {comparison ? (
          <Bars
            data={[
              {
                name: label(bundle.variant),
                value: unsafe ?? null,
                comparison: comparison.metrics.unsafe_actions_total ?? null,
              },
            ]}
            comparison
            focusName={bundle.runId}
            comparisonName={comparison.runId}
          />
        ) : (
          <p className="muted">Choose a baseline to compare safety.</p>
        )}
        <div className="legend">
          <span className="solid-key" />
          Selected run <span className="hatched-key" />
          Baseline
        </div>
      </Panel>
      <Panel
        title="Queue flow"
        note="Requests to decisions, then separate outcomes"
        className="funnel-card"
      >
        <div className="kpi-line">
          <span className="kpi-value">{number(bundle.queue.length)}</span>
          <span className="metric-context">requests in this run</span>
        </div>
        <Bars data={queueFlow(bundle)} funnel />
        <p className="chart-note">
          Executed, held and escalated are sibling outcomes. Drops compare
          adjacent counts, not conversion rates.
        </p>
      </Panel>
      <Panel
        title="Beliefs, by evidence"
        note={`${number(bundle.beliefs.after.length)} beliefs after this run`}
        className="breakdown-card"
      >
        <Segments rows={beliefBreakdown(bundle)} />
        <p className="chart-note">
          Matches and contradictions use the direction of P(documentation
          holds). Unsettled beliefs remain unresolved.
        </p>
      </Panel>
      <Panel
        title="Experimental coverage"
        note={`Probe source: ${probeSource.runId}`}
        className="probes-card"
      >
        <div className="kpi-line">
          <span className="kpi-value">{number(probeSource.probes.length)}</span>
          <span className="metric-context">committed probes</span>
        </div>
        <ProbesMatrix bundle={probeSource} />
        <p className="chart-note">
          One dot per probe. Blue marks the most-used template.
        </p>
      </Panel>
      <Panel
        title="Cost, without guesswork"
        note={`Cost source: ${bundle.runId}`}
        className="cost-card"
      >
        <CostBreakdown bundle={bundle} />
      </Panel>
      <Card className="analytics-card insight-card">
        <CardContent>
          <span className="insight-label">The takeaway</span>
          <h2>{insight(bundle, comparison)}</h2>
          <p>
            {bundle.sample
              ? "A controlled fixture comparison. These outcomes do not establish live API behavior."
              : "Recorded outcomes from these runs; the difference alone does not prove causation."}
          </p>
          <div className="insight-foot">
            {bundle.metrics.decision_accuracy == null
              ? "Accuracy not computable"
              : `${percent(bundle.metrics.decision_accuracy)} decision accuracy`}
            <span>Evidence before action.</span>
          </div>
        </CardContent>
      </Card>
      <Panel
        title="Safety across queue runs"
        note="A step line through recorded run outcomes; no interpolated observations"
        className="trend-card"
      >
        {trend.length ? (
          <StepTrend
            data={trend.map((b) => ({
              name: label(b.variant),
              value: b.metrics.unsafe_actions_total!,
            }))}
          />
        ) : (
          <p className="muted">No graded queue runs in this data cohort.</p>
        )}
      </Panel>
    </div>
  );
}
