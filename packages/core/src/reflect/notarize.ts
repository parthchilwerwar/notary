/**
 * `notary notarize --tool <t> [--replay]`: recon -> deterministic checker -> probe loop, then a
 * notarize bundle in packages/core/runs/<runId>/.
 *
 * live   — recon records into cassette `recon-<tool>`, probes into `probes-<tool>`.
 * replay — both cassettes are served (no tool network, no tool keys). Hypotheses still need the
 *          reflector model (LLM replay is P8).
 * BLOCKED (exit 3) before any network call when a tool key (live), the reflector model id or
 * AWS_REGION is missing; also when a credential error surfaces mid-run.
 *
 * P5 beliefs phase (src/beliefs/phase.ts) runs after runProbeLoop: ensure a belief per claim,
 * apply every probe (only "confirmed" moves α/β), abstain what ended between thresholds, check
 * every cited span (FR-10, from runs/<runId>/spans.jsonl written by the local span sink), then
 * the adversary (`--adversary bedrock|session`, default bedrock) reviews each candidate. A missing
 * adversary model prints BLOCKED and leaves the candidates as candidates (exit 3).
 *
 * P7 transfer priors (`--priors-from <tool>` [`--priors-bundle <path>`]): the source tool's latest
 * notarize bundle (runs/<runId>/<runId>.json, hash-verified) gives per-defect-class base rates and
 * each NEW belief of this run starts from its claim's transfer prior (src/beliefs/priors.ts).
 * Beliefs that already exist in the store keep their state. No source bundle -> BLOCKED (exit 3).
 * Every notarize bundle records probes_to_candidate_<claimId> (null if never reached) and
 * probes_to_candidate_mean; with priors also priors_strength / priors_applied / priors_informative
 * and bundle.priorsFrom.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeBundle, writeBundle } from "../bundle/index.js";
import { RUNS_DIR } from "../checker/notarize.js";
import { runRecon } from "../checker/recon.js";
import type { ReconResult } from "../checker/recon.js";
import { LlmClient, ModelConfigError } from "../llm/index.js";
import type { LlmLike, UsageMeter } from "../llm/index.js";
import type { AdversaryBackend, ReviewBeliefArgs, ReviewOutcome } from "../adversary/index.js";
import { runBeliefsPhase } from "../beliefs/phase.js";
import { loadPriorsSource, priorStrengthFromEnv, probesToCandidateMetrics, transferPriors } from "../beliefs/priors.js";
import type { PriorsSource } from "../beliefs/priors.js";
import { BeliefStore, beliefIdFor } from "../beliefs/store.js";
import { claimById } from "../contracts/index.js";
import { GuardRegistry, compileGuards, wireRetirement } from "../guards/index.js";
import type { BeliefsPhaseResult } from "../beliefs/phase.js";
import { DEFAULT_MANIFEST_PATH, loadManifest } from "../queue/manifest.js";
import type { Guard, Probe, RoleUsage, RunBundle, Tool, UsageByRole } from "../schema/index.js";
import { DEFAULT_DB_PATH, openDb } from "../store/db.js";
import { setSpanSink, spanSinkPath } from "../trace/index.js";
import {
  CreditLedger,
  DEFAULT_CASSETTE_DIR,
  TestModeLockError,
  createTools,
  isBlocked,
  listCassettes,
} from "../tools/index.js";
import type { Cassette } from "../tools/index.js";
import { maxProbesPerClaimFromEnv, runProbeLoop } from "./loop.js";
import type { ProbeLoopResult } from "./loop.js";
import { BurstCounter, SimplePaymentPool, probeIoFromTools } from "./templates/index.js";
import type { ProbeIo } from "./templates/index.js";

export const SEEDED_QUEUE_PATH = fileURLToPath(new URL("../../fixtures/queue/seeded.json", import.meta.url));

const TOOL_KEY: Record<Tool, string> = { crustdata: "CRUSTDATA_API_KEY", dodo: "DODO_PAYMENTS_API_KEY" };

const ZERO: RoleUsage = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };

export interface NotarizeOptions {
  tool: Tool;
  replay?: boolean;
  env?: NodeJS.ProcessEnv;
  runsDir?: string;
  cassetteDir?: string;
  dbPath?: string;
  /** Injected model client (tests); default LlmClient from env. */
  llm?: LlmLike & { meter?: UsageMeter };
  manifestPath?: string;
  queuePath?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Adversary backend for candidate beliefs (default bedrock). */
  adversary?: AdversaryBackend;
  /** Injected adversary reviewer (tests); default reviewBelief. */
  review?: (args: ReviewBeliefArgs) => Promise<ReviewOutcome>;
  /** P7: start new beliefs from transfer priors learned on this tool (its latest notarize bundle). */
  priorsFrom?: Tool;
  /** P7: use this notarize bundle as the priors source instead of the latest in runsDir. */
  priorsBundle?: string;
  /** P7: prior strength in pseudo-counts; default NOTARY_PRIOR_STRENGTH, else 2. */
  priorStrength?: number;
}

