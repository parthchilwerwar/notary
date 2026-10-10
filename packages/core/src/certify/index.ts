/**
 * `notary export --certificates [--fixture]`: write certificates derived from verified bundles.
 *
 *   real (default)  sources: REAL bundles only — packages/core/runs/<dir>/<runId>.json, sample:false,
 *                   hash-verified (export/collect.ts collectBundles): full notarize bundles, plus queue
 *                   runs and drift replays that carry belief events (a guarded run's sentinel can
 *                   un-learn a belief mid-run). Writes
 *                     packages/web/public/certificates/<tool>.json   (one per tool)
 *                     packages/web/public/certificates/report.json
 *                     export/REPORT.md
 *                   With 0 real bundles it still writes honest files: every claim "not tested", all
 *                   counts zero, header "no real runs yet".
 *   --fixture       sources: the FIXTURE demo bundles under packages/core/runs/demo/ and
 *                   runs/demo-change-api/ (sample:true, FIXTURE disclosure, demo-* runIds;
 *                   demo/publish.ts fixturePublishRefusal), GROUPED BY SCENARIO (demo/index.ts
 *                   demoScenarioOf: runId prefix). Scenarios are separate simulated worlds and are never
 *                   merged. Writes
 *                     packages/web/public/certificates/fixture/<scenario>/<tool>.json + <scenario>/report.json
 *                     packages/web/public/certificates/fixture/index.json   (the scenarios)
 *                     export/REPORT.fixture.md                              (one section per scenario)
 *                   and removes the old merged fixture/<tool>.json and fixture/report.json. Every record
 *                   carries sample: true and the FIXTURE disclosure. Fixture data never reaches the real
 *                   files, and export/REPORT.md is never written from it.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex, verifyBundle } from "../bundle/hash.js";
import { CHANGE_API_RUNS_DIR, DEMO_RUNS_DIR, DEMO_SCENARIOS, demoScenarioOf } from "../demo/index.js";
import { fixturePublishRefusal } from "../demo/publish.js";
import { classify, collectBundles, isDriftReplay } from "../export/collect.js";
import type { SkippedBundle } from "../export/collect.js";
import type { RunBundle } from "../schema/index.js";
import { CERTIFICATES_FIXTURE_GENERATED_BY, FIXTURE_CERT_DISCLOSURE, TOOLS, buildCertificates } from "./certificates.js";
import type { CertificateSet } from "./certificates.js";
import { bundleOrder } from "./ledger.js";
import { FixtureIndexSchema, buildReport, renderReportMd } from "./report.js";
import type { CertificateReport, FixtureIndex } from "./report.js";

export * from "./certificates.js";
export * from "./report.js";
export { RevocationSchema, verifyRevocation, verifySeal, sealOf } from "./revocations.js";
export type { Revocation, RetiredGuard } from "./revocations.js";

export const CERTIFICATES_FIXTURE_SUBDIR = "fixture";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export const CERTIFICATE_PATHS = {
  runsDir: fileURLToPath(new URL("../../runs/", import.meta.url)),
  /** Where the fixture demo writes its bundles, one dir per scenario run (read-only use of demo/index.ts). */
  fixtureRunsDirs: [DEMO_RUNS_DIR, CHANGE_API_RUNS_DIR],
  webCertificatesDir: fileURLToPath(new URL("../../../web/public/certificates/", import.meta.url)),
  exportDir: join(REPO_ROOT, "export"),
};

export interface CertificateExportOptions {
  fixture?: boolean;
  /** Real: runs dir (default packages/core/runs). */
  runsDir?: string;
  /** Fixture: demo run dirs to scan (default runs/demo and runs/demo-change-api). */
  fixtureDirs?: readonly string[];
  /** packages/web/public/certificates (fixture output goes to its fixture/ subdirectory). */
  webDir?: string;
  exportDir?: string;
}

export interface ScenarioOutput {
  scenario: string;
  set: CertificateSet;
  report: CertificateReport;
  bundles: RunBundle[];
}

export interface CertificateExportResult {
  /** Real export: the one set. Fixture export: one entry per scenario. */
  outputs: ScenarioOutput[];
  skipped: SkippedBundle[];
  files: string[];
  lines: string[];
}

