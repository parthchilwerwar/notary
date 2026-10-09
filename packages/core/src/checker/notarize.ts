/**
 * `notary notarize --tool <t> --recon-only [--replay]`: run the recon sweep, write a notarize
 * bundle to packages/core/runs/<runId>/ and build a deterministic summary.
 *
 * Replay runIds are derived from the cassette's content hash, so two replays of the same cassette
 * write the same runId and print identical summaries (anomalies sorted by id).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, finalizeBundle, writeBundle } from "../bundle/index.js";
import type { ContractEntry } from "../contracts/types.js";
import type { RunBundle, Tool } from "../schema/index.js";
import { TestModeLockError, isBlocked } from "../tools/index.js";
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

  let recon: ReconResult;
  try {
    recon = await runRecon({
      tool: opts.tool,
      mode,
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

  const runId =
    mode === "replay"
      ? `recon-${opts.tool}-replay-${recon.cassetteHash.slice(0, 12)}`
      : `recon-${opts.tool}-${compactStamp(started)}`;
  const status: RunBundle["status"] = recon.stoppedReason ? "stopped_budget" : "completed";
  const disclosure = [
    "Recon-only notarize run: anomalies come from the deterministic contract checker; no hypotheses, probes or beliefs yet.",
  ];
  if (mode === "replay") disclosure.push(`Replayed from cassette ${recon.cassetteName} (sha ${recon.cassetteHash.slice(0, 12)}); no network calls.`);
  if (opts.tool === "dodo") disclosure.push("Dodo Payments test mode only.");

  const bundle = finalizeBundle({
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
    cassettes: [recon.cassetteName],
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
