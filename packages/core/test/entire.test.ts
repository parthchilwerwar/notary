/**
 * src/entire (packages/web/public/evidence/entire.json) and schema/entire.ts. The Entire CLI and git
 * are TEST DOUBLES that replay REAL output captured on 2026-10-12 from Entire CLI 0.11.4 in a scratch
 * clone of this repo (test/fixtures/entire/: checkpoint-list.json, checkpoint-explain.json,
 * status.json). The checkpoint is the one Entire made for a real headless adversary review
 * (`adversary: downgrade belief-crustdata.enrich.headcount-total-integer`).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkpointCommits,
  collectEntireFile,
  entireCliVersion,
  explainCheckpoint,
  listCheckpoints,
  parseAdversaryCommit,
  readEntireSettings,
  toEntireCoverage,
  writeEntireFile,
  type Exec,
} from "../src/entire/index.js";
import type { CoverageReport } from "../src/guards/coverage.js";
import { ENTIRE_FILE_KIND, EntireFileSchema } from "../src/schema/entire.js";
import { EntireFileSchema as FromIndex } from "../src/schema/index.js";

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "entire", name), "utf8");
const CP = "01M4PYAG60V4ZBFR9WN79VAWB1";
const SHA = "e6cb269672b674cd3990aac2b212134419ce66c0";
const HEAD = "50cd3366bad484d04dc27a5902cb6c3c6dd42c69";
const SUBJECT = "adversary: downgrade belief-crustdata.enrich.headcount-total-integer";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function repoWith(settings: Record<string, unknown> | null, local?: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), "notary-entire-"));
  dirs.push(d);
  if (settings) {
    mkdirSync(join(d, ".entire"), { recursive: true });
    writeFileSync(join(d, ".entire", "settings.json"), JSON.stringify(settings));
    if (local) writeFileSync(join(d, ".entire", "settings.local.json"), JSON.stringify(local));
  }
  return d;
}

/** Replays real `entire` output by subcommand. */
function entireDouble(overrides: Partial<Record<string, string | null>> = {}): Exec {
  const table: Record<string, string | null> = {
    "--version": "Entire CLI 0.11.4\nGo version: go1.27.1\nOS/Arch: windows/amd64\n",
    "graph version": '{"provider":"entire-graph","version":"v0.4.0"}\n',
    "status": fixture("status.json"),
    "checkpoint list": fixture("checkpoint-list.json"),
    "checkpoint explain": fixture("checkpoint-explain.json"),
    ...overrides,
  };
  return (args) => {
    const key = args[0] === "--version" ? "--version" : args.slice(0, 2).join(" ").replace(/ --json$/, "");
    const out = table[key] ?? table[args[0]!];
    if (out === null || out === undefined) return { status: 1, stdout: "", stderr: `unknown command ${args.join(" ")}` };
    return { status: 0, stdout: out, stderr: "" };
  };
}

/** git: HEAD, branch, and a log where SHA carries the checkpoint trailer. */
const gitDouble: Exec = (args) => {
  if (args[0] === "rev-parse" && args[1] === "HEAD") return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
  if (args[0] === "rev-parse") return { status: 0, stdout: "main\n", stderr: "" };
  if (args[0] === "log") return { status: 0, stdout: `${SHA}\x1f${SUBJECT}\x1f${CP}\x1e\n${HEAD}\x1fscratch: entire enable\x1f\x1e\n`, stderr: "" };
  return { status: 1, stdout: "", stderr: "unexpected" };
};

const enabled = { enabled: true, telemetry: false, checkpoints: { primary: { type: "git-refs" } }, commit_linking: "always" };

const coverageReport = (unguarded = 0): CoverageReport => ({
  backend: "entire",
  backendNote: "x",
  entire: {
    provider: "entire-graph",
    providerVersion: "v0.4.0",
    commit: "0ce991dc108e6708620e70015f694e2c6e57be5a",
    tree: "5922bc8d04ae38682812272f630b50a1a3c6a015",
    worktree: true,
    completeness: "ok",
    partialFailures: 0,
    skippedFiles: [],
    callEdges: 7666,
    constructEdges: 377,
    clientEdges: 2,
    command: "entire graph edges --repo . --format ndjson --worktree --relation CALLS,ASYNC_CALLS,CONSTRUCTS",
  },
  ops: [],
  sites: unguarded ? [{ op: "dodo.createRefund", file: "packages/core/src/x.ts", line: 4, status: "UNGUARDED", detail: "called from x (entire graph)" }] : [],
  createToolsCalls: [],
  totals: { ops: 18, sites: 33, guarded: 26, rawByDesign: 7, unguarded },
  unguarded_call_sites: unguarded,
});

