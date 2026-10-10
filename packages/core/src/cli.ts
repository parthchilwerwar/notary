import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import { NotImplementedError } from "./errors.js";

export { NotImplementedError };

function notImplemented(command: string, phase: string): never {
  throw new NotImplementedError(command, phase);
}

// .env lives at the repo root; values are read into process.env and never printed.
function loadEnv(): void {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

export function buildProgram(): Command {
  const program = new Command()
    .name("notary")
    .description("An agent that won't touch money until it has proven how its tools actually behave.")
    .showHelpAfterError();

  program
    .command("notarize")
    .description("Run the notarization loop for one tool")
    .addOption(new Option("--tool <tool>", "tool to notarize").choices(["crustdata", "dodo"]).makeOptionMandatory())
    .addOption(new Option("--priors-from <tool>", "seed priors from another tool's defect classes").choices(["crustdata", "dodo"]))
    .option("--recon-only", "run the recon sweep and the deterministic checker only, then write a notarize bundle")
    .option("--replay", "replay the recon-<tool> (and, without --recon-only, probes-<tool>) cassettes: no tool network, no tool keys")
    .addOption(
      new Option("--adversary <backend>", "adversary backend for candidate beliefs").choices(["bedrock", "session"]).default("bedrock"),
    )
    .option("--priors-bundle <path>", "with --priors-from: use this notarize bundle instead of the source tool's latest")
    .option("--compare-priors", "replay the probe loop twice over the probes-<tool> cassette (without / with priors) and record probes-to-candidate for both")
    .action(
      async (opts: {
        tool: "crustdata" | "dodo";
        priorsFrom?: "crustdata" | "dodo";
        reconOnly?: boolean;
        replay?: boolean;
        adversary?: "bedrock" | "session";
        priorsBundle?: string;
        comparePriors?: boolean;
      }) => {
        if (opts.priorsBundle && !opts.priorsFrom && !opts.comparePriors) throw new Error("--priors-bundle goes with --priors-from or --compare-priors");
        if (opts.reconOnly && (opts.priorsFrom || opts.comparePriors)) throw new Error("--recon-only runs no probe loop; it takes no --priors-from or --compare-priors");
        if (opts.comparePriors) {
          // Replay only (no tool network): the probe loop twice, without and with transfer priors.
          const { comparePriors } = await import("./reflect/compare-priors.js");
          const result = await comparePriors({
            tool: opts.tool,
            ...(opts.priorsFrom ? { priorsFrom: opts.priorsFrom } : {}),
            ...(opts.priorsBundle ? { priorsBundle: opts.priorsBundle } : {}),
          });
          for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
          if (result.exitCode !== 0) process.exitCode = result.exitCode;
          return;
        }
        const { initTracing, shutdownTracing, withWorkflow } = await import("./trace/index.js");
        if (!opts.reconOnly) {
          // Full loop: recon -> checker -> hypotheses -> probes -> beliefs -> evidence check -> adversary.
          const { notarize, recordedRunId } = await import("./reflect/notarize.js");
          const { unguardedCallSitesMetric } = await import("./eval/metrics.js");
          if (opts.replay && !opts.priorsFrom) {
            // P8: a recorded live run replays exactly (its own probe ids/tags, model answers and store
            // snapshot, no keys) through `notary replay`; older cassettes fall back to the P7 path.
            const { RUNS_DIR } = await import("./checker/notarize.js");
            const recorded = recordedRunId(RUNS_DIR, opts.tool);
            if (recorded) {
              const { runReplay } = await import("./replay/index.js");
              console.log(`notarize --replay: replaying recorded run ${recorded} (same as: notary replay --bundle ${recorded})`);
              const result = await runReplay({ bundle: recorded, unguardedCallSites: unguardedCallSitesMetric });
              for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
              process.exitCode = result.exitCode;
              return;
            }
          }
          await initTracing({ serviceName: "notarize" });
          try {
            const result = await withWorkflow(`notarize.${opts.tool}`, () => notarize({
              tool: opts.tool,
              replay: opts.replay === true,
              adversary: opts.adversary ?? "bedrock",
              ...(opts.priorsFrom ? { priorsFrom: opts.priorsFrom } : {}),
              ...(opts.priorsBundle ? { priorsBundle: opts.priorsBundle } : {}),
              unguardedCallSites: unguardedCallSitesMetric,
            }));
            for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
            if (result.exitCode !== 0) process.exitCode = result.exitCode;
          } finally {
            await shutdownTracing();
          }
          return;
        }
        const { reconOnly } = await import("./checker/notarize.js");
        // Replay touches no network at all, tracing export included.
        if (!opts.replay) await initTracing({ serviceName: "recon" });
        try {
          if (opts.replay) {
            const { DEFAULT_CASSETTE_DIR, listCassettes } = await import("./tools/index.js");
            if (!listCassettes(DEFAULT_CASSETTE_DIR).includes(`recon-${opts.tool}`)) {
              console.error(`No cassette recon-${opts.tool} in ${DEFAULT_CASSETTE_DIR}; record one first with a live --recon-only run.`);
              process.exitCode = 1;
              return;
            }
          }
          const { unguardedCallSitesMetric } = await import("./eval/metrics.js");
          const result = await withWorkflow(`recon.${opts.tool}`, () =>
            reconOnly({ tool: opts.tool, replay: opts.replay === true, unguardedCallSites: unguardedCallSitesMetric }),
          );
          for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
          if (result.exitCode !== 0) process.exitCode = result.exitCode;
        } finally {
          if (!opts.replay) await shutdownTracing();
        }
      },
    );

  program
    .command("run")
    .description("Work the billing queue and write a run bundle")
    .option("--queue <file>", "queue fixture to work (required unless --resume)")
    .option("--naive", "disable gating and guards (run-1 baseline)")
    .option("--resume", "continue an interrupted guarded run from its last incomplete item")
    .option("--run <runId>", "with --resume: the run to continue (default: the latest unfinished one)")
    .option("--replay <cassette>", "replay a recorded run from its cassette (no network, no keys)")
    .action(async (opts: { queue?: string; naive?: boolean; resume?: boolean; run?: string; replay?: string }) => {
      if (opts.resume && (opts.naive || opts.replay !== undefined)) throw new Error("--resume continues a live guarded run; it takes no --naive or --replay");
      if (!opts.resume && !opts.queue) throw new Error("run needs --queue <file> (or --resume)");
      if (opts.run && !opts.resume) throw new Error("--run <runId> is only used with --resume");
      const { runQueue } = await import("./queue/run.js");
      const { unguardedCallSitesMetric } = await import("./eval/metrics.js");
      const { initTracing, shutdownTracing, withWorkflow } = await import("./trace/index.js");
      const replay = opts.replay !== undefined;
      if (!replay) await initTracing({ serviceName: "queue-run" });
      try {
        const variant = opts.naive ? "naive" : "guarded";
        const result = await withWorkflow(`queue-run.${variant}`, () => runQueue({
          ...(opts.queue ? { queueFile: opts.queue } : {}),
          variant,
          mode: replay ? "replay" : "live",
          ...(replay ? { cassette: opts.replay! } : {}),
          ...(opts.resume ? { resume: true } : {}),
          ...(opts.run ? { runId: opts.run } : {}),
          unguardedCallSites: unguardedCallSitesMetric,
        }));
        for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      } finally {
        if (!replay) await shutdownTracing();
      }
    });

  program
    .command("replay")
    .description("Re-run from cassettes with no keys and verify headline metrics")
    .option("--bundle <id>", "bundle id to replay")
    .option("--drift <fixture>", "replay a drift fixture's source run, then the drift: belief trajectory and retired guards")
    .action(async (opts: { bundle?: string; drift?: string }) => {
      // No .env, no keys, no tracing export: replay reads nothing from the environment (see main()).
      const { runReplay } = await import("./replay/index.js");
      const { unguardedCallSitesMetric } = await import("./eval/metrics.js");
      const result = await runReplay({
        ...(opts.bundle ? { bundle: opts.bundle } : {}),
        ...(opts.drift ? { drift: opts.drift } : {}),
        unguardedCallSites: unguardedCallSitesMetric,
      });
      for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
      process.exitCode = result.exitCode;
    });

  program
    .command("eval")
    .description("Evaluation commands")
    .command("noise-floor")
    .description("Run the guarded queue N times and record each metric's run-to-run spread as its noise floor")
    .requiredOption("--queue <file>", "queue fixture to run")
    .option("--runs <n>", "number of runs", "3")
    .option("--replay", "replay the newest recorded live guarded run of this queue instead (no keys)")
    .action(async (opts: { queue: string; runs: string; replay?: boolean }) => {
      const runs = Number(opts.runs);
      if (!Number.isInteger(runs) || runs < 2) throw new Error(`--runs must be an integer >= 2, got ${JSON.stringify(opts.runs)}`);
      const { runNoiseFloor } = await import("./eval/noise-floor.js");
      const { unguardedCallSitesMetric } = await import("./eval/metrics.js");
      const { resolveInputPath } = await import("./queue/run.js");
      const { initTracing, shutdownTracing, withWorkflow } = await import("./trace/index.js");
      if (!opts.replay) await initTracing({ serviceName: "noise-floor" });
      try {
        const result = await withWorkflow("noise-floor", () => runNoiseFloor({
          queueFile: resolveInputPath(opts.queue),
          runs,
          ...(opts.replay ? { replay: true, env: {} } : {}),
          unguardedCallSites: unguardedCallSitesMetric,
        }));
        for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
        process.exitCode = result.exitCode;
      } finally {
        if (!opts.replay) await shutdownTracing();
      }
    });

  program
    .command("export")
    .description("Write TOOLS.md, guards.json and the latest bundles")
    .option("--sample", "write a synthetic SAMPLE bundle (for dashboard development) to packages/web/public/bundles/")
    .option("--out <dir>", "dashboard bundles directory to write to instead of packages/web/public/bundles/")
    .option("--seed <n>", "with --sample: PRNG seed", "42")
    .option("--runs-dir <dir>", "read real bundles from this directory instead of packages/core/runs/")
    .option("--root <dir>", "write export/ and docs/EVALUATION.md under this directory instead of the repo root")
    .option("--no-checks", "skip running `pnpm test` and `guards coverage` for EVALUATION.md")
    .action(async (opts: { sample?: boolean; out?: string; seed: string; runsDir?: string; root?: string; checks: boolean }) => {
      if (!opts.sample) {
        const { runExport } = await import("./export/index.js");
        const { join, resolve } = await import("node:path");
        // pnpm runs scripts from packages/core; resolve relative paths against where the user ran it.
        const at = (p: string): string => resolve(process.env.INIT_CWD ?? process.cwd(), p);
        const result = await runExport({
          ...(opts.runsDir ? { runsDir: at(opts.runsDir) } : {}),
          ...(opts.root ? { exportDir: join(at(opts.root), "export"), docsDir: join(at(opts.root), "docs") } : {}),
          ...(opts.out ? { webBundlesDir: at(opts.out) } : {}),
          ...(opts.checks ? {} : { checks: null }),
        });
        for (const line of result.lines) console.log(line);
        return;
      }
      const seed = Number(opts.seed);
      if (!Number.isInteger(seed)) throw new Error(`--seed must be an integer, got ${JSON.stringify(opts.seed)}`);
      const { buildSampleBundle, writeBundle } = await import("./bundle/index.js");
      const dir = opts.out ?? fileURLToPath(new URL("../../web/public/bundles/", import.meta.url));
      const { bundlePath, indexPath } = await writeBundle(buildSampleBundle(seed), dir);
      console.log(`SAMPLE bundle (synthetic, not a run result) written to ${bundlePath}`);
      console.log(`index updated: ${indexPath}`);
    });

  program
    .command("serve")
    .description("Local API + SSE for the dashboard's live mode (read-only)")
    .option("--port <port>", "port to listen on", "8787")
    .option("--host <host>", "interface to bind (loopback by default)", "127.0.0.1")
    .action(async (opts: { port: string; host: string }) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0-65535, got ${JSON.stringify(opts.port)}`);
      const loopback = ["127.0.0.1", "localhost", "::1"].includes(opts.host);
      if (!loopback) console.warn(`warning: binding ${opts.host} exposes the API beyond this machine`);
      const { startServer } = await import("./api/server.js");
      const server = await startServer({ port, host: opts.host });
      console.log(`notary serve: listening on ${server.url}`);
      console.log(`  GET ${server.url}/api/bundles  GET ${server.url}/api/bundles/:id  GET ${server.url}/api/stream (SSE)`);
      const shutdown = (): void => {
        void server.close().then(() => process.exit(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });

  program
    .command("guards")
    .description("Guard registry commands")
    .command("coverage")
    .description("entire-graph caller check; non-zero exit on any unguarded call site")
    .option("--json", "machine-readable report (unguarded_call_sites, sites, totals)")
    .addOption(new Option("--backend <backend>", "caller backend; auto uses entire when on PATH").choices(["auto", "entire", "tsc"]).default("auto"))
    .action(async (opts: { json?: boolean; backend: "auto" | "entire" | "tsc" }) => {
      const { runCoverage, formatCoverage, coverageExitCode } = await import("./guards/coverage.js");
      const report = runCoverage({ backend: opts.backend });
      console.log(opts.json ? JSON.stringify(report, null, 2) : formatCoverage(report));
      process.exitCode = coverageExitCode(report);
    });

  program
    .command("demo")
    .description("Run the whole pipeline end to end on FIXTURE data (simulated APIs and model doubles; no keys, no network)")
    .option("--fixture", "required: use the in-process fixture API and model doubles (the only demo mode)")
    .action(async (opts: { fixture?: boolean }) => {
      if (!opts.fixture) throw new Error("notary demo needs --fixture (there is no live demo: live runs are `notarize` and `run`)");
      const { runFixtureDemo } = await import("./demo/index.js");
      const result = await runFixtureDemo();
      for (const line of result.lines) console.log(line);
      process.exitCode = result.exitCode;
    });

  program
    .command("doctor")
    .description("Emit one neatlogs test span and flush")
    .action(async () => {
      const { runDoctor } = await import("./trace/doctor.js");
      const report = await runDoctor();
      console.log(JSON.stringify(report, null, 2));
      if (report.spanEmitted) return;
      // A missing key is a BLOCKED precondition (exit 3), like every other keyed command; a key that
      // is set but fails to export is a real failure (exit 1).
      if (!report.tracing.enabled && /not set/.test(report.tracing.reason ?? "")) {
        console.error(`BLOCKED: ${report.tracing.reason}`);
        process.exitCode = 3;
      } else {
        process.exitCode = 1;
      }
    });

  return program;
}

/** Commands that must run with no keys: they never load .env (P8: replay reads nothing for credentials). */
export function isKeylessInvocation(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  const cmd = args.find((a) => !a.startsWith("-"));
  if (cmd === "replay" || cmd === "demo") return true;
  return cmd === "eval" && args.includes("--replay");
}

/** Commands that emit live events; they journal them so a separate `notary serve` can stream them. */
const EVENT_PRODUCING_COMMANDS = new Set(["run", "notarize", "eval"]);

async function main(): Promise<void> {
  if (!isKeylessInvocation(process.argv)) loadEnv();
  const cmd = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (cmd && EVENT_PRODUCING_COMMANDS.has(cmd)) {
    const { setEventJournal, DEFAULT_EVENT_JOURNAL } = await import("./api/bus.js");
    setEventJournal(DEFAULT_EVENT_JOURNAL);
  }
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    if (err instanceof NotImplementedError) {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
