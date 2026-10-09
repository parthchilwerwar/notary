/**
 * `notary run --queue <file> --naive [--replay <cassette>]`.
 *
 * Live: records every exchange into cassette `run-<variant>-<stamp>` (the runId). Replay: serves
 * the same run from that cassette with no network and no keys. Either way: ground truth before,
 * execute, ground truth after, deterministic grade, then a bundle in packages/core/runs/<runId>/
 * and a copy in packages/web/public/bundles/. Nothing is written when the run is BLOCKED.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { finalizeBundle, writeBundle } from "../bundle/index.js";
import { NotImplementedError } from "../errors.js";
import { QueueRequestSchema } from "../schema/index.js";
import type { QueueRequest, RunBundle } from "../schema/index.js";
import {
  CreditLedger,
  DEFAULT_CASSETTE_DIR,
  MissingCredentialError,
  TestModeLockError,
  createTools,
  isBlocked,
  listCassettes,
  loadCassette,
} from "../tools/index.js";
import type { Tools } from "../tools/index.js";
import { executeQueue } from "./executor.js";
import type { PolicyFns, QueueTools } from "./executor.js";
import { ExpectedFileSchema, collectGroundTruth, gradeRun } from "./grader.js";
import type { ExpectedEntry, GroundTruthSnapshot } from "./grader.js";
import { loadManifest } from "./manifest.js";
import type { SeedManifest } from "./manifest.js";

export const RUNS_DIR = fileURLToPath(new URL("../../runs/", import.meta.url));
export const WEB_BUNDLES_DIR = fileURLToPath(new URL("../../../web/public/bundles/", import.meta.url));
const CORE_DIR = fileURLToPath(new URL("../../", import.meta.url));

export interface RunQueueOptions {
  queueFile: string;
  variant: "naive" | "guarded";
  mode: "live" | "replay";
  /** Replay: the cassette to serve from (a previous live run's runId). */
  cassette?: string;
  resume?: boolean;
  /** Default: expected.json next to the queue file. */
  expectedFile?: string;
  runsDir?: string;
  /** Where the dashboard copy goes; null skips the copy. */
  webBundlesDir?: string | null;
  cassetteDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  clientTimeoutMs?: number;
  /** Test seams. */
  manifest?: SeedManifest;
  tools?: Tools | (QueueTools & Pick<Tools, "ledger">);
  policy?: PolicyFns;
}

export interface RunQueueResult {
  exitCode: number;
  lines: string[];
  status: RunBundle["status"];
  runId?: string;
  bundlePath?: string;
  metrics?: Record<string, number | null>;
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };

function compactStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Resolve a CLI path against cwd, then INIT_CWD (pnpm runs scripts from the package dir). */
export function resolveInputPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(p)) return p;
  const candidates = [resolvePath(process.cwd(), p)];
  if (env.INIT_CWD) candidates.push(resolvePath(env.INIT_CWD, p));
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

