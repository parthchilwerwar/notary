/**
 * `notary demo --fixture`: the WHOLE pipeline end to end on fixture data, so a reader can see what
 * the agent does without any API key:
 *
 *   recon -> checker anomalies -> reflector (model double) -> probes with committed predictions ->
 *   beliefs -> adversary (model double) -> guards compiled -> naive run and guarded run over
 *   fixtures/queue/seeded.json -> export / replay exclusion checks -> drift replay (Stage 11: an
 *   op-level drift fixture built from the demo's own FIXTURE probe cassette under runs/demo/drift/,
 *   replayDrift on a copy of the demo store, un-learning and guard retirement by the real rules).
 *
 * Every step runs through the REAL code paths (notarize(), runQueue(), the recorder, redaction,
 * ledger, checker, probe templates, commit-then-run into SQLite, BeliefStore, guard compiler,
 * guarded(), executor, grader, bundle writer). Only two things are simulated:
 *   - HTTP: an in-process fixture API (fixture-api.ts) installed as the recorder's transport;
 *   - models: deterministic reflector / adversary doubles (fixture-llm.ts) behind the real LlmClient.
 *
 * Safety: global fetch is replaced by a trap for the duration of the demo (any call is counted and
 * fails); the fixture transport refuses every non-fixture host; NOTARY_MODE=test is set in-process
 * only; keys are fake placeholders in a private env object (never process.env). Output goes to
 * packages/core/runs/demo/ (gitignored): bundles in runs/demo/<runId>/ (runId prefixed `demo-`,
 * `sample: true`, FIXTURE DATA disclosure), cassettes in runs/demo/cassettes/ (`fixture: true`), a
 * separate store runs/demo/notary.sqlite. Nothing is written to fixtures/cassettes or packages/web.
 * Only `--publish` (src/demo/publish.ts, after the demo finishes cleanly) copies the bundles,
 * unchanged, into packages/web/public/bundles/fixture/ with their own index.json.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { finalizeBundle, verifyBundle, writeBundle } from "../bundle/index.js";
import { RUNS_DIR } from "../checker/notarize.js";
import { collectBundles, runExport } from "../export/index.js";
import { DEFAULT_MANIFEST_PATH } from "../queue/manifest.js";
import { seedSteps } from "../queue/seed-plan.js";
import { runQueue } from "../queue/run.js";
import { replayDrift } from "../beliefs/drift.js";
import type { ReplayDriftResult } from "../beliefs/drift.js";
import { GuardRegistry } from "../guards/registry.js";
import { openDb } from "../store/db.js";
import { makeDriftFixture } from "../tools/drift-fixture.js";
import { DEFAULT_MAX_PROBES_PER_CLAIM, MAX_PROBES_PER_RUN } from "../reflect/loop.js";
import { SEEDED_QUEUE_PATH, notarize, recordedRunId } from "../reflect/notarize.js";
import type { NotarizeResult } from "../reflect/notarize.js";
import { runReplay } from "../replay/index.js";
import { PinMismatchError, loadPinned } from "../replay/pins.js";
import type { Belief, RunBundle, Tool } from "../schema/index.js";
import { DEFAULT_CASSETTE_DIR, loadCassette, setRecorderTransport } from "../tools/index.js";
import type { Cassette } from "../tools/index.js";
import { FIXTURE_CONTROLS, FIXTURE_QUIRKS, FixtureApi, FixtureWorld } from "./fixture-api.js";
import { FIXTURE_MODEL_LABEL, createFixtureLlm } from "./fixture-llm.js";
import {
  adversaryLines,
  anomalyLines,
  beliefLines,
  guardLines,
  heading,
  hypothesisLines,
  probeLines,
  reconLines,
  requiredBeliefLines,
  runLines,
  short,
} from "./summary.js";

export const FIXTURE_DISCLOSURE =
  "FIXTURE DATA — simulated API and model responses produced by `notary demo --fixture`; not a live run";

export const DEMO_RUNS_DIR = fileURLToPath(new URL("../../runs/demo/", import.meta.url));
const CORE_DIR = fileURLToPath(new URL("../../", import.meta.url));
const WEB_DIR = fileURLToPath(new URL("../../../web/", import.meta.url));
const REPO_ENV = fileURLToPath(new URL("../../../../.env", import.meta.url));

/** Placeholder credentials so the real clients pass their key checks; the fixture never sees the network. */
const FIXTURE_KEY = "fixture-placeholder-not-a-real-key";

