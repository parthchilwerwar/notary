// Replay of a recorded timeline as a stream. Timing rule (DECISIONS #126): the real gap between
// consecutive events, clamped to 200–1600 ms (recorded gaps are milliseconds — unwatchable raw —
// and live ones can be minutes), divided by the speed. The first event appears after one floor
// step. "instant" delivers every event at once. Order is always the recorded seq order.
import type { TimelineEvent } from "../../../core/src/schema";
import type { EventStreamOptions } from "./types";

export const REPLAY_MIN_STEP_MS = 200;
export const REPLAY_MAX_STEP_MS = 1600;

export type ReplaySpeed = NonNullable<EventStreamOptions["speed"]>;

export type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Delay (ms) before each event, relative to the previous one, at `speed`. */
export function replayDelays(events: readonly Pick<TimelineEvent, "at">[], speed: ReplaySpeed): number[] {
  if (speed === "instant") return events.map(() => 0);
  return events.map((e, i) => {
    if (i === 0) return REPLAY_MIN_STEP_MS / speed;
    const gap = Date.parse(e.at) - Date.parse(events[i - 1]!.at);
    const shown = Math.min(REPLAY_MAX_STEP_MS, Math.max(REPLAY_MIN_STEP_MS, Number.isFinite(gap) ? gap : 0));
    return shown / speed;
  });
}

/**
 * Emit `load()`'s events at `opts.speed` (default 1×). Returns unsubscribe; nothing is delivered
 * after it is called. Load failures go to `opts.onError`.
 */
export function replayStream(
  load: () => Promise<TimelineEvent[]>,
  onEvent: (e: TimelineEvent) => void,
  opts: EventStreamOptions = {},
  timers: Timers = realTimers,
): () => void {
  let stopped = false;
  let handle: unknown;
  const speed = opts.speed ?? 1;
  load().then(
    (events) => {
      if (stopped) return;
      if (speed === "instant") {
        for (const e of events) {
          if (stopped) return;
          onEvent(e);
        }
        if (!stopped) opts.onEnd?.();
        return;
      }
      const delays = replayDelays(events, speed);
      let i = 0;
      const next = () => {
        if (stopped) return;
        if (i >= events.length) {
          opts.onEnd?.();
          return;
        }
        handle = timers.set(() => {
          if (stopped) return;
          onEvent(events[i]!);
          i += 1;
          next();
        }, delays[i]!);
      };
      next();
    },
    (e: unknown) => {
      if (!stopped) opts.onError?.(e instanceof Error ? e.message : String(e));
    },
  );
  return () => {
    stopped = true;
    if (handle !== undefined) timers.clear(handle);
  };
}
