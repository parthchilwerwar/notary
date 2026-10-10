// Compact, auto-looping, read-only replay of mission control for the landing page.
// Driven only by published fixture timelines (public/bundles/fixture/<runId>.timeline.json),
// each tied to its hash-verified bundle (landing-data verifyTimeline). The stage graph and its
// counting rules are Mission control's own (src/pages/mission-control: StageGraph, stageStats,
// nodeStates, edgesForNewEvents), imported unchanged; this file adds only the looping clock,
// run sequencing and the compact layout. Stage counts are counts of the current run's replayed events.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { PauseIcon as Pause } from "@phosphor-icons/react/dist/csr/Pause";
import { PlayIcon as Play } from "@phosphor-icons/react/dist/csr/Play";
import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import type { TimelineFile } from "../../../../core/src/schema";
import { Button, Card } from "../ui";
import { number } from "../../data";
import { withRun } from "../../state/data-mode";
import { STAGE_LABEL, replayEvents, typeCounts } from "../../landing-data";
import { StageGraph } from "../../pages/mission-control/StageGraph";
import {
  edgesForNewEvents,
  nodeStates,
  stageStats,
} from "../../pages/mission-control/model";
import "../../pages/mission-control/mission-control.css";
import type { TimelineStage } from "../../../../core/src/schema";

export const REPLAY_LABEL = "Fixture replay — simulated APIs, not a live run";
const TICK_MS = 110;
const HOLD_TICKS = 28; // pause on the finished state before looping

function useReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduce, setReduce] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setReduce(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduce;
}

