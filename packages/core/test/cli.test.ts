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
    [["notarize", "--tool", "crustdata", "--priors-from", "dodo"]],
    [["replay"]],
    [["export"]],
    [["guards", "coverage"]],
  ])("stubs %j with a not-implemented error", async (args) => {
    await expect(parse(args)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("notarize has --recon-only, --replay and --adversary flags", () => {
    const notarize = buildProgram().commands.find((c) => c.name() === "notarize");
    expect(notarize?.options.map((o) => o.long)).toEqual(["--tool", "--priors-from", "--recon-only", "--replay", "--adversary"]);
    const adv = notarize?.options.find((o) => o.long === "--adversary");
    expect(adv?.argChoices).toEqual(["bedrock", "session"]);
    expect(adv?.defaultValue).toBe("bedrock");
  });

  it("run: needs --queue unless --resume; --resume is guarded-live only; --run goes with --resume", async () => {
    await expect(parse(["run"])).rejects.toThrow(/needs --queue/);
    await expect(parse(["run", "--queue", "x", "--naive", "--resume"])).rejects.toThrow(/--resume continues a live guarded run/);
    await expect(parse(["run", "--resume", "--replay", "c"])).rejects.toThrow(/--resume continues a live guarded run/);
    await expect(parse(["run", "--queue", "x", "--run", "r1"])).rejects.toThrow(/only used with --resume/);
    const run = buildProgram().commands.find((c) => c.name() === "run");
    expect(run?.options.map((o) => o.long)).toEqual(["--queue", "--naive", "--resume", "--run", "--replay"]);
  });

  it("serve takes --port (default 8787) and --host (default loopback) and rejects a bad port", async () => {
    const serve = buildProgram().commands.find((c) => c.name() === "serve");
    expect(serve?.options.map((o) => [o.long, o.defaultValue])).toEqual([
      ["--port", "8787"],
      ["--host", "127.0.0.1"],
    ]);
    await expect(parse(["serve", "--port", "http"])).rejects.toThrow(/--port must be/);
  });

  it("rejects an unknown tool", async () => {
    await expect(parse(["notarize", "--tool", "stripe"])).rejects.toThrow();
  });

  it("requires --queue for run", async () => {
    await expect(parse(["run"])).rejects.toThrow();
  });
});
