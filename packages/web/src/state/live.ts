// SSE client for a local `notary serve` (GET /api/stream). One shared EventSource for the whole
// tab, opened while at least one subscriber needs it (Mission control in Live mode, the shell's
// live toasts) and closed when the last one leaves. Only `timeline` events are used; each carries
// one TimelineEvent, validated with the shared schema before anyone sees it.
//
// Reconnects: on any error the EventSource is closed and reopened by us with
// `?lastEventId=<last id seen>` (the server's equivalent of the Last-Event-ID header), backing
// off 1 s → 15 s, so missed events still in the server's buffer are replayed and none twice.
// The hosted site has no local API; nothing here runs unless the data source is the local API.
import { useEffect, useRef, useState } from "react";
import type { TimelineEvent } from "../../../core/src/schema";
import { API_BASE } from "../data";
import { parseStreamData, toastFor } from "../pages/mission-control/model";
import { useData } from "./DataProvider";
import { notify } from "../components/shell/notify";

export type LiveStatus = "connecting" | "open" | "reconnecting" | "unavailable";

type Listener = (event: TimelineEvent) => void;
type StatusListener = (status: LiveStatus) => void;

const MAX_BACKOFF_MS = 15_000;
/** After this many failed reopen attempts in a row the status reads "unavailable" (it keeps trying). */
const UNAVAILABLE_AFTER = 3;

class LiveStream {
  private source: EventSource | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private lastEventId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  status: LiveStatus = "connecting";

  subscribe(listener: Listener, onStatus?: StatusListener): () => void {
    this.listeners.add(listener);
    if (onStatus) {
      this.statusListeners.add(onStatus);
      onStatus(this.status);
    }
    if (!this.source && !this.timer) this.open();
    return () => {
      this.listeners.delete(listener);
      if (onStatus) this.statusListeners.delete(onStatus);
      if (this.listeners.size === 0) this.close();
    };
  }

  private setStatus(status: LiveStatus) {
    if (status === this.status) return;
    this.status = status;
    for (const l of [...this.statusListeners]) l(status);
  }

  private open() {
    if (typeof EventSource === "undefined") {
      this.setStatus("unavailable");
      return;
    }
    const query = this.lastEventId ? `?lastEventId=${encodeURIComponent(this.lastEventId)}` : "";
    const source = new EventSource(`${API_BASE}/api/stream${query}`);
    this.source = source;
    source.onopen = () => {
      this.failures = 0;
      this.setStatus("open");
    };
    source.addEventListener("timeline", (message) => {
      const m = message as MessageEvent<string>;
      if (m.lastEventId) this.lastEventId = m.lastEventId;
      const event = parseStreamData(m.data);
      if (!event) return;
      for (const l of [...this.listeners]) {
        try {
          l(event);
        } catch {
          // A broken subscriber never stops the stream.
        }
      }
    });
    source.onerror = () => {
      // Always reopen ourselves with ?lastEventId= rather than relying on the browser's
      // automatic retry, so the resume point is explicit and the backoff is ours.
      source.close();
      if (this.source === source) this.source = null;
      this.failures++;
      this.setStatus(this.failures >= UNAVAILABLE_AFTER ? "unavailable" : "reconnecting");
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failures - 1));
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.listeners.size) this.open();
      }, delay);
    };
  }

  private close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.source?.close();
    this.source = null;
    this.failures = 0;
    this.status = "connecting";
  }
}

const stream = new LiveStream();

/**
 * Subscribe to `timeline` events while `enabled`. Returns the connection status (null when
 * disabled). The callback may change between renders; the latest one is always used.
 */
export function useLiveTimeline(
  enabled: boolean,
  onEvent: (event: TimelineEvent) => void,
): LiveStatus | null {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const callback = useRef(onEvent);
  callback.current = onEvent;
  useEffect(() => {
    if (!enabled) return;
    return stream.subscribe((e) => callback.current(e), setStatus);
  }, [enabled]);
  return enabled ? status : null;
}

/**
 * Toasts for meaningful live events from any local run: a decision held, a certificate revoked,
 * an approval recorded, a run finished. Mounted once by the app shell; inert on the hosted site.
 */
const toasted = new Set<string>();

export function LiveToasts(): null {
  const { source } = useData();
  useLiveTimeline(source === "api", (event) => {
    const t = toastFor(event);
    if (!t || toasted.has(t.id)) return;
    toasted.add(t.id);
    notify[t.tone](t.title, { description: t.description, id: t.id });
  });
  return null;
}
