/**
 * `notary export` (P8; TDD CLI table, PRD FR-19): from REAL bundles only, write
 *   export/TOOLS.md        corrected tool spec
 *   export/guards.json     active + retired guards from the newest notarize bundles
 *   docs/EVALUATION.md     every metric with the command that produced it
 * and copy the newest real bundle per category into packages/web/public/bundles/ (writeBundle
 * upserts index.json; nothing is ever removed, so the SAMPLE bundle stays).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_BUNDLES_SUBDIR, writeBundle } from "../bundle/index.js";
import { BundleIndexSchema } from "../schema/bundle.js";
import type { RunBundle } from "../schema/index.js";
import type { ChecksRunner, CheckResult } from "./checks.js";
import { collectBundles, latestPerCategory, type SkippedBundle } from "./collect.js";
import { renderEvaluationMd } from "./evaluation.js";
import { buildGuardsJson } from "./guards-json.js";
import { renderToolsMd } from "./tools-md.js";

export { collectBundles, classify, latestPerCategory } from "./collect.js";
export { commandFor } from "./commands.js";
export { compareValues } from "./compare.js";
export { renderEvaluationMd } from "./evaluation.js";
export { buildGuardsJson } from "./guards-json.js";
export { renderToolsMd, UNVERIFIED } from "./tools-md.js";
export type { CheckResult, ChecksRunner } from "./checks.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export const DEFAULT_PATHS = {
  runsDir: fileURLToPath(new URL("../../runs/", import.meta.url)),
  exportDir: join(REPO_ROOT, "export"),
  docsDir: join(REPO_ROOT, "docs"),
  webBundlesDir: fileURLToPath(new URL("../../../web/public/bundles/", import.meta.url)),
  driftDir: fileURLToPath(new URL("../../fixtures/drift/", import.meta.url)),
};

export interface ExportOptions {
  runsDir?: string;
  exportDir?: string;
  docsDir?: string;
  /** null = do not copy bundles to the dashboard. */
  webBundlesDir?: string | null;
  driftDir?: string;
  /** null = skip the no-key checks (EVALUATION.md says so). */
  checks?: ChecksRunner | null;
  now?: () => Date;
}

export interface ExportResult {
  bundles: RunBundle[];
  skipped: SkippedBundle[];
  excluded: SkippedBundle[];
  copied: string[];
  notCopied: { runId: string; reason: string }[];
  checks: CheckResult[] | null;
  files: { toolsMd: string; guardsJson: string; evaluationMd: string };
  lines: string[];
}

function driftFixtures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

/** runIds already in the dashboard index as SAMPLE entries; a real bundle never overwrites one. */
function sampleIds(webDir: string): Set<string> {
  const p = join(webDir, "index.json");
  if (!existsSync(p)) return new Set();
  const parsed = BundleIndexSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
  return new Set(parsed.success ? parsed.data.filter((e) => e.sample).map((e) => e.runId) : []);
}

export async function runExport(opts: ExportOptions = {}): Promise<ExportResult> {
  const runsDir = opts.runsDir ?? DEFAULT_PATHS.runsDir;
  const exportDir = opts.exportDir ?? DEFAULT_PATHS.exportDir;
  const docsDir = opts.docsDir ?? DEFAULT_PATHS.docsDir;
  const webDir = opts.webBundlesDir === undefined ? DEFAULT_PATHS.webBundlesDir : opts.webBundlesDir;
  // Real bundles never go into the fixture-demo directory (bundles/fixture/, its own index.json).
  if (webDir !== null && basename(resolve(webDir)) === FIXTURE_BUNDLES_SUBDIR) {
    throw new Error(`notary export: refusing to write real bundles into the fixture-demo directory ${webDir}`);
  }
  const generatedAt = (opts.now ?? (() => new Date()))().toISOString();

  const { bundles: collected, skipped, excluded } = collectBundles(runsDir);
  const bundles = collected.map((c) => c.bundle);

  const checksRunner = opts.checks === undefined ? (await import("./checks.js")).runDefaultChecks : opts.checks;
  const checks = checksRunner ? await checksRunner() : null;

  await mkdir(exportDir, { recursive: true });
  await mkdir(docsDir, { recursive: true });
  const files = {
    toolsMd: join(exportDir, "TOOLS.md"),
    guardsJson: join(exportDir, "guards.json"),
    evaluationMd: join(docsDir, "EVALUATION.md"),
  };
  await writeFile(files.toolsMd, renderToolsMd({ bundles, generatedAt }), "utf8");
  const guards = buildGuardsJson(bundles);
  await writeFile(files.guardsJson, `${JSON.stringify(guards, null, 2)}\n`, "utf8");
  await writeFile(
    files.evaluationMd,
    renderEvaluationMd({ bundles, skipped, excluded, checks, driftFixtures: driftFixtures(opts.driftDir ?? DEFAULT_PATHS.driftDir), generatedAt }),
    "utf8",
  );

  const copied: string[] = [];
  const notCopied: ExportResult["notCopied"] = [];
  if (webDir !== null) {
    const samples = sampleIds(webDir);
    for (const b of latestPerCategory(bundles)) {
      if (samples.has(b.runId)) {
        notCopied.push({ runId: b.runId, reason: "runId collides with a SAMPLE bundle in the dashboard index" });
        continue;
      }
      await writeBundle(b, webDir); // re-verifies schema + hash before writing
      copied.push(b.runId);
    }
  }

  const lines = [
    `notary export: ${bundles.length} real bundle(s) from ${runsDir}`,
    ...skipped.map((s) => `  SKIPPED ${s.file}: ${s.reason}`),
    ...excluded.map((s) => `  excluded ${s.file}: ${s.reason}`),
    `  ${files.toolsMd}`,
    `  ${files.guardsJson} (${guards.guards.length} guard(s) from ${guards.generatedFrom.length} notarize bundle(s))`,
    `  ${files.evaluationMd}`,
    webDir === null ? "  dashboard copy: disabled" : `  dashboard: ${copied.length} bundle(s) copied to ${webDir}${copied.length ? ` (${copied.join(", ")})` : ""}`,
    ...notCopied.map((n) => `  NOT copied ${n.runId}: ${n.reason}`),
    ...(checks === null ? ["  checks: skipped (--no-checks)"] : checks.map((c) => `  check ${c.command}: ${c.ok ? "PASS" : "FAIL"} — ${c.summary}`)),
  ];
  if (bundles.length === 0) lines.push("  no real runs yet: TOOLS.md lists every claim as unverified; EVALUATION.md lists what is blocked");
  return { bundles, skipped, excluded, copied, notCopied, checks, files, lines };
}
