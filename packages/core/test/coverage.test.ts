/**
 * `notary guards coverage` (FR-17). The tsc backend runs on the real repo (must be 0 unguarded) and on
 * a throwaway fixture project with deliberate raw calls. The entire backend is UNVERIFIED: its command
 * and parser are tested against samples built from docs.entire.io/cli-reference/graph (read
 * 2026-10-10) and entire-graph@f22e6c95 source, never against output from a real `entire` install.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENTIRE_STATUS,
  RAW_BY_DESIGN,
  coverageExitCode,
  entireNeighborsArgs,
  formatCoverage,
  parseEntireNeighbors,
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

describe("guards coverage on a fixture with deliberate raw calls", () => {
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

// Every sample below is BUILT FROM DOCS AND SOURCE, not captured from a real `entire` run (none is
// installed here; ENTIRE_STATUS). Text: first line per docs.entire.io/cli-reference/graph (read
// 2026-10-10), the rest per entire-graph@f22e6c95 writeAgentNeighborsFull. JSON: per that commit's
// neighborResponse / neighborEdge / callSite struct tags (the binary's default --format).
describe("entire backend (UNVERIFIED): documented command and output parsing", () => {
  it("builds the command from documented flags only (no --format/--file/--line/--exclude-tests)", () => {
    expect(entireNeighborsArgs("/repo", { className: "DodoClient", name: "createRefund" })).toEqual([
      "graph", "neighbors", "--repo", "/repo", "--symbol", "DodoClient.createRefund",
      "--relation", "CALLS", "--direction", "in", "--limit", "500", "--internal-only",
    ]);
  });

  it("marks the backend UNVERIFIED with the doc URL and read date", () => {
    expect(ENTIRE_STATUS).toMatch(/^UNVERIFIED: /);
    expect(ENTIRE_STATUS).toContain("docs.entire.io/cli-reference/graph (read 2026-10-10)");
  });

  it("a tsc report carries no unverified marker; an entire report would print it", () => {
    const base: CoverageReport = {
      backend: "tsc", backendNote: "x", ops: [], sites: [], createToolsCalls: [],
      totals: { ops: 0, sites: 0, guarded: 0, rawByDesign: 0, unguarded: 0 }, unguarded_call_sites: 0,
    };
    expect(formatCoverage(base)).not.toContain("UNVERIFIED");
    expect(formatCoverage({ ...base, backend: "entire", unverified: ENTIRE_STATUS })).toContain(`UNVERIFIED backend: ${ENTIRE_STATUS}`);
  });

  const text = [
    "Index: cache-miss (812ms) | Query: 4ms | Total: 820ms",
    "Focus: DodoClient.createRefund (packages/core/src/tools/dodo.ts:363) def=363 span=363-380",
    "Callers:",
    "- refundDirect (packages/core/src/bad.ts:7, def :3) [receiver_type]",
    "  packages/core/src/bad.ts:5-9",
    "    7 | return client.createRefund(\"pay_1\");",
    "- Mod.other (packages/core/src/other.ts:12) [+2 more call sites, name_only]",
    "- <module> (packages/core/scripts/x.ts) [file-level]",
    "Callees: not queried (--direction in); rerun with --direction both to include them",
    "",
  ].join("\n");

  it("parses the documented text output (Index: header, Callers section)", () => {
    const parsed = parseEntireNeighbors(text);
    expect(parsed).toMatchObject({ format: "text", exactMatch: true, disambiguationRequired: false, truncated: false });
    expect(parsed.callers).toEqual([
      { caller: "refundDirect", file: "packages/core/src/bad.ts", line: 7, resolution: "receiver_type" },
      { caller: "Mod.other", file: "packages/core/src/other.ts", line: 12, resolution: "name_only", additionalSites: 2 },
      { caller: "<module>", file: "packages/core/scripts/x.ts", line: 0 },
    ]);
  });

  it("text: no callers, truncation, ambiguity, fuzzy and no-match are distinguished", () => {
    const head = "Index: cache-hit (3ms) | Query: 1ms | Total: 4ms";
    const none = parseEntireNeighbors([head, "Focus: DodoClient.listRefunds (a.ts:9)", "Callers:", "- none", "Callees: not queried (--direction in); x"].join("\n"));
    expect(none).toMatchObject({ callers: [], exactMatch: true });
    expect(parseEntireNeighbors([head, "Focus: X.y (a.ts:1)", "Callers:", "- a (b.ts:2)", "Neighbor lists truncated; increase --limit for more callers or callees."].join("\n")).truncated).toBe(true);
    expect(parseEntireNeighbors([head, '"X.y" matches 2 definitions; all are listed, the first 2 with source.', "- X.y (a.ts:1) [method]  a.ts:1"].join("\n")).disambiguationRequired).toBe(true);
    expect(parseEntireNeighbors([head, 'No exact match for "X.y". Closest 1 by prefix match:', "- X.yy (a.ts:1)", "Focus: X.yy (a.ts:1)", "Callers:", "- none"].join("\n")).exactMatch).toBe(false);
    expect(parseEntireNeighbors([head, 'No symbols matched "X.y". Run `entire graph query --query "X.y"` to find the name.'].join("\n")).exactMatch).toBe(false);
  });

  it("rejects output it does not recognize instead of reporting zero callers", () => {
    expect(() => parseEntireNeighbors("!output-truncated\nF a.ts:1\n")).toThrow(/unrecognized/);
    expect(() => parseEntireNeighbors("Index: cache-hit (1ms) | Query: 1ms | Total: 2ms\nFocus: X.y (a.ts:1)\nCallers:\n- garbage line\n")).toThrow(/caller line/);
    expect(() => parseEntireNeighbors("Index: cache-hit (1ms) | Query: 1ms | Total: 2ms\nFocus: X.y (a.ts:1)\nCallers: not queried (--direction out); x\n")).toThrow(/did not query callers/);
  });

  it("also parses the binary's default JSON output (per source; the docs list no --format)", () => {
    const sample = JSON.stringify({
      format_version: 1, repo_root: "/repo", profile: "full", relation: "CALLS", direction: "in", query: "DodoClient.createRefund",
      index_cache_hit: false, truncated: false, focus_matches_total: 1, focus_matches_truncated: false, disambiguation_required: false,
      matches: [
        {
          symbol: { id: "s1", name: "createRefund", qualified_name: "DodoClient.createRefund", kind: "method", file_path: "packages/core/src/tools/dodo.ts", start_line: 363 },
          incoming: [
            {
              direction: "in", relation: "CALLS", confidence: 0.9, resolution: "receiver_type",
              endpoint: { id: "s2", name: "refundDirect", file_path: "packages/core/src/bad.ts", start_line: 3 },
              call_site: { file_path: "packages/core/src/bad.ts", line: 7, additional_sites: 1 },
            },
            { direction: "in", relation: "CALLS", confidence: 0.5, endpoint: { id: "s3", name: "other", qualified_name: "Mod.other", file_path: "packages/core/src/other.ts", start_line: 12 } },
          ],
          outgoing: [],
        },
      ],
      partial_failures: [],
    });
    const parsed = parseEntireNeighbors(sample);
    expect(parsed).toMatchObject({ format: "json", exactMatch: true, disambiguationRequired: false, truncated: false });
    expect(parsed.callers).toEqual([
      { caller: "refundDirect", file: "packages/core/src/bad.ts", line: 7, resolution: "receiver_type", confidence: 0.9, additionalSites: 1 },
      { caller: "Mod.other", file: "packages/core/src/other.ts", line: 12, confidence: 0.5 },
    ]);
    expect(parseEntireNeighbors(JSON.stringify({ disambiguation_required: true, matches: [] })).disambiguationRequired).toBe(true);
    expect(parseEntireNeighbors(JSON.stringify({ fuzzy_match: true, matches: [{ incoming: [] }] })).exactMatch).toBe(false);
  });
});
