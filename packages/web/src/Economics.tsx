import "./record-pages.css";
import { useEffect, useState } from "react";
import type { RunBundle } from "../../core/src/schema";
import { CostBreakdown, Panel, Delta } from "./Overview";
import { totalUsd, unsafeDelta } from "./analytics";
import { number, usd } from "./data";
import { Segments } from "./charts";
import { Json } from "./components";
import { readOptionalJSON } from "./optional-json";

type PlanState =
  | { status: "loading" }
  | { status: "ready"; plan: unknown }
  | { status: "missing" }
  | { status: "error"; error: string };

export function Economics({
  bundle,
  comparison,
}: {
  bundle: RunBundle;
  comparison?: RunBundle;
}) {
  const [plan, setPlan] = useState<PlanState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    readOptionalJSON("economics.json", controller.signal)
      .then((raw) => {
        if (!controller.signal.aborted)
          setPlan(raw === undefined ? { status: "missing" } : { status: "ready", plan: raw });
      })
      .catch((e: Error) => {
        if (controller.signal.aborted) return;
        setPlan({
          status: "error",
          error:
            e instanceof SyntaxError
              ? "economics.json is not valid JSON. Plan withheld."
              : e.message,
        });
      });
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
          note={`${number(notarized)} notarized ${notarized === 1 ? "belief" : "beliefs"} after this run`}
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
          note={
            delta === null
              ? "No comparable baseline for this run"
              : `${bundle.runId} against baseline ${comparison!.runId}`
          }
        >
          <span className="kpi-value">
            {delta === null ? (
              "—"
            ) : delta === 0 ? (
              "0"
            ) : (
              <>
                {number(Math.abs(delta))}
                <span className="kpi-unit">{delta < 0 ? "fewer" : "more"}</span>
              </>
            )}
          </span>
          <Delta value={delta} safety />
          <p className="chart-note">
            {delta === null
              ? "This run or its baseline records no unsafe-action count, or no baseline from the same cohort is selected."
              : "Observed unsafe actions, not a causal incident valuation."}
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
        {plan.status === "loading" ? (
          <p className="economics-plan-state" role="status">
            Loading the cfo.ai plan…
          </p>
        ) : plan.status === "error" ? (
          <p className="economics-plan-state error-copy" role="alert">
            {plan.error}
          </p>
        ) : plan.status === "missing" ? (
          <p className="economics-plan-state">
            No cfo.ai plan is published yet (<code>economics.json</code>). The
            figures above come from the run bundle alone.
          </p>
        ) : (
          <Json value={plan.plan} />
        )}
      </Panel>
    </>
  );
}