function readJson(path: string, what: string): unknown {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function displayPath(p: string): string {
  const rel = relative(CORE_DIR, p).split("\\").join("/");
  return rel.startsWith("..") ? p : rel;
}

function blocked(err: unknown): RunQueueResult | null {
  if (isBlocked(err) || err instanceof TestModeLockError || (err instanceof Error && err.message.startsWith("BLOCKED:"))) {
    const msg = (err as Error).message;
    return { exitCode: 3, lines: [msg.startsWith("BLOCKED:") ? msg : `BLOCKED: ${msg}`], status: "blocked" };
  }
  return null;
}

export async function runQueue(opts: RunQueueOptions): Promise<RunQueueResult> {
  if (opts.resume) throw new NotImplementedError("run --resume", "P6");
  if (opts.variant === "guarded") throw new NotImplementedError("run (guarded)", "P6");
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const started = now();

  // Inputs.
  const queuePath = resolveInputPath(opts.queueFile, env);
  const queue: QueueRequest[] = z.array(QueueRequestSchema).parse(readJson(queuePath, "queue file"));
  const expectedPath = opts.expectedFile ? resolveInputPath(opts.expectedFile, env) : join(dirname(queuePath), "expected.json");
  const expected: ExpectedEntry[] = ExpectedFileSchema.parse(readJson(expectedPath, "expected outcomes file"));

  let runId: string;
  let cassetteName: string;
  let manifest: SeedManifest;
  let tools: QueueTools & Pick<Tools, "ledger">;
  try {
    if (opts.mode === "replay") {
      if (!opts.cassette) throw new Error("replay needs a cassette name (--replay <cassette>)");
      cassetteName = opts.cassette;
      const cassetteDir = opts.cassetteDir ?? DEFAULT_CASSETTE_DIR;
      if (!listCassettes(cassetteDir).includes(cassetteName)) {
        return {
          exitCode: 1,
          lines: [`No cassette ${cassetteName} in ${cassetteDir}; record one first with a live \`notary run --naive\`.`],
          status: "failed",
        };
      }
      const cassette = loadCassette(cassetteName, opts.cassetteDir === undefined ? {} : { dir: opts.cassetteDir });
      runId = `${cassetteName}-replay-${cassette.contentHash.slice(0, 12)}`;
      tools =
        opts.tools ??
        createTools({ mode: "replay", cassettes: [cassette], ...(opts.cassetteDir === undefined ? {} : { cassetteDir: opts.cassetteDir }) });
    } else {
      // Fail fast, before any request or file, when a key is missing.
      if (!opts.tools) {
        for (const v of ["DODO_PAYMENTS_API_KEY", "CRUSTDATA_API_KEY"]) if (!env[v]?.trim()) throw new MissingCredentialError(v);
      }
      runId = `run-${opts.variant}-${compactStamp(started)}`;
      cassetteName = runId;
      tools =
        opts.tools ??
        createTools({
          mode: "live",
          cassette: cassetteName,
          ledger: new CreditLedger({ env }),
          env,
          ...(opts.cassetteDir === undefined ? {} : { cassetteDir: opts.cassetteDir }),
        });
    }
    manifest = opts.manifest ?? loadManifest();
  } catch (err) {
    const b = blocked(err);
    if (b) return b;
    throw err;
  }

  let before: GroundTruthSnapshot;
  let after: GroundTruthSnapshot;
  let exec: Awaited<ReturnType<typeof executeQueue>>;
  try {
    before = await collectGroundTruth(tools, manifest, now);
    exec = await executeQueue({
      queue,
      manifest,
      tools,
      variant: opts.variant,
      runId,
      ...(opts.policy ? { policy: opts.policy } : {}),
      ...(opts.clientTimeoutMs === undefined ? {} : { clientTimeoutMs: opts.clientTimeoutMs }),
      now,
    });
    after = await collectGroundTruth(tools, manifest, now);
  } catch (err) {
    const b = blocked(err);
    if (b) return b;
    throw err;
  }

  const graded = gradeRun({
    decisions: exec.decisions,
    expected,
    groundTruth: { before, after },
    queue,
    itemsTotal: queue.length,
  });

  const queueRel = displayPath(queuePath);
  const disclosure = [
    `Seeded queue: ${queueRel} (SEEDED FIXTURE)`,
    `Expected outcomes: ${displayPath(expectedPath)}, hand-written from the policy table before any run.`,
    "Dodo Payments test mode only.",
    "Naive variant (run-1 baseline): no gating, no guards; trusts the docs (one page of refunds/payments, retries a write once after timeout/5xx).",
    "Graded deterministically from Dodo state read back by full pagination before and after the run; no LLM grades anything.",
  ];
  if (!before.complete || !after.complete) {
    disclosure.push(`Ground truth incomplete (${[...before.problems, ...after.problems].join("; ")}); unsafe-action metrics are null.`);
  }
  if (opts.mode === "replay") disclosure.push(`Replayed from cassette ${cassetteName}; no network calls.`);
  for (const n of exec.notes) disclosure.push(`Client timeout: ${n}`);
  if (exec.notProcessed.length) disclosure.push(`Not processed (budget stop): ${exec.notProcessed.join(", ")}`);

  const snap = tools.ledger.snapshot();
  const manifestCassette = (manifest as unknown as { cassette?: unknown }).cassette;
  const status: RunBundle["status"] = exec.stopReason ? "stopped_budget" : "completed";
  const bundle = finalizeBundle({
    runId,
    kind: "run",
    variant: opts.variant,
    mode: opts.mode,
    sample: false,
    disclosure,
    startedAt: started.toISOString(),
    finishedAt: now().toISOString(),
    status,
    ...(exec.stopReason ? { stopReason: exec.stopReason } : {}),
    seed: 0,
    ...(opts.mode === "replay" ? { replayOf: cassetteName } : {}),
    queue,
    decisions: graded.decisions,
    claims: [],
    anomalies: [],
    hypotheses: [],
    probes: [],
    beliefs: { before: [], after: [] },
    beliefEvents: [],
    guards: [],
    usageByRole: { executor: ZERO_USAGE, reflector: ZERO_USAGE, adversary: ZERO_USAGE },
    credits: { byEndpoint: snap.byEndpoint, total: snap.total, budget: snap.budget },
    metrics: graded.metrics,
    traceLinks: {},
    cassettes: [cassetteName, ...(typeof manifestCassette === "string" && manifestCassette ? [manifestCassette] : [])],
  });

  const { bundlePath } = await writeBundle(bundle, join(opts.runsDir ?? RUNS_DIR, runId));
  const webDir = opts.webBundlesDir === undefined ? WEB_BUNDLES_DIR : opts.webBundlesDir;
  const lines = [
    `run --${opts.variant}: mode=${opts.mode} queue=${queueRel} items=${queue.length} status=${status}`,
    `runId: ${runId}  cassette: ${cassetteName}`,
    ...(exec.stopReason ? [`STOPPED: ${exec.stopReason}`] : []),
    ...Object.entries(graded.metrics).map(([k, v]) => `  ${k}: ${v === null ? "null" : v}`),
    `credits: ${snap.total}/${snap.budget}`,
    `bundle: ${bundlePath}`,
  ];
  if (webDir !== null) {
    const web = await writeBundle(bundle, webDir);
    lines.push(`dashboard copy: ${web.bundlePath}`);
  }
  return { exitCode: 0, lines, status, runId, bundlePath, metrics: graded.metrics };
}