/**
 * Probe caps raised for the FIXTURE demo only (DECISIONS #100), in-process: the per-claim cap through
 * the demo's private env (NOTARY_MAX_PROBES_PER_CLAIM, never process.env) and the per-run cap through
 * notarize's params. The intermittent Q2 needs 6 designs on the wallet unit claim, and without the
 * per-run headroom those probes would come out of the #85 re-examination and the change-plan
 * verification. Live defaults (5 per claim, 30 per run) are untouched.
 */
export const DEMO_MAX_PROBES_PER_CLAIM = 6;
export const DEMO_MAX_PROBES_PER_RUN = 40;

export const DEMO_RUN_IDS = {
  notarizeCrustdata: "demo-notarize-crustdata",
  notarizeDodo: "demo-notarize-dodo",
  naive: "demo-run-naive",
  guarded: "demo-run-guarded",
} as const;

export interface FixtureDemoOptions {
  /** Default packages/core/runs/demo. */
  outDir?: string;
  /** Clock for bundles, probes and beliefs; default a strictly increasing wall clock. */
  now?: () => Date;
  /** PLANTED QUIRK Q5 delay; must exceed the executor's 200 ms client timeout. Default 500. */
  slowFullRefundMs?: number;
  /** Environment checked (presence only) for the "where a live run would stop" lines; default process.env + .env. */
  readinessEnv?: NodeJS.ProcessEnv;
}

export interface FixtureDemoResult {
  exitCode: number;
  lines: string[];
  outDir: string;
  bundlePaths: string[];
  bundles: RunBundle[];
  stats: { globalFetchCalls: number; served: number; refused: string[]; unknownRoutes: string[] };
  /** Stage 11: the replayDrift result (on the store copy) and the drift fixture path. */
  drift?: { result?: ReplayDriftResult; fixturePath?: string; storePath: string };
}

/** A wall clock that never returns the same instant twice (committedAt is always before ranAt). */
export function monotonicClock(): () => Date {
  let last = 0;
  return () => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last);
  };
}

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

/** The demo writes only to its own directory: never the real runs dir itself, cassettes or the dashboard. */
function assertSafeOutDir(outDir: string): void {
  if (inside(outDir, WEB_DIR)) throw new Error(`notary demo: refusing to write into packages/web (${outDir})`);
  if (inside(outDir, DEFAULT_CASSETTE_DIR) || inside(DEFAULT_CASSETTE_DIR, outDir)) throw new Error(`notary demo: refusing to write near fixtures/cassettes (${outDir})`);
  if (resolve(outDir) === resolve(RUNS_DIR)) throw new Error("notary demo: refusing to use packages/core/runs itself; use runs/demo");
}

/** Remove what a previous demo run left in outDir (only the demo's own artifacts). */
function cleanPrevious(outDir: string): void {
  if (!existsSync(outDir)) return;
  for (const name of readdirSync(outDir)) {
    const own = name.startsWith("demo-") || ["cassettes", "fixture", "export-check", "drift"].includes(name) || /^notary\.sqlite(-wal|-shm|-journal)?$/.test(name);
    if (own) rmSync(join(outDir, name), { recursive: true, force: true });
  }
}

function readinessEnvDefault(): NodeJS.ProcessEnv {
  let fromFile: NodeJS.ProcessEnv = {};
  try {
    if (existsSync(REPO_ENV)) fromFile = parseEnv(readFileSync(REPO_ENV, "utf8"));
  } catch {
    fromFile = {};
  }
  return { ...fromFile, ...process.env };
}

// ---------------------------------------------------------------------------------------------
// Where a live run would stop (presence checks only; values are never read out or printed)

interface LiveStops {
  line(stage: number): string;
}

