import { describe, expect, it } from "vitest";
import { buildProgram, NotImplementedError } from "../src/cli.js";

function parse(args: string[]) {
  const program = buildProgram();
  const silent = { writeOut: () => {}, writeErr: () => {} };
  for (const cmd of [program, ...program.commands, ...program.commands.flatMap((c) => c.commands)]) {
    cmd.exitOverride();
    cmd.configureOutput(silent);
  }
  return program.parseAsync(["node", "notary", ...args]);
}

describe("cli", () => {
  it("registers every TDD subcommand plus doctor", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(["notarize", "run", "replay", "export", "serve", "guards", "doctor"]);
    const guards = buildProgram().commands.find((c) => c.name() === "guards");
    expect(guards?.commands.map((c) => c.name())).toEqual(["coverage"]);
  });

  it.each([
    [["notarize", "--tool", "crustdata"]],
    [["run", "--queue", "fixtures/queue/seeded.json"]],
    [["replay"]],
    [["export"]],
    [["serve"]],
    [["guards", "coverage"]],
  ])("stubs %j with a not-implemented error", async (args) => {
    await expect(parse(args)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("notarize has --recon-only and --replay flags", () => {
    const notarize = buildProgram().commands.find((c) => c.name() === "notarize");
    expect(notarize?.options.map((o) => o.long)).toEqual(["--tool", "--priors-from", "--recon-only", "--replay"]);
  });

  it("rejects an unknown tool", async () => {
    await expect(parse(["notarize", "--tool", "stripe"])).rejects.toThrow();
  });

  it("requires --queue for run", async () => {
    await expect(parse(["run"])).rejects.toThrow();
  });
});
