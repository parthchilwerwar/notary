/**
 * Per-item run state for crash recovery (TDD "Recovery"), in the Notary SQLite store.
 *
 *   run_meta   one row per guarded run: queue/expected files, mode, cassettes, the ground-truth
 *              snapshot taken before the first item (so a resumed run is graded against the state
 *              before the ORIGINAL start), finished_at once the bundle is written.
 *   run_items  one row per queue item: state pending | in_flight | done, decision_json (the final
 *              Decision when done; while in flight, the draft decision as of the write), the last
 *              write (op + params + pre-write snapshot) persisted BEFORE the write is sent, updated_at.
 *
 * `notary run --resume [--run <runId>]` picks the run (latest unfinished by default) and continues:
 * done items keep their decision, pending items run normally, and an in_flight item with a recorded
 * write is READ BACK first (src/guards/readback.ts): landed -> executed from the draft, proven not
 * landed -> processed again from scratch, unknown -> held. Never a blind retry.
 */
import { DatabaseSync } from "node:sqlite";
import type { PendingWrite } from "../guards/readback.js";
import { DecisionSchema } from "../schema/index.js";
import type { Decision } from "../schema/index.js";
import type { NotaryDb } from "../store/db.js";
import type { GroundTruthSnapshot } from "./grader.js";

export type ItemState = "pending" | "in_flight" | "done";

export interface RunMeta {
  runId: string;
  queueFile: string;
  expectedFile: string;
  variant: "naive" | "guarded";
  mode: "live" | "replay";
  startedAt: string;
  finishedAt?: string;
  cassettes: string[];
  before: GroundTruthSnapshot | null;
}