export function MissionReplay({
  files,
  unsafe,
  loading,
  error,
}: {
  files: TimelineFile[];
  /** Decision ids the grader marked unsafe in the replayed runs (Mission control's failure rule). */
  unsafe: ReadonlySet<string>;
  loading: boolean;
  error: string;
}) {
  const events = useMemo(() => replayEvents(files), [files]);
  const reduce = useReducedMotion();
  // `tick` runs past the last event by HOLD_TICKS so the finished state stays up before looping.
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cursor = Math.min(tick, events.length);

  // Reduced motion: no autoplay; show the finished state until the viewer presses Play.
  useEffect(() => {
    if (reduce) {
      setPlaying(false);
      setTick(events.length);
    }
  }, [reduce, events.length]);

  // Reduced motion plays once, then stops on the finished state.
  useEffect(() => {
    if (reduce && playing && tick >= events.length) setPlaying(false);
  }, [reduce, playing, tick, events.length]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) =>
      setVisible(!!entry?.isIntersecting),
    );
    io.observe(el);
    return () => io.disconnect();
  }, [events.length]);

  useEffect(() => {
    if (!playing || !visible || events.length === 0) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setTick((t) => (t + 1) % (events.length + HOLD_TICKS + 1));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing, visible, events.length]);

  const [stage, setStage] = useState<TimelineStage | null>(null);
  // Cursor at the last event of each run (cumulative event counts).
  const runEnds = useMemo(() => {
    let n = 0;
    return files.map((f) => (n += f.events.length));
  }, [files]);
  const types = typeCounts(events, cursor);
  const current = cursor > 0 ? events[cursor - 1] : undefined;
  const runIndex = Math.max(0, current ? files.findIndex((f) => f.runId === current.runId) : 0);
  const run = files[runIndex];
  // The graph shows one run at a time, exactly as Mission control would for that run.
  const runEvents = useMemo(
    () => events.slice(0, cursor).filter((e) => e.runId === run?.runId),
    [events, cursor, run?.runId],
  );
  const stats = useMemo(() => stageStats(runEvents, unsafe), [runEvents, unsafe]);
  const states = useMemo(() => nodeStates(runEvents, stats), [runEvents, stats]);
  const lit = useMemo(
    () => (reduce || !playing ? [] : edgesForNewEvents(runEvents, runEvents.length - 1)),
    [runEvents, reduce, playing],
  );
  const recent = events
    .slice(0, cursor)
    .filter((e) => !stage || e.stage === stage)
    .slice(-4)
    .reverse();

  return (
    <section id="replay" className="landing-section" aria-labelledby="lreplay-title">
      <div className="chapter-heading">
        <span className="eyebrow">Mission control</span>
        <h2 id="lreplay-title">Watch a run move through the five stages.</h2>
        <p>
          A replay of published fixture timelines: notarize the simulated APIs,
          then run the guarded queue. Each count is a replayed timeline event.
        </p>
      </div>
      <Card className="lreplay-card" ref={ref}>
        <div className="lreplay-label" role="note">
          <ShieldCheck size={18} aria-hidden="true" />
          <span>{REPLAY_LABEL}</span>
        </div>
        {loading ? (
          <div className="result-state" role="status">
            Verifying fixture timelines…
          </div>
        ) : error ? (
          <div className="result-state" role="alert">
            <h3>Replay unavailable</h3>
            <p>{error}</p>
          </div>
        ) : events.length === 0 ? (
          <div className="result-state">
            <h3>No fixture timelines published</h3>
            <p>
              Publish them with <code>pnpm notary demo --fixture --publish</code>.
            </p>
          </div>
        ) : (
          <>
            <div className="lreplay-top">
              <div className="lreplay-run">
                <span className="lreplay-k" id="lreplay-runs-label">
                  Run {runIndex + 1} of {files.length}
                </span>
                <div className="lreplay-runs" role="group" aria-labelledby="lreplay-runs-label">
                  {files.map((f, i) => (
                    <button
                      type="button"
                      key={f.runId}
                      aria-pressed={i === runIndex}
                      title={`Show the end of ${f.runId}`}
                      onClick={() => {
                        setPlaying(false);
                        setTick(runEnds[i] ?? events.length);
                      }}
                    >
                      {f.runId}
                    </button>
                  ))}
                </div>
              </div>
              <div className="lreplay-controls">
                <span className="lreplay-k lreplay-progress-text">
                  Event {number(cursor)} / {number(events.length)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (!playing && cursor >= events.length) setTick(0);
                    setPlaying(!playing);
                  }}
                >
                  {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                  {playing ? "Pause" : "Play"}
                </Button>
              </div>
            </div>
            <div
              className="lreplay-progress"
              role="progressbar"
              aria-label="Replay progress"
              aria-valuemin={0}
              aria-valuemax={events.length}
              aria-valuenow={cursor}
            >
              <span style={{ width: `${(cursor / events.length) * 100}%` }} />
            </div>
            <div className="lreplay-graph">
              <StageGraph
                stats={stats}
                states={states}
                selected={stage}
                onSelect={(st) => setStage((cur) => (cur === st ? null : st))}
                lit={lit}
                reduced={reduce}
              />
            </div>
            <div className="lreplay-bottom">
              <div>
                <p className="lreplay-k lreplay-facts-title">Across the replay so far</p>
              <dl className="lreplay-facts" aria-label="Across the replay so far">
                <div>
                  <dt>Certificates issued</dt>
                  <dd>{number(types.certificatesIssued)}</dd>
                </div>
                <div>
                  <dt>Certificates revoked</dt>
                  <dd>{number(types.certificatesRevoked)}</dd>
                </div>
                <div>
                  <dt>Money actions executed</dt>
                  <dd>{number(types.executed)}</dd>
                </div>
                <div>
                  <dt>Held for a human</dt>
                  <dd>{number(types.held)}</dd>
                </div>
              </dl>
              </div>
              <ol
                className="lreplay-events"
                aria-label={stage ? `Latest ${STAGE_LABEL[stage]} events` : "Latest replayed events"}
              >
                {recent.map((e) => (
                  <li key={`${e.runId}-${e.seq}`}>
                    <span className="lreplay-event-stage">{STAGE_LABEL[e.stage]}</span>
                    <span className="lreplay-event-text">{e.summary}</span>
                  </li>
                ))}
                {recent.length === 0 && (
                  <li className="muted">
                    {stage ? `No ${STAGE_LABEL[stage]} events replayed yet.` : "Starting the replay…"}
                  </li>
                )}
              </ol>
            </div>
            <p className="chart-note">
              Timelines {files.map((f) => f.runId).join(", ")}; each one's
              bundleHash matches its verified bundle.{" "}
              <Link to={withRun("/app/mission-control", files[files.length - 1]?.runId)}>
                Open mission control
              </Link>
            </p>
          </>
        )}
      </Card>
    </section>
  );
}
