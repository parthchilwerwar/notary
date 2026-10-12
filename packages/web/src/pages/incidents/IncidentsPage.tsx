// /app/incidents: every incident Notary's agents ran into during published runs, grouped by run
// (newest first, as published), each tied to its neatlogs span and to how it was resolved. All of it
// comes from the published incidents file (see src/data/incidents.ts); counts are computed in
// ./model.ts. One cohort at a time: real runs, or fixture runs under ?fixtures=1 with the disclosure.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Incident, IncidentKind } from "../../../../core/src/schema";
import { ListMagnifyingGlassIcon as ListMagnifyingGlass } from "@phosphor-icons/react/dist/csr/ListMagnifyingGlass";
import { TestTubeIcon as TestTube } from "@phosphor-icons/react/dist/csr/TestTube";
import { SealWarningIcon as SealWarning } from "@phosphor-icons/react/dist/csr/SealWarning";
import { ArrowFatDownIcon as ArrowFatDown } from "@phosphor-icons/react/dist/csr/ArrowFatDown";
import { HandPalmIcon as HandPalm } from "@phosphor-icons/react/dist/csr/HandPalm";
import { ProhibitIcon as Prohibit } from "@phosphor-icons/react/dist/csr/Prohibit";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { WarningOctagonIcon as WarningOctagon } from "@phosphor-icons/react/dist/csr/WarningOctagon";
import { GaugeIcon as Gauge } from "@phosphor-icons/react/dist/csr/Gauge";
import { HourglassIcon as Hourglass } from "@phosphor-icons/react/dist/csr/Hourglass";
import { RobotIcon as Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { WrenchIcon as Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { ArrowSquareOutIcon as ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CopyIcon as Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import {
  AgentBadge,
  EmptyState,
  Expander,
  FixtureNote,
  Note,
  Page,
  PageBody,
  PageHeader,
  PageSkeleton,
  Pills,
  Section,
  Stat,
  StatRow,
  StatusPill,
  usePageMotion,
  type StatusTone,
} from "../../ui";
import { INCIDENTS_FILE, loadIncidents, type IncidentsLoad } from "../../data/incidents";
import { fixturesRequested, FIXTURES_PARAM } from "../../app/links";
import { useOptionalData } from "../../app/catalog";
import { dateTime } from "../../lib/time";
import {
  ACTION_LABEL,
  KIND_LABEL,
  KINDS,
  SEVERITIES,
  SEVERITY_LABEL,
  STATUSES,
  STATUS_LABEL,
  buildView,
  isFiltered,
  kindLabel,
  matches,
  parseFilter,
  relatedLinks,
  runLink,
  shortId,
  traceCell,
  type IncidentFilter,
  type IncidentStats,
  type IncidentsView,
  type RunView,
  type ViewContext,
} from "./model";
import "./incidents.css";

export const INCIDENTS_DESCRIPTION =
  "What went wrong while the agents worked, where it happened in neatlogs, and how it was resolved.";

/** One icon per incident kind (typed against the schema enum: a new kind is a type error). */
export const KIND_ICON: Record<IncidentKind, typeof Prohibit> = {
  checker_anomaly: ListMagnifyingGlass,
  probe_contradiction: TestTube,
  belief_unlearned: SealWarning,
  adversary_downgrade: ArrowFatDown,
  guard_hold: HandPalm,
  guard_block: Prohibit,
  unsafe_action_prevented: ShieldCheck,
  unsafe_action_executed: WarningOctagon,
  budget_stop: Gauge,
  rate_limited: Hourglass,
  model_error: Robot,
  tool_error: Wrench,
};

export type IncidentsPageState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; load: Extract<IncidentsLoad, { status: "ready" }> };

export function IncidentsPage() {
  const [params] = useSearchParams();
  // The bundles the data layer hash-verified in this browser: the only basis for "Matches the
  // published bundle" (the bundle index alone is not verified here).
  const data = useOptionalData();
  const ctx = useMemo<ViewContext>(() => (data && !data.loading && !data.error ? { bundles: data.bundles } : {}), [data?.loading, data?.error, data?.bundles]);
  const [state, setState] = useState<IncidentsPageState>({ status: "loading" });
  useEffect(() => {
    const ac = new AbortController();
    loadIncidents({ signal: ac.signal })
      .then((load) => setState(load.status === "missing" ? { status: "missing" } : { status: "ready", load }))
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setState({ status: "error", message: (e as Error).message || "The incidents file could not be read." });
      });
    return () => ac.abort();
  }, []);
  return <IncidentsContent state={state} params={params} ctx={ctx} />;
}

