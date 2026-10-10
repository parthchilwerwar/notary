/**
 * Commit, then run (TDD "The notarization loop", step 5).
 *
 * For one selected probe:
 *   1. budget: reserve the design's estimated credits on the run ledger (BudgetExceededError ->
 *      nothing is committed or sent; the caller stops cleanly). The reservation is released right
 *      before execution because each Crustdata call reserves its own cost again.
 *   2. open the neatlogs span "notary.probe" with notary.probeId / claimId / template /
 *      prediction (canonical JSON of every hypothesis's prediction) / predictionHash,
 *   3. commitProbe: prediction + hash + committedAt into SQLite BEFORE any HTTP call. The IO handed
 *      to the template refuses every call until that row exists (CommitOrderError),
 *   4. execute -> observe -> verdict -> recordResult (refused if the prediction hash changed),
 *   5. set notary.verdict on the span.
 * Errors during execution still get a result row: BudgetExceededError / BurstCapError record an
 * "uninformative" result and return `stoppedReason`; anything else (BLOCKED, cassette miss)
 * records "uninformative" with the error and is rethrown.
 */
import { canonicalJson } from "../bundle/hash.js";
import { predictionHash as hashPrediction } from "../store/db.js";
import type { NotaryDb } from "../store/db.js";
import { ProbeSchema } from "../schema/index.js";
import type { Claim, Probe } from "../schema/index.js";
import { traceLog, withSpan } from "../trace/index.js";
import { BudgetExceededError } from "../tools/index.js";
import type { CreditLedger } from "../tools/index.js";
import { BurstCapError } from "./templates/types.js";
import type { ProbeContext, ProbeDesign, ProbeIo, ProbeObservation, ProbeTemplateModule, TaggedExchange } from "./templates/types.js";
import { judge } from "./verdict.js";
import type { VerdictResult } from "./verdict.js";

export class CommitOrderError extends Error {
  constructor(probeId: string, op: string) {
    super(`commit-then-run violated: ${op} called before probe ${probeId} was committed`);
    this.name = "CommitOrderError";
  }
}

export interface RunProbeOptions {
  io: ProbeIo;
  db: NotaryDb;
  runId: string;
  probeId: string;
  claim: Claim;
  template: ProbeTemplateModule;
  design: ProbeDesign;
  ctx: ProbeContext;
  ledger: CreditLedger;
  now?: () => Date;
}

