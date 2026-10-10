// Mission control: where the selected run stands, stage by stage, from its timeline.
//   Live     (local `notary serve`, real run) — the API's timeline plus the run's SSE events.
//   Replay   (hosted / static) — the published <runId>.timeline.json replayed event by event,
//            labelled "Fixture replay" (sample runs) or "Recorded replay" (real runs).
// Every number on screen is a count of, or a value carried by, the events shown so far.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import type { RunBundle, TimelineStage } from "../../../../core/src/schema";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusPill,
} from "../../components/ui";
import { useData } from "../../state/DataProvider";
import type { LiveStatus } from "../../state/live";
import { useBundle } from "../shared";
import {
  REPLAY_MAX_STEP_MS,
  REPLAY_MIN_STEP_MS,
  edgesForNewEvents,
  filterFeed,
  finishedStatus,
  firstBudgetSeq,
  latestBudget,
  nodeStates,
  stageStats,
  unsafeDecisionIds,
} from "./model";
import { useReplay, usePrefersReducedMotion, useRunTimeline, type TimelineLoad } from "./hooks";
import { StageGraph } from "./StageGraph";
import { EventFeed } from "./EventFeed";
import { BudgetMeters } from "./BudgetMeters";
import { ReplayControls } from "./ReplayControls";
import "./mission-control.css";

const LIVE_TEXT: Record<LiveStatus, string> = {
  connecting: "connecting…",
  open: "stream connected",
  reconnecting: "reconnecting…",
  unavailable: "stream unavailable",
  ended: "run finished",
};

/** How long an edge stays lit after a hand-off. */
const EDGE_LIT_MS = 1100;

