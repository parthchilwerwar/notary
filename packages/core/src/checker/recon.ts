/**
 * Recon sweep (BUILD_PLAN P2): run each contract entry's cheap recon steps through createTools,
 * associate the exchanges they produce with the entry's claim, and check them.
 *
 * live   — records everything into the cassette `recon-<tool>` (written after every exchange).
 * replay — serves the same cassette; no network, no keys, no waiting.
 *
 * Step params. Ops whose client method takes a params object get `step.params` as that object.
 * Ops whose URL carries an id (RECON_PATH_PARAMS in src/contracts) get it as the first argument;
 * the remaining keys, if any, become the params object. Any value that is exactly
 * "$from:<stepIndex>:<path>" is replaced by the value at <path> in the response body of that
 * earlier step's first 2xx exchange (a path with `[]` resolves to the list of values). A step
 * whose ref can't resolve is skipped with a recorded reason. A `setup` step runs and feeds refs,
 * but its exchanges are not associated with the claim (not checked against it).
 *
 * Safety: `repeat` is clamped to maxRepeat and `delayMs` to maxDelayMs. BudgetExceededError stops
 * the sweep cleanly (the reason is returned). MissingCredentialError and TestModeLockError
 * propagate: the caller reports BLOCKED. A replay cassette miss propagates (replay fails loudly).
 */
import { RECON_PATH_PARAMS, contractFor } from "../contracts/index.js";
import type { ContractEntry, ReconStep } from "../contracts/types.js";
import type { Anomaly, Tool } from "../schema/index.js";
import { tracingEnabled, withSpan } from "../trace/index.js";
import type { SpanIds } from "../trace/index.js";
import { anomalySummary } from "../incidents/derive.js";
import { reportIncident } from "../incidents/live.js";
import {
  BudgetExceededError,
  CRUSTDATA_OPS,
  CassetteMissError,
  CreditLedger,
  DODO_OPS,
  TestModeLockError,
  createTools,
  isBlocked,
  loadCassette,
} from "../tools/index.js";
import type { Exchange, RecorderMode, Tools } from "../tools/index.js";
import { checkAll } from "./check.js";
import type { Observation } from "./check.js";
import { resolvePath } from "./path.js";

export const DEFAULT_MAX_DELAY_MS = 5000;
export const DEFAULT_MAX_REPEAT = 3;

export interface ReconStepReport {
  claimId: string;
  stepIndex: number;
  op: string;
  status: "ran" | "skipped" | "failed";
  /** A setup step: its exchanges feed refs but are not associated with the claim. */
  setup: boolean;
  /** Effective (clamped) values. */
  repeat: number;
  delayMs: number;
  /** Ids of the exchanges this step produced, in order. */
  exchangeIds: string[];
  reason?: string;
}

export interface ReconOptions {
  tool: Tool;
  mode: RecorderMode;
  /** Default `recon-<tool>`. */
  cassetteName?: string;
  /** Default: the recorder's cassette dir (packages/core/fixtures/cassettes). */
  cassetteDir?: string;
  ledger?: CreditLedger;
  maxDelayMs?: number;
  maxRepeat?: number;
  /** Default: contractFor(tool) from src/contracts. */
  entries?: ContractEntry[];
  /** live only; default process.env. */
  env?: NodeJS.ProcessEnv;
  /** live only; default setTimeout. Replay never waits. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ReconResult {
  tool: Tool;
  mode: RecorderMode;
  cassetteName: string;
  /** sha256 of the cassette's exchanges (the loaded one in replay, the recorded one in live). */
  cassetteHash: string;
  entries: ContractEntry[];
  observations: Observation[];
  anomalies: Anomaly[];
  steps: ReconStepReport[];
  creditsUsed: number;
  creditsByEndpoint: Record<string, number>;
  budget: number;
  stoppedReason?: string;
}

class UnresolvedRef extends Error {}

const FROM_REF = /^\$from:(\d+):(.*)$/;

