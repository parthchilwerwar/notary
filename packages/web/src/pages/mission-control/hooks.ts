// Mission control's stateful pieces: loading the selected run's timeline (local API or the
// published file) and the replay clock. All rules live in ./model.ts.
import { useCallback, useEffect, useMemo, useRef, useState, type RefCallback } from "react";
import type { RunBundle, TimelineEvent, TimelineFile } from "../../../../core/src/schema";
import { API_BASE } from "../../data";
import {
  advance,
  checkTimeline,
  cursorAt,
  elapsedAtCursor,
  mergeEvents,
  replayDuration,
  replayOffsets,
  type ReplaySpeed,
} from "./model";
import { useLiveTimeline, type LiveStatus } from "../../state/live";

export type TimelineLoad =
  | { status: "loading" }
  | { status: "ready"; file: TimelineFile; from: string }
  | { status: "missing"; tried: string[] }
  | { status: "error"; error: string };

/** Where a run's timeline is published, in the order to try. */
export function timelineUrls(bundle: Pick<RunBundle, "runId" | "sample">, local: boolean): string[] {
  const id = encodeURIComponent(bundle.runId);
  if (local) return [`${API_BASE}/api/bundles/${id}/timeline`];
  const base = import.meta.env.BASE_URL;
  // Fixture runs are published under bundles/fixture/; a sample bundle in the primary index
  // (sample-42) would sit next to it under bundles/.
  return bundle.sample
    ? [`${base}bundles/fixture/${id}.timeline.json`, `${base}bundles/${id}.timeline.json`]
    : [`${base}bundles/${id}.timeline.json`];
}

/** JSON body, or null for "not published" (404, or the dev server's HTML fallback). */
async function fetchJson(url: string, signal: AbortSignal, local: boolean): Promise<unknown | null> {
  const response = await fetch(url, { signal, cache: "no-store", headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  const type = response.headers.get("content-type") ?? "";
  if (response.ok && !type.includes("json")) return null;
  if (!response.ok) {
    let message = `Unable to load the ${local ? "" : "published "}timeline (${response.status}). Data withheld.`;
    // Only the local API answers with a JSON { error } body worth quoting.
    if (local) {
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body?.error === "string") message = `The local API refused the timeline: ${body.error}.`;
      } catch {
        // Keep the status message.
      }
    }
    throw new Error(message);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("The published timeline is not valid JSON. Data withheld.");
  }
}

/**
 * The selected run's timeline, validated against the shared schema and tied to the verified
 * bundle (checkTimeline). In local mode, `timeline` stream events for this run are merged in;
 * a recorded run.finished re-reads the file, which is the source of truth.
 */
export function useRunTimeline(
  bundle: RunBundle,
  local: boolean,
): { load: TimelineLoad; events: TimelineEvent[]; live: LiveStatus | null } {
  const [load, setLoad] = useState<TimelineLoad>({ status: "loading" });
  const [streamed, setStreamed] = useState<TimelineEvent[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const runId = bundle.runId;

  const live = useLiveTimeline(local, (event) => {
    if (event.runId !== runId) return;
    setStreamed((prev) => [...prev, event]);
    if (event.type === "run.finished" && event.data?.live !== true) setReloadKey((k) => k + 1);
  });

  useEffect(() => {
    const controller = new AbortController();
    const urls = timelineUrls(bundle, local);
    setLoad((prev) => (prev.status === "ready" && prev.file.runId === runId ? prev : { status: "loading" }));
    (async () => {
      for (const url of urls) {
        const raw = await fetchJson(url, controller.signal, local);
        if (raw === null) continue;
        const checked = checkTimeline(raw, bundle);
        return checked.ok
          ? ({ status: "ready", file: checked.file, from: url } as const)
          : ({ status: "error", error: checked.error } as const);
      }
      return { status: "missing", tried: urls } as const;
    })()
      .then((next) => {
        if (controller.signal.aborted) return;
        setLoad(next);
        // Stream events the file now holds are superseded by it.
        if (next.status === "ready") {
          const lastSeq = next.file.events.at(-1)?.seq ?? -1;
          setStreamed((prev) => prev.filter((e) => e.runId === runId && e.seq > lastSeq));
        }
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setLoad({ status: "error", error: e.message });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, bundle.contentHash, local, reloadKey]);

  useEffect(() => setStreamed([]), [runId]);

  const events = useMemo(
    () => (load.status === "ready" ? mergeEvents(load.file.events, streamed, runId) : []),
    [load, streamed, runId],
  );
  return { load, events, live };
}

export type Replay = {
  /** Events replayed so far (0..total). */
  cursor: number;
  total: number;
  playing: boolean;
  speed: ReplaySpeed;
  play: () => void;
  pause: () => void;
  restart: () => void;
  setSpeed: (s: ReplaySpeed) => void;
  seek: (cursor: number) => void;
};

/**
 * Replay clock over a timeline (see model.ts for the timing rule). The clock is elapsed time at
 * 1×, advanced by wall time × speed on animation frames; the cursor is how many events' offsets
 * have passed. `startAtEnd` (reduced motion) opens on the finished state, paused.
 */
export function useReplay(events: readonly TimelineEvent[], key: string, startAtEnd: boolean): Replay {
  const offsets = useMemo(() => replayOffsets(events), [events]);
  const duration = replayDuration(offsets);
  const total = offsets.length;
  const elapsed = useRef(0);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);

  // New timeline: start over (or at the end).
  useEffect(() => {
    elapsed.current = startAtEnd ? duration : 0;
    setCursor(startAtEnd ? total : 0);
    setPlaying(!startAtEnd && total > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, total]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      elapsed.current = advance(elapsed.current, now - last, speed, duration);
      last = now;
      const c = cursorAt(offsets, elapsed.current);
      setCursor((prev) => (prev === c ? prev : c));
      if (elapsed.current >= duration) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, offsets, duration]);

  const seek = useCallback(
    (c: number) => {
      elapsed.current = elapsedAtCursor(offsets, c);
      setCursor(cursorAt(offsets, elapsed.current));
    },
    [offsets],
  );
  const play = useCallback(() => {
    if (elapsed.current >= duration) {
      elapsed.current = 0;
      setCursor(0);
    }
    setPlaying(true);
  }, [duration]);
  const pause = useCallback(() => setPlaying(false), []);
  const restart = useCallback(() => {
    elapsed.current = 0;
    setCursor(0);
    setPlaying(true);
  }, []);

  return { cursor, total, playing, speed, play, pause, restart, setSpeed, seek };
}

/** prefers-reduced-motion, kept in sync. */
export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const sync = () => setReduced(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/** Width of an element, for layouts that switch at a breakpoint (the stage graph). */
export function useElementWidth<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    observer.current = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    observer.current.observe(node);
  }, []);
  return [ref, width];
}
