import { SelectControl } from "./components/SelectControl";
import { FlaskIcon as Flask } from "@phosphor-icons/react/dist/csr/Flask";
import { useState } from "react";
import type { Probe, RunBundle } from "../../core/src/schema";
import { Empty, Json, RecordLinks, Status, Trace } from "./components";
import { Link } from "react-router";
import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { recordPath, withRun } from "./state/data-mode";
import { Panel, ProbesMatrix } from "./Overview";
import { date, label, number } from "./data";

export function ProbeRecord({
  bundle,
  probe,
  link = false,
}: {
  bundle: RunBundle;
  probe: Probe;
  link?: boolean;
}) {
  return (
    <Panel
      title={label(probe.template)}
      note={`${probe.id} · ${probe.claimId}`}
    >
      <div className="probe-meta">
        <span className="commit-stamp">
          Committed {date(probe.committedAt)} IST
        </span>
        <span>
          Call {probe.ranAt ? date(probe.ranAt) : "not recorded"}
        </span>
        <Status value={probe.verdict ?? "pending"} />
        <span>
          {number(probe.costCredits)} credits · {number(probe.calls)}{" "}
          calls
        </span>
      </div>
      <div className="experiment-grid">
        <section className="prediction-pane">
          <h3>Committed predictions</h3>
          {Object.entries(probe.prediction).map(([id, prediction]) => (
            <div
              key={id}
              className={`hypothesis ${probe.winningHypothesisId === id ? "winner" : ""}`}
            >
              <span>
                {probe.winningHypothesisId === id
                  ? "Winning hypothesis"
                  : "Rival hypothesis"}
              </span>
              <h4>
                {bundle.hypotheses.find((h) => h.id === id)?.statement ??
                  id}
              </h4>
              <Json value={prediction} />
            </div>
          ))}
          <code className="prediction-hash">
            Prediction hash: {probe.predictionHash}
          </code>
        </section>
        <section className="observed-pane">
          <h3>Observed after the call</h3>
          <Json value={probe.observed} />
          <h3>Control variant</h3>
          <Json value={probe.control?.observed} />
          {probe.ranAt &&
            new Date(probe.ranAt) <= new Date(probe.committedAt) && (
              <p className="error-copy">
                Timestamp order does not prove prediction preceded the
                call.
              </p>
            )}
        </section>
      </div>
      <details className="record-details">
        <summary>Parameters and trace receipt</summary>
        <Json
          value={{ params: probe.params, control: probe.control?.params }}
        />
        <Trace
          bundle={bundle}
          traceId={probe.traceId}
          spanId={probe.spanId}
        />
      </details>
      <div className="record-link-row">
        <RecordLinks bundle={bundle} beliefs={beliefsFor(bundle, probe.id)} />
        {link && (
          <Link to={withRun(recordPath.probe(probe.id), bundle.runId)}>
            Open probe record
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        )}
      </div>
    </Panel>
  );
}

const beliefsFor = (bundle: RunBundle, probeId: string) =>
  bundle.beliefs.after
    .filter((b) => b.evidence.some((e) => e.probeId === probeId))
    .map((b) => b.id);

export function ProbeLog({ bundle }: { bundle: RunBundle }) {
  const [template, setTemplate] = useState("all");
  const probes = [...bundle.probes]
    .sort((a, b) => a.committedAt.localeCompare(b.committedAt))
    .filter((p) => template === "all" || p.template === template);
  return (
    <>
      <Panel
        title="Prediction before the call"
        note="Each experiment commits rival predictions before recording an observation."
        className="probe-intro"
      >
        <ProbesMatrix bundle={bundle} />
      </Panel>
      <div className="section-toolbar">
        <p>{number(probes.length)} probes in view</p>
        <label className="inline-label">
          Template
          <SelectControl
            icon={<Flask size={16} />}
            aria-label="Filter probes by template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            <option value="all">All templates</option>
            {[...new Set(bundle.probes.map((p) => p.template))].map((t) => (
              <option key={t} value={t}>
                {label(t)}
              </option>
            ))}
          </SelectControl>
        </label>
      </div>
      <div className="probe-timeline">
        {probes.map((probe) => (
          <ProbeRecord key={probe.id} bundle={bundle} probe={probe} link />
        ))}
      </div>
      {!probes.length && (
        <Empty title="No probes in this run">
          Select a notarization bundle to inspect its committed experiments.
        </Empty>
      )}
    </>
  );
}