/** The page for a given load state and query string (pure; render tests use it directly). */
export function IncidentsContent({ state, params, ctx }: { state: IncidentsPageState; params: URLSearchParams; ctx?: ViewContext }) {
  const fixtures = fixturesRequested(params);
  const view = state.status === "ready" ? buildView(state.load, fixtures, ctx) : undefined;
  const root = usePageMotion([state.status, view?.cohort]);
  if (state.status === "loading") return <PageSkeleton label="Loading incidents…" stats={4} />;
  return (
    <Page ref={root} className="incidents">
      <PageHeader title="Incidents" summary={INCIDENTS_DESCRIPTION} />
      <PageBody>
        {state.status === "error" ? (
          <EmptyState tone="error" title="Incidents withheld">
            <p>The published incidents file could not be read or does not match the shared schema, so nothing is shown.</p>
            <p className="inc-detail">{state.message}</p>
          </EmptyState>
        ) : state.status === "missing" ? (
          <NothingPublished />
        ) : (
          view && <Ready view={view} params={params} />
        )}
      </PageBody>
    </Page>
  );
}

function NothingPublished() {
  return (
    <EmptyState title="No incidents published yet">
      <p>
        Incidents are derived by code from a real run's records and published with <code>pnpm notary export</code> after the
        run (to <code>{INCIDENTS_FILE}</code>).
      </p>
    </EmptyState>
  );
}

function filterPath(params: URLSearchParams, patch: Record<string, string | null>) {
  const next = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  const q = next.toString();
  return q ? `/app/incidents?${q}` : "/app/incidents";
}

