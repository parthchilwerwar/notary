import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, Option } from "commander";

export class NotImplementedError extends Error {
  constructor(command: string, phase: string) {
    super(`notary ${command}: not implemented yet (lands in ${phase}, see PLAN.md)`);
    this.name = "NotImplementedError";
  }
}

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
    .action(() => notImplemented("notarize", "P2/P4/P5"));

  program
    .command("run")
    .description("Work the billing queue and write a run bundle")
    .requiredOption("--queue <file>", "queue fixture to work")
    .option("--naive", "disable gating and guards (run-1 baseline)")
    .option("--resume", "continue from the last incomplete item")
    .action(() => notImplemented("run", "P3/P6"));

  program
    .command("replay")
    .description("Re-run from cassettes with no keys and verify headline metrics")
    .option("--bundle <id>", "bundle id to replay")
    .action(() => notImplemented("replay", "P8"));

  program
    .command("export")
    .description("Write TOOLS.md, guards.json and the latest bundles")
    .action(() => notImplemented("export", "P1/P8"));

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