function liveStops(env: NodeJS.ProcessEnv): LiveStops {
  const has = (k: string) => (env[k] ?? "").trim().length > 0;
  const missing = (ks: string[]) => ks.filter((k) => !has(k)).map((k) => `${k} not set`);
  const manifest = existsSync(DEFAULT_MANIFEST_PATH) ? [] : [`no seed manifest (fixtures/seed/manifest.json: live seed with a Dodo test key + ${seedSteps().filter((st) => st.kind === "human").length} hosted test-card checkouts)`];
  const own: Record<number, string[]> = {
    1: missing(["CRUSTDATA_API_KEY", "DODO_PAYMENTS_API_KEY"]),
    2: [],
    3: [...missing(["NOTARY_MODEL_REFLECTOR", "AWS_REGION"])],
    4: manifest.map((m) => `refund probes: ${m}`),
    5: [],
    6: missing(["NOTARY_MODEL_ADVERSARY"]),
    7: [],
    8: [...missing(["CRUSTDATA_API_KEY", "DODO_PAYMENTS_API_KEY"]), ...manifest],
    9: [...missing(["CRUSTDATA_API_KEY", "DODO_PAYMENTS_API_KEY"]), ...manifest],
    10: [],
    11: [],
  };
  const upstream: Record<number, number[]> = { 1: [], 2: [1], 3: [1, 2], 4: [1, 2, 3], 5: [1, 2, 3, 4], 6: [1, 2, 3, 4, 5], 7: [1, 2, 3, 4, 5, 6], 8: [], 9: [1, 2, 3, 4, 5, 6, 7], 10: [], 11: [1, 2, 3, 4, 5, 6, 7] };
  return {
    line(stage) {
      if (stage === 10) return "live: keyless (export and replay read local files only)";
      if (stage === 11) {
        const blockedAt = (upstream[11] ?? []).find((s) => (own[s] ?? []).length > 0);
        return `live: keyless itself (make:drift + replay --drift read a recorded cassette)${blockedAt !== undefined ? `; needs a recorded live notarize run, blocked upstream at Stage ${blockedAt}` : ""}`;
      }
      const mine = own[stage] ?? [];
      if (mine.length) return `live: BLOCKED at Stage ${stage} — ${mine.join("; ")}`;
      const blockedAt = (upstream[stage] ?? []).find((s) => (own[s] ?? []).length > 0);
      if (blockedAt !== undefined) return `live: nothing of its own to configure; blocked upstream at Stage ${blockedAt}`;
      return `live: requirements present (AWS credentials are not checked offline)`;
    },
  };
}

// ---------------------------------------------------------------------------------------------

/** Re-label a bundle the real pipeline wrote: sample: true + the FIXTURE disclosure, re-hashed, same path. */
async function labelAsFixture(bundlePath: string): Promise<RunBundle> {
  const v = verifyBundle(JSON.parse(readFileSync(bundlePath, "utf8")));
  if (!v.ok) throw new Error(`demo: bundle ${bundlePath} failed verification: ${v.error}`);
  const b = v.bundle;
  if (!b.runId.startsWith("demo-")) throw new Error(`demo: refusing to label non-demo bundle ${b.runId}`);
  const quirks = `PLANTED FIXTURE QUIRKS (simulated, not claims about the real APIs): ${FIXTURE_QUIRKS.map((q) => `${q.id} ${q.where}: ${q.behaviour}`).join("; ")}`;
  const models = `Reflector and adversary are deterministic model doubles (${FIXTURE_MODEL_LABEL}); token counts are estimates, usd 0.`;
  const caps = `Probe caps raised for the fixture demo only: ${DEMO_MAX_PROBES_PER_CLAIM} per claim, ${DEMO_MAX_PROBES_PER_RUN} per run (live defaults ${DEFAULT_MAX_PROBES_PER_CLAIM} and ${MAX_PROBES_PER_RUN}).`;
  const labelled = finalizeBundle({
    ...b,
    sample: true,
    disclosure: [FIXTURE_DISCLOSURE, quirks, models, caps, ...b.disclosure.filter((d) => d !== FIXTURE_DISCLOSURE)],
  });
  await writeBundle(labelled, dirname(bundlePath));
  return labelled;
}

function readCassette(dir: string, name: string): Cassette | null {
  try {
    return loadCassette(name, { dir });
  } catch {
    return null;
  }
}

/** A path for display: runs/demo/... for the default dir, <outDir>/... otherwise (stable across runs). */
function rel(outDir: string, p: string): string {
  const r = relative(outDir, p).split(sep).join("/");
  if (r.startsWith("..")) return relative(CORE_DIR, p).split(sep).join("/");
  const base = resolve(outDir) === resolve(DEMO_RUNS_DIR) ? "runs/demo" : "<outDir>";
  return r ? `${base}/${r}` : base;
}

// ---------------------------------------------------------------------------------------------
// Stage 11: drift replay (FIXTURE)

/** The belief the drift beat targets: notarized violated on MIXED evidence (intermittent Q2). */
export const DRIFT_CLAIM_ID = "dodo.wallet.credit-amount-minor-units";
export const DRIFT_FIXTURE_NAME = "demo-drift-wallet-unit-fixed";
/** "Dodo fixed the ledger unit bug": every credit's echoed balance becomes the minor-unit amount. */
export const DRIFT_REWRITE = { op: "dodo.createWalletLedgerEntry", path: "$.balance", transform: { kind: "divide", divisor: 100, exact: true } } as const;