export interface RunProbeResult {
  probe: Probe;
  verdict: VerdictResult;
  observation: ProbeObservation | null;
  exchanges: TaggedExchange[];
  stoppedReason?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export async function runProbe(opts: RunProbeOptions): Promise<RunProbeResult> {
  const { db, design, template, claim, probeId, ledger } = opts;
  const now = opts.now ?? (() => new Date());
  const predictions = design.predictions as Record<string, unknown>;
  const hash = hashPrediction(predictions);
  const hypothesisIds = Object.keys(design.predictions).sort();

  // 1. Budget: reserve before running; throws BudgetExceededError before anything is committed.
  const reservation = `probe:${template.name}`;
  ledger.reserve(reservation, design.estCredits);
  ledger.release(reservation);

  let traceId = "";
  let spanId: string | undefined;
  let setAttr: ((k: string, v: string | number | boolean) => void) | undefined;

  return withSpan(
    "notary.probe",
    {
      "notary.probeId": probeId,
      "notary.claimId": claim.id,
      "notary.template": template.name,
      "notary.prediction": canonicalJson(predictions),
      "notary.predictionHash": hash,
    },
    async (): Promise<RunProbeResult> => {
      // 3. Commit before any HTTP call.
      const committedAt = now().toISOString();
      const control = { params: design.control.params as Record<string, unknown> };
      const stored = db.commitProbe({
        id: probeId,
        runId: opts.runId,
        tool: claim.tool,
        claimId: claim.id,
        hypothesisIds,
        template: template.name,
        params: design.params as Record<string, unknown>,
        control,
        prediction: predictions,
        committedAt,
        traceId,
        ...(spanId ? { spanId } : {}),
      });
      if (stored !== hash) throw new Error(`probe ${probeId}: stored prediction hash differs from the span's`);
      traceLog("notary.probe.committed", { "notary.probeId": probeId, "notary.predictionHash": hash, "notary.committedAt": committedAt });

      const guardedIo: ProbeIo = {
        sleep: (ms) => opts.io.sleep(ms),
        call: (op, args) => {
          if (!db.isCommitted(probeId)) return Promise.reject(new CommitOrderError(probeId, op));
          return opts.io.call(op, args);
        },
      };

      // 4. Execute -> observe -> verdict.
      const creditsBefore = ledger.total;
      const callsBefore = Object.values(ledger.snapshot().calls).reduce((a, b) => a + b, 0);
      let exchanges: TaggedExchange[] = [];
      let observation: ProbeObservation | null = null;
      let verdict: VerdictResult;
      let stoppedReason: string | undefined;
      let rethrow: unknown;
      try {
        exchanges = await template.execute(guardedIo, design, opts.ctx);
        observation = template.observe(exchanges, design, claim);
        verdict = judge(template, design, observation);
      } catch (err) {
        if (err instanceof BudgetExceededError || err instanceof BurstCapError) stoppedReason = err.message;
        else rethrow = err;
        verdict = {
          verdict: "uninformative",
          refutedIds: [],
          needsRepropose: false,
          reason: `probe did not complete: ${errorText(err)}`,
        };
      }
      const ranAt = now().toISOString();
      const callsAfter = Object.values(ledger.snapshot().calls).reduce((a, b) => a + b, 0);
      const calls = Math.max(exchanges.length, callsAfter - callsBefore);
      const costCredits = Math.max(0, Math.round((ledger.total - creditsBefore) * 1e6) / 1e6);
      const observed = observation
        ? {
            outcome: observation.outcome,
            ...observation.treatment,
            ...(observation.note ? { note: observation.note } : {}),
            ...(observation.missingPaths?.length ? { missingPaths: [...observation.missingPaths] } : {}),
            reason: verdict.reason,
          }
        : { outcome: null, error: errorText(rethrow ?? stoppedReason), reason: verdict.reason };
      const controlObserved = observation ? observation.control : undefined;

      db.recordResult(probeId, hash, {
        observed,
        ...(controlObserved === undefined ? {} : { controlObserved }),
        verdict: verdict.verdict,
        ...(verdict.winningHypothesisId ? { winningHypothesisId: verdict.winningHypothesisId } : {}),
        ranAt,
        costCredits,
        calls,
      });
      setAttr?.("notary.verdict", verdict.verdict);
      if (verdict.winningHypothesisId) setAttr?.("notary.winningHypothesisId", verdict.winningHypothesisId);
      if (rethrow !== undefined) throw rethrow;

      const probe = ProbeSchema.parse({
        id: probeId,
        tool: claim.tool,
        claimId: claim.id,
        hypothesisIds,
        template: template.name,
        params: design.params,
        control: { ...control, ...(controlObserved === undefined ? {} : { observed: controlObserved }) },
        prediction: predictions,
        predictionHash: hash,
        committedAt,
        ranAt,
        observed,
        verdict: verdict.verdict,
        ...(verdict.winningHypothesisId ? { winningHypothesisId: verdict.winningHypothesisId } : {}),
        costCredits,
        calls,
        traceId,
        ...(spanId ? { spanId } : {}),
      });
      return { probe, verdict, observation, exchanges, ...(stoppedReason ? { stoppedReason } : {}) };
    },
    {
      kind: "TOOL",
      onSpan: (ids, set) => {
        traceId = ids.traceId;
        spanId = ids.spanId;
        setAttr = set;
      },
    },
  );
}