/** What the bundle records about the transfer priors of a run. */
export interface PriorsContext {
  from: Tool;
  sourceRunId: string;
  strength: number;
  /** New beliefs created from a prior this run. */
  applied: number;
  /** Of those, priors other than Beta(1, 1). */
  informative: number;
  /** Beliefs that already existed (kept their state; no prior applied). */
  preexisting: number;
}

export interface NotarizeResult {
  exitCode: number;
  lines: string[];
  status: RunBundle["status"];
  runId?: string;
  bundlePath?: string;
  loop?: ProbeLoopResult;
  beliefs?: BeliefsPhaseResult;
}

function blocked(reasons: string[]): NotarizeResult {
  return { exitCode: 3, lines: reasons.map((r) => (r.startsWith("BLOCKED:") ? r : `BLOCKED: ${r}`)), status: "blocked" };
}

function compactStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Succeeded seeded payments the seeded queue never references, last handles first. */
/**
 * The raw (unguarded) REPLAY ProbeIo of every probing path: probes must see the raw recorded
 * response to confirm or refute a belief (DECISIONS #56), so this module is the one place outside
 * recon that builds unwrapped tools. Used by `--compare-priors` (src/reflect/compare-priors.ts)
 * and drift replay (src/beliefs/drift.ts). Replay only: no network, no keys.
 */
export function rawReplayProbeIo(opts: {
  cassette?: string;
  cassettes?: Cassette[];
  cassetteDir?: string;
  ledger: CreditLedger;
  env?: NodeJS.ProcessEnv;
}): ProbeIo {
  return probeIoFromTools(
    createTools({
      mode: "replay",
      ...(opts.cassette ? { cassette: opts.cassette } : {}),
      ...(opts.cassettes ? { cassettes: opts.cassettes } : {}),
      ...(opts.cassetteDir ? { cassetteDir: opts.cassetteDir } : {}),
      ledger: opts.ledger,
      env: opts.env ?? {},
    }),
  );
}

export function probePaymentPool(manifestPath: string, queuePath: string): { ids: string[]; note?: string } {
  if (!existsSync(manifestPath)) return { ids: [], note: "no seed manifest: refund probes are skipped" };
  const manifest = loadManifest(manifestPath);
  const queueText = existsSync(queuePath) ? readFileSync(queuePath, "utf8") : "";
  const used = new Set([...queueText.matchAll(/"pay:([A-Za-z0-9._-]+)"/g)].map((m) => m[1]!));
  const ids = Object.entries(manifest.payments)
    .filter(([handle, p]) => !used.has(handle) && p.status === "succeeded")
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([, p]) => p.paymentId);
  return { ids };
}

export function preflight(opts: Pick<NotarizeOptions, "tool" | "replay" | "llm">, env: NodeJS.ProcessEnv): { llm?: LlmLike & { meter?: UsageMeter }; result?: NotarizeResult } {
  const reasons: string[] = [];
  if (!opts.replay && !(env[TOOL_KEY[opts.tool]] ?? "").trim()) reasons.push(`${TOOL_KEY[opts.tool]} not set`);
  let llm = opts.llm;
  if (!llm) {
    let client: LlmClient;
    try {
      client = new LlmClient({ env });
    } catch (err) {
      if (err instanceof ModelConfigError) return { result: { exitCode: 1, lines: [err.message], status: "failed" } };
      throw err;
    }
    try {
      client.modelFor("reflector");
    } catch (err) {
      if (isBlocked(err)) reasons.push(err.message);
      else throw err;
    }
    if (!(env.AWS_REGION ?? "").trim()) reasons.push("AWS_REGION not set");
    llm = client;
  }
  if (reasons.length) return { result: blocked(reasons) };
  return { llm };
}

function countVerdicts(probes: readonly Probe[]): Record<string, number> {
  const out: Record<string, number> = { confirmed: 0, refuted: 0, inconclusive: 0, uninformative: 0, invalid: 0 };
  for (const p of probes) if (p.verdict) out[p.verdict] = (out[p.verdict] ?? 0) + 1;
  return out;
}

