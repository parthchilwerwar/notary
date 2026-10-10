import "./record-pages.css";
import type { RunBundle } from "../../core/src/schema";
import { Panel } from "./Overview";
import { Comparison } from "./Comparison";
import { safeLink } from "./data";
import { FixtureBanner } from "./components/ui/fixture-banner";
import { StatusPill } from "./components/ui/status-pill";
import { EmptyState, ErrorState, LoadingState } from "./components/ui/states";
import type { EvidenceEntry, Loadable } from "./state/DataProvider";
import { scenarioKey } from "./state/data-mode";

/**
 * Naive and guarded fixture queue runs from the same simulated world (shared runId prefix).
 * The selected run's own scenario comes first, so the page never shows a different world's
 * comparison when the selected run has one.
 */
export function fixturePair(all: RunBundle[], prefer?: RunBundle) {
  const preferKey = prefer?.sample ? scenarioKey(prefer.runId) : undefined;
  const runs = all
    .filter((b) => b.sample && b.kind === "run")
    .sort(
      (a, b) =>
        Number(scenarioKey(b.runId) === preferKey) -
          Number(scenarioKey(a.runId) === preferKey) ||
        b.startedAt.localeCompare(a.startedAt),
    );
  for (const guarded of runs.filter((b) => b.variant === "guarded")) {
    const naive = runs.find(
      (b) =>
        b.variant === "naive" &&
        scenarioKey(b.runId) === scenarioKey(guarded.runId),
    );
    if (naive) return { guarded, naive };
  }
  return undefined;
}

export function Evidence({
  all,
  evidence,
  selected,
}: {
  all: RunBundle[];
  evidence: Loadable<EvidenceEntry[]>;
  /** The selected run; its fixture scenario is preferred for the demo comparison. */
  selected?: RunBundle;
}) {
  const entries = evidence.status === "ready" ? evidence.data : [];
  const pair = fixturePair(all, selected);
  return (
    <>
      <section className="evidence-section">
        <div className="section-heading">
          <h2>Required tools</h2>
          <p>
            Integration receipts. Status comes from the published evidence file.
          </p>
        </div>
        {evidence.status === "loading" ? (
          <LoadingState title="Loading integration receipts…">
            Reading the published evidence file.
          </LoadingState>
        ) : evidence.status === "error" ? (
          <ErrorState title="Integration receipts withheld">
            {evidence.error}
          </ErrorState>
        ) : evidence.status === "missing" ? (
          <EmptyState title="No evidence file published">
            Integration receipts are published to <code>evidence/evidence.json</code>{" "}
            by <code>pnpm notary export --evidence</code>.
          </EmptyState>
        ) : (
        <div className="tool-grid">
          {["neatlogs", "Entire", "cfo.ai"].map((name) => {
            const entry = entries.find(
              (e) => e.name.toLowerCase() === name.toLowerCase(),
            );
            return (
              <Panel key={name} title={name}>
                <StatusPill
                  value={entry?.status ?? "pending"}
                  tone={entry?.status === "live" ? "safe" : "neutral"}
                >
                  {entry?.status ?? "Pending"}
                </StatusPill>
                <p className="tool-purpose">{entry?.purpose ?? "Pending"}</p>
                {entry?.notes && (
                  <details className="record-details">
                    <summary>Evidence and limitations</summary>
                    <p>{entry.notes}</p>
                  </details>
                )}
                <div className="tool-links">
                  {entry?.links.map((link) =>
                    safeLink(link.url) ? (
                      <a
                        key={link.url}
                        href={safeLink(link.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {link.label} ↗
                      </a>
                    ) : (
                      <span key={link.url}>{link.label}</span>
                    ),
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
        )}
      </section>
      <section className="evidence-section">
        <div className="section-heading">
          <h2>Fixture demo</h2>
          <p>Simulated APIs, kept separate from integration evidence above.</p>
        </div>
        {pair ? (
          <>
            <FixtureBanner variant="inline" />
            <p className="world-note">
              Scenario {scenarioKey(pair.guarded.runId)}: {pair.guarded.runId} against{" "}
              {pair.naive.runId}
              {selected?.sample && scenarioKey(selected.runId) !== scenarioKey(pair.guarded.runId)
                ? ` (the selected run ${selected.runId} has no naive/guarded pair of its own)`
                : ""}
              .
            </p>
            <Comparison bundle={pair.guarded} comparison={pair.naive} />
          </>
        ) : (
          <Panel title="Fixture comparison unavailable">
            <p>
              No naive and guarded fixture bundles from the same simulated world
              are published.
            </p>
          </Panel>
        )}
      </section>
    </>
  );
}
