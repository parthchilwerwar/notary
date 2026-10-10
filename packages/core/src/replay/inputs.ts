/**
 * The replay record of a live run (P8): cassette `<runId>-inputs`, one exchange (op
 * `notary.inputs`) whose body holds everything a replay needs besides the tool and model traffic:
 *
 *   - the identity runId (probe ids and request tags are derived from it, not from the replay's id),
 *   - the seed, variant, tool, and every run parameter that otherwise comes from the environment
 *     (credit budget, probes per claim, λ, prior strength, adversary backend, client timeout),
 *   - sha256 of each input file (queue, expected outcomes, seed manifest) — replay refuses changed files,
 *   - the recorded transfer-priors source beliefs and the probe payment pool,
 *   - a snapshot of the Notary store tables BEFORE the run (beliefs, their probes and events,
 *     probes, hypotheses, guards), so a replay starts from the same state in a scratch store.
 *
 * It is a normal cassette, so its content hash is verified on load and pinned in the bundle.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BeliefStore } from "../beliefs/store.js";
import { GuardRegistry } from "../guards/registry.js";
import type { Belief, Tool } from "../schema/index.js";
import { NotaryDb } from "../store/db.js";
import { canonicalJson, computeContentHash, saveCassette } from "../tools/index.js";
import type { Cassette, Exchange } from "../tools/index.js";

export const INPUTS_OP = "notary.inputs";
export const INPUTS_VERSION = 1;

/** Store tables a run reads; run-state tables (resume bookkeeping) are not needed to replay. */
export const SNAPSHOT_TABLES = ["beliefs", "belief_probes", "belief_events", "probes", "hypotheses", "guards"] as const;

export type SqlValue = string | number | null;
export type StoreSnapshot = Record<string, Array<Record<string, SqlValue>>>;

export interface FilePin {
  /** As given to the run (for messages). */
  path: string;
  sha256: string;
}

export interface ReplayInputs {
  version: number;
  runId: string;
  kind: "run" | "notarize";
  variant: "naive" | "guarded" | "notarize";
  tool?: Tool;
  seed: number;
  /** Probe ids and request tags were derived from this runId. */
  identityRunId: string;
  /** A `notarize --recon-only` run (recon + checker only, no model calls, no store). */
  reconOnly?: boolean;
  params: {
    creditBudget: number;
    maxProbesPerClaim?: number;
    maxProbesPerRun?: number;
    lambda?: number;
    priorStrength?: number;
    adversary?: "bedrock" | "session";
    clientTimeoutMs?: number;
  };
  files: { queue?: FilePin; expected?: FilePin; manifest?: FilePin };
  priorsSource?: { from: Tool; runId: string; beliefsAfter: Belief[] };
  paymentPool?: string[];
  /** Probe subscription pool (change-plan probes); absent in records made before it existed. */
  subscriptionPool?: string[];
  /** null for runs that use no store (naive). */
  store: StoreSnapshot | null;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const CORE_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** Pin a file by sha256; paths inside packages/core are stored relative to it (so a clone resolves them). */
export function pinFile(path: string): FilePin {
  const rel = relative(CORE_DIR, path);
  const portable = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : path;
  return { path: portable, sha256: sha256File(path) };
}

/** Absolute path of a pinned file (relative pins resolve against packages/core). */
export function pinnedPath(pin: FilePin): string {
  return isAbsolute(pin.path) ? pin.path : join(CORE_DIR, pin.path);
}

function toSql(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return Number(v);
  return String(v);
}

/** Every row of the snapshot tables that exist in `db`, in rowid order. */
export function snapshotStore(db: NotaryDb): StoreSnapshot {
  const out: StoreSnapshot = {};
  const existing = new Set(
    (db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: unknown }>).map((r) => String(r.name)),
  );
  for (const table of SNAPSHOT_TABLES) {
    if (!existing.has(table)) continue;
    const rows = db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    out[table] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toSql(v)])));
  }
  return out;
}

/** A scratch in-memory store holding exactly the snapshot's rows (schemas created by their owners). */
export function restoreStore(snapshot: StoreSnapshot | null): NotaryDb {
  const db = new NotaryDb(":memory:");
  new BeliefStore(db);
  new GuardRegistry(db);
  for (const table of SNAPSHOT_TABLES) {
    const rows = snapshot?.[table] ?? [];
    if (rows.length === 0) continue;
    const cols = new Set((db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: unknown }>).map((c) => String(c.name)));
    for (const row of rows) {
      const keys = Object.keys(row).filter((k) => cols.has(k));
      db.db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k] ?? null));
    }
  }
  // New probes are numbered after the highest restored one, as in the original store.
  db.syncSeq();
  return db;
}

// ---------------------------------------------------------------------------------------------
// The inputs cassette

export function inputsCassette(name: string, inputs: ReplayInputs): Cassette {
  const body = { runId: inputs.runId };
  const requestHash = createHash("sha256").update(canonicalJson({ op: INPUTS_OP, body })).digest("hex");
  const exchange: Exchange = {
    id: `${INPUTS_OP}#${requestHash.slice(0, 12)}#0`,
    tool: "notary",
    op: INPUTS_OP,
    method: "GET",
    url: `notary://inputs/${inputs.runId}`,
    requestHeaders: {},
    requestBody: body,
    status: 200,
    responseHeaders: {},
    responseBody: inputs,
    latencyMs: 0,
    credits: null,
    recordedAt: new Date().toISOString(),
    requestHash,
    occurrence: 0,
  };
  return { name, tool: "notary", createdAt: exchange.recordedAt, exchanges: [exchange], contentHash: computeContentHash([exchange]) };
}

export function saveInputs(name: string, inputs: ReplayInputs, dir?: string): Cassette {
  const c = inputsCassette(name, inputs);
  saveCassette(c, dir);
  return c;
}

export function readInputs(cassette: Cassette): ReplayInputs {
  const ex = cassette.exchanges.find((e) => e.op === INPUTS_OP);
  if (!ex) throw new Error(`cassette ${cassette.name} holds no ${INPUTS_OP} record`);
  const inputs = ex.responseBody as ReplayInputs;
  if (inputs.version !== INPUTS_VERSION) throw new Error(`cassette ${cassette.name}: replay record version ${inputs.version}, expected ${INPUTS_VERSION}`);
  return inputs;
}