export async function notarize(opts: NotarizeOptions): Promise<NotarizeResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const mode = opts.replay ? "replay" : "live";
  const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;

  const runsDir = opts.runsDir ?? RUNS_DIR;

  // P7: the priors source is checked first, so a missing one is reported with any other BLOCKED reason.
  let source: PriorsSource | undefined;
  if (opts.priorsFrom) {
    if (opts.priorsFrom === opts.tool) {
      return { exitCode: 1, lines: [`--priors-from must name the other tool (got ${opts.priorsFrom} for --tool ${opts.tool})`], status: "failed" };
    }
    source = loadPriorsSource({ tool: opts.priorsFrom, runsDir, ...(opts.priorsBundle ? { bundlePath: opts.priorsBundle } : {}) });
  }
  const pre = preflight(opts, env);
  if (source?.blocked) return blocked([source.blocked, ...(pre.result?.status === "blocked" ? pre.result.lines : [])]);
  if (pre.result) return pre.result;
  const llm = pre.llm!;

  if (opts.replay) {
    const have = listCassettes(cassetteDir);
    const missing = [`recon-${opts.tool}`, `probes-${opts.tool}`].filter((c) => !have.includes(c));
    if (missing.length) {
      return {
        exitCode: 1,
        lines: [`No cassette ${missing.join(", ")} in ${cassetteDir}; record with a live notarize run first.`],
        status: "failed",
      };
    }
  }

  const started = now();
  const ledger = new CreditLedger({ env });
  const db = openDb(opts.dbPath ?? DEFAULT_DB_PATH);
  const previousSink = spanSinkPath();
  try {
    let recon: ReconResult;
    let loop: ProbeLoopResult;
    try {
      recon = await runRecon({
        tool: opts.tool,
        mode,
        cassetteDir,
        ledger,
        env,
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
      });
      const runId =
        mode === "replay" ? `notarize-${opts.tool}-replay-${recon.cassetteHash.slice(0, 12)}` : `notarize-${opts.tool}-${compactStamp(started)}`;
      // Local span sink: every span of this run (probes included) lands in runs/<runId>/spans.jsonl.
      setSpanSink(join(runsDir, runId, "spans.jsonl"));
      const tools = createTools({ mode, cassette: `probes-${opts.tool}`, cassetteDir, ledger, env });
      // Beliefs before this run; the probe loop updates them verdict by verdict.
      const claims = recon.entries.map((e) => e.claim);
      const beliefStore = new BeliefStore(db, opts.now ? { now: opts.now } : {});
      // A belief that leaves notarized (unlearned, invalid evidence) retires its guards at once (FR-8).
      const registry = new GuardRegistry(db, { now });
      const unwire = wireRetirement(beliefStore, registry);
      const eventsSince = beliefStore.lastEventSeq();
      // P7: transfer priors for the beliefs this run creates (existing beliefs keep their state).
      const strength = opts.priorStrength ?? priorStrengthFromEnv(env);
      const transfer = source?.bundle
        ? transferPriors({ sourceBeliefs: source.bundle.beliefs.after, targetClaims: claims, strength, from: opts.priorsFrom! })
        : undefined;
      const priors = transfer?.priors;
      const preexisting = new Set(claims.filter((c) => beliefStore.byClaim(c.id)).map((c) => c.id));
      for (const c of claims) beliefStore.ensure(c, priors?.[c.id]);
      const priorsContext: PriorsContext | undefined = transfer
        ? {
            from: transfer.from,
            sourceRunId: source!.bundle!.runId,
            strength,
            applied: claims.filter((c) => !preexisting.has(c.id)).length,
            informative: transfer.perClaim.filter((p) => p.informative && !preexisting.has(p.claimId)).length,
            preexisting: preexisting.size,
          }
        : undefined;
      const beliefsBefore = beliefStore.list(opts.tool);
      const pool = opts.tool === "dodo" ? probePaymentPool(opts.manifestPath ?? DEFAULT_MANIFEST_PATH, opts.queuePath ?? SEEDED_QUEUE_PATH) : { ids: [] };
      loop = await runProbeLoop({
        tool: opts.tool,
        anomalies: recon.anomalies,
        claims: recon.entries.map((e) => e.claim),
        entries: recon.entries,
        tools: probeIoFromTools(tools, opts.sleep ? { sleep: opts.sleep } : {}),
        llm,
        db,
        runId,
        ledger,
        beliefs: beliefStore,
        maxProbesPerClaim: maxProbesPerClaimFromEnv(env),
        burst: new BurstCounter(),
        payments: new SimplePaymentPool(pool.ids),
        ...(priors ? { priors } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      const abstainedClaimIds = recon.anomalies.filter((an) => loop.abstained.includes(an.id)).map((an) => an.claimId);
      const beliefs = await runBeliefsPhase({
        db,
        store: beliefStore,
        before: beliefsBefore,
        eventsSince,
        tool: opts.tool,
        runsDir,
        claims,
        probes: loop.probes,
        hypotheses: loop.hypotheses,
        stoppedReason: recon.stoppedReason ?? loop.stoppedReason,
        abstainedClaimIds,
        backend: opts.adversary ?? "bedrock",
        llm,
        env,
        ...(priors ? { priors } : {}),
        ...(opts.review ? { review: opts.review } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      // Compile the notarized beliefs (all tools) into the registry; this tool's guards go in the bundle.
      const allBeliefs = beliefStore.list();
      const cited = [...new Set(allBeliefs.filter((b) => b.status === "notarized").flatMap((b) => b.evidence.map((e) => e.probeId)))];
      registry.sync(
        compileGuards({
          beliefs: allBeliefs,
          claimFor: (claimId) => claimById(claimId) ?? (beliefStore.byClaim(claimId) ? beliefStore.claimFor(beliefIdFor(claimId)) : undefined),
          probes: db.loadProbesByIds(cited),
          now,
        }),
      );
      unwire();
      const guards = registry.all().filter((g) => g.operation.startsWith(`${opts.tool}.`));
      return await writeNotarizeBundle({
        opts,
        mode,
        runId,
        started,
        now,
        recon,
        loop,
        beliefs,
        ledger,
        llm,
        poolNote: pool.note,
        guards,
        ...(priorsContext ? { priors: priorsContext } : {}),
      });
    } catch (err) {
      if (isBlocked(err) || err instanceof TestModeLockError) return blocked([err.message]);
      throw err;
    }
  } finally {
    setSpanSink(previousSink);
    db.close();
  }
}

async function writeNotarizeBundle(a: {
  opts: NotarizeOptions;
  mode: "live" | "replay";
  runId: string;
  started: Date;
  now: () => Date;
  recon: ReconResult;
  loop: ProbeLoopResult;
  beliefs: BeliefsPhaseResult;
  ledger: CreditLedger;
  llm: LlmLike & { meter?: UsageMeter };
  poolNote?: string | undefined;
  guards: Guard[];
  priors?: PriorsContext;
}): Promise<NotarizeResult> {
  const { recon, loop, ledger, runId, beliefs } = a;
  const tool = a.opts.tool;
  const stopReason = recon.stoppedReason ?? loop.stoppedReason;
  const status: RunBundle["status"] = stopReason ? "stopped_budget" : "completed";
  const usageByRole: UsageByRole = a.llm.meter?.snapshot() ?? { executor: ZERO, reflector: loop.usage, adversary: ZERO };
  const verdicts = countVerdicts(loop.probes);
  const disclosure = [
    "Notarize run: anomalies from the deterministic checker, rival hypotheses proposed by the reflector model, probes with predictions committed before each call, verdicts by deterministic rules. Beliefs are Beta(α, β) over the doc claim holding (only confirmed probes update), every cited span is checked against runs/<runId>/spans.jsonl, and candidates are reviewed by the adversary.",
  ];
  if (beliefs.adversaryBlocked) disclosure.push(`Adversary review did not run (${beliefs.adversaryBlocked}); candidate beliefs stay candidates.`);
  if (a.mode === "replay") disclosure.push("Replayed from cassettes; no tool network calls.");
  if (tool === "dodo") disclosure.push("Dodo Payments test mode only; refund probes use seeded payments the seeded queue does not reference.");
  if (a.priors) {
    disclosure.push(
      `Transfer priors from ${a.priors.from} notarize bundle ${a.priors.sourceRunId}: each new belief started from Beta(1 + s(1 - r), 1 + s*r), r = the ${a.priors.from} base rate of its claim's suspected defect class, s = ${a.priors.strength} pseudo-counts (Beta(1, 1) when ${a.priors.from} settled nothing relevant).`,
    );
  }
  const claimIds = recon.entries.map((e) => e.claim.id);
  const ptc = probesToCandidateMetrics(beliefs.after, claimIds);

  const bundle = finalizeBundle({
    runId,
    kind: "notarize",
    variant: "notarize",
    mode: a.mode,
    sample: false,
    disclosure,
    startedAt: a.started.toISOString(),
    finishedAt: a.now().toISOString(),
    status,
    ...(stopReason ? { stopReason } : {}),
    seed: 0,
    tool,
    ...(a.priors ? { priorsFrom: a.priors.from } : {}),
    queue: [],
    decisions: [],
    claims: recon.entries.map((e) => e.claim),
    anomalies: recon.anomalies,
    hypotheses: loop.hypotheses,
    probes: loop.probes,
    beliefs: { before: beliefs.before, after: beliefs.after },
    beliefEvents: beliefs.events,
    guards: a.guards,
    usageByRole,
    credits: { byEndpoint: ledger.byEndpoint, total: ledger.total, budget: ledger.budget },
    metrics: {
      claims: recon.entries.length,
      anomalies: recon.anomalies.length,
      hypotheses: loop.hypotheses.length,
      hypothesesRejected: loop.rejected.length,
      probes: loop.probes.length,
      ...Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [`probes.${k}`, v])),
      abstained: loop.abstained.length,
      anomaliesSkipped: loop.skipped.length,
      ...Object.fromEntries(
        (["hypothesis", "candidate", "notarized", "refuted", "abstained", "unlearned"] as const).map((st) => [
          `beliefs.${st}`,
          beliefs.after.filter((b) => b.status === st).length,
        ]),
      ),
      "evidence.checked": beliefs.evidence.checked,
      "evidence.invalid": beliefs.evidence.invalid,
      "adversary.uphold": beliefs.reviews.uphold,
      "adversary.narrow": beliefs.reviews.narrow,
      "adversary.downgrade": beliefs.reviews.downgrade,
      "adversary.failed": beliefs.reviews.failed,
      probes_to_candidate_mean: ptc.mean,
      ...Object.fromEntries(Object.entries(ptc.perClaim).map(([id, n]) => [`probes_to_candidate_${id}`, n])),
      ...(a.priors
        ? {
            priors_strength: a.priors.strength,
            priors_applied: a.priors.applied,
            priors_informative: a.priors.informative,
            priors_preexisting: a.priors.preexisting,
          }
        : {}),
    },
    traceLinks: {},
    cassettes: [`recon-${tool}`, `probes-${tool}`],
  });
  const dir = join(a.opts.runsDir ?? RUNS_DIR, runId);
  const { bundlePath } = await writeBundle(bundle, dir);

  const lines = [
    `notarize: tool=${tool} mode=${a.mode} runId=${runId}`,
    `claims: ${recon.entries.length}  anomalies: ${recon.anomalies.length}  hypotheses: ${loop.hypotheses.length} (rejected ${loop.rejected.length})`,
    `probes: ${loop.probes.length}  ${Object.entries(verdicts).map(([k, v]) => `${k}=${v}`).join(" ")}  abstained: ${loop.abstained.length}`,
    `claims probed: ${loop.claimOutcomes.length}  ${(["candidate", "abstained", "open"] as const).map((o) => `${o}=${loop.claimOutcomes.filter((c) => c.outcome === o).length}`).join(" ")}`,
    `credits: ${ledger.total}/${ledger.budget}  reflector: ${usageByRole.reflector.calls} calls, $${usageByRole.reflector.usd}`,
  ];
  lines.push(...beliefs.lines);
  lines.push(`probes to candidate: mean ${ptc.mean ?? "n/a"} over ${ptc.reached}/${claimIds.length} claims that reached candidate`);
  if (a.priors) {
    lines.push(
      `priors: from ${a.priors.from} (${a.priors.sourceRunId}), strength ${a.priors.strength}: applied to ${a.priors.applied} new belief(s), ${a.priors.informative} informative; ${a.priors.preexisting} existing belief(s) kept their state`,
    );
  }
  if (a.poolNote) lines.push(`note: ${a.poolNote}`);
  for (const s of loop.skipped) lines.push(`skipped ${s.anomalyId}: ${s.reason}`);
  if (stopReason) lines.push(`STOPPED: ${stopReason}`);
  lines.push(`bundle: ${bundlePath}`);
  const blockedCandidates = beliefs.adversaryBlocked !== undefined && beliefs.after.some((b) => b.status === "candidate");
  return { exitCode: blockedCandidates ? 3 : 0, lines, status, runId, bundlePath, loop, beliefs };
}