describe("Entire CLI readers (real captured output)", () => {
  it("reads the CLI version and the repo settings layers", () => {
    expect(entireCliVersion(entireDouble(), ".")).toBe("0.11.4");
    expect(entireCliVersion(() => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }), ".")).toBeNull();
    expect(readEntireSettings(repoWith(enabled))).toEqual({ enabled: true, checkpointStore: "git-refs", commitLinking: "always" });
    expect(readEntireSettings(repoWith({ enabled: true }, { commit_linking: "prompt", enabled: false }))).toEqual({ enabled: false, checkpointStore: null, commitLinking: "prompt" });
    expect(readEntireSettings(repoWith(null))).toEqual({ enabled: false, checkpointStore: null, commitLinking: null });
  });

  it("lists checkpoints and explains one (metadata only)", () => {
    const list = listCheckpoints(entireDouble(), ".");
    expect(list).toEqual([
      expect.objectContaining({ checkpoint_id: CP, session_id: "f5cf4a6a-3f07-4c6d-8b51-e9ecce71d467", agent: "Claude Code", is_logs_only: true }),
    ]);
    expect(explainCheckpoint(entireDouble(), ".", CP)).toEqual({
      filesTouched: ["adversary/verdicts/belief-crustdata.enrich.headcount-total-integer.json"],
      model: "claude-opus-5-5",
      tokens: { input: 6, output: 1894, cacheRead: 17027, cacheCreation: 8670, apiCalls: 3 },
    });
    expect(() => listCheckpoints(entireDouble({ "checkpoint list": "not json" }), ".")).toThrow(/JSON array/);
  });

  it("maps checkpoint ids to commits from Entire-Checkpoint trailers", () => {
    expect([...checkpointCommits(gitDouble, ".")]).toEqual([[CP, { sha: SHA, subject: SUBJECT }]]);
  });

  it("recognizes adversary verdict commits only by their exact message", () => {
    expect(parseAdversaryCommit("adversary: downgrade belief-crustdata.enrich.headcount-total-integer")).toEqual({
      verdict: "downgrade",
      beliefId: "belief-crustdata.enrich.headcount-total-integer",
    });
    expect(parseAdversaryCommit("adversary: maybe belief-x")).toBeNull();
    expect(parseAdversaryCommit("K4: visual check loop")).toBeNull();
  });
});

