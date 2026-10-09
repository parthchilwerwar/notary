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
    .option("--replay", "with --recon-only: replay the recon-<tool> cassette (no network, no keys)")
    .action(async (opts: { tool: "crustdata" | "dodo"; reconOnly?: boolean; replay?: boolean }) => {
      if (!opts.reconOnly) notImplemented("notarize", "P4/P5");
      const { reconOnly } = await import("./checker/notarize.js");
      const { initTracing, shutdownTracing } = await import("./trace/index.js");
      // Replay touches no network at all, tracing export included.
      if (!opts.replay) await initTracing({ serviceName: "notary" });
      try {
        if (opts.replay) {
          const { DEFAULT_CASSETTE_DIR, listCassettes } = await import("./tools/index.js");
          if (!listCassettes(DEFAULT_CASSETTE_DIR).includes(`recon-${opts.tool}`)) {
            console.error(`No cassette recon-${opts.tool} in ${DEFAULT_CASSETTE_DIR}; record one first with a live --recon-only run.`);
            process.exitCode = 1;
            return;
          }
        }
        const result = await reconOnly({ tool: opts.tool, replay: opts.replay === true });
        for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      } finally {
        if (!opts.replay) await shutdownTracing();
      }
    });

  program
    .command("run")
    .description("Work the billing queue and write a run bundle")
    .requiredOption("--queue <file>", "queue fixture to work")
    .option("--naive", "disable gating and guards (run-1 baseline)")
    .option("--resume", "continue from the last incomplete item")
    .option("--replay <cassette>", "replay a recorded run from its cassette (no network, no keys)")
    .action(async (opts: { queue: string; naive?: boolean; resume?: boolean; replay?: string }) => {
      if (opts.resume) notImplemented("run --resume", "P6");
      if (!opts.naive) notImplemented("run (guarded)", "P6");
      const { runQueue } = await import("./queue/run.js");
      const { initTracing, shutdownTracing } = await import("./trace/index.js");
      const replay = opts.replay !== undefined;
      if (!replay) await initTracing({ serviceName: "notary" });
      try {
        const result = await runQueue({
          queueFile: opts.queue,
          variant: "naive",
          mode: replay ? "replay" : "live",
          ...(replay ? { cassette: opts.replay! } : {}),
        });
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
    .action(() => notImplemented("replay", "P8"));

  program
    .command("export")
    .description("Write TOOLS.md, guards.json and the latest bundles")
    .option("--sample", "write a synthetic SAMPLE bundle (for dashboard development) to packages/web/public/bundles/")
    .option("--out <dir>", "with --sample: write to this directory instead")
    .option("--seed <n>", "with --sample: PRNG seed", "42")
    .action(async (opts: { sample?: boolean; out?: string; seed: string }) => {
      if (!opts.sample) notImplemented("export", "P8");
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
    .description("Local API + SSE for the dashboard's live mode")
    .action(() => notImplemented("serve", "P6"));

  program
    .command("guards")
    .description("Guard registry commands")
    .command("coverage")
    .description("entire-graph caller check; non-zero exit on any unguarded call site")
    .action(() => notImplemented("guards coverage", "P7"));

  program
    .command("doctor")
    .description("Emit one neatlogs test span and flush")
    .action(async () => {
      const { runDoctor } = await import("./trace/doctor.js");
      const report = await runDoctor();
      console.log(JSON.stringify(report, null, 2));
      if (!report.spanEmitted) process.exitCode = 1;
    });

  return program;
}

async function main(): Promise<void> {
  loadEnv();
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
