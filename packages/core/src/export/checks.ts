/**
 * "Checks that don't need API keys" for EVALUATION.md: results that exist today, produced by
 * actually running each command at export time (never copied from an earlier run or typed in).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CheckResult {
  /** The command a reader runs to reproduce it. */
  command: string;
  /** How export actually ran it, when that differs. */
  ranAs: string;
  ok: boolean;
  exitCode: number | null;
  /** One-line result, e.g. "512 passed, 0 failed (512 tests in 30 files)". */
  summary: string;
}

export type ChecksRunner = () => Promise<CheckResult[]>;

const CORE_DIR = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const TEN_MIN = 10 * 60 * 1000;

interface VitestJson {
  success?: boolean;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  numTotalTestSuites?: number;
  testResults?: unknown[];
}

/** The core vitest suite, run with the JSON reporter (@notary/web runs its own suite via `pnpm test`). */
export function runTestsCheck(): CheckResult {
  const command = "pnpm test";
  const ranAs = "vitest run --reporter=json in packages/core (the @notary/web suite runs separately in `pnpm test`)";
  const dir = mkdtempSync(join(tmpdir(), "notary-export-vitest-"));
  const out = join(dir, "vitest.json");
  try {
    const vitestPkg = createRequire(join(CORE_DIR, "package.json")).resolve("vitest/package.json");
    const bin = join(dirname(vitestPkg), "vitest.mjs");
    const res = spawnSync(process.execPath, [bin, "run", "--reporter=json", `--outputFile=${out}`], {
      cwd: CORE_DIR,
      encoding: "utf8",
      timeout: TEN_MIN,
      env: { ...process.env, CI: "1" },
    });
    let report: VitestJson;
    try {
      report = JSON.parse(readFileSync(out, "utf8")) as VitestJson;
    } catch {
      return { command, ranAs, ok: false, exitCode: res.status, summary: `could not run (no JSON report; exit ${res.status ?? "signal"})` };
    }
    const passed = report.numPassedTests ?? 0;
    const failed = report.numFailedTests ?? 0;
    const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
    const files = report.testResults?.length ?? 0;
    const summary = `${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""} (${report.numTotalTests ?? 0} tests in ${files} files)`;
    return { command, ranAs, ok: res.status === 0 && failed === 0, exitCode: res.status, summary };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface CoverageJson {
  backend?: string;
  unguarded_call_sites?: number;
  totals?: { sites?: number; guarded?: number; rawByDesign?: number; unguarded?: number };
}

export function runCoverageCheck(): CheckResult {
  const command = "pnpm notary guards coverage --json";
  // Arguments contain no spaces, so the shell (needed for pnpm on Windows) sees them verbatim.
  const res = spawnSync("pnpm notary guards coverage --json", { cwd: REPO_ROOT, encoding: "utf8", shell: true, timeout: TEN_MIN });
  const stdout = res.stdout ?? "";
  const start = stdout.indexOf("\n{") >= 0 ? stdout.indexOf("\n{") + 1 : stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  let report: CoverageJson;
  try {
    report = JSON.parse(stdout.slice(start, end + 1)) as CoverageJson;
  } catch {
    return { command, ranAs: command, ok: false, exitCode: res.status, summary: `could not run (no JSON on stdout; exit ${res.status ?? "signal"})` };
  }
  const t = report.totals ?? {};
  const summary = `unguarded_call_sites = ${report.unguarded_call_sites ?? "?"} (${t.sites ?? "?"} sites: ${t.guarded ?? "?"} guarded, ${t.rawByDesign ?? "?"} raw-by-design; backend ${report.backend ?? "?"})`;
  return { command, ranAs: command, ok: res.status === 0 && report.unguarded_call_sites === 0, exitCode: res.status, summary };
}

export const runDefaultChecks: ChecksRunner = async () => [runTestsCheck(), runCoverageCheck()];
