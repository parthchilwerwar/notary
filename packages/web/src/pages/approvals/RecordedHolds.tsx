// Replay only: the held decisions of the visible recorded runs, one row per run, one list per data
// world. Visible = real runs, or fixture runs under the development-only ?fixtures=1 view (whose
// page header already carries the fixture disclosure); held decisions of hidden runs are never
// listed or counted. Derived from the hash-verified bundles useData() already holds (the same rule
// as ReplaySource.approvals: decisions with status "held"), so no other world's bundle is fetched,
// and each fixture scenario is its own list: worlds never mix in one table or count.
import { Link } from "react-router";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { EmptyState, ReplayBadge, Section } from "../../ui";
import { number, worldLabel } from "../../data";
import { heldApprovals } from "../../data/replay";
import { useData } from "../../app/catalog";
import { liveFirst, replayBadge, withRun } from "../../app/links";
import { byWorld } from "./model";

export function RecordedHolds() {
  const { bundles, selectedRunId } = useData();
  const worlds = byWorld(liveFirst(bundles))
    .map((w) => {
      const pending = heldApprovals(w.runs);
      const perRun = new Map<string, number>();
      for (const item of pending) perRun.set(item.runId, (perRun.get(item.runId) ?? 0) + 1);
      return { key: w.key, pending: pending.length, runs: [...perRun] };
    })
    .filter((w) => w.runs.length > 0);
  if (!worlds.length)
    return (
      <Section aria-labelledby="recorded-holds" title={<span id="recorded-holds">Held in recorded runs</span>}>
        <EmptyState title="Nothing waiting for review.">No recorded run held a money action for a human.</EmptyState>
      </Section>
    );
  return (
    <>
      {worlds.map((w) => (
        <Section
          key={w.key}
          aria-labelledby={`recorded-holds-${w.key}`}
          title={
            <span id={`recorded-holds-${w.key}`}>
              Held in recorded runs{w.key === "real" ? "" : ` · ${worldLabel(w.key)}`}
            </span>
          }
          description={`${number(w.pending)} held ${w.pending === 1 ? "decision" : "decisions"} across ${number(w.runs.length)} ${w.runs.length === 1 ? "run" : "runs"}`}
        >
          <ul className="desk-runs" aria-label={`Recorded runs with held decisions (${worldLabel(w.key)})`}>
            {w.runs.map(([runId, count]) => {
              const selected = runId === selectedRunId;
              const replay = replayBadge(bundles.find((b) => b.runId === runId), bundles);
              return (
                <li key={runId} className="desk-run" data-selected={selected || undefined} aria-current={selected ? "true" : undefined}>
                  {selected ? (
                    <span className="desk-run-id">
                      <CheckCircle className="desk-run-icon" size={16} weight="regular" aria-hidden="true" />
                      <span>{runId}</span>
                      {replay && <ReplayBadge>{replay}</ReplayBadge>}
                      <span className="desk-run-tag">Selected · listed below</span>
                    </span>
                  ) : (
                    <Link className="desk-run-id" to={withRun("/app/approvals", runId)}>
                      <ArrowRight className="desk-run-icon" size={16} weight="regular" aria-hidden="true" />
                      <span>{runId}</span>
                      {replay && <ReplayBadge>{replay}</ReplayBadge>}
                    </Link>
                  )}
                  <span className="desk-run-count">
                    <span className="num-display">{number(count)}</span> <span className="desk-run-unit">held</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
    </>
  );
}
