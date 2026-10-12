/**
 * `notary guards coverage` (FR-17). The tsc backend runs on the real repo (must be 0 unguarded) and on
 * a throwaway fixture project with deliberate raw calls. The entire backend is tested against REAL
 * output captured from Entire CLI 0.11.4 + entire-graph v0.4.0 (test/fixtures/entire/); the live run on
 * this repo (`pnpm notary guards coverage --backend entire`, 1-5 min) is not part of the unit suite.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENTIRE_CHECKED_WITH,
  RAW_BY_DESIGN,
  coverageExitCode,
  entireEdgesArgs,
  entireNeighborsArgs,
  entireRawCallers,
  formatCoverage,
  parseEntireEdges,
  parseEntireNeighbors,
  parseEntireSymbolId,
  runCoverage,
} from "../src/guards/coverage.js";
import type { CoverageConfig, CoverageReport } from "../src/guards/coverage.js";

describe("guards coverage on the real repo (tsc backend)", () => {
  let report: CoverageReport;
  beforeAll(() => {
    report = runCoverage({ backend: "tsc" });
  }, 120_000);

  it("finds 0 unguarded call sites and exits 0", () => {
    const unguarded = [...report.sites, ...report.createToolsCalls].filter((s) => s.status === "UNGUARDED");
    expect(unguarded).toEqual([]);
    expect(report.unguarded_call_sites).toBe(0);
    expect(coverageExitCode(report)).toBe(0);
    expect(report.backend).toBe("tsc");
  });

  it("routes every public client method through wrap in src/tools/index.ts", () => {
    expect(report.ops.length).toBeGreaterThanOrEqual(18);
    for (const op of report.ops) {
      expect(op.exposed).toBe(true);
      const sites = report.sites.filter((s) => s.op === op.op);
      expect(sites).toHaveLength(1);
      expect(sites[0]!.status).toBe("guarded");
      expect(sites[0]!.file).toBe("packages/core/src/tools/index.ts");
    }
  });

  it("the guarded queue path passes a real wrap; raw-by-design is only the allow-list", () => {
    const guardedQueue = report.createToolsCalls.filter((c) => c.file === "packages/core/src/queue/run.ts" && c.status === "guarded");
    expect(guardedQueue.length).toBeGreaterThanOrEqual(1);
    const allowed = new Set(RAW_BY_DESIGN.map((a) => `packages/core/${a.file}`));
    for (const c of report.createToolsCalls.filter((x) => x.status === "raw-by-design")) expect(allowed.has(c.file)).toBe(true);
  });
});

// Each case runs the TypeScript compiler over a fixture project: seconds under full-suite load.
describe("guards coverage on a fixture with deliberate raw calls", { timeout: 60_000 }, () => {
  let dir: string;
  const write = (rel: string, text: string) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const config = (): CoverageConfig => ({
    projectDir: dir,
    displayRoot: dir,
    scanDirs: ["src"],
    toolsIndex: "src/tools/index.ts",
    clients: [{ className: "DodoClient", file: "src/tools/dodo.ts", opPrefix: "dodo" }],
    allowList: [{ file: "src/probe.ts", kind: "no-wrap", fn: "probeTools", sites: 1, reason: "probing (fixture)" }],
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "notary-coverage-"));
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: [], noEmit: true },
        include: ["src"],
      }),
    );
    write(
      "src/tools/dodo.ts",
      `export class DodoClient {
  createRefund(paymentId: string): Promise<string> {
    return this.call(paymentId);
  }
  listRefunds(): Promise<string[]> {
    return Promise.resolve([]);
  }
  private call(x: string): Promise<string> {
    return Promise.resolve(x);
  }
}
`,
    );
    write(
      "src/tools/index.ts",
      `import { DodoClient } from "./dodo.js";
type AnyAsyncFn = (...args: any[]) => Promise<unknown>;
export type Wrap = <F extends AnyAsyncFn>(op: string, fn: F) => F;
export const identityWrap: Wrap = (_op, fn) => fn;
export const DODO_OPS = {
  createRefund: "dodo.createRefund",
  listRefunds: "dodo.listRefunds",
} as const;
function exposed<C extends object>(client: C, ops: Record<string, string>, wrap: Wrap): Pick<DodoClient, "createRefund" | "listRefunds"> {
  const out: Record<string, AnyAsyncFn> = {};
  for (const [method, op] of Object.entries(ops)) {
    out[method] = wrap(op, ((client as Record<string, unknown>)[method] as AnyAsyncFn).bind(client));
  }
  return out as unknown as Pick<DodoClient, "createRefund" | "listRefunds">;
}
export function createTools(opts: { wrap?: Wrap } = {}) {
  const wrap = opts.wrap ?? identityWrap;
  const dodo = new DodoClient();
  return { dodo: exposed(dodo, DODO_OPS, wrap) };
}
`,
    );
    write(
      "src/ok.ts",
      `import { createTools } from "./tools/index.js";
import type { Wrap } from "./tools/index.js";
const guard: Wrap = (_op, fn) => fn;
export async function ok(): Promise<string> {
  const tools = createTools({ wrap: guard });
  return tools.dodo.createRefund("pay_ok");
}
`,
    );
    write(
      "src/probe.ts",
      `import { createTools } from "./tools/index.js";
export const probeTools = () => createTools();
`,
    );
    write(
      "src/bad.ts",
      `import { DodoClient } from "./tools/dodo.js";
import { createTools as make, identityWrap } from "./tools/index.js";
export async function refundDirect(): Promise<string> {
  const client = new DodoClient();
  const { listRefunds } = client;
  void listRefunds;
  return client.createRefund("pay_1");
}
export const naked = () => make({});
export const fake = () => make({ wrap: identityWrap });
`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports each raw call with file:line and exits 1", () => {
    const report = runCoverage({ backend: "tsc", config: config() });
    const unguarded = [...report.sites, ...report.createToolsCalls]
      .filter((s) => s.status === "UNGUARDED")
      .map((s) => `${s.op} ${s.file}:${s.line}`)
      .sort();
    expect(unguarded).toEqual(
      [
        "dodo.createRefund src/bad.ts:7", // client.createRefund(...)
        "dodo.listRefunds src/bad.ts:5", // destructured from a raw client
        "new DodoClient src/bad.ts:4",
        "createTools() src/bad.ts:9", // aliased createTools without wrap
        "createTools() src/bad.ts:10", // wrap: identityWrap
      ].sort(),
    );
    expect(report.unguarded_call_sites).toBe(5);
    expect(coverageExitCode(report)).toBe(1);

    // The routed path is guarded; the createTools() surface call in ok.ts is not a raw reference.
    expect(report.sites.filter((s) => s.status === "guarded").map((s) => `${s.op} ${s.file}:${s.line}`).sort()).toEqual(
      ["dodo.createRefund src/tools/index.ts:6", "dodo.listRefunds src/tools/index.ts:7", "new DodoClient src/tools/index.ts:18"].sort(),
    );
    const byFile = Object.fromEntries(report.createToolsCalls.map((c) => [`${c.file}:${c.line}`, c.status]));
    expect(byFile["src/ok.ts:5"]).toBe("guarded");
    expect(byFile["src/probe.ts:2"]).toBe("raw-by-design");
    expect(report.sites.some((s) => s.file === "src/ok.ts")).toBe(false);
    expect(formatCoverage(report)).toContain("src/bad.ts:7");
  });

  it("P9 AUDIT-10: the allow-list covers named call sites, not a whole file", () => {
    // A second no-wrap createTools() in the allow-listed file, in another function and beyond the
    // entry's site count, is UNGUARDED; the original site stays raw-by-design.
    const original = `import { createTools } from "./tools/index.js";
export const probeTools = () => createTools();
`;
    write(
      "src/probe.ts",
      `import { createTools } from "./tools/index.js";
export const probeTools = () => createTools();
export const sneaky = () => createTools();
export function probeToolsAgain() {
  return createTools();
}
`,
    );
    try {
      const report = runCoverage({ backend: "tsc", config: config() });
      const probe = Object.fromEntries(report.createToolsCalls.filter((c) => c.file === "src/probe.ts").map((c) => [c.line, c.status]));
      expect(probe).toEqual({ 2: "raw-by-design", 3: "UNGUARDED", 5: "UNGUARDED" });
      // Same function, more sites than the entry allows: the extra one is UNGUARDED too.
      write(
        "src/probe.ts",
        `import { createTools } from "./tools/index.js";
export const probeTools = () => [createTools(), createTools()];
`,
      );
      const again = runCoverage({ backend: "tsc", config: config() });
      expect(again.createToolsCalls.filter((c) => c.file === "src/probe.ts").map((c) => c.status).sort()).toEqual(["UNGUARDED", "raw-by-design"]);
    } finally {
      write("src/probe.ts", original);
    }
  });

  it("P9 AUDIT-10: every real allow-list entry names its function and exact site count", () => {
    for (const a of RAW_BY_DESIGN) {
      expect(a.fn.length).toBeGreaterThan(0);
      expect(Number.isInteger(a.sites) && a.sites >= 1).toBe(true);
    }
  });

  it("exits 0 once the raw calls are gone", () => {
    write("src/bad.ts", "export const nothing = 1;\n");
    const report = runCoverage({ backend: "tsc", config: config() });
    expect(report.unguarded_call_sites).toBe(0);
    expect(coverageExitCode(report)).toBe(0);
  });
});

// Every sample below is REAL output captured on 2026-10-12 from Entire CLI 0.11.4 + entire-graph v0.4.0
// (test/fixtures/entire/; repo_root redacted). edges-with-raw-call.ndjson is a trimmed
// `entire graph edges --worktree --relation CALLS,ASYNC_CALLS,CONSTRUCTS --format ndjson` run on a
// scratch clone of this repo with a deliberate raw call added (packages/core/src/entire-probe-raw.ts:
// `client.createRefund(…)` on line 4 and `new DodoClient(…)` on line 7); the header, the summary and a
// few unrelated relations are kept as Entire printed them. neighbors-createRefund.json is the
// follow-up `entire graph neighbors --symbol DodoClient.createRefund --direction in --format json`.
describe("entire backend: real command and output (Entire CLI 0.11.4, entire-graph v0.4.0)", () => {
  const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "entire", name), "utf8");
  const edges = fixture("edges-with-raw-call.ndjson");
  const neighbors = fixture("neighbors-createRefund.json");

  it("builds the verified commands", () => {
    expect(entireEdgesArgs("/repo")).toEqual([
      "graph", "edges", "--repo", "/repo", "--format", "ndjson", "--worktree", "--relation", "CALLS,ASYNC_CALLS,CONSTRUCTS",
    ]);
    expect(entireNeighborsArgs("/repo", { className: "DodoClient", name: "createRefund" })).toEqual([
      "graph", "neighbors", "--repo", "/repo", "--symbol", "DodoClient.createRefund",
      "--relation", "CALLS", "--direction", "in", "--limit", "500", "--internal-only", "--format", "json",
    ]);
    expect(ENTIRE_CHECKED_WITH).toContain("Entire CLI 0.11.4");
  });

  it("parses the real edges stream: header, relations, summary, skipped files", () => {
    const parsed = parseEntireEdges(edges);
    expect(parsed).toMatchObject({ provider: "entire-graph", providerVersion: "v0.4.0", repoKey: "local/eclone", worktree: true, completeness: "ok", partialFailures: 1 });
    expect(parsed.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.failedFiles).toEqual([{ code: "E_MINIFIED", file: "adversary/inbox/belief-crustdata.enrich.headcount-total-integer.json" }]);
    expect(parsed.edges).toHaveLength(9);
    const raw = parsed.edges.find((e) => e.toId.endsWith(":method:DodoClient.createRefund"))!;
    expect(raw).toMatchObject({ type: "CALLS", resolution: "type_inferred", confidence: 0.83 });
    expect(raw.evidence).toMatchObject({ file: "packages/core/src/entire-probe-raw.ts", detail: "client.createRefund" });
    expect(parseEntireSymbolId(raw.toId)).toEqual({ language: "TypeScript", path: "packages/core/src/tools/dodo.ts", kind: "method", name: "DodoClient.createRefund" });
    expect(parseEntireSymbolId("local/eclone:file:packages/core/src/tools/dodo.ts")).toBeNull();
  });

  it("parses the real neighbors JSON with the exact call line", () => {
    const parsed = parseEntireNeighbors(neighbors);
    expect(parsed).toMatchObject({ exactMatch: true, disambiguationRequired: false, truncated: false });
    expect(parsed.callers).toEqual([
      { caller: "sneakyRefund", file: "packages/core/src/entire-probe-raw.ts", line: 4, resolution: "type_inferred", confidence: 0.83 },
    ]);
  });

  it("rejects output it does not recognize instead of reporting zero callers", () => {
    expect(() => parseEntireEdges("")).toThrow(/printed nothing/);
    expect(() => parseEntireEdges('{"provider":"other"}\n')).toThrow(/unrecognized header/);
    const cut = edges.trim().split("\n").slice(0, -1).join("\n");
    expect(() => parseEntireEdges(cut)).toThrow(/no summary record/);
    expect(() => parseEntireNeighbors("Index: cache-hit (3ms)\nFocus: X.y (a.ts:1)\n")).toThrow(/expected JSON/);
    expect(parseEntireNeighbors(JSON.stringify({ disambiguation_required: true, matches: [] })).disambiguationRequired).toBe(true);
    expect(parseEntireNeighbors(JSON.stringify({ fuzzy_match: true, matches: [{ incoming: [] }] })).exactMatch).toBe(false);
  });

  const repo = join(tmpdir(), "entire-fixture-repo");
  const cfg: CoverageConfig = {
    projectDir: join(repo, "packages", "core"),
    displayRoot: repo,
    scanDirs: ["src", "scripts"],
    toolsIndex: "src/tools/index.ts",
    clients: [{ className: "DodoClient", file: "src/tools/dodo.ts", opPrefix: "dodo" }],
    allowList: [],
  };
  const client = cfg.clients[0]!;
  const methods = ["createRefund", "createCustomer", "listCustomers"].map((name) => ({ key: `DodoClient.${name}`, name, file: "packages/core/src/tools/dodo.ts", client }));
  const ops = new Map(methods.map((m) => [m.key, `dodo.${m.name}`]));
  const real = (args: string[]) => ({ status: 0, stdout: args[1] === "edges" ? edges : neighbors, stderr: "" });

  it("finds the raw call (exact line via neighbors) and the raw construction; internal this.call edges are not callers", () => {
    const calls: string[][] = [];
    const { sites, graph } = entireRawCallers(cfg, methods, ops, (args) => {
      calls.push(args);
      return real(args);
    });
    expect(calls.map((a) => a[1])).toEqual(["edges", "neighbors"]); // one bulk pass, one line lookup
    expect(sites).toEqual([
      expect.objectContaining({ op: "new DodoClient", file: "packages/core/src/entire-probe-raw.ts", line: 6, status: "UNGUARDED" }),
      expect.objectContaining({ op: "dodo.createRefund", file: "packages/core/src/entire-probe-raw.ts", line: 4, status: "UNGUARDED" }),
    ]);
    expect(graph).toMatchObject({ providerVersion: "v0.4.0", worktree: true, callEdges: 4, constructEdges: 5, clientEdges: 3, partialFailures: 1 });
    expect(graph.skippedFiles).toEqual(["adversary/inbox/belief-crustdata.enrich.headcount-total-integer.json (E_MINIFIED)"]);
  });

  it("does not repeat a construction the TypeScript wiring check already reported", () => {
    const wiring = [{ op: "new DodoClient", file: "packages/core/src/entire-probe-raw.ts", line: 7, status: "UNGUARDED" as const, detail: "tsc" }];
    expect(entireRawCallers(cfg, methods, ops, real, wiring).sites.map((s) => s.op)).toEqual(["dodo.createRefund"]);
  });

  it("fails loudly when Entire could not parse scanned source or the command fails", () => {
    const blind = edges.replace("adversary/inbox/belief-crustdata.enrich.headcount-total-integer.json", "packages/core/src/tools/dodo.ts");
    expect(() => entireRawCallers(cfg, methods, ops, () => ({ status: 0, stdout: blind, stderr: "" }))).toThrow(/could not parse scanned source/);
    expect(() => entireRawCallers(cfg, methods, ops, () => ({ status: 1, stdout: "", stderr: "boom" }))).toThrow(/failed: boom/);
  });

  it("formats an entire report with the graph facts", () => {
    const { graph } = entireRawCallers(cfg, methods, ops, real);
    const base: CoverageReport = {
      backend: "entire", backendNote: "x", ops: [], sites: [], createToolsCalls: [], entire: graph,
      totals: { ops: 0, sites: 0, guarded: 0, rawByDesign: 0, unguarded: 0 }, unguarded_call_sites: 0,
    };
    const text = formatCoverage(base);
    expect(text).toContain("entire graph edges --repo . --format ndjson --worktree --relation CALLS,ASYNC_CALLS,CONSTRUCTS");
    expect(text).toMatch(/graph: entire-graph v0\.4\.0, commit [0-9a-f]{12} \+ working tree, completeness ok/);
    expect(text).not.toContain("UNVERIFIED");
  });
});
