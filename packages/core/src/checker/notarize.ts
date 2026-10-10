/**
 * `notary notarize --tool <t> --recon-only [--replay]`: run the recon sweep, write a notarize
 * bundle to packages/core/runs/<runId>/ and build a deterministic summary.
 *
 * Replay runIds are derived from the cassette's content hash, so two replays of the same cassette
 * write the same runId and print identical summaries (anomalies sorted by id).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, finalizeBundle, writeBundle } from "../bundle/index.js";
import type { UnhashedBundle } from "../bundle/index.js";
import { consolidateMetrics } from "../eval/metrics.js";
import { INPUTS_VERSION, saveInputs } from "../replay/inputs.js";
import { pinIfPresent } from "../replay/pins.js";
import type { ContractEntry } from "../contracts/types.js";
import type { RunBundle, Tool } from "../schema/index.js";
import { DEFAULT_CASSETTE_DIR, TestModeLockError, computeContentHash, isBlocked, loadCassette, saveCassette } from "../tools/index.js";
import type { CreditLedger } from "../tools/index.js";
import { runRecon } from "./recon.js";
import type { ReconResult } from "./recon.js";

export const RUNS_DIR = fileURLToPath(new URL("../../runs/", import.meta.url));

export interface ReconOnlyOptions {
  tool: Tool;
  replay?: boolean;
  /** Default packages/core/runs. */
  runsDir?: string;
  cassetteDir?: string;
  entries?: ContractEntry[];
  ledger?: CreditLedger;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  /** Clock for live runIds and bundle timestamps. */
  now?: () => Date;
  // ---- P8 replay -----------------------------------------------------------------------------
  /** Live: record into `<runId>-recon` (+ the `recon-<tool>` alias) and write the replay record (default true). */
  recordReplay?: boolean;
  /** Replay: the cassette to serve (default recon-<tool>). */
  reconCassette?: string;
  /** Bundle runId override and the run this one reproduces (notary replay). */
  runId?: string;
  replayOf?: string;
  /** Replay: more pinned refs to list in the bundle (the replay record). */
  extraCassettes?: string[];
  /** unguarded_call_sites for bundle.metrics; default null. */
  unguardedCallSites?: () => Promise<number | null>;
}

export interface ReconOnlyResult {
  exitCode: number;
  /** Lines to print (deterministic for a replay). */
  lines: string[];
  status: RunBundle["status"];
  runId?: string;
  bundlePath?: string;
  recon?: ReconResult;
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };

function compactStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function formatReconSummary(r: ReconResult, extra: { runId: string; bundlePath?: string }): string[] {
  const lines: string[] = [];
  lines.push(
    `notarize --recon-only: tool=${r.tool} mode=${r.mode} cassette=${r.cassetteName} (sha ${r.cassetteHash.slice(0, 12)})`,
  );
  lines.push(`runId: ${extra.runId}`);
  lines.push(
    `claims: ${r.entries.length}  exchanges: ${r.observations.length}  credits: ${r.creditsUsed}/${r.budget}`,
  );
  if (r.stoppedReason) lines.push(`STOPPED: ${r.stoppedReason}`);
  const notRun = r.steps.filter((s) => s.status !== "ran");
  for (const s of notRun) lines.push(`step ${s.status}: ${s.claimId}#${s.stepIndex} ${s.op} — ${s.reason ?? ""}`);
  const sorted = [...r.anomalies].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  lines.push(`anomalies: ${sorted.length}`);
  for (const a of sorted) {
    lines.push(`${a.id}  ${a.claimId}  observed=${canonicalJson(a.observed ?? null)}  expected=${canonicalJson(a.expected ?? null)}`);
  }
  if (extra.bundlePath) lines.push(`bundle: ${extra.bundlePath}`);
  return lines;
}