describe("entire.json", () => {
  it("collects the real checkpoint as an adversary review tied to its session and commit", () => {
    const file = collectEntireFile({ repoRoot: repoWith(enabled), entire: entireDouble(), git: gitDouble, coverage: () => coverageReport() });
    expect(EntireFileSchema.parse(file)).toEqual(file);
    expect(FromIndex).toBe(EntireFileSchema);
    expect(file).toMatchObject({
      kind: ENTIRE_FILE_KIND,
      repoHead: HEAD,
      branch: "main",
      cli: { installed: true, version: "0.11.4", graphPlugin: "v0.4.0" },
      repo: { enabled: true, agents: ["Claude Code"], checkpointStore: "git-refs", commitLinking: "always" },
      checkpointsNote: null,
      coverageNote: null,
    });
    expect(file.checkpoints).toEqual([
      {
        id: CP,
        at: "2026-10-12T02:15:49.000Z",
        agent: "Claude Code",
        sessionIds: ["f5cf4a6a-3f07-4c6d-8b51-e9ecce71d467"],
        model: "claude-opus-5-5",
        commit: SHA,
        message: "adversary: downgrade belief-crustdata.enrich.headcount-total-integer",
        filesTouched: ["adversary/verdicts/belief-crustdata.enrich.headcount-total-integer.json"],
        tokens: { input: 6, output: 1894, cacheRead: 17027, cacheCreation: 8670, apiCalls: 3 },
        kind: "adversary-review",
        review: { verdict: "downgrade", beliefId: "belief-crustdata.enrich.headcount-total-integer" },
        logsOnly: true,
      },
    ]);
    expect(file.coverage).toMatchObject({ backend: "entire", graphVersion: "v0.4.0", unguardedCallSites: 0, unguarded: [], callEdges: 7666, ops: 18 });
  });

  it("is empty with the reason (and the exact command) when there is nothing real to show", () => {
    const none = collectEntireFile({ repoRoot: repoWith(enabled), entire: entireDouble({ "checkpoint list": "[]\n" }), git: gitDouble, coverage: null });
    expect(none.checkpoints).toEqual([]);
    expect(none.checkpointsNote).toMatch(/no commit on main carries an Entire-Checkpoint trailer yet/);
    expect(none.checkpointsNote).toContain("--adversary session");
    expect(none.coverage).toBeNull();
    expect(none.coverageNote).toMatch(/skipped/);

    const missing = collectEntireFile({ repoRoot: repoWith(null), entire: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }), git: gitDouble });
    expect(missing.cli).toEqual({ installed: false, version: null, graphPlugin: null });
    expect(missing.checkpointsNote).toMatch(/not on PATH/);
    expect(missing.coverageNote).toMatch(/needs the Entire CLI/);

    const disabled = collectEntireFile({ repoRoot: repoWith(null), entire: entireDouble(), git: gitDouble, coverage: () => coverageReport() });
    expect(disabled.checkpointsNote).toContain("entire enable --agent claude-code");

    const noGraph = collectEntireFile({ repoRoot: repoWith(enabled), entire: entireDouble({ "graph version": null }), git: gitDouble, coverage: () => coverageReport() });
    expect(noGraph.coverageNote).toContain("entire plugin install graph");

    const failing = collectEntireFile({ repoRoot: repoWith(enabled), entire: entireDouble(), git: gitDouble, coverage: () => { throw new Error("entire graph failed: boom"); } });
    expect(failing.coverage).toBeNull();
    expect(failing.coverageNote).toMatch(/failed: entire graph failed: boom/);
  });

  it("never publishes a live session's shadow snapshots (40-hex ids whose message is prompt text)", () => {
    // Real shape seen in this repo on 2026-10-12 while a Claude Code session was live and nothing was
    // committed yet: `entire checkpoint list --json` returned shadow snapshots with prompt text as the message.
    const shadow = JSON.stringify([
      { checkpoint_id: "38d05e3f063955a5e2bdc19a0cc1af54d6ceb7ac", session_id: "ff1243e8-a2bc-405f-820f-cf11571bb5d5", date: "2026-10-12T08:24:55+05:30", message: "<agent-message from=…> private prompt text" },
      ...JSON.parse(fixture("checkpoint-list.json")),
    ]);
    const file = collectEntireFile({ repoRoot: repoWith(enabled), entire: entireDouble({ "checkpoint list": shadow }), git: gitDouble, coverage: null });
    expect(file.checkpoints.map((c) => c.id)).toEqual([CP]);
    expect(JSON.stringify(file)).not.toContain("private prompt text");
    // Uncommitted only: nothing is published, and the note says why.
    const noCommits: Exec = (args) => (args[0] === "log" ? { status: 0, stdout: `${HEAD}\x1fK4\x1f\x1e\n`, stderr: "" } : gitDouble(args, "."));
    const none = collectEntireFile({ repoRoot: repoWith(enabled), entire: entireDouble({ "checkpoint list": shadow }), git: noCommits, coverage: null });
    expect(none.checkpoints).toEqual([]);
    expect(none.checkpointsNote).toMatch(/Entire-Checkpoint trailer/);
    expect(JSON.stringify(none)).not.toContain("private prompt text");
  });

  it("carries unguarded call sites through and rejects inconsistent files", () => {
    const cov = toEntireCoverage(coverageReport(1))!;
    expect(cov.unguardedCallSites).toBe(1);
    expect(cov.unguarded).toEqual([{ op: "dodo.createRefund", file: "packages/core/src/x.ts", line: 4, detail: "called from x (entire graph)" }]);
    expect(toEntireCoverage({ ...coverageReport(), backend: "tsc", entire: undefined })).toBeNull();
    const good = collectEntireFile({ repoRoot: repoWith(enabled), entire: entireDouble(), git: gitDouble, coverage: () => coverageReport() });
    expect(EntireFileSchema.safeParse({ ...good, checkpointsNote: "x" }).success).toBe(false);
    expect(EntireFileSchema.safeParse({ ...good, coverage: { ...good.coverage!, unguardedCallSites: 2 } }).success).toBe(false);
    expect(EntireFileSchema.safeParse({ ...good, cli: { installed: false, version: null, graphPlugin: null } }).success).toBe(false);
    expect(EntireFileSchema.safeParse({ ...good, checkpoints: [{ ...good.checkpoints[0]!, id: "not-an-id" }] }).success).toBe(false);
  });

  it("writes the validated file", () => {
    const dir = repoWith(enabled);
    const path = join(dir, "out", "entire.json");
    const { lines, file } = writeEntireFile({ path, repoRoot: dir, entire: entireDouble(), git: gitDouble, coverage: () => coverageReport() });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(file);
    expect(lines.join("\n")).toMatch(/checkpoints: 1 \(1 adversary reviews\)/);
    expect(lines.join("\n")).toMatch(/unguarded_call_sites = 0/);
  });
});

describe("the published packages/web/public/evidence/entire.json", () => {
  const path = fileURLToPath(new URL("../../web/public/evidence/entire.json", import.meta.url));
  it("validates against the schema when present (written by `notary export --entire`, never by hand)", () => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return; // not published yet
    }
    const file = EntireFileSchema.parse(JSON.parse(text));
    for (const c of file.checkpoints) expect(c.sessionIds.length).toBeGreaterThan(0);
  });
});