export function MissionControlPage() {
  const bundle = useBundle();
  const { mode } = useData();
  const local = mode === "live";
  const reduced = usePrefersReducedMotion();
  const { load, events, live } = useRunTimeline(bundle, local);
  const replayLabel = bundle.sample ? "Fixture replay" : "Recorded replay";

  const replayEvents = useMemo(() => (local ? [] : events), [local, events]);
  const replay = useReplay(replayEvents, `${bundle.runId}:${bundle.contentHash}:${load.status}`, reduced);
  const visible = useMemo(
    () => (local ? events : events.slice(0, replay.cursor)),
    [local, events, replay.cursor],
  );

  const unsafe = useMemo(() => unsafeDecisionIds(bundle), [bundle]);
  const stats = useMemo(() => stageStats(visible, unsafe), [visible, unsafe]);
  const states = useMemo(() => nodeStates(visible, stats), [visible, stats]);
  const budget = useMemo(() => latestBudget(visible), [visible]);
  const finished = finishedStatus(visible);

  const [stage, setStage] = useState<TimelineStage | null>(null);
  useEffect(() => setStage(null), [bundle.runId]);
  const toggleStage = useCallback(
    (s: TimelineStage) => setStage((cur) => (cur === s ? null : s)),
    [],
  );
  const rows = useMemo(() => filterFeed(visible, stage), [visible, stage]);

  // New rows animate in and stage hand-offs light their edges — only for small forward steps
  // (playback or live arrivals), never for a scrub jump.
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const [lit, setLit] = useState<string[]>([]);
  const prevCount = useRef(0);
  const litTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const prev = prevCount.current;
    prevCount.current = visible.length;
    if (visible.length > prev && visible.length - prev <= 12) {
      setFresh(new Set(visible.slice(prev).map((e) => e.seq)));
      const edges = edgesForNewEvents(visible, prev);
      if (edges.length) {
        setLit(edges);
        clearTimeout(litTimer.current);
        litTimer.current = setTimeout(() => setLit([]), EDGE_LIT_MS);
      }
    } else if (visible.length !== prev) {
      setFresh(new Set());
      setLit([]);
    }
  }, [visible]);
  useEffect(() => () => clearTimeout(litTimer.current), []);

  const replaying = !local;
  const modeChip = local ? (
    <StatusPill tone={live === "open" ? "safe" : "neutral"}>
      Live · {LIVE_TEXT[live ?? "connecting"]}
    </StatusPill>
  ) : load.status === "ready" ? (
    <StatusPill tone="info">{replayLabel}</StatusPill>
  ) : null;
  const statusChip =
    load.status !== "ready" ? null : finished ? (
      <StatusPill value={finished}>Run {finished.replaceAll("_", " ")}</StatusPill>
    ) : local ? (
      <StatusPill value={bundle.status}>Bundle status: {bundle.status.replaceAll("_", " ")}</StatusPill>
    ) : (
      <StatusPill tone="neutral">
        {replay.playing ? "Replaying" : "Paused"} · {replay.cursor} of {replay.total} events
      </StatusPill>
    );

  return (
    <MotionConfig reducedMotion="user">
      <PageHeader
        title="Mission control"
        description="Where the selected run stands, stage by stage."
        actions={
          <>
            {modeChip}
            {statusChip}
          </>
        }
      />
      <Body load={load} local={local} bundle={bundle}>
        {replaying && (
          <ReplayControls replay={replay} current={visible.at(-1)} label={replayLabel} />
        )}
        <Card className="mc-card graph-card">
          <div className="mc-card-head">
            <div>
              <h2>Read → Test → Challenge → Certify → Enforce</h2>
              <p className="muted">
                Event counts per stage{replaying ? " so far" : ""}. Select a stage to filter the feed.
              </p>
            </div>
          </div>
          <StageGraph
            stats={stats}
            states={states}
            selected={stage}
            onSelect={toggleStage}
            lit={lit}
            reduced={reduced}
          />
        </Card>
        <div className="mc-grid">
          <Card className="mc-card feed-card">
            <EventFeed
              rows={rows}
              bundle={bundle}
              stage={stage}
              onClearStage={() => setStage(null)}
              fresh={fresh}
              reduced={reduced}
              shown={visible.length}
              total={events.length}
              replaying={replaying}
            />
          </Card>
          <Card className="mc-card budget-card">
            <BudgetMeters
              budget={budget}
              firstSeq={firstBudgetSeq(events)}
              replaying={replaying}
              reduced={reduced}
            />
          </Card>
        </div>
        <p className="caption">
          {replaying
            ? `${replayLabel} of ${bundle.runId}'s published timeline. Each event waits its real gap since the previous one, clamped to ${REPLAY_MIN_STEP_MS / 1000}–${REPLAY_MAX_STEP_MS / 1000} s and divided by the speed; times in the feed are the recorded ones.`
            : `Live from the local API: the run's timeline file plus stream events (events marked "live" are provisional until the file is rewritten).`}{" "}
          Node states: idle = no events yet; active = latest event, run not finished; done = had
          events and the run moved on or finished; failed = a revoked certificate, unlearned
          belief, failed review or approval, unsafe decision, or a failed / stopped run.
        </p>
      </Body>
    </MotionConfig>
  );
}

function Body({
  load,
  local,
  bundle,
  children,
}: {
  load: TimelineLoad;
  local: boolean;
  bundle: Pick<RunBundle, "runId" | "sample" | "kind">;
  children: ReactNode;
}) {
  const { runId, sample } = bundle;
  if (load.status === "loading")
    return (
      <LoadingState title="Loading the run timeline…">
        Checking it against the shared schema and the verified bundle hash.
      </LoadingState>
    );
  if (load.status === "error")
    return <ErrorState title="Timeline withheld">{load.error}</ErrorState>;
  if (load.status === "missing")
    return (
      <EmptyState
        title={
          <>
            No timeline published for <span className="mc-nowrap">{runId}</span>
          </>
        }
      >
        {local ? (
          <>
            The local API has no timeline for this run. Every run writes{" "}
            <code>runs/{runId}/timeline.jsonl</code>; runs recorded before timelines existed have
            none. <code>pnpm notary export</code> publishes one next to each real bundle.
          </>
        ) : bundle.kind === "sample" ? (
          <>
            {runId} is a synthetic sample bundle (<code>pnpm notary export --sample</code>), which
            records no timeline. Select a fixture demo run to replay one.
          </>
        ) : sample ? (
          <>
            Fixture timelines are published with the fixture bundles by{" "}
            <code>pnpm notary demo --fixture --publish</code>.
          </>
        ) : (
          <>
            <code>pnpm notary export</code> publishes the run's timeline file next to each real
            bundle.
          </>
        )}
      </EmptyState>
    );
  return <div className="mission-control">{children}</div>;
}
