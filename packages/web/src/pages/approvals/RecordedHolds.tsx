// Replay only: the held decisions of every recorded run, from DataSource.approvals() (the list the
// sidebar counts), grouped by cohort. Fixture runs are labelled and never share a table with real ones.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ApprovalsList } from "../../../../core/src/schema";
import { FixtureBanner } from "../../components/ui";
import { number } from "../../data";
import { useData } from "../../app/catalog";
import { withRun } from "../../app/links";

type State = { status: "loading" } | { status: "ready"; list: ApprovalsList } | { status: "error"; error: string };

export function RecordedHolds() {
  const { dataSource, bundles, selectedRunId } = useData();
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    dataSource
      .approvals(controller.signal)
      .then((list) => !controller.signal.aborted && setState({ status: "ready", list }))
      .catch((e: Error) => !controller.signal.aborted && setState({ status: "error", error: e.message }));
    return () => controller.abort();
  }, [dataSource]);
  if (state.status === "loading")
    return (
      <p className="muted" role="status">
        Reading held decisions of the recorded runs…
      </p>
    );
  if (state.status === "error")
    return (
      <p className="text-unsafe" role="alert">
        {state.error}
      </p>
    );
  const perRun = new Map<string, number>();
  for (const item of state.list.pending) perRun.set(item.runId, (perRun.get(item.runId) ?? 0) + 1);
  const sampleOf = (runId: string) => bundles.find((b) => b.runId === runId)?.sample;
  const groups = [false, true]
    .map((sample) => ({ sample, runs: [...perRun].filter(([runId]) => sampleOf(runId) === sample) }))
    .filter((g) => g.runs.length);
  return (
    <section className="desk-section" aria-labelledby="recorded-holds">
      <div className="desk-section-head">
        <h2 id="recorded-holds">Held in recorded runs</h2>
        <span className="muted">{number(state.list.pending.length)} held decisions</span>
      </div>
      {!groups.length ? (
        <p className="muted">No recorded run held a money action for a human.</p>
      ) : (
        groups.map((g) => (
          <div className="desk-cohort" key={String(g.sample)}>
            {g.sample && <FixtureBanner variant="inline" />}
            <div className="table-scroll">
              <table className="data-table">
                <caption className="sr-only">{g.sample ? "Fixture runs" : "Real runs"} with held decisions</caption>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col" className="num">
                      Held
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {g.runs.map(([runId, count]) => (
                    <tr key={runId} data-highlight={runId === selectedRunId ? "true" : undefined}>
                      <th scope="row">
                        {runId === selectedRunId ? (
                          <span>
                            {runId} <span className="muted">(selected, listed below)</span>
                          </span>
                        ) : (
                          <Link to={withRun("/app/approvals", runId)}>{runId}</Link>
                        )}
                      </th>
                      <td className="num">{number(count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