export async function reconOnly(opts: ReconOnlyOptions): Promise<ReconOnlyResult> {
  const now = opts.now ?? (() => new Date());
  const mode = opts.replay ? "replay" : "live";
  const started = now();
  const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;
  // P8: a live run records into its own cassette so this exact run stays replayable.
  const record = mode === "live" && opts.recordReplay !== false;
  const liveRunId = mode === "live" ? (opts.runId ?? `recon-${opts.tool}-${compactStamp(started)}`) : undefined;
  const cassetteName = record ? `${liveRunId}-recon` : (opts.reconCassette ?? `recon-${opts.tool}`);

  let recon: ReconResult;
  try {
    recon = await runRecon({
      tool: opts.tool,
      mode,
      cassetteName,
      ...(opts.cassetteDir === undefined ? {} : { cassetteDir: opts.cassetteDir }),
      ...(opts.entries === undefined ? {} : { entries: opts.entries }),
      ...(opts.ledger === undefined ? {} : { ledger: opts.ledger }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
      ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
    });
  } catch (err) {
    if (isBlocked(err) || err instanceof TestModeLockError) {
      const msg = err.message.startsWith("BLOCKED:") ? err.message : `BLOCKED: ${err.message}`;
      return { exitCode: 3, lines: [msg], status: "blocked" };
    }
    throw err;
  }

  const runId = opts.runId ?? liveRunId ?? `recon-${opts.tool}-replay-${recon.cassetteHash.slice(0, 12)}`;
  let cassettes: string[];
  if (record) {
    if (!existsSync(join(cassetteDir, `${cassetteName}.json`))) {
      saveCassette({ name: cassetteName, tool: opts.tool, createdAt: started.toISOString(), exchanges: [], contentHash: computeContentHash([]) }, cassetteDir);
    }
    // `recon-<tool>` stays the "latest recording" alias that `--recon-only --replay` serves.
    saveCassette({ ...loadCassette(cassetteName, { dir: cassetteDir }), name: `recon-${opts.tool}` }, cassetteDir);
    saveInputs(
      `${runId}-inputs`,
      {
        version: INPUTS_VERSION,
        runId,
        kind: "notarize",
        variant: "notarize",
        tool: opts.tool,
        seed: 0,
        identityRunId: runId,
        reconOnly: true,
        params: { creditBudget: recon.budget },
        files: {},
        store: null,
      },
      cassetteDir,
    );
    cassettes = [cassetteName, `${runId}-inputs`].map((n) => pinIfPresent(n, cassetteDir));
  } else {
    cassettes = [pinIfPresent(recon.cassetteName, cassetteDir), ...(opts.extraCassettes ?? [])];
  }
  const status: RunBundle["status"] = recon.stoppedReason ? "stopped_budget" : "completed";
  const disclosure = [
    "Recon-only notarize run: anomalies come from the deterministic contract checker; no hypotheses, probes or beliefs yet.",
  ];
  if (mode === "replay") disclosure.push(`Replayed from cassette ${recon.cassetteName} (sha ${recon.cassetteHash.slice(0, 12)}); no network calls.`);
  if (opts.replayOf) disclosure.push(`Replay of ${opts.replayOf}.`);
  if (opts.tool === "dodo") disclosure.push("Dodo Payments test mode only.");

  const draft: UnhashedBundle = {
    runId,
    kind: "notarize",
    variant: "notarize",
    mode,
    sample: false,
    disclosure,
    startedAt: started.toISOString(),
    finishedAt: now().toISOString(),
    status,
    ...(recon.stoppedReason ? { stopReason: recon.stoppedReason } : {}),
    seed: 0,
    tool: opts.tool,
    ...(opts.replayOf ? { replayOf: opts.replayOf } : {}),
    queue: [],
    decisions: [],
    claims: recon.entries.map((e) => e.claim),
    anomalies: recon.anomalies,
    hypotheses: [],
    probes: [],
    beliefs: { before: [], after: [] },
    beliefEvents: [],
    guards: [],
    usageByRole: { executor: ZERO_USAGE, reflector: ZERO_USAGE, adversary: ZERO_USAGE },
    credits: { byEndpoint: recon.creditsByEndpoint, total: recon.creditsUsed, budget: recon.budget },
    metrics: {
      claims: recon.entries.length,
      exchanges: recon.observations.length,
      anomalies: recon.anomalies.length,
      skippedSteps: recon.steps.filter((s) => s.status !== "ran").length,
    },
    traceLinks: {},
    cassettes,
  };
  const unguarded = opts.unguardedCallSites ? await opts.unguardedCallSites() : null;
  const bundle = finalizeBundle({
    ...draft,
    metrics: consolidateMetrics(draft, { checkedClaimIds: recon.observations.map((o) => o.claimId), unguardedCallSites: unguarded }),
  });

  const dir = join(opts.runsDir ?? RUNS_DIR, runId);
  const { bundlePath } = await writeBundle(bundle, dir);
  return {
    exitCode: 0,
    lines: formatReconSummary(recon, { runId, bundlePath }),
    status,
    runId,
    bundlePath,
    recon,
  };
}
