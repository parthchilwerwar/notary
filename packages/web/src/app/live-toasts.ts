// Live events for the UI, through the data layer: DataSource.streamEvents (LiveSource = SSE
// GET /api/runs/:id/events, every event schema-validated there). Nothing here runs in replay
// mode; the hosted site never opens a stream.
import { useEffect, useRef, useState } from "react";
import { RunStatusSchema, type TimelineEvent } from "../../../core/src/schema";
import { useData } from "./catalog";
import { notify } from "../components/shell/notify";

/** Run statuses that are not a clean finish, from the shared schema (never typed by hand). */
const FAILED_RUN_STATUSES = new Set<string>(RunStatusSchema.options.filter((s) => s !== "completed"));

export type LiveToast = {
  tone: "info" | "success" | "error";
  title: string;
  description: string;
  /**
   * Stable per record, not per seq: a live event and its recorded re-emission when the run
   * finishes share it, so one held decision toasts once.
   */
  id: string;
};

/** Which live events deserve a toast: a held decision, a revoked certificate, a finished run, an approval. */
export function toastFor(e: TimelineEvent): LiveToast | null {
  const id = `${e.runId}|${e.type}|${e.recordIds[0] ?? e.seq}`;
  const description = `${e.runId}: ${e.summary}`;
  if (e.type === "decision" && e.data?.status === "held") return { tone: "info", title: "Decision held", description, id };
  if (e.type === "certificate.revoked") return { tone: "error", title: "Certificate revoked", description, id };
  if (e.type === "approval.decided") return { tone: "info", title: "Approval recorded", description, id };
  if (e.type === "run.finished") {
    const status = typeof e.data?.status === "string" ? e.data.status : "finished";
    return {
      tone: FAILED_RUN_STATUSES.has(status) ? "error" : "success",
      title: `Run finished: ${status.replaceAll("_", " ")}`,
      description,
      id,
    };
  }
  return null;
}

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
