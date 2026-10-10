/**
 * `notary export --certificates [--fixture]`: write certificates derived from verified bundles.
 *
 *   real (default)  sources: REAL bundles only — packages/core/runs/<dir>/<runId>.json, sample:false,
 *                   hash-verified (export/collect.ts collectBundles), full notarize bundles plus drift
 *                   replays that carry belief events. Writes
 *                     packages/web/public/certificates/<tool>.json   (one per tool)
 *                     packages/web/public/certificates/report.json
 *                     export/REPORT.md
 *                   With 0 real bundles it still writes honest files: every claim "not tested", all
 *                   counts zero, header "no real runs yet".
 *   --fixture       sources: the FIXTURE demo bundles under packages/core/runs/demo/** (sample:true,
 *                   FIXTURE disclosure, demo-* runIds; demo/publish.ts fixturePublishRefusal). Writes
 *                     packages/web/public/certificates/fixture/<tool>.json + fixture/report.json
 *                     export/REPORT.fixture.md
 *                   Every record carries sample: true and the FIXTURE disclosure. Fixture data never
 *                   reaches the real files, and export/REPORT.md is never written from it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex, verifyBundle } from "../bundle/hash.js";
import { fixturePublishRefusal } from "../demo/publish.js";
import { classify, collectBundles, isDriftReplay } from "../export/collect.js";
import type { SkippedBundle } from "../export/collect.js";
import type { RunBundle } from "../schema/index.js";
import { buildCertificates } from "./certificates.js";
import type { CertificateSet } from "./certificates.js";
import { buildReport, renderReportMd } from "./report.js";
import type { CertificateReport } from "./report.js";

export * from "./certificates.js";
export * from "./report.js";
export { RevocationSchema, verifyRevocation, verifySeal, sealOf } from "./revocations.js";
export type { Revocation, RetiredGuard } from "./revocations.js";

export const CERTIFICATES_FIXTURE_SUBDIR = "fixture";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export const CERTIFICATE_PATHS = {
  runsDir: fileURLToPath(new URL("../../runs/", import.meta.url)),
  demoRunsDir: fileURLToPath(new URL("../../runs/demo/", import.meta.url)),
  webCertificatesDir: fileURLToPath(new URL("../../../web/public/certificates/", import.meta.url)),
  exportDir: join(REPO_ROOT, "export"),
};

export interface CertificateExportOptions {
  fixture?: boolean;
  /** Real: runs dir (default packages/core/runs). Fixture: demo runs dir (default packages/core/runs/demo). */
  runsDir?: string;
  /** packages/web/public/certificates (fixture output goes to its fixture/ subdirectory). */
  webDir?: string;
  exportDir?: string;
}

export interface CertificateExportResult {
  set: CertificateSet;
  report: CertificateReport;
  bundles: RunBundle[];
  skipped: SkippedBundle[];
  files: string[];
  lines: string[];
}

/** Real sources: full notarize bundles and drift replays with belief events (never sample, never compare-priors arms). */
export function realCertificateSources(bundles: readonly RunBundle[]): RunBundle[] {
  return bundles.filter((b) => !b.sample && (classify(b) === "notarize-full" || (isDriftReplay(b) && b.beliefEvents.length > 0)));
}

/** Fixture bundles under the demo runs dir (two levels: <dir>/<file>.json and <dir>/<sub>/<file>.json). */
export function collectFixtureBundles(demoDir: string): { bundles: RunBundle[]; skipped: SkippedBundle[] } {
  const bundles: RunBundle[] = [];
  const skipped: SkippedBundle[] = [];
  if (!existsSync(demoDir)) return { bundles, skipped };
  const files: string[] = [];
  for (const d of readdirSync(demoDir).sort()) {
    const full = join(demoDir, d);
    if (!statSync(full).isDirectory() || d === "cassettes" || d === "export-check") continue;
    for (const f of readdirSync(full).sort()) if (f.endsWith(".json") && f !== "index.json") files.push(join(full, f));
  }
  for (const path of files) {
    const file = path.slice(demoDir.length).replace(/\\/g, "/").replace(/^\//, "");
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
    if (v.bundle.kind === "notarize" || v.bundle.beliefEvents.length > 0) bundles.push(v.bundle);
  }
  return { bundles, skipped };
}

function pretty(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

export async function writeCertificates(opts: CertificateExportOptions = {}): Promise<CertificateExportResult> {
  const fixture = opts.fixture === true;
  const webRoot = resolve(opts.webDir ?? CERTIFICATE_PATHS.webCertificatesDir);
  if (!fixture && basename(webRoot) === CERTIFICATES_FIXTURE_SUBDIR) {
    throw new Error(`notary export --certificates: refusing to write real certificates into the fixture directory ${webRoot}`);
  }
  const outDir = fixture ? join(webRoot, CERTIFICATES_FIXTURE_SUBDIR) : webRoot;
  const exportDir = opts.exportDir ?? CERTIFICATE_PATHS.exportDir;

  let bundles: RunBundle[];
  let skipped: SkippedBundle[];
  if (fixture) {
    ({ bundles, skipped } = collectFixtureBundles(opts.runsDir ?? CERTIFICATE_PATHS.demoRunsDir));
  } else {
    const c = collectBundles(opts.runsDir ?? CERTIFICATE_PATHS.runsDir);
    bundles = realCertificateSources(c.bundles.map((x) => x.bundle));
    skipped = c.skipped;
  }

  const set = buildCertificates(bundles, { fixture });
  await mkdir(outDir, { recursive: true });
  await mkdir(exportDir, { recursive: true });
  const files: string[] = [];
  const hashes: Record<string, string> = {};
  for (const t of set.tools) {
    const p = join(outDir, `${t.tool}.json`);
    await writeFile(p, pretty(t), "utf8");
    hashes[`${t.tool}.json`] = sha256Hex(canonicalJson(t));
    files.push(p);
  }
  const report = buildReport(set, hashes, (tool) => `${tool}.json`);
  const reportPath = join(outDir, "report.json");
  await writeFile(reportPath, pretty(report), "utf8");
  files.push(reportPath);
  const mdPath = join(exportDir, fixture ? "REPORT.fixture.md" : "REPORT.md");
  await writeFile(mdPath, renderReportMd(report, set), "utf8");
  files.push(mdPath);

  const o = report.overall;
  const lines = [
    `notary export --certificates${fixture ? " --fixture (FIXTURE — simulated APIs and models, not a live run)" : ""}: ${report.sourceBundles.length} source bundle(s)${report.sourceBundles.length ? ` (${report.sourceBundles.map((s) => s.runId).join(", ")})` : fixture ? "" : " — no real runs yet"}`,
    ...skipped.filter((s) => s.reason !== "not a run bundle").map((s) => `  SKIPPED ${s.file}: ${s.reason}`),
    ...report.tools.map(
      (t) =>
        `  ${t.tool}: claims ${t.counts.claimsTotal}, certified ${t.counts.certified} (matches docs ${t.counts.matchesDocs}, contradicts docs ${t.counts.contradictsDocs}), unproven ${t.counts.unproven}, revoked ${t.counts.revoked}`,
    ),
    `  overall: claims ${o.claimsTotal}, certified ${o.certified} (matches docs ${o.matchesDocs}, contradicts docs ${o.contradictsDocs}), unproven ${o.unproven}, revoked ${o.revoked}`,
    ...files.map((f) => `  ${f}`),
  ];
  return { set, report, bundles, skipped, files, lines };
}
