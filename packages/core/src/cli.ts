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
    .action(async (opts: { tool: "crustdata" | "dodo"; priorsFrom?: string; reconOnly?: boolean; replay?: boolean; adversary?: "bedrock" | "session" }) => {
      if (opts.priorsFrom) notImplemented("notarize --priors-from", "P7");
      const { initTracing, shutdownTracing } = await import("./trace/index.js");
      if (!opts.reconOnly) {
        // Full loop: recon -> checker -> hypotheses -> probes -> beliefs -> evidence check -> adversary.
        const { notarize } = await import("./reflect/notarize.js");
        await initTracing({ serviceName: "notary" });
        try {
          const result = await notarize({ tool: opts.tool, replay: opts.replay === true, adversary: opts.adversary ?? "bedrock" });
          for (const line of result.lines) (result.exitCode === 0 ? console.log : console.error)(line);
          if (result.exitCode !== 0) process.exitCode = result.exitCode;
        } finally {
          await shutdownTracing();
        }
        return;
      }
      const { reconOnly } = await import("./checker/notarize.js");
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
      const { initTracing, shutdownTracing } = await import("./trace/index.js");
      const replay = opts.replay !== undefined;
      if (!replay) await initTracing({ serviceName: "notary" });
      try {
        const result = await runQueue({
          ...(opts.queue ? { queueFile: opts.queue } : {}),
          variant: opts.naive ? "naive" : "guarded",
          mode: replay ? "replay" : "live",
          ...(replay ? { cassette: opts.replay! } : {}),
          ...(opts.resume ? { resume: true } : {}),
          ...(opts.run ? { runId: opts.run } : {}),
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
