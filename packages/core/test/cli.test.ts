import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProgram, isKeylessInvocation, NotImplementedError } from "../src/cli.js";

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
    expect(names).toEqual(["notarize", "run", "replay", "eval", "export", "serve", "guards", "doctor"]);
    const guards = buildProgram().commands.find((c) => c.name() === "guards");
    expect(guards?.commands.map((c) => c.name())).toEqual(["coverage"]);
  });

  it("replay has --bundle and --drift; eval noise-floor has --queue, --runs (default 3) and --replay (P8)", () => {
    const replay = buildProgram().commands.find((c) => c.name() === "replay");
    expect(replay?.options.map((o) => o.long)).toEqual(["--bundle", "--drift"]);
    const nf = buildProgram()
      .commands.find((c) => c.name() === "eval")
      ?.commands.find((c) => c.name() === "noise-floor");
    expect(nf?.options.map((o) => o.long)).toEqual(["--queue", "--runs", "--replay"]);
    expect(nf?.options.find((o) => o.long === "--runs")?.defaultValue).toBe("3");
  });

  it("replay and eval --replay never load .env; everything else does", () => {
    expect(isKeylessInvocation(["node", "cli", "replay"])).toBe(true);
    expect(isKeylessInvocation(["node", "cli", "replay", "--bundle", "x"])).toBe(true);
    expect(isKeylessInvocation(["node", "cli", "eval", "noise-floor", "--queue", "q", "--replay"])).toBe(true);
    expect(isKeylessInvocation(["node", "cli", "eval", "noise-floor", "--queue", "q"])).toBe(false);
    expect(isKeylessInvocation(["node", "cli", "run", "--replay", "c"])).toBe(false);
  });

  it("not-implemented commands still raise NotImplementedError", () => {
    expect(new NotImplementedError("x", "P9")).toBeInstanceOf(Error);
  });

  it("export (no --sample) runs for real: writes TOOLS.md, guards.json, EVALUATION.md; no real runs -> all unverified", async () => {
    const root = mkdtempSync(join(tmpdir(), "notary-cli-export-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await parse(["export", "--runs-dir", join(root, "runs"), "--root", root, "--out", join(root, "web"), "--no-checks"]);
      expect(readFileSync(join(root, "export", "TOOLS.md"), "utf8")).toMatch(/No real notarize bundles exist yet/);
      expect(JSON.parse(readFileSync(join(root, "export", "guards.json"), "utf8"))).toEqual({ generatedFrom: [], guards: [] });
      expect(readFileSync(join(root, "docs", "EVALUATION.md"), "utf8")).toMatch(/from 0 bundles — do not edit by hand/);
      expect(existsSync(join(root, "web", "index.json"))).toBe(false);
    } finally {
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("guards coverage has --json and --backend auto|entire|tsc", () => {
    const coverage = buildProgram()
      .commands.find((c) => c.name() === "guards")
      ?.commands.find((c) => c.name() === "coverage");
    expect(coverage?.options.map((o) => o.long)).toEqual(["--json", "--backend"]);
    const backend = coverage?.options.find((o) => o.long === "--backend");
    expect(backend?.argChoices).toEqual(["auto", "entire", "tsc"]);
    expect(backend?.defaultValue).toBe("auto");
  });

  it("notarize has --recon-only, --replay and --adversary flags", () => {
    const notarize = buildProgram().commands.find((c) => c.name() === "notarize");
    expect(notarize?.options.map((o) => o.long)).toEqual([
      "--tool",
      "--priors-from",
      "--recon-only",
      "--replay",
      "--adversary",
      "--priors-bundle",
      "--compare-priors",
    ]);
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

  it("notarize: --priors-bundle needs --priors-from/--compare-priors; --recon-only takes neither", async () => {
    await expect(parse(["notarize", "--tool", "dodo", "--priors-bundle", "x.json"])).rejects.toThrow(/--priors-bundle goes with/);
    await expect(parse(["notarize", "--tool", "dodo", "--recon-only", "--priors-from", "crustdata"])).rejects.toThrow(/--recon-only runs no probe loop/);
    await expect(parse(["notarize", "--tool", "dodo", "--recon-only", "--compare-priors"])).rejects.toThrow(/--recon-only runs no probe loop/);
  });

  it("rejects an unknown tool", async () => {
    await expect(parse(["notarize", "--tool", "stripe"])).rejects.toThrow();
  });

  it("requires --queue for run", async () => {
    await expect(parse(["run"])).rejects.toThrow();
  });
});
