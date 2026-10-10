// Replay transport: play / pause, restart, speed (1×/2×/4×/8×) and a scrubber over event
// positions. The scrubber moves by whole events, so the screen always shows exactly the events
// replayed so far.
import { PlayIcon as Play } from "@phosphor-icons/react/dist/csr/Play";
import { PauseIcon as Pause } from "@phosphor-icons/react/dist/csr/Pause";
import { ArrowCounterClockwiseIcon as Restart } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import type { TimelineEvent } from "../../../../core/src/schema";
import { Button } from "../../components/ui";
import { REPLAY_SPEEDS, eventTime } from "./model";
import type { Replay } from "./hooks";

export function ReplayControls({
  replay,
  current,
  label,
}: {
  replay: Replay;
  /** The latest replayed event, if any. */
  current?: TimelineEvent;
  label: string;
}) {
  const { cursor, total, playing, speed } = replay;
  const ended = cursor >= total;
  return (
    <div className="replay-bar" role="group" aria-label={`${label} controls`}>
      <div className="replay-buttons">
        <Button
          size="sm"
          onClick={playing ? replay.pause : replay.play}
          aria-label={playing ? "Pause replay" : ended ? "Replay from the start" : "Play replay"}
        >
          {playing ? <Pause weight="fill" /> : <Play weight="fill" />}
          {playing ? "Pause" : ended ? "Replay" : "Play"}
        </Button>
        <Button size="sm" variant="outline" onClick={replay.restart} aria-label="Restart replay">
          <Restart />
          Restart
        </Button>
        <div className="speed-group" role="group" aria-label="Replay speed">
          {REPLAY_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={speed === s}
              onClick={() => replay.setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
      <label className="replay-scrub">
        <span className="sr-only">Replay position (events)</span>
        <input
          type="range"
          min={0}
          max={total}
          step={1}
          value={cursor}
          onChange={(e) => replay.seek(Number(e.target.value))}
          aria-valuetext={`${cursor} of ${total} events replayed`}
          style={{ ["--progress" as string]: `${total ? (cursor / total) * 100 : 0}%` }}
        />
      </label>
      <span className="replay-position" aria-live="off">
        <strong>{cursor}</strong> / {total} events
        {current ? ` · ${eventTime(current.at)} IST` : ""}
      </span>
    </div>
  );
}
