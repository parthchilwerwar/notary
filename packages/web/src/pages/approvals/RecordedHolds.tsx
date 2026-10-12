// Replay only: the held decisions of the visible recorded runs, from DataSource.approvals() (the
// list the sidebar counts), one row per run. Visible = real runs, or fixture runs under the
// development-only ?fixtures=1 view (whose page header already carries the fixture disclosure);
// held decisions of hidden runs are never listed or counted.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import type { ApprovalsList } from "../../../../core/src/schema";
import { EmptyState, Section, Skeleton } from "../../ui";
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
  const visible = new Set(bundles.map((b) => b.runId));
  const pending = state.list.pending.filter((item) => visible.has(item.runId));
  const perRun = new Map<string, number>();
  for (const item of pending) perRun.set(item.runId, (perRun.get(item.runId) ?? 0) + 1);
  const runs = [...perRun];
  return (
    <Section
      aria-labelledby="recorded-holds"
      title={<span id="recorded-holds">Held in recorded runs</span>}
      description={runs.length ? `${number(pending.length)} held ${pending.length === 1 ? "decision" : "decisions"} across ${number(runs.length)} ${runs.length === 1 ? "run" : "runs"}` : undefined}
    >
      {!runs.length ? (
        <EmptyState title="Nothing waiting for review.">No recorded run held a money action for a human.</EmptyState>
      ) : (
        <ul className="desk-runs" aria-label="Recorded runs with held decisions">
          {runs.map(([runId, count]) => {
            const selected = runId === selectedRunId;
            return (
              <li key={runId} className="desk-run" data-selected={selected || undefined} aria-current={selected ? "true" : undefined}>
                {selected ? (
                  <span className="desk-run-id">
                    <CheckCircle className="desk-run-icon" size={16} weight="regular" aria-hidden="true" />
                    <span>{runId}</span>
                    <span className="desk-run-tag">Selected · listed below</span>
                  </span>
                ) : (
                  <Link className="desk-run-id" to={withRun("/app/approvals", runId)}>
                    <ArrowRight className="desk-run-icon" size={16} weight="regular" aria-hidden="true" />
                    <span>{runId}</span>
                  </Link>
                )}
                <span className="desk-run-count">
                  <span className="num-display">{number(count)}</span> <span className="desk-run-unit">held</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