function Ready({ view, params }: { view: IncidentsView; params: URLSearchParams }) {
  const { stats, runs, cohort } = view;
  const filter = parseFilter(params);
  const fixtureBanner = cohort === "fixture" ? <FixtureNote className="inc-fixture" /> : null;

  if (view.withheld)
    return (
      <>
        {fixtureBanner}
        <EmptyState tone="error" title="Incidents withheld">
          <p>The published incidents index failed its integrity check in this browser, so none of its incidents are shown.</p>
          <p className="inc-detail">{view.withheld}</p>
        </EmptyState>
      </>
    );

  if (!runs.length)
    return (
      <>
        {fixtureBanner}
        {cohort === "fixture" ? (
          <EmptyState title="No fixture incidents published">
            The fixture view lists incidents of <code>sample: true</code> runs only, and none are published.
          </EmptyState>
        ) : view.otherCohortRuns > 0 ? (
          <EmptyState
            title="No incidents from real runs published yet"
            action={<Link to={filterPath(new URLSearchParams(), { [FIXTURES_PARAM]: "1" })}>Open the fixture view</Link>}
          >
            <p>
              Only fixture incidents are published ({view.otherCohortRuns} {view.otherCohortRuns === 1 ? "run" : "runs"}). Real
              runs are published with <code>pnpm notary export</code> after a real run.
            </p>
          </EmptyState>
        ) : (
          <NothingPublished />
        )}
      </>
    );

  const kindsPresent = KINDS.filter((k) => stats.byKind[k]);
  return (
    <>
      {fixtureBanner}
      {view.groups.length <= 1 ? (
        <Counts stats={stats} label={cohort === "fixture" ? `Fixture incident counts${view.groups[0] ? ` · ${view.groups[0].label}` : ""}` : "Incident counts"} />
      ) : (
        // Fixture scenarios are separate worlds: one row of counts per scenario, never a sum.
        view.groups.map((g) => (
          <div key={g.key} className="inc-world">
            <h3 className="ui-title ui-title-card inc-world-title">{g.label}</h3>
            <Counts stats={g.stats} label={`Incident counts · ${g.label}`} />
          </div>
        ))
      )}
      <p className="inc-quiet inc-count-note">
        An incident listed under more than one run (same id) counts once.
        {view.replays.length > 0 && (
          <>
            {" "}
            {view.replays.length} {view.replays.length === 1 ? "replay is" : "replays are"} not listed (
            {view.replays.map((r, i) => (
              <span key={r.runId}>
                {i > 0 && ", "}
                <code>{r.runId}</code>
                {r.replayOf ? <> — Replay of <code>{r.replayOf}</code></> : " — Replay"}
              </span>
            ))}
            ): a replay re-serves its original run's recording, so its incidents are the original run's.
          </>
        )}
      </p>

      <Section
        aria-label="Incidents by run"
        title="By run"
        description={`${runs.length} ${runs.length === 1 ? "run" : "runs"}, newest first. Every incident is derived by code from the run's records, never by a model.`}
      >
        {stats.total > 0 && (
          <div className="inc-filters">
            <Pills
              label="Filter by resolution"
              items={[
                { key: "all", label: "All", to: filterPath(params, { status: null }), current: !filter.status, count: stats.total },
                ...STATUSES.map((s) => ({
                  key: s,
                  label: STATUS_LABEL[s],
                  to: filterPath(params, { status: s }),
                  current: filter.status === s,
                  count: stats.byStatus[s],
                })),
              ]}
            />
            <Pills
              label="Filter by severity"
              items={[
                { key: "all", label: "Any severity", to: filterPath(params, { severity: null }), current: !filter.severity },
                ...SEVERITIES.map((s) => ({
                  key: s,
                  label: SEVERITY_LABEL[s],
                  to: filterPath(params, { severity: s }),
                  current: filter.severity === s,
                  count: stats.bySeverity[s],
                })),
              ]}
            />
            {kindsPresent.length > 1 && (
              <Pills
                label="Filter by kind"
                items={[
                  { key: "all", label: "Every kind", to: filterPath(params, { kind: null }), current: !filter.kind },
                  ...kindsPresent.map((k) => ({
                    key: k,
                    label: KIND_LABEL[k],
                    to: filterPath(params, { kind: k }),
                    current: filter.kind === k,
                    count: stats.byKind[k],
                  })),
                ]}
              />
            )}
          </div>
        )}
        <div className="inc-runs">
          {runs.map((run) => (
            <RunGroup key={run.runId} run={run} filter={filter} />
          ))}
        </div>
      </Section>
    </>
  );
}

function Counts({ stats, label }: { stats: IncidentStats; label: string }) {
  return (
    <StatRow label={label}>
      <Stat
        label="Incidents"
        value={stats.total}
        note={`${stats.errors} ${stats.errors === 1 ? "error" : "errors"} · ${stats.warnings} ${stats.warnings === 1 ? "warning" : "warnings"}`}
      />
      <Stat label="Resolved" value={stats.resolved} of={`of ${stats.total}`} />
      <Stat label="Awaiting a human" value={stats.awaitingHuman} />
      <Stat label="Open" value={stats.open} />
    </StatRow>
  );
}

function RunCheckLine({ run }: { run: RunView }) {
  const c = run.check;
  switch (c.state) {
    case "verified":
      return (
        <StatusPill tone="safe" className="inc-check">
          <span title={`contentHash ${c.bundleHash}, recomputed in this browser`}>Matches the published bundle</span>
        </StatusPill>
      );
    case "listed":
      return (
        <StatusPill tone="neutral" className="inc-check">
          <span title={`contentHash ${c.entry.contentHash} (bundle index; the bundle itself is not loaded here)`}>Listed in the bundle index</span>
        </StatusPill>
      );
    case "unpublished":
      return <StatusPill tone="neutral">Bundle not published</StatusPill>;
    default:
      return null;
  }
}