interface DriftStageInput {
  outDir: string;
  cassetteDir: string;
  dbPath: string;
  bundle: RunBundle;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

/**
 * Build an op-level drift fixture from the dodo notarize run's own FIXTURE probe cassette (written
 * under <outDir>/drift, stamped fixture: true), then run the real replayDrift on a COPY of the demo
 * store, so the store keeps what Stages 1–9 saw. Nothing is special-cased: un-learning is BeliefStore's
 * crossing-0.5 rule and retirement is wireRetirement; if the recorded designs can't cross, it says why.
 */
async function driftStage(o: DriftStageInput): Promise<{ lines: string[]; problems: string[]; result?: ReplayDriftResult; fixturePath?: string }> {
  const lines: string[] = [];
  const problems: string[] = [];
  const driftDir = join(o.outDir, "drift");
  mkdirSync(driftDir, { recursive: true });
  const sourceRef = o.bundle.cassettes.find((r) => r.split("@")[0]!.startsWith("probes-"));
  if (!sourceRef) return { lines: ["  skipped: the dodo notarize bundle pins no probe cassette"], problems: ["stage 11: no probe cassette to drift"] };
  const source = sourceRef.split("@")[0]!;

  const storeCopy = join(driftDir, "notary.sqlite");
  const src = openDb(o.dbPath);
  try {
    src.db.exec(`VACUUM INTO '${storeCopy.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }

  const made = makeDriftFixture({ from: source, cassetteDir: o.cassetteDir, driftDir, ...DRIFT_REWRITE, out: DRIFT_FIXTURE_NAME, force: true });
  const fx = made.fixture;
  lines.push(
    `  drift fixture ${rel(o.outDir, made.path)} (fixture: ${fx.fixture === true}) from FIXTURE cassette ${source}: op ${fx.drift.op}, ${fx.drift.path} ${fx.drift.transform} — every wallet credit now books the sent amount in minor units`,
  );
  if (fx.fixture !== true) problems.push("stage 11: the drift fixture is not marked fixture: true");
  lines.push(`  ${fx.drift.changed.length} exchange(s) rewritten, ${fx.drift.skipped.length} left unchanged${fx.drift.skipped.length ? `: ${fx.drift.skipped.map((s) => s.reason).join("; ")}` : ""}`);
  lines.push(`  replayed on a copy of the demo store (${rel(o.outDir, storeCopy)}); the demo store keeps what Stages 1–9 saw`);

  const db = openDb(storeCopy);
  let result: ReplayDriftResult | undefined;
  try {
    const res = await replayDrift({ fixture: fx, db, probes: o.bundle.probes, hypotheses: o.bundle.hypotheses, claimId: DRIFT_CLAIM_ID, env: o.env, now: o.now });
    result = res;
    const t = res.trajectories.find((x) => x.claimId === DRIFT_CLAIM_ID);
    if (!t) {
      lines.push(`  ${DRIFT_CLAIM_ID}: not replayed — ${res.stopReason}`);
      for (const l of res.lines.filter((x) => !x.startsWith("drift fixture "))) lines.push(`    ${short(l, 200)}`);
      return { lines, problems, result, fixturePath: made.path };
    }
    const fmt = (p: { alpha: number; beta: number; pHolds: number }) => `Beta(${p.alpha}, ${p.beta}) P(holds)=${p.pHolds.toFixed(4)}`;
    lines.push(
      `  ${t.beliefId}: ${t.start.status} ${t.side} at ${fmt(t.start)} from mixed evidence; crossing 0.5 needs ${t.designsNeeded} contrary distinct designs`,
    );
    for (const s of t.steps) {
      lines.push(`    design ${s.design} (${s.sourceProbeId}): ${s.verdict}${s.against ? ", against the notarized side" : ""} -> ${fmt(s)}  ${s.status}`);
      if (s.replicateIds.length) lines.push(`      replicates not re-counted: ${s.replicateIds.join(", ")}`);
    }
    if (t.unlearned) {
      const at = t.steps.findIndex((s) => s.status === "unlearned") + 1;
      lines.push(`  UN-LEARNED at distinct design ${at} of ${t.distinctDesigns} (needed ${t.designsNeeded}; ${t.designsAgainst} of ${t.distinctDesigns} replayed designs went against the notarized side, each counted once)`);
    } else {
      lines.push(`  not un-learned: ${res.stopReason} (crossing 0.5 from Beta(${t.start.alpha}, ${t.start.beta}) needs ${t.designsNeeded})`);
    }
    for (const g of res.retiredGuards) lines.push(`  guard retired: ${g.id} (${g.kind} on ${g.operation}) — ${short(g.reason, 140)}`);
    if (res.retiredGuards.length === 0) lines.push("  guards retired: none");
    const still = new GuardRegistry(db).all().filter((g) => g.active && g.operation === DRIFT_REWRITE.op);
    lines.push(`  still active on ${DRIFT_REWRITE.op}: ${still.length ? still.map((g) => `${g.id} (${g.kind}, ${g.beliefId.replace(/^belief-/, "")})`).join(", ") : "none"}`);
  } finally {
    db.close();
  }
  // The live command must not accept this fixture as a result.
  const live = await runReplay({ drift: made.path, runsDir: o.outDir, webBundlesDir: null, cassetteDir: o.cassetteDir, now: o.now });
  const refused = live.exitCode !== 0;
  // The cassette hash covers recordedAt/latency (differs run to run): print it as <sha>.
  const why = (live.lines[live.lines.length - 1] ?? "").replace(/\(sha [0-9a-f]+\)/g, "(sha <sha>)");
  lines.push(`  ${refused ? "PASS" : "FAIL"} \`notary replay --drift\` on this fixture: exit ${live.exitCode} — ${short(why, 160)}`);
  if (!refused) problems.push("stage 11: replay --drift accepted a FIXTURE drift fixture");
  return { lines, problems, ...(result ? { result } : {}), fixturePath: made.path };
}

export async function runFixtureDemo(opts: FixtureDemoOptions = {}): Promise<FixtureDemoResult> {
  const outDir = resolve(opts.outDir ?? DEMO_RUNS_DIR);
  assertSafeOutDir(outDir);
  cleanPrevious(outDir);
  mkdirSync(outDir, { recursive: true });
  const cassetteDir = join(outDir, "cassettes");
  const dbPath = join(outDir, "notary.sqlite");
  const manifestPath = join(outDir, "fixture", "seed-manifest.json");
  const now = opts.now ?? monotonicClock();
  const stops = liveStops(opts.readinessEnv ?? readinessEnvDefault());

  let world = new FixtureWorld();
  const api = new FixtureApi(() => world, opts.slowFullRefundMs === undefined ? {} : { slowFullRefundMs: opts.slowFullRefundMs });
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(world.seedManifest(), null, 2)}\n`, "utf8");

  const lines: string[] = [];
  const bundlePaths: string[] = [];
  const bundles: RunBundle[] = [];
  const problems: string[] = [];
  let globalFetchCalls = 0;
  let driftOut: FixtureDemoResult["drift"];

  // ---- safety: trap global fetch, test mode in-process, fixture transport, private env ---------
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    globalFetchCalls += 1;
    throw new Error(`notary demo --fixture: global fetch is disabled during the demo (attempted ${String(input)})`);
  }) as typeof fetch;
  const hadMode = Object.hasOwn(process.env, "NOTARY_MODE");
  const prevMode = process.env.NOTARY_MODE;
  process.env.NOTARY_MODE = "test";
  const restoreTransport = setRecorderTransport({ fetch: api.fetch, fixture: true });
  const env: NodeJS.ProcessEnv = {
    NOTARY_MODE: "test",
    CRUSTDATA_API_KEY: FIXTURE_KEY,
    DODO_PAYMENTS_API_KEY: FIXTURE_KEY,
    NOTARY_MAX_PROBES_PER_CLAIM: String(DEMO_MAX_PROBES_PER_CLAIM),
  };
  const noSleep = async (): Promise<void> => {};

  try {
    lines.push("notary demo --fixture");
    lines.push(FIXTURE_DISCLOSURE);
    lines.push(`output: ${rel(outDir, outDir)} (bundles <runId>/, cassettes cassettes/ marked fixture: true, store notary.sqlite); nothing under fixtures/cassettes or packages/web`);
    lines.push("network: global fetch is trapped for the whole demo; every HTTP call goes to the in-process fixture API (api.crustdata.com, test.dodopayments.com), any other host is refused");
    lines.push(`models: reflector and adversary are deterministic doubles behind the real LlmClient (${FIXTURE_MODEL_LABEL})`);
    lines.push(
      `probe caps (FIXTURE only, in-process): ${DEMO_MAX_PROBES_PER_CLAIM} per claim (NOTARY_MAX_PROBES_PER_CLAIM in the demo's private env), ${DEMO_MAX_PROBES_PER_RUN} per run (notarize params); live defaults stay ${DEFAULT_MAX_PROBES_PER_CLAIM} and ${MAX_PROBES_PER_RUN}`,
    );
    lines.push(
      `world: built from SEED_PLAN (${world.products.size} products, ${world.customers.size} customers, ${world.payments.size} payments, ${world.refunds.length} pre-existing refund(s), ${world.ledger.length} seeded wallet credit(s), ${world.subscriptions.size} subscriptions); re-seeded before each queue run`,
    );
    lines.push("");
    lines.push("PLANTED FIXTURE QUIRKS (simulated behaviour; not claims about the real Crustdata or Dodo APIs):");
    for (const q of FIXTURE_QUIRKS) lines.push(`  PLANTED FIXTURE QUIRK ${q.id} [${q.tool}] ${q.where}: ${q.behaviour}`);
    lines.push(`CONTROLS (fixture honors the doc): ${FIXTURE_CONTROLS.join("; ")}`);

    // ---- Stages 1–7: notarize both tools through the real loop --------------------------------
    const notarized: Partial<Record<Tool, { result: NotarizeResult; bundle?: RunBundle }>> = {};
    for (const tool of ["crustdata", "dodo"] as const) {
      const runId = tool === "crustdata" ? DEMO_RUN_IDS.notarizeCrustdata : DEMO_RUN_IDS.notarizeDodo;
      const result = await notarize({
        tool,
        env,
        runsDir: outDir,
        cassetteDir,
        dbPath,
        llm: createFixtureLlm(),
        manifestPath,
        queuePath: SEEDED_QUEUE_PATH,
        sleep: noSleep,
        now,
        adversary: "bedrock",
        recordReplay: false,
        runId,
        params: { maxProbesPerRun: DEMO_MAX_PROBES_PER_RUN },
      });
      const entry: { result: NotarizeResult; bundle?: RunBundle } = { result };
      if (result.bundlePath) {
        entry.bundle = await labelAsFixture(result.bundlePath);
        bundlePaths.push(result.bundlePath);
        bundles.push(entry.bundle);
      } else {
        problems.push(`notarize --tool ${tool} wrote no bundle: ${result.lines.join(" | ")}`);
      }
      notarized[tool] = entry;
    }
    const nb = (["crustdata", "dodo"] as const).flatMap((t) => (notarized[t]?.bundle ? [notarized[t]!.bundle!] : []));
    const reconOf = (t: Tool) => readCassette(cassetteDir, `recon-${t}`);

    lines.push(heading(1, "Recon (cheap calls per claim, raw tools, recorded to a fixture cassette)"));
    for (const b of nb) lines.push(...reconLines(b.tool!, b, reconOf(b.tool!)));
    lines.push(`  ${stops.line(1)}`);

    lines.push(heading(2, "Checker anomalies (deterministic doc-vs-wire rules, no model)"));
    for (const b of nb) lines.push(...anomalyLines(b));
    lines.push(`  ${stops.line(2)}`);

    lines.push(heading(3, "Hypotheses (reflector: one batched model call, the model only proposes; verification rivals: built by code, no model)"));
    for (const b of nb) lines.push(...hypothesisLines(b));
    lines.push(`  ${stops.line(3)}`);

    lines.push(heading(4, "Probes (prediction committed to SQLite before any call, then run, then verdict)"));
    for (const b of nb) {
      const { lines: pl, orderOk } = probeLines(b);
      lines.push(...pl);
      if (!orderOk) problems.push(`${b.runId}: a probe's committedAt is not before its ranAt`);
    }
    for (const t of ["crustdata", "dodo"] as const) {
      for (const s of (notarized[t]?.result.lines ?? []).filter((l) => l.startsWith("skipped ") || l.startsWith("verification "))) lines.push(`  ${t}: ${short(s, 200)}`);
    }
    lines.push(`  ${stops.line(4)}`);

    const allBeliefs: Belief[] = nb.flatMap((b) => b.beliefs.after);
    lines.push(heading(5, "Beliefs (Beta(α, β) per claim; only confirmed probes move it)"));
    lines.push(...beliefLines(allBeliefs));
    lines.push(`  ${stops.line(5)}`);

    lines.push(heading(6, "Adversary verdicts (reads raw probe records only)"));
    const advUsage = nb.reduce(
      (s, b) => ({
        calls: s.calls + b.usageByRole.adversary.calls,
        inputTokens: s.inputTokens + b.usageByRole.adversary.inputTokens,
        outputTokens: s.outputTokens + b.usageByRole.adversary.outputTokens,
        usd: s.usd + b.usageByRole.adversary.usd,
      }),
      { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
    );
    lines.push(...adversaryLines(allBeliefs, advUsage));
    lines.push(`  ${stops.line(6)}`);

    lines.push(heading(7, "Guards compiled (only notarized beliefs on the violated side)"));
    lines.push(...guardLines(nb));
    lines.push(`  ${stops.line(7)}`);

    // ---- Stages 8–9: the seeded queue, naive then guarded, each on a freshly seeded world --------
    const runs: Partial<Record<"naive" | "guarded", RunBundle>> = {};
    for (const variant of ["naive", "guarded"] as const) {
      world = new FixtureWorld();
      const runId = variant === "naive" ? DEMO_RUN_IDS.naive : DEMO_RUN_IDS.guarded;
      const r = await runQueue({
        queueFile: SEEDED_QUEUE_PATH,
        variant,
        mode: "live",
        runId,
        runsDir: outDir,
        webBundlesDir: null,
        cassetteDir,
        ...(variant === "guarded" ? { dbPath } : {}),
        env,
        now,
        manifest: world.seedManifest(),
        recordReplay: false,
      });
      if (r.bundlePath) {
        runs[variant] = await labelAsFixture(r.bundlePath);
        bundlePaths.push(r.bundlePath);
        bundles.push(runs[variant]!);
      } else {
        problems.push(`run --${variant} wrote no bundle: ${r.lines.join(" | ")}`);
      }
    }

    lines.push(heading(8, "Naive run (doc-trusting baseline: no gate, no guards) over fixtures/queue/seeded.json"));
    if (runs.naive) lines.push(...runLines(runs.naive, { guarded: false }));
    lines.push(`  ${stops.line(8)}`);

    lines.push(heading(9, "Guarded run (gate on required beliefs + compiled guards) over fixtures/queue/seeded.json"));
    if (runs.guarded) {
      const fired = [...new Set(runs.guarded.decisions.flatMap((d) => d.guardsApplied))];
      lines.push(...runLines(runs.guarded, { guarded: true, beliefs: runs.guarded.beliefs.before }));
      lines.push(`  guards fired during the run: ${fired.length ? fired.join(", ") : "none"}`);
      lines.push("  required beliefs per action (src/queue/required.ts) vs the store:");
      lines.push(...requiredBeliefLines(runs.guarded.beliefs.before));
    }
    lines.push(`  ${stops.line(9)}`);

    // ---- Stage 10: export / replay must ignore every demo artifact -------------------------------
    lines.push(heading(10, "Export and replay exclusion (demo output is never a result)"));
    const checks: Array<{ ok: boolean; text: string }> = [];
    const demoCollect = collectBundles(outDir);
    checks.push({
      ok: demoCollect.bundles.length === 0 && demoCollect.excluded.length === bundles.length,
      text: `collectBundles(${rel(outDir, outDir)}): ${demoCollect.bundles.length} result bundle(s), ${demoCollect.excluded.length} excluded as SAMPLE (${bundles.length} demo bundles), ${demoCollect.skipped.length} non-bundle file(s) skipped (cassettes, seed manifest)`,
    });
    const realCollect = collectBundles(RUNS_DIR);
    const leaked = realCollect.bundles.filter((x) => x.bundle.runId.startsWith("demo-") || x.bundle.sample);
    checks.push({ ok: leaked.length === 0, text: `collectBundles(packages/core/runs) — what \`notary export\` reads: ${realCollect.bundles.length} real bundle(s), ${leaked.length} demo/sample among them` });
    const exportDir = join(outDir, "export-check");
    const exp = await runExport({ runsDir: outDir, exportDir: join(exportDir, "export"), docsDir: join(exportDir, "docs"), webBundlesDir: null, checks: null, now });
    checks.push({
      ok: exp.bundles.length === 0 && exp.copied.length === 0,
      text: `runExport over the demo dir (scratch EVALUATION.md at ${rel(outDir, exp.files.evaluationMd)}): ${exp.bundles.length} bundle(s) used, ${exp.excluded.length} excluded, dashboard copy disabled`,
    });
    const replayAll = await runReplay({ runsDir: outDir, webBundlesDir: null, cassetteDir, now });
    checks.push({ ok: replayAll.exitCode === 3, text: `runReplay over the demo dir: exit ${replayAll.exitCode} — ${short(replayAll.lines[replayAll.lines.length - 1] ?? "", 150)}` });
    if (runs.naive) {
      const one = await runReplay({ bundle: runs.naive.runId, runsDir: outDir, webBundlesDir: null, cassetteDir, now });
      checks.push({ ok: one.exitCode === 1, text: `runReplay --bundle ${runs.naive.runId}: exit ${one.exitCode} — ${short(one.lines[one.lines.length - 1] ?? "", 150)}` });
      const pin = runs.naive.cassettes[0];
      if (pin) {
        let refused = "";
        try {
          loadPinned(pin, cassetteDir);
        } catch (err) {
          refused = err instanceof PinMismatchError ? err.message : String(err);
        }
        // The pin's hash covers recordedAt/latency, so it differs run to run; print the name only.
        const at = refused.indexOf("FIXTURE");
        checks.push({
          ok: at >= 0,
          text: `loadPinned(${pin.split("@")[0]}@<sha256>) for replay: ${refused ? `refused — ${short(at >= 0 ? refused.slice(at) : refused, 120)}` : "ACCEPTED (bug)"}`,
        });
      }
    }
    const recorded = (["crustdata", "dodo"] as const).map((t) => recordedRunId(outDir, t));
    checks.push({ ok: recorded.every((r) => r === undefined), text: `notarize --replay discovery (recordedRunId) over the demo dir: ${recorded.filter(Boolean).length} recorded run(s) found` });
    const cassetteFiles = existsSync(cassetteDir) ? readdirSync(cassetteDir).filter((f) => f.endsWith(".json")) : [];
    const unmarked = cassetteFiles.filter((f) => readCassette(cassetteDir, f.slice(0, -5))?.fixture !== true);
    checks.push({ ok: cassetteFiles.length > 0 && unmarked.length === 0, text: `${cassetteFiles.length} demo cassette(s), ${unmarked.length} without fixture: true` });
    checks.push({ ok: bundles.every((b) => b.sample && b.disclosure.includes(FIXTURE_DISCLOSURE) && b.runId.startsWith("demo-")), text: `${bundles.length} demo bundle(s): all sample: true, FIXTURE disclosure, runId demo-*` });
    for (const c of checks) {
      lines.push(`  ${c.ok ? "PASS" : "FAIL"} ${c.text}`);
      if (!c.ok) problems.push(`stage 10: ${c.text}`);
    }
    lines.push(`  ${stops.line(10)}`);

    // ---- Stage 11: drift replay on the demo's own FIXTURE cassette ------------------------------
    lines.push(heading(11, "Drift replay (FIXTURE: simulated \"Dodo fixed the ledger unit bug\", replayed through replayDrift)"));
    if (notarized.dodo?.bundle) {
      const drift = await driftStage({ outDir, cassetteDir, dbPath, bundle: notarized.dodo.bundle, env, now });
      lines.push(...drift.lines);
      problems.push(...drift.problems);
      driftOut = { ...(drift.result ? { result: drift.result } : {}), ...(drift.fixturePath ? { fixturePath: drift.fixturePath } : {}), storePath: join(outDir, "drift", "notary.sqlite") };
    } else {
      lines.push("  skipped: no dodo notarize bundle");
    }
    lines.push(`  ${stops.line(11)}`);
  } finally {
    restoreTransport();
    globalThis.fetch = realFetch;
    if (hadMode) process.env.NOTARY_MODE = prevMode;
    else delete process.env.NOTARY_MODE;
  }

  lines.push(heading(null, "Demo integrity"));
  lines.push(`  global fetch calls during the demo: ${globalFetchCalls}`);
  lines.push(`  fixture API: ${api.stats.served} request(s) served (${Object.entries(api.stats.byHost).map(([h, n]) => `${h} ${n}`).join(", ")}), ${api.stats.refused.length} refused, ${api.stats.unknownRoutes.length} unsimulated route(s)`);
  if (globalFetchCalls > 0) problems.push(`global fetch was called ${globalFetchCalls} time(s)`);
  if (api.stats.refused.length) problems.push(`fixture transport refused: ${api.stats.refused.join(", ")}`);
  if (api.stats.unknownRoutes.length) problems.push(`unsimulated routes: ${[...new Set(api.stats.unknownRoutes)].join(", ")}`);
  lines.push(`  bundles: ${bundlePaths.map((p) => rel(outDir, p)).join(", ")}`);
  for (const p of problems) lines.push(`  PROBLEM: ${p}`);
  lines.push(problems.length ? `demo finished with ${problems.length} problem(s)` : "demo finished: every stage ran on fixtures; nothing above is a live result");

  return {
    exitCode: problems.length ? 1 : 0,
    lines,
    outDir,
    bundlePaths,
    bundles,
    stats: { globalFetchCalls, served: api.stats.served, refused: [...api.stats.refused], unknownRoutes: [...api.stats.unknownRoutes] },
    ...(driftOut ? { drift: driftOut } : {}),
  };
}