/** Real sources: full notarize bundles, and queue runs / drift replays that carry belief events (never sample, never compare-priors arms). */
export function realCertificateSources(bundles: readonly RunBundle[]): RunBundle[] {
  return bundles.filter(
    (b) => !b.sample && (classify(b) === "notarize-full" || (b.beliefEvents.length > 0 && (b.kind === "run" || isDriftReplay(b)))),
  );
}

/** Fixture bundles under the demo run dirs (<dir>/<sub>/<file>.json), with the files skipped and why. */
export function collectFixtureBundles(dirs: readonly string[]): { bundles: RunBundle[]; skipped: SkippedBundle[] } {
  const bundles: RunBundle[] = [];
  const skipped: SkippedBundle[] = [];
  const seen = new Set<string>();
  for (const demoDir of dirs) {
    if (!existsSync(demoDir)) continue;
    const files: string[] = [];
    for (const d of readdirSync(demoDir).sort()) {
      const full = join(demoDir, d);
      if (!statSync(full).isDirectory() || d === "cassettes" || d === "export-check") continue;
      for (const f of readdirSync(full).sort()) if (f.endsWith(".json") && f !== "index.json") files.push(join(full, f));
    }
    for (const path of files) {
      const file = `${basename(resolve(demoDir))}/${path.slice(demoDir.length).replace(/\\/g, "/").replace(/^\//, "")}`;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        skipped.push({ file, reason: "unreadable JSON" });
        continue;
      }
      const v = verifyBundle(raw);
      if (!v.ok) {
        // Non-bundle JSON (seed manifests, drift fixtures) lands here too; only a hash mismatch is suspicious.
        skipped.push({ file, reason: v.reason === "hash" ? "content hash mismatch (tampered or edited after writing)" : "not a run bundle" });
        continue;
      }
      const refusal = fixturePublishRefusal(v.bundle);
      if (refusal) {
        skipped.push({ file, reason: `not a fixture bundle: ${refusal}` });
        continue;
      }
      if (seen.has(v.bundle.runId)) {
        skipped.push({ file, reason: `duplicate runId ${v.bundle.runId}` });
        continue;
      }
      seen.add(v.bundle.runId);
      if (v.bundle.kind === "notarize" || v.bundle.beliefEvents.length > 0) bundles.push(v.bundle);
    }
  }
  return { bundles, skipped };
}

/** Group fixture bundles by demo scenario; every known scenario is present (possibly empty). */
export function groupByScenario(bundles: readonly RunBundle[]): Map<string, RunBundle[]> {
  const out = new Map<string, RunBundle[]>(DEMO_SCENARIOS.map((s) => [s, [] as RunBundle[]]));
  for (const b of bundles) {
    const s = demoScenarioOf(b.runId);
    out.set(s, [...(out.get(s) ?? []), b]);
  }
  for (const [s, group] of out) out.set(s, [...group].sort(bundleOrder));
  return out;
}

