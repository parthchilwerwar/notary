import { useEffect, useState } from "react";
import type { RunBundle } from "../../core/src/schema";
import { CostBreakdown, Panel, Delta } from "./Overview";
import { totalUsd, unsafeDelta } from "./analytics";
import { number, usd } from "./data";
import { Segments } from "./charts";
import { Json } from "./components";

export function Economics({
  bundle,
  comparison,
}: {
  bundle: RunBundle;
  comparison?: RunBundle;
}) {
  const [plan, setPlan] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}economics.json`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (r.ok && r.headers.get("content-type")?.includes("json"))
          setPlan(await r.json());
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const notarized = bundle.beliefs.after.filter(
    (b) => b.status === "notarized",
  ).length;
  const delta = unsafeDelta(bundle, comparison);
  return (
    <>
      <div className="economics-grid">
        <Panel
          title="Recorded model cost / run"
          note="API credits are not converted to USD"
        >
          <span className="kpi-value">{usd(totalUsd(bundle))}</span>
        </Panel>
        <Panel
          title="USD / notarized belief"
          note={`${number(notarized)} notarized beliefs in this run`}
        >
          <span className="kpi-value">
            {notarized ? usd(totalUsd(bundle) / notarized) : "—"}
          </span>
          {!notarized && (
            <p className="chart-note">
              No notarized beliefs; cost per belief is undefined.
            </p>
          )}
        </Panel>
        <Panel
          title="Unsafe action difference"
          note="Relative to the selected same-kind baseline"
        >
          <span className="kpi-value">
            {delta === null ? "—" : number(-delta)}
          </span>
          <Delta value={delta} safety />
          <p className="chart-note">
            Fewer observed unsafe actions, not a causal incident valuation.
          </p>
        </Panel>
      </div>
      <div className="two-column">
        <Panel title="USD by role & endpoint credits">
          <CostBreakdown bundle={bundle} />
        </Panel>
        <Panel
          title="Credit allocation"
          note={`${number(bundle.credits.total)} of ${number(bundle.credits.budget)} budgeted credits`}
        >
          <Segments
            rows={Object.entries(bundle.credits.byEndpoint).map(
              ([name, value]) => ({ name, value }),
            )}
          />
        </Panel>
      </div>
      <Panel
        title="cfo.ai plan"
        note="Business model and economics assumptions"
      >
        {plan === undefined ? (
          <p className="plan-pending">cfo.ai plan pending</p>
        ) : (
          <Json value={plan} />
        )}
      </Panel>
    </>
  );
}