function RunProblem({ run }: { run: RunView }) {
  const c = run.check;
  const n = run.incidents.length;
  const withheld = `${n} ${n === 1 ? "incident" : "incidents"} withheld.`;
  if (c.state === "mismatch")
    return (
      <Note tone="error" role="alert" className="inc-run-note">
        <p>Incidents were derived from a different bundle than the one published. {withheld}</p>
        <p className="inc-hashes">
          Published <code title={c.indexHash}>{shortId(c.indexHash, 12, 6)}</code> · derived from{" "}
          <code title={c.bundleHash}>{shortId(c.bundleHash, 12, 6)}</code>
        </p>
      </Note>
    );
  if (c.state === "world_mismatch")
    return (
      <Note tone="error" role="alert" className="inc-run-note">
        The published bundle of this run belongs to a different data world (real vs fixture). {withheld}
      </Note>
    );
  if (run.foreign > 0)
    return (
      <Note tone="error" role="alert" className="inc-run-note">
        {run.foreign} {run.foreign === 1 ? "incident names" : "incidents name"} a different run than this file. {withheld}
      </Note>
    );
  if (c.state === "unchecked")
    return (
      <Note tone="warning" className="inc-run-note">
        Could not check these incidents against the published bundle: {c.reason}
      </Note>
    );
  return null;
}

function RunGroup({ run, filter }: { run: RunView; filter: IncidentFilter }) {
  const shown = run.shown ? run.incidents.filter((i) => matches(i, filter)) : [];
  const linkable = run.check.state !== "unpublished";
  const n = run.incidents.length;
  return (
    <section className="inc-run" aria-label={`Run ${run.runId}`} data-reveal>
      <header className="inc-run-head">
        <h3 className="ui-title ui-title-card inc-run-title">
          {linkable ? (
            <Link to={runLink(run.runId)}>
              <code>{run.runId}</code>
            </Link>
          ) : (
            <code>{run.runId}</code>
          )}
        </h3>
        <p className="inc-run-meta">
          <span>
            {n} {n === 1 ? "incident" : "incidents"}
          </span>
          {run.sources.length > 0 && <span>from {run.sources.join(", ")}</span>}
          <RunCheckLine run={run} />
        </p>
      </header>
      <RunProblem run={run} />
      {run.shown &&
        (n === 0 ? (
          <p className="inc-quiet">Nothing went wrong in this run.</p>
        ) : shown.length === 0 ? (
          <p className="inc-quiet">{isFiltered(filter) ? "No incident in this run matches the filters." : "No incidents."}</p>
        ) : (
          <ul className="inc-list" aria-label={`${shown.length} incidents in ${run.runId}`}>
            {shown.map((i) => (
              <IncidentRow key={i.id} incident={i} linkable={linkable} />
            ))}
          </ul>
        ))}
    </section>
  );
}

const STATUS_TONE: Record<Incident["resolution"]["status"], StatusTone> = {
  resolved: "safe",
  awaiting_human: "held",
  open: "unsafe",
};

