// In-process typed event bus for the dashboard's live mode (TDD "Local API": SSE events
// `decision`, `probe.committed`, `probe.verdict`, `belief.changed`, `run.finished`).
//
// Producers (the queue runner, the notarization loop) call emitEvent with bundle records; the
// `notary serve` SSE endpoint subscribes and forwards them. A bounded ring buffer of recent events
// with monotonically increasing ids lets a reconnecting client replay what it missed via
// `Last-Event-ID`.
//
// Secrets: payloads are bundle records and should never carry secrets. As a backstop, the value
// of every secret-looking env var is scrubbed from each payload before it is stored or delivered
// (same rule as the trace module and the adversary evidence packet).
import { scrubSecrets } from "../adversary/evidence-packet.js";

export const NOTARY_EVENT_TYPES = ["decision", "probe.committed", "probe.verdict", "belief.changed", "run.finished"] as const;
export type NotaryEventType = (typeof NOTARY_EVENT_TYPES)[number];

export interface NotaryEvent {
  /** Monotonically increasing per process, starting at 1. */
  id: number;
  type: NotaryEventType;
  /** ISO timestamp of emission. */
  at: string;
  payload: unknown;
}

export type NotaryEventListener = (event: NotaryEvent) => void;

export const DEFAULT_BUFFER_SIZE = 500;

const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

function secretEnvValues(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_RE.test(name) && value && value.trim().length >= 8) out.push(value.trim());
  }
  return out.sort((a, b) => b.length - a.length);
}

/** JSON round-trip so listeners and the buffer never share (or see later mutation of) the producer's object. */
function snapshot(payload: unknown): unknown {
  if (payload === undefined) return null;
  return JSON.parse(JSON.stringify(payload)) as unknown;
}

export class EventBus {
  private readonly buffer: NotaryEvent[] = [];
  private readonly listeners = new Set<NotaryEventListener>();
  private nextId = 1;

  constructor(
    private readonly capacity = DEFAULT_BUFFER_SIZE,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`bus capacity must be a positive integer, got ${capacity}`);
  }

  emit(type: NotaryEventType, payload: unknown): NotaryEvent {
    if (!(NOTARY_EVENT_TYPES as readonly string[]).includes(type)) throw new TypeError(`unknown notary event type ${JSON.stringify(type)}`);
    const event: NotaryEvent = {
      id: this.nextId++,
      type,
      at: new Date().toISOString(),
      payload: scrubSecrets(snapshot(payload), secretEnvValues(this.env)),
    };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber (e.g. a closed SSE stream) must never break the producer.
      }
    }
    return event;
  }

  subscribe(listener: NotaryEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Buffered events with id > afterId (all buffered events when afterId is undefined), oldest first. */
  since(afterId?: number): NotaryEvent[] {
    if (afterId === undefined) return [...this.buffer];
    return this.buffer.filter((e) => e.id > afterId);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  get lastId(): number {
    return this.nextId - 1;
  }
}

/** The process-wide bus used by producers and `notary serve`. */
export const bus = new EventBus();

export function emitEvent(type: NotaryEventType, payload: unknown): NotaryEvent {
  return bus.emit(type, payload);
}

export function subscribe(listener: NotaryEventListener): () => void {
  return bus.subscribe(listener);
}

export function recentEvents(afterId?: number): NotaryEvent[] {
  return bus.since(afterId);
}
