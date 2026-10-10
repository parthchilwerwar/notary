// Live events for the UI, through the data layer: DataSource.streamEvents (LiveSource = SSE
// GET /api/runs/:id/events, every event schema-validated there). Nothing here runs in replay
// mode; the hosted site never opens a stream.
import { useEffect, useRef, useState } from "react";
import type { TimelineEvent } from "../../../core/src/schema";
import { toastFor } from "../pages/mission-control/model";
import { useData } from "./DataProvider";
import { notify } from "../components/shell/notify";

export type LiveStatus = "connecting" | "open" | "reconnecting" | "unavailable" | "ended";

/**
 * Subscribe to one run's live events while `runId` is set and the data source is live. Returns
 * the connection status (null when disabled). The callback may change between renders; the
 * latest one is always used.
 */
export function useLiveTimeline(
  runId: string | undefined,
  onEvent: (event: TimelineEvent) => void,
): LiveStatus | null {
  const { dataSource } = useData();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const callback = useRef(onEvent);
  callback.current = onEvent;
  const enabled = !!runId && dataSource.mode === "live";
  useEffect(() => {
    if (!enabled || !runId) return;
    setStatus("connecting");
    return dataSource.streamEvents(
      runId,
      (e) => {
        setStatus("open");
        try {
          callback.current(e);
        } catch {
          // A broken subscriber never stops the stream.
        }
      },
      {
        onEnd: () => setStatus("ended"),
        onError: (message) =>
          setStatus(message.includes("no EventSource") ? "unavailable" : "reconnecting"),
      },
    );
  }, [enabled, runId, dataSource]);
  return enabled ? status : null;
}

/**
 * Toasts for meaningful live events of the selected real run: a decision held, a certificate
 * revoked, an approval recorded, the run finished. Mounted once by the app shell. Only events that
 * arrive live (flagged `data.live`, or stamped after the stream opened) toast — the stream's replay
 * of the recorded file does not.
 */
const toasted = new Set<string>();

export function LiveToasts(): null {
  const { source, bundle, selectedRunId } = useData();
  const since = useRef(Date.now());
  const runId = source === "api" && bundle && !bundle.sample ? selectedRunId : undefined;
  useEffect(() => {
    since.current = Date.now();
  }, [runId]);
  useLiveTimeline(runId, (event) => {
    const fresh = event.data?.live === true || Date.parse(event.at) >= since.current;
    if (!fresh) return;
    const t = toastFor(event);
    if (!t || toasted.has(t.id)) return;
    toasted.add(t.id);
    notify[t.tone](t.title, { description: t.description, id: t.id });
  });
  return null;
}