function IncidentRow({ incident: i, linkable }: { incident: Incident; linkable: boolean }) {
  const KindIcon = KIND_ICON[i.kind];
  const facts = i.data ? Object.entries(i.data) : [];
  return (
    <li className="inc-item" data-severity={i.severity} data-status={i.resolution.status} data-kind={i.kind}>
      <span className="inc-icon" data-severity={i.severity} aria-hidden="true">
        <KindIcon size={20} weight="regular" />
      </span>
      <div className="inc-body">
        <p className="inc-top">
          <span className="inc-kind">{kindLabel(i)}</span>
          <StatusPill tone={i.severity === "error" ? "unsafe" : "neutral"}>{SEVERITY_LABEL[i.severity]}</StatusPill>
          <time className="inc-time" dateTime={i.at}>
            {dateTime(i.at)}
          </time>
        </p>
        <p className="inc-summary">{i.summary}</p>
        {(i.agent || i.tool) && (
          <p className="inc-meta">
            {i.agent && <AgentBadge agent={i.agent} />}
            {i.tool && (
              <span>
                <span className="inc-k">Tool </span>
                {i.tool}
              </span>
            )}
          </p>
        )}

        <div className="inc-resolution">
          <p className="inc-res-head">
            <StatusPill tone={STATUS_TONE[i.resolution.status]}>{STATUS_LABEL[i.resolution.status]}</StatusPill>
            <span className="inc-action">{ACTION_LABEL[i.resolution.action]}</span>
            {i.resolution.at && (
              <time className="inc-time" dateTime={i.resolution.at}>
                {dateTime(i.resolution.at)}
              </time>
            )}
          </p>
          <p className="inc-res-summary">{i.resolution.summary}</p>
        </div>

        <div className="inc-foot">
          <TraceView incident={i} />
          <span className="inc-links">
            {relatedLinks(i).map((l) =>
              linkable || l.key === "approvals" ? (
                <Link key={l.key} className="ui-record-chip" to={l.to}>
                  <span>{l.kind}</span>
                  {l.label}
                </Link>
              ) : (
                <code key={l.key} className="ui-record-chip" data-unknown title="Bundle not published">
                  <span>{l.kind}</span>
                  {l.label}
                </code>
              ),
            )}
          </span>
        </div>

        <Expander summary="Records" className="inc-records">
          <dl className="inc-facts">
            <div>
              <dt>Incident</dt>
              <dd>
                <code>{i.id}</code>
              </dd>
            </div>
            {i.recordIds.length > 0 && (
              <div>
                <dt>About</dt>
                <dd>
                  <code>{i.recordIds.join(", ")}</code>
                </dd>
              </div>
            )}
            {i.resolution.recordIds.length > 0 && (
              <div>
                <dt>Resolved by</dt>
                <dd>
                  <code>{i.resolution.recordIds.join(", ")}</code>
                </dd>
              </div>
            )}
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt>{k.replaceAll("_", " ")}</dt>
                <dd>{v === null ? "Not recorded" : String(v)}</dd>
              </div>
            ))}
          </dl>
        </Expander>
      </div>
    </li>
  );
}

function TraceView({ incident }: { incident: Incident }) {
  const cell = traceCell(incident);
  if (cell.kind === "none") return <span className="inc-trace inc-quiet">No trace id recorded</span>;
  if (cell.kind === "link")
    return (
      <span className="inc-trace">
        <a className="inc-neatlogs" href={cell.url} target="_blank" rel="noopener noreferrer">
          Open in neatlogs
          <ArrowSquareOut size={14} weight="regular" aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        {!cell.exported && <span className="inc-quiet">local span only (not exported to neatlogs)</span>}
      </span>
    );
  return (
    <span className="inc-trace">
      <span className="inc-k-vis">Trace</span>
      <TraceId id={cell.traceId} />
      {!cell.exported && <span className="inc-quiet">local span only (not exported to neatlogs)</span>}
    </span>
  );
}

function TraceId({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () => {
    const done = (s: "copied" | "failed") => {
      setState(s);
      setTimeout(() => setState("idle"), 1600);
    };
    const clip = globalThis.navigator?.clipboard;
    if (!clip) return done("failed");
    clip.writeText(id).then(
      () => done("copied"),
      () => done("failed"),
    );
  };
  return (
    <span className="inc-trace-id">
      <code title={id}>{shortId(id)}</code>
      <button type="button" className="inc-copy" onClick={copy} aria-label={`Copy trace id ${id}`}>
        {state === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <span className="sr-only" role="status">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Could not copy" : ""}
      </span>
    </span>
  );
}