/** Replace every "$from:<i>:<path>" value (at any depth) using earlier steps' first 2xx body. */
export function resolveRefs(value: unknown, bodies: ReadonlyArray<unknown | undefined>): unknown {
  if (typeof value === "string") {
    const m = FROM_REF.exec(value);
    if (!m) return value;
    const index = Number(m[1]);
    const path = m[2] ?? "";
    if (index >= bodies.length || bodies[index] === undefined) {
      throw new UnresolvedRef(`${value}: step ${index} has no 2xx response`);
    }
    const hits = resolvePath(bodies[index], path).filter((h) => h.found);
    if (hits.length === 0) throw new UnresolvedRef(`${value}: path not found in step ${index}'s response`);
    return path.includes("[]") ? hits.map((h) => h.value) : hits[0]!.value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, bodies));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveRefs(v, bodies);
    return out;
  }
  return value;
}

/** Arguments for an op: a leading id from RECON_PATH_PARAMS, then the remaining params object. */
export function argsFor(op: string, params: Record<string, unknown>): unknown[] {
  const key = RECON_PATH_PARAMS[op];
  if (key === undefined) return [params];
  const { [key]: id, ...rest } = params;
  if (typeof id !== "string" || id === "") throw new Error(`${op}: params.${key} must be a non-empty string`);
  return Object.keys(rest).length > 0 ? [id, rest] : [id];
}

type AnyFn = (...args: unknown[]) => Promise<unknown>;

function methodFor(tools: Tools, op: string): AnyFn | null {
  for (const [tool, ops] of [
    ["crustdata", CRUSTDATA_OPS],
    ["dodo", DODO_OPS],
  ] as const) {
    for (const [method, name] of Object.entries(ops)) {
      if (name === op) return (tools[tool] as unknown as Record<string, AnyFn>)[method] ?? null;
    }
  }
  return null;
}