export interface RunItem {
  runId: string;
  requestId: string;
  seq: number;
  state: ItemState;
  decision?: Decision;
  lastWrite?: PendingWrite;
  updatedAt: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS run_meta (
  run_id        TEXT PRIMARY KEY,
  queue_file    TEXT NOT NULL,
  expected_file TEXT NOT NULL,
  variant       TEXT NOT NULL,
  mode          TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  cassettes_json TEXT NOT NULL,
  before_json   TEXT
);

CREATE TABLE IF NOT EXISTS run_items (
  run_id            TEXT NOT NULL,
  request_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('pending', 'in_flight', 'done')),
  decision_json     TEXT,
  last_write_op     TEXT,
  last_write_params TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (run_id, request_id)
);
`;

type Row = Record<string, unknown>;

export class RunStateStore {
  readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: NotaryDb | DatabaseSync, opts: { now?: () => Date } = {}) {
    this.db = db instanceof DatabaseSync ? db : db.db;
    this.now = opts.now ?? (() => new Date());
    this.db.exec(SCHEMA_SQL);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  startRun(meta: Omit<RunMeta, "finishedAt">, requestIds: readonly string[]): void {
    this.db
      .prepare(
        `INSERT INTO run_meta (run_id, queue_file, expected_file, variant, mode, started_at, finished_at, cassettes_json, before_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(meta.runId, meta.queueFile, meta.expectedFile, meta.variant, meta.mode, meta.startedAt, JSON.stringify(meta.cassettes), meta.before ? JSON.stringify(meta.before) : null);
    const stmt = this.db.prepare(
      "INSERT INTO run_items (run_id, request_id, seq, state, updated_at) VALUES (?, ?, ?, 'pending', ?)",
    );
    requestIds.forEach((id, i) => stmt.run(meta.runId, id, i, this.stamp()));
  }

  setBefore(runId: string, before: GroundTruthSnapshot): void {
    this.db.prepare("UPDATE run_meta SET before_json = ? WHERE run_id = ?").run(JSON.stringify(before), runId);
  }

  addCassette(runId: string, cassette: string): void {
    const m = this.meta(runId);
    if (!m || m.cassettes.includes(cassette)) return;
    this.db.prepare("UPDATE run_meta SET cassettes_json = ? WHERE run_id = ?").run(JSON.stringify([...m.cassettes, cassette]), runId);
  }

  finishRun(runId: string): void {
    this.db.prepare("UPDATE run_meta SET finished_at = ? WHERE run_id = ?").run(this.stamp(), runId);
  }

  meta(runId: string): RunMeta | undefined {
    const r = this.db.prepare("SELECT * FROM run_meta WHERE run_id = ?").get(runId) as Row | undefined;
    return r ? this.toMeta(r) : undefined;
  }

  private toMeta(r: Row): RunMeta {
    return {
      runId: String(r.run_id),
      queueFile: String(r.queue_file),
      expectedFile: String(r.expected_file),
      variant: String(r.variant) as RunMeta["variant"],
      mode: String(r.mode) as RunMeta["mode"],
      startedAt: String(r.started_at),
      ...(r.finished_at == null ? {} : { finishedAt: String(r.finished_at) }),
      cassettes: JSON.parse(String(r.cassettes_json)) as string[],
      before: r.before_json == null ? null : (JSON.parse(String(r.before_json)) as GroundTruthSnapshot),
    };
  }

  /** The most recently started run that never finished (its bundle was never written). */
  latestIncomplete(): RunMeta | undefined {
    const r = this.db
      .prepare(
        `SELECT m.* FROM run_meta m
         WHERE m.finished_at IS NULL
         ORDER BY m.started_at DESC, m.run_id DESC LIMIT 1`,
      )
      .get() as Row | undefined;
    return r ? this.toMeta(r) : undefined;
  }

  items(runId: string): RunItem[] {
    const rows = this.db.prepare("SELECT * FROM run_items WHERE run_id = ? ORDER BY seq").all(runId) as Row[];
    return rows.map((r) => ({
      runId: String(r.run_id),
      requestId: String(r.request_id),
      seq: Number(r.seq),
      state: String(r.state) as ItemState,
      ...(r.decision_json == null ? {} : { decision: DecisionSchema.parse(JSON.parse(String(r.decision_json))) }),
      ...(r.last_write_params == null ? {} : { lastWrite: JSON.parse(String(r.last_write_params)) as PendingWrite }),
      updatedAt: String(r.updated_at),
    }));
  }

  /** The item started (any earlier write record is cleared: a fresh attempt). */
  markInFlight(runId: string, requestId: string): void {
    this.db
      .prepare(
        "UPDATE run_items SET state = 'in_flight', decision_json = NULL, last_write_op = NULL, last_write_params = NULL, updated_at = ? WHERE run_id = ? AND request_id = ?",
      )
      .run(this.stamp(), runId, requestId);
  }

  /** Persisted BEFORE the write is sent. */
  recordWrite(runId: string, requestId: string, write: PendingWrite, draft: Decision): void {
    this.db
      .prepare(
        "UPDATE run_items SET state = 'in_flight', decision_json = ?, last_write_op = ?, last_write_params = ?, updated_at = ? WHERE run_id = ? AND request_id = ?",
      )
      .run(JSON.stringify(DecisionSchema.parse(draft)), write.op, JSON.stringify(write), this.stamp(), runId, requestId);
  }

  markDone(runId: string, requestId: string, decision: Decision): void {
    this.db
      .prepare("UPDATE run_items SET state = 'done', decision_json = ?, updated_at = ? WHERE run_id = ? AND request_id = ?")
      .run(JSON.stringify(DecisionSchema.parse(decision)), this.stamp(), runId, requestId);
  }

  /** Hooks for executeQueue bound to one run. */
  hooks(runId: string): { start(requestId: string): void; beforeWrite(requestId: string, w: PendingWrite, draft: Decision): void; done(requestId: string, d: Decision): void } {
    return {
      start: (id) => this.markInFlight(runId, id),
      beforeWrite: (id, w, draft) => this.recordWrite(runId, id, w, draft),
      done: (id, d) => this.markDone(runId, id, d),
    };
  }
}