function pretty(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

async function writeSet(set: CertificateSet, dir: string, files: string[]): Promise<CertificateReport> {
  await mkdir(dir, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const t of set.tools) {
    const p = join(dir, `${t.tool}.json`);
    await writeFile(p, pretty(t), "utf8");
    hashes[`${t.tool}.json`] = sha256Hex(canonicalJson(t));
    files.push(p);
  }
  const report = buildReport(set, hashes, (tool) => `${tool}.json`);
  const reportPath = join(dir, "report.json");
  await writeFile(reportPath, pretty(report), "utf8");
  files.push(reportPath);
  return report;
}

function countLines(report: CertificateReport, indent: string): string[] {
  const line = (name: string, c: CertificateReport["overall"]) =>
    `${indent}${name}: claims ${c.claimsTotal}, certified ${c.certified} (matches docs ${c.matchesDocs}, contradicts docs ${c.contradictsDocs}), unproven ${c.unproven}, revoked ${c.revoked}`;
  return [...report.tools.map((t) => line(t.tool, t.counts)), line("overall", report.overall)];
}

export async function writeCertificates(opts: CertificateExportOptions = {}): Promise<CertificateExportResult> {
  const fixture = opts.fixture === true;
  const webRoot = resolve(opts.webDir ?? CERTIFICATE_PATHS.webCertificatesDir);
  if (!fixture && basename(webRoot) === CERTIFICATES_FIXTURE_SUBDIR) {
    throw new Error(`notary export --certificates: refusing to write real certificates into the fixture directory ${webRoot}`);
  }
  const exportDir = opts.exportDir ?? CERTIFICATE_PATHS.exportDir;
  await mkdir(exportDir, { recursive: true });
  const files: string[] = [];

  if (!fixture) {
    const c = collectBundles(opts.runsDir ?? CERTIFICATE_PATHS.runsDir);
    const bundles = realCertificateSources(c.bundles.map((x) => x.bundle));
    const set = buildCertificates(bundles, {});
    const report = await writeSet(set, webRoot, files);
    const mdPath = join(exportDir, "REPORT.md");
    await writeFile(mdPath, renderReportMd(report, set), "utf8");
    files.push(mdPath);
    const lines = [
      `notary export --certificates: ${report.sourceBundles.length} source bundle(s)${report.sourceBundles.length ? ` (${report.sourceBundles.map((s) => s.runId).join(", ")})` : " — no real runs yet"}`,
      ...c.skipped.map((s) => `  SKIPPED ${s.file}: ${s.reason}`),
      ...countLines(report, "  "),
      ...files.map((f) => `  ${f}`),
    ];
    return { outputs: [{ scenario: "real", set, report, bundles }], skipped: c.skipped, files, lines };
  }

  const fixtureRoot = join(webRoot, CERTIFICATES_FIXTURE_SUBDIR);
  const { bundles, skipped } = collectFixtureBundles(opts.fixtureDirs ?? CERTIFICATE_PATHS.fixtureRunsDirs);
  const outputs: ScenarioOutput[] = [];
  for (const [scenario, group] of groupByScenario(bundles)) {
    const set = buildCertificates(group, { fixture: true, scenario });
    const report = await writeSet(set, join(fixtureRoot, scenario), files);
    outputs.push({ scenario, set, report, bundles: group });
  }
  // The old merged layout (fixture/<tool>.json, fixture/report.json) mixed worlds: remove it.
  const removed: string[] = [];
  for (const name of [...TOOLS.map((t) => `${t}.json`), "report.json"]) {
    const p = join(fixtureRoot, name);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed.push(name);
    }
  }
  const index: FixtureIndex = FixtureIndexSchema.parse({
    generatedBy: CERTIFICATES_FIXTURE_GENERATED_BY,
    sample: true,
    disclosure: [FIXTURE_CERT_DISCLOSURE],
    note: "Each scenario is a separate simulated world; its certificates come only from that scenario's fixture bundles and are never merged with another scenario or with real data.",
    scenarios: outputs.map((o) => ({
      scenario: o.scenario,
      report: `${o.scenario}/report.json`,
      files: o.set.tools.map((t) => `${o.scenario}/${t.tool}.json`),
      sourceBundles: o.report.sourceBundles.map((s) => s.runId),
      overall: o.report.overall,
    })),
  });
  const indexPath = join(fixtureRoot, "index.json");
  await writeFile(indexPath, pretty(index), "utf8");
  files.push(indexPath);

  const md = [
    "# Notary certificates — FIXTURE (simulated, not a live run)",
    "",
    `> ${FIXTURE_CERT_DISCLOSURE}. Generated by \`${CERTIFICATES_FIXTURE_GENERATED_BY}\`; do not edit by hand.`,
    `> One section per fixture scenario (${outputs.map((o) => o.scenario).join(", ")}). Scenarios are separate simulated worlds and are never merged. Nothing here is a claim about the real APIs.`,
    "",
    ...outputs.map((o) => renderReportMd(o.report, o.set, { shift: 1 })),
  ].join("\n");
  const mdPath = join(exportDir, "REPORT.fixture.md");
  await writeFile(mdPath, `${md.trimEnd()}\n`, "utf8");
  files.push(mdPath);

  const lines = [
    `notary export --certificates --fixture (${FIXTURE_CERT_DISCLOSURE}): ${bundles.length} fixture source bundle(s) in ${outputs.length} scenario(s)`,
    ...skipped.filter((s) => s.reason !== "not a run bundle").map((s) => `  SKIPPED ${s.file}: ${s.reason}`),
    ...outputs.flatMap((o) => [
      `  scenario ${o.scenario}: ${o.bundles.length ? o.bundles.map((b) => b.runId).join(", ") : "no fixture bundles"}`,
      ...countLines(o.report, "    "),
    ]),
    ...(removed.length ? [`  removed the old merged fixture files: ${removed.join(", ")}`] : []),
    ...files.map((f) => `  ${f}`),
  ];
  return { outputs, skipped, files, lines };
}
