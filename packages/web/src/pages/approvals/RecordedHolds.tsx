// Replay only: the held decisions of every recorded run, from DataSource.approvals() (the list the
// sidebar counts), grouped by cohort. Fixture runs are labelled and never share a list with real ones.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ApprovalsList } from "../../../../core/src/schema";
import { Card, EmptyState, FixtureNote, Section, Skeleton } from "../../ui";
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
      <div role="status" aria-live="polite">
        <span className="sr-only">Reading held decisions of the recorded runs…</span>
        <Skeleton shape="block" />
      </div>
    );
  if (state.status === "error")
    return (
      <EmptyState tone="error" title="Held decisions withheld">
        <p>The recorded runs’ held decisions could not be read. Re-export the runs with <code>pnpm notary export</code>.</p>
        <p className="desk-muted">{state.error}</p>
      </EmptyState>
    );
  const perRun = new Map<string, number>();
  for (const item of state.list.pending) perRun.set(item.runId, (perRun.get(item.runId) ?? 0) + 1);
  const sampleOf = (runId: string) => bundles.find((b) => b.runId === runId)?.sample;
  const groups = [false, true]
    .map((sample) => ({ sample, runs: [...perRun].filter(([runId]) => sampleOf(runId) === sample) }))
    .filter((g) => g.runs.length);
  return (
    <Section
      aria-labelledby="recorded-holds"
      title={<span id="recorded-holds">Held in recorded runs</span>}
      description={`${number(state.list.pending.length)} held decisions across ${number(perRun.size)} runs`}
    >
      {!groups.length ? (
        <EmptyState title="Nothing waiting for review.">No recorded run held a money action for a human.</EmptyState>
      ) : (
        groups.map((g) => (
          <div className="desk-cohort" key={String(g.sample)}>
            {g.sample && <FixtureNote />}
            <ul className="desk-runs" aria-label={g.sample ? "Fixture runs with held decisions" : "Real runs with held decisions"}>
              {g.runs.map(([runId, count]) => (
                <li key={runId}>
                  <Card padding="sm" className="desk-run" data-selected={runId === selectedRunId || undefined}>
                    {runId === selectedRunId ? (
                      <span className="desk-run-id">
                        {runId} <span className="desk-muted">(selected, listed below)</span>
                      </span>
                    ) : (
                      <Link className="desk-run-id" to={withRun("/app/approvals", runId)}>
                        {runId}
                      </Link>
                    )}
                    <span className="desk-run-count">
                      {number(count)} <span>held</span>
                    </span>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </Section>
  );
}