function clamp(n: number | undefined, fallback: number, max: number, min: number): number {
  const v = n === undefined || !Number.isFinite(n) ? fallback : Math.floor(n);
  return Math.min(Math.max(v, min), max);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export async function runRecon(opts: ReconOptions): Promise<ReconResult> {
  const maxDelayMs = Math.max(0, opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const maxRepeat = Math.max(1, Math.floor(opts.maxRepeat ?? DEFAULT_MAX_REPEAT));
  const cassetteName = opts.cassetteName ?? `recon-${opts.tool}`;
  const sleep = opts.sleep ?? defaultSleep;
  const entries = opts.entries ?? contractFor(opts.tool);

  // The budget is configuration (CRUSTDATA_CREDIT_BUDGET), read in both modes so a replay stops
  // where the recorded run stopped.
  const ledger = opts.ledger ?? new CreditLedger({ env: opts.env ?? process.env });
  // Exchanges produced by the step currently running (steps run one at a time).
  let current: Exchange[] = [];
  const tools = createTools({
    mode: opts.mode,
    cassette: cassetteName,
    ...(opts.cassetteDir === undefined ? {} : { cassetteDir: opts.cassetteDir }),
    ledger,
    ...(opts.env === undefined ? {} : { env: opts.env }),
    onExchange: (ex) => {
      current.push(ex);
    },
  });

  const observations: Observation[] = [];
  const steps: ReconStepReport[] = [];
  let stoppedReason: string | undefined;

  // Each claim's recon span (exported spans only), so its anomalies point at the span whose exchanges they read.
  const reconSpans = new Map<string, SpanIds>();
  for (const entry of entries) {
    if (stoppedReason !== undefined) break;
    const claimId = entry.claim.id;
    const sdkOn = tracingEnabled();
    await withSpan("notary.recon", { "notary.claimId": claimId, "notary.tool": opts.tool }, async () => {
      const bodies: Array<unknown | undefined> = [];
      for (let i = 0; i < entry.recon.length; i++) {
        const step: ReconStep = entry.recon[i]!;
        const repeat = clamp(step.repeat, 1, maxRepeat, 1);
        const delayMs = clamp(step.delayMs, 0, maxDelayMs, 0);
        const report: ReconStepReport = { claimId, stepIndex: i, op: step.op, status: "ran", setup: step.setup === true, repeat, delayMs, exchangeIds: [] };
        steps.push(report);
        bodies.push(undefined);

        let args: unknown[];
        try {
          args = argsFor(step.op, resolveRefs(step.params, bodies) as Record<string, unknown>);
        } catch (err) {
          report.status = "skipped";
          report.reason = err instanceof UnresolvedRef ? `unresolved ref ${err.message}` : errorText(err);
          continue;
        }
        const method = methodFor(tools, step.op);
        if (!method) {
          report.status = "skipped";
          report.reason = `unknown op ${step.op}`;
          continue;
        }
        if (delayMs > 0 && opts.mode === "live") await sleep(delayMs);

        for (let r = 0; r < repeat; r++) {
          current = [];
          let failure: unknown;
          try {
            await method(...args);
          } catch (err) {
            failure = err;
          }
          for (const ex of current) {
            // Setup exchanges only feed "$from" refs; they are never evidence about the claim.
            if (!step.setup) observations.push({ claimId, exchange: ex });
            report.exchangeIds.push(ex.id);
            if (bodies[i] === undefined && ex.status >= 200 && ex.status < 300) bodies[i] = ex.responseBody;
          }
          if (failure === undefined) continue;
          if (isBlocked(failure) || failure instanceof TestModeLockError || failure instanceof CassetteMissError) throw failure;
          if (failure instanceof BudgetExceededError) {
            report.status = "failed";
            report.reason = failure.message;
            stoppedReason = `${failure.message} (stopped at ${claimId} step ${i})`;
            return;
          }
          // An HTTP error is data (its exchange is recorded above); anything else is noted.
          if (current.length === 0) {
            report.status = "failed";
            report.reason = errorText(failure);
            break;
          }
        }
      }
    }, { onSpan: (ids) => void (sdkOn && reconSpans.set(claimId, ids)) });
  }

  // The deterministic checker as one EVALUATOR span; each anomaly is an incident (warn log) in neatlogs.
  let anomalies: Anomaly[] = [];
  let setCheckerAttr: ((k: string, v: string | number | boolean) => void) | undefined;
  await withSpan(
    "notary.checker",
    { "notary.tool": opts.tool, "notary.checker.observations": observations.length, "notary.checker.claims": entries.length },
    () => {
      anomalies = checkAll(entries, observations).map((a) => {
        const ids = reconSpans.get(a.claimId);
        return a.traceId || !ids ? a : { ...a, traceId: ids.traceId, spanId: ids.spanId };
      });
      setCheckerAttr?.("notary.checker.anomalies", anomalies.length);
      for (const a of anomalies) {
        reportIncident({
          kind: "checker_anomaly",
          subject: a.id,
          severity: "warning",
          summary: anomalySummary(a),
          ...(a.traceId && a.spanId ? { span: { traceId: a.traceId, spanId: a.spanId } } : {}),
          attrs: { "notary.claimId": a.claimId, "notary.tool": a.tool, "notary.anomalyId": a.id },
        });
      }
      return { anomalies: anomalies.length };
    },
    { kind: "EVALUATOR", onSpan: (_ids, set) => (setCheckerAttr = set) },
  );

  const cassetteHash =
    opts.mode === "replay"
      ? loadCassette(cassetteName, opts.cassetteDir === undefined ? {} : { dir: opts.cassetteDir }).contentHash
      : tools.recorder.toCassette(cassetteName, opts.tool).contentHash;
  return {
    tool: opts.tool,
    mode: opts.mode,
    cassetteName,
    cassetteHash,
    entries,
    observations,
    anomalies,
    steps,
    creditsUsed: ledger.total,
    creditsByEndpoint: ledger.byEndpoint,
    budget: ledger.budget,
    ...(stoppedReason === undefined ? {} : { stoppedReason }),
  };
}
