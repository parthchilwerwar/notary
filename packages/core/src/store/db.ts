/**
 * Notary state store: SQLite via Node's built-in `node:sqlite` (DatabaseSync; no native deps).
 * Default file packages/core/runs/notary.sqlite (gitignored); tests pass ":memory:".
 *
 * Prediction immutability (TDD "The notarization loop", step 5: "Predictions are immutable after
 * that"), enforced twice:
 *   1. An SQL trigger aborts any UPDATE that changes a probe's pre-registered columns
 *      (prediction_json, prediction_hash, committed_at, params_json, control_json, template,
 *      hypothesis_ids_json, claim_id) and any DELETE of a committed probe.
 *   2. `recordResult()` writes only result columns (observed, verdict, ran_at, ...) and first
 *      recomputes sha256(canonicalJson(prediction_json)); it refuses if that no longer equals the
 *      stored prediction_hash or the hash the caller committed (so a prediction edited behind the
 *      trigger's back, e.g. with the trigger dropped, can never receive a verdict).
 * A probe's result can be recorded once; a second recordResult is refused.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Hex } from "../bundle/hash.js";
import { AnomalySchema, HypothesisSchema, ProbeSchema } from "../schema/index.js";
import type { Anomaly, Hypothesis, Probe, ProbeVerdict } from "../schema/index.js";

export const DEFAULT_DB_PATH = fileURLToPath(new URL("../../runs/notary.sqlite", import.meta.url));

export class PredictionImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PredictionImmutableError";
  }
}

/** sha256 hex of the canonical JSON of a prediction map (Probe.predictionHash). */
export function predictionHash(prediction: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(prediction));
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS anomalies (
  run_id        TEXT NOT NULL,
  id            TEXT NOT NULL,
  claim_id      TEXT NOT NULL,
  tool          TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  exchange_id   TEXT,
  trace_id      TEXT NOT NULL,
  span_id       TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS hypotheses (
  run_id              TEXT NOT NULL,
  id                  TEXT NOT NULL,
  anomaly_id          TEXT NOT NULL,
  class               TEXT NOT NULL,
  statement           TEXT NOT NULL,
  distinguishing_test TEXT NOT NULL,
  -- 0 = first proposal, 1 = re-proposed after all rivals were refuted
  round               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS probes (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL,
  tool                  TEXT NOT NULL,
  claim_id              TEXT NOT NULL,
  hypothesis_ids_json   TEXT NOT NULL,
  template              TEXT NOT NULL,
  params_json           TEXT NOT NULL,
  control_json          TEXT,
  prediction_json       TEXT NOT NULL,
  prediction_hash       TEXT NOT NULL,
  committed_at          TEXT NOT NULL,
  observed_json         TEXT,
  control_observed_json TEXT,
  verdict               TEXT,
  winning_hypothesis_id TEXT,
  cost_credits          REAL NOT NULL DEFAULT 0,
  calls                 INTEGER NOT NULL DEFAULT 0,
  trace_id              TEXT NOT NULL,
  span_id               TEXT,
  ran_at                TEXT,
  seq                   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS probes_run ON probes (run_id, seq);

CREATE TRIGGER IF NOT EXISTS probes_prediction_immutable
BEFORE UPDATE ON probes
WHEN NEW.prediction_json IS NOT OLD.prediction_json
  OR NEW.prediction_hash IS NOT OLD.prediction_hash
  OR NEW.committed_at IS NOT OLD.committed_at
  OR NEW.params_json IS NOT OLD.params_json
  OR NEW.control_json IS NOT OLD.control_json
  OR NEW.template IS NOT OLD.template
  OR NEW.hypothesis_ids_json IS NOT OLD.hypothesis_ids_json
  OR NEW.claim_id IS NOT OLD.claim_id
BEGIN
  SELECT RAISE(ABORT, 'probe prediction is immutable after commit');
END;

CREATE TRIGGER IF NOT EXISTS probes_no_delete
BEFORE DELETE ON probes
BEGIN
  SELECT RAISE(ABORT, 'committed probes cannot be deleted');
END;
`;

/** What commitProbe needs: the pre-registered part of a Probe. */
export interface ProbeCommit {
  id: string;
  runId: string;
  tool: Probe["tool"];
  claimId: string;
  hypothesisIds: string[];
  template: Probe["template"];
  params: Record<string, unknown>;
  control?: { params: Record<string, unknown> };
  prediction: Record<string, unknown>;
  /** ISO timestamp; written before any HTTP call. */
  committedAt: string;
  traceId: string;
  spanId?: string;
}

export interface ProbeResult {
  observed: unknown;
  controlObserved?: unknown;
  verdict: ProbeVerdict;
  winningHypothesisId?: string;
  ranAt: string;
  costCredits: number;
  calls: number;
}

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

function json(v: unknown): string {
  return JSON.stringify(v ?? null);
}

export class NotaryDb {
  readonly db: DatabaseSync;
  readonly path: string;
  private seq = 0;

  constructor(path: string = DEFAULT_DB_PATH) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA_SQL);
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM probes").get() as Row | undefined;
    this.seq = Number(row?.s ?? 0);
  }

  close(): void {
    this.db.close();
  }

  /** Re-read the probe sequence after rows were inserted directly (replay restores a store snapshot). */
  syncSeq(): void {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM probes").get() as Row | undefined;
    this.seq = Number(row?.s ?? 0);
  }

  // ------------------------------------------------------------------ anomalies / hypotheses

  saveAnomalies(runId: string, anomalies: readonly Anomaly[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO anomalies (run_id, id, claim_id, tool, observed_json, expected_json, exchange_id, trace_id, span_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of anomalies) {
      stmt.run(runId, a.id, a.claimId, a.tool, json(a.observed), json(a.expected), a.exchangeId ?? null, a.traceId, a.spanId);
    }
  }

  loadAnomalies(runId: string): Anomaly[] {
    const rows = this.db.prepare("SELECT * FROM anomalies WHERE run_id = ? ORDER BY id").all(runId) as Row[];
    return rows.map((r) =>
      AnomalySchema.parse({
        id: r.id,
        claimId: r.claim_id,
        tool: r.tool,
        observed: JSON.parse(str(r.observed_json)),
        expected: JSON.parse(str(r.expected_json)),
        ...(r.exchange_id == null ? {} : { exchangeId: r.exchange_id }),
        traceId: r.trace_id,
        spanId: r.span_id,
      }),
    );
  }

  saveHypotheses(runId: string, hypotheses: readonly Hypothesis[], round = 0): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO hypotheses (run_id, id, anomaly_id, class, statement, distinguishing_test, round)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const h of hypotheses) stmt.run(runId, h.id, h.anomalyId, h.class, h.statement, h.distinguishingTest, round);
  }

  loadHypotheses(runId: string): Hypothesis[] {
    const rows = this.db.prepare("SELECT * FROM hypotheses WHERE run_id = ? ORDER BY round, id").all(runId) as Row[];
    return rows.map((r) =>
      HypothesisSchema.parse({
        id: r.id,
        anomalyId: r.anomaly_id,
        class: r.class,
        statement: r.statement,
        distinguishingTest: r.distinguishing_test,
      }),
    );
  }

  // ------------------------------------------------------------------ probes

  /**
   * Pre-register a probe: prediction, its hash and committedAt are written in one INSERT, before
   * any HTTP call. Returns the stored prediction hash.
   */
  commitProbe(p: ProbeCommit): string {
    if (Number.isNaN(Date.parse(p.committedAt))) throw new Error(`commitProbe: invalid committedAt ${p.committedAt}`);
    const hash = predictionHash(p.prediction);
    this.seq += 1;
    this.db
      .prepare(
        `INSERT INTO probes (id, run_id, tool, claim_id, hypothesis_ids_json, template, params_json, control_json,
           prediction_json, prediction_hash, committed_at, trace_id, span_id, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.runId,
        p.tool,
        p.claimId,
        json(p.hypothesisIds),
        p.template,
        json(p.params),
        p.control === undefined ? null : json(p.control),
        // canonical form, so the hash can be recomputed from exactly what is stored
        canonicalJson(p.prediction),
        hash,
        p.committedAt,
        p.traceId,
        p.spanId ?? null,
        this.seq,
      );
    return hash;
  }

  /** True once the probe's prediction row exists (the commit-then-run assertion). */
  isCommitted(probeId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM probes WHERE id = ?").get(probeId) !== undefined;
  }

  committedAt(probeId: string): string | undefined {
    const row = this.db.prepare("SELECT committed_at FROM probes WHERE id = ?").get(probeId) as Row | undefined;
    return row ? str(row.committed_at) : undefined;
  }

  /**
   * Record a probe's outcome. Only result columns are written. Refuses when the stored prediction
   * no longer hashes to its committed hash, when `expectedHash` differs, or when a result was
   * already recorded.
   */
  recordResult(probeId: string, expectedHash: string, r: ProbeResult): void {
    const row = this.db
      .prepare("SELECT prediction_json, prediction_hash, verdict FROM probes WHERE id = ?")
      .get(probeId) as Row | undefined;
    if (!row) throw new Error(`recordResult: probe ${probeId} was never committed`);
    const stored = str(row.prediction_hash);
    const recomputed = predictionHash(JSON.parse(str(row.prediction_json)) as Record<string, unknown>);
    if (recomputed !== stored) {
      throw new PredictionImmutableError(`probe ${probeId}: stored prediction no longer matches its committed hash`);
    }
    if (stored !== expectedHash) {
      throw new PredictionImmutableError(`probe ${probeId}: prediction hash ${stored.slice(0, 12)} != committed ${expectedHash.slice(0, 12)}`);
    }
    if (row.verdict != null) throw new PredictionImmutableError(`probe ${probeId}: result already recorded`);
    if (r.verdict === "confirmed" && !r.winningHypothesisId) throw new Error("recordResult: confirmed needs winningHypothesisId");
    if (r.verdict !== "confirmed" && r.winningHypothesisId) throw new Error("recordResult: winningHypothesisId only with confirmed");
    this.db
      .prepare(
        `UPDATE probes SET observed_json = ?, control_observed_json = ?, verdict = ?, winning_hypothesis_id = ?,
           ran_at = ?, cost_credits = ?, calls = ?
         WHERE id = ? AND prediction_hash = ?`,
      )
      .run(
        json(r.observed),
        r.controlObserved === undefined ? null : json(r.controlObserved),
        r.verdict,
        r.winningHypothesisId ?? null,
        r.ranAt,
        r.costCredits,
        r.calls,
        probeId,
        expectedHash,
      );
  }

  /** Attach the neatlogs span id once known (not part of the pre-registration). */
  setSpanId(probeId: string, spanId: string): void {
    this.db.prepare("UPDATE probes SET span_id = ? WHERE id = ?").run(spanId, probeId);
  }

  /** All probes of a run in commit order, validated against the frozen Probe schema. */
  loadProbes(runId: string): Probe[] {
    const rows = this.db.prepare("SELECT * FROM probes WHERE run_id = ? ORDER BY seq").all(runId) as Row[];
    return rows.map((r) => this.toProbe(r));
  }

  /** Every probe run on these claims (any run), in commit order, with the run that ran it. */
  loadProbesByClaims(claimIds: readonly string[]): Array<{ runId: string; probe: Probe }> {
    if (claimIds.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM probes WHERE claim_id IN (${claimIds.map(() => "?").join(", ")}) ORDER BY seq`)
      .all(...claimIds) as Row[];
    return rows.map((r) => ({ runId: str(r.run_id), probe: this.toProbe(r) }));
  }

  /** Probes by id (any run); unknown ids are skipped. */
  loadProbesByIds(ids: readonly string[]): Probe[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM probes WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY seq`)
      .all(...ids) as Row[];
    return rows.map((r) => this.toProbe(r));
  }

  private toProbe(r: Row): Probe {
    const control =
      r.control_json == null
        ? undefined
        : {
            ...(JSON.parse(str(r.control_json)) as { params: Record<string, unknown> }),
            ...(r.control_observed_json == null ? {} : { observed: JSON.parse(str(r.control_observed_json)) }),
          };
    return ProbeSchema.parse({
      id: r.id,
      tool: r.tool,
      claimId: r.claim_id,
      hypothesisIds: JSON.parse(str(r.hypothesis_ids_json)),
      template: r.template,
      params: JSON.parse(str(r.params_json)),
      ...(control === undefined ? {} : { control }),
      prediction: JSON.parse(str(r.prediction_json)),
      predictionHash: r.prediction_hash,
      committedAt: r.committed_at,
      ...(r.ran_at == null ? {} : { ranAt: r.ran_at }),
      ...(r.observed_json == null ? {} : { observed: JSON.parse(str(r.observed_json)) }),
      ...(r.verdict == null ? {} : { verdict: r.verdict }),
      ...(r.winning_hypothesis_id == null ? {} : { winningHypothesisId: r.winning_hypothesis_id }),
      costCredits: Number(r.cost_credits),
      calls: Number(r.calls),
      traceId: r.trace_id,
      ...(r.span_id == null ? {} : { spanId: r.span_id }),
    });
  }
}

export function openDb(path: string = DEFAULT_DB_PATH): NotaryDb {
  return new NotaryDb(path);
}

/** runs/<runId>/ next to the default db file. */
export function runDir(runId: string, runsDir: string = dirname(DEFAULT_DB_PATH)): string {
  return join(runsDir, runId);
}
