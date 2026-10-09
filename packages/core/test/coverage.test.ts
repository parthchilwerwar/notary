/**
 * `notary guards coverage` (FR-17). The tsc backend runs on the real repo (must be 0 unguarded) and on
 * a throwaway fixture project with deliberate raw calls. The entire backend's parser is exercised on
 * JSON shaped by entire-graph's own struct tags (internal/cli/neighbors.go @ f22e6c95); no captured
 * output from an installed `entire` exists here, so that test checks the parser, not live behavior.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
    allowList: [{ file: "src/probe.ts", kind: "no-wrap", reason: "probing (fixture)" }],
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

  it("exits 0 once the raw calls are gone", () => {
    write("src/bad.ts", "export const nothing = 1;\n");
    const report = runCoverage({ backend: "tsc", config: config() });
    expect(report.unguarded_call_sites).toBe(0);
    expect(coverageExitCode(report)).toBe(0);
  });
});

describe("entire backend: neighbors JSON parser", () => {
  // Shape per entire-graph neighborResponse / neighborFocus / neighborEdge / callSite JSON tags.
  const sample = JSON.stringify({
    format_version: 1,
    repo_root: "/repo",
    profile: "full",
    relation: "CALLS",
    direction: "in",
    query: "DodoClient.createRefund",
    index_cache_hit: false,
    truncated: false,
    focus_matches_total: 1,
    focus_matches_truncated: false,
    disambiguation_required: false,
    matches: [
      {
        symbol: { id: "s1", name: "createRefund", qualified_name: "DodoClient.createRefund", kind: "method", file_path: "packages/core/src/tools/dodo.ts", start_line: 363 },
        incoming: [
          {
            direction: "in",
            relation: "CALLS",
            endpoint: { id: "s2", name: "refundDirect", file_path: "packages/core/src/bad.ts", start_line: 3 },
            confidence: 0.9,
            resolution: "receiver_type",
            call_site: { file_path: "packages/core/src/bad.ts", line: 7 },
          },
          {
            direction: "in",
            relation: "CALLS",
            endpoint: { id: "s3", name: "other", qualified_name: "Mod.other", file_path: "packages/core/src/other.ts", start_line: 12 },
            confidence: 0.5,
          },
        ],
        outgoing: [],
      },
    ],
    partial_failures: [],
  });

  it("extracts caller call sites (call_site when resolved, else the caller's definition line)", () => {
    const parsed = parseEntireNeighbors(sample);
    expect(parsed.disambiguationRequired).toBe(false);
    expect(parsed.callers).toEqual([
      { caller: "refundDirect", file: "packages/core/src/bad.ts", line: 7, resolution: "receiver_type", confidence: 0.9 },
      { caller: "Mod.other", file: "packages/core/src/other.ts", line: 12, confidence: 0.5 },
    ]);
  });

  it("flags an ambiguous symbol", () => {
    expect(parseEntireNeighbors(JSON.stringify({ disambiguation_required: true, matches: [] })).disambiguationRequired).toBe(true);
  });

  it("builds the documented neighbors command", () => {
    expect(entireNeighborsArgs("/repo", { className: "DodoClient", name: "createRefund", file: "packages/core/src/tools/dodo.ts", line: 363 })).toEqual([
      "graph", "neighbors", "--repo", "/repo", "--symbol", "DodoClient.createRefund", "--file", "packages/core/src/tools/dodo.ts",
      "--line", "363", "--relation", "CALLS", "--direction", "in", "--format", "json", "--limit", "500", "--internal-only", "--exclude-tests",
    ]);
  });
});
