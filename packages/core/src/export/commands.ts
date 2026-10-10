/**
 * The command that produced a bundle. Bundles do not store their argv, so it is reconstructed from
 * the fields each writer sets (kind, variant, mode, tool, priorsFrom, cassettes, the "Seeded queue:"
 * disclosure, the adversary backend recorded on reviewed beliefs). Every reconstruction is a real
 * CLI invocation of this repo; EVALUATION.md says that commands are reconstructed.
 */
import type { RunBundle, Tool } from "../schema/index.js";
import { classify } from "./collect.js";

export const DEFAULT_QUEUE = "packages/core/fixtures/queue/seeded.json";

/** Queue file from the run writer's "Seeded queue: <path> (SEEDED FIXTURE)" disclosure, repo-relative. */
function queueOf(b: RunBundle): string {
  for (const d of b.disclosure) {
    const m = /^Seeded queue: (.+?) \(SEEDED FIXTURE\)$/.exec(d);
    if (m) {
      const p = m[1]!;
      // The run writer prints paths relative to packages/core; absolute paths are kept as is.
      return /^([A-Za-z]:[\\/]|\/)/.test(p) || p.startsWith("packages/") ? p : `packages/core/${p}`;
    }
  }
  return DEFAULT_QUEUE;
}

export function commandFor(b: RunBundle): string {
  switch (classify(b)) {
    case "run-naive":
    case "run-guarded": {
      const parts = ["pnpm notary run", `--queue ${queueOf(b)}`];
      if (b.variant === "naive") parts.push("--naive");
      // bundle.cassettes entries are pinned as "name@sha256"; the CLI takes the bare name.
      if (b.mode === "replay") parts.push(`--replay ${b.replayOf ?? b.cassettes[0]?.split("@")[0] ?? "<cassette>"}`);
      return parts.join(" ");
    }
    case "notarize-recon":
      return `pnpm notary notarize --tool ${b.tool ?? "<tool>"} --recon-only${b.mode === "replay" ? " --replay" : ""}`;
    case "notarize-compare-priors":
      return `pnpm notary notarize --tool ${b.tool ?? "<tool>"} --compare-priors${b.priorsFrom ? ` --priors-from ${b.priorsFrom}` : ""}`;
    case "notarize-full": {
      const parts = [`pnpm notary notarize --tool ${b.tool ?? "<tool>"}`];
      if (b.priorsFrom) parts.push(`--priors-from ${b.priorsFrom}`);
      if (b.mode === "replay") parts.push("--replay");
      if (b.beliefs.after.some((x) => x.adversary?.backend === "session")) parts.push("--adversary session");
      return parts.join(" ");
    }
  }
}

/** Commands for bundles that do not exist yet ("Not yet measured"). */
export const PRODUCE = {
  naive: `pnpm notary run --queue ${DEFAULT_QUEUE} --naive`,
  guarded: `pnpm notary run --queue ${DEFAULT_QUEUE}`,
  notarize: (tool: Tool): string =>
    tool === "dodo" ? "pnpm notary notarize --tool dodo --priors-from crustdata" : `pnpm notary notarize --tool ${tool}`,
  comparePriors: "pnpm notary notarize --tool dodo --compare-priors --priors-from crustdata",
  replay: "pnpm notary replay",
  drift:
    "pnpm --filter @notary/core make:drift --from <recorded cassette> --exchange <requestHash> --set '<jsonPath>=<value>' --out <name>",
  noiseFloor: `pnpm notary run --queue ${DEFAULT_QUEUE}`,
} as const;
