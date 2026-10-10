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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

// Cross-process delivery. `notary run` / `notary notarize` run in their own process, so the
// in-memory bus alone never reaches a separate `notary serve`. Producers append each event to an
// append-only journal (runs/events.jsonl, gitignored) and the server tails it into its own bus.
export const DEFAULT_EVENT_JOURNAL = fileURLToPath(new URL("../../runs/events.jsonl", import.meta.url));

let journalPath: string | null = null;

/** Start (path) or stop (null) appending emitted events to a journal file. Off by default. */
export function setEventJournal(path: string | null): void {
  journalPath = path;
  if (path) mkdirSync(dirname(path), { recursive: true });
}

export function emitEvent(type: NotaryEventType, payload: unknown): NotaryEvent {
  const event = bus.emit(type, payload);
  if (journalPath) {
    try {
      // event.payload is already scrubbed of secret env values by the bus.
      appendFileSync(journalPath, JSON.stringify({ pid: process.pid, type: event.type, at: event.at, payload: event.payload }) + "\n");
    } catch {
      // The journal is best-effort live view; a write failure must never break a run.
    }
  }
  return event;
}

export interface JournalTail {
  /** Read any new journal lines now (the timer calls this; tests call it directly). */
  poll: () => void;
  stop: () => void;
}

/**
 * Re-emit events that other processes append to `path` into `target`. Starts at the current end of
 * the file (no replay of old runs), skips this process's own events, tolerates a truncated or
 * recreated file and partial trailing lines.
 */
export function tailEventJournal(path: string = DEFAULT_EVENT_JOURNAL, target: EventBus = bus, intervalMs = 500): JournalTail {
  // Size alone can't detect a recreated file that is as long as the old one, so also compare the
  // first bytes we last saw.
  const readHead = (n: number): string => {
    const head = Buffer.alloc(n);
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, n, 0);
    } finally {
      closeSync(fd);
    }
    return head.toString("utf8");
  };
  const HEAD_BYTES = 64;
  let offset = existsSync(path) ? statSync(path).size : 0;
  let head = offset > 0 ? readHead(Math.min(HEAD_BYTES, offset)) : "";
  let partial = "";
  const poll = (): void => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < offset || (head && size >= head.length && readHead(head.length) !== head)) {
      offset = 0;
      partial = "";
    }
    if (offset === 0 && size > 0) head = readHead(Math.min(HEAD_BYTES, size));
    if (size === offset) return;
    const buf = Buffer.alloc(size - offset);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, buf.length, offset);
    } finally {
      closeSync(fd);
    }
    offset = size;
    if (head.length < HEAD_BYTES) head = readHead(Math.min(HEAD_BYTES, size));
    const lines = (partial + buf.toString("utf8")).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { pid?: number; type?: string; payload?: unknown };
        if (rec.pid === process.pid) continue;
        if (!(NOTARY_EVENT_TYPES as readonly string[]).includes(rec.type ?? "")) continue;
        target.emit(rec.type as NotaryEventType, rec.payload);
      } catch {
        // Skip a malformed line rather than stop tailing.
      }
    }
  };
  const timer = setInterval(poll, intervalMs);
  timer.unref();
  return { poll, stop: () => clearInterval(timer) };
}

export function subscribe(listener: NotaryEventListener): () => void {
  return bus.subscribe(listener);
}

export function recentEvents(afterId?: number): NotaryEvent[] {
  return bus.since(afterId);
}
