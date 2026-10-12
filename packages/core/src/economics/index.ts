/**
 * `notary economics`: writes packages/web/public/economics.json (schema/economics.ts) and
 * docs/BUSINESS.md from
 *   - REAL bundles: packages/core/runs/<dir>/<runId>.json (export/collect.ts rules) and the
 *     published packages/web/public/bundles/<runId>.json; sample/fixture and drift bundles are
 *     listed under `skipped`, never used
 *   - public/certificates/report.json (real only) for cost per certificate
 *   - the cfo.ai plan: `--cfo-import <file>` parses a fresh export; otherwise the plan already in
 *     economics.json is kept if that file still verifies (schema + content hash)
 * The output is a pure function of those inputs (the import timestamp is part of the plan).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex, verifyBundle } from "../bundle/hash.js";
import { collectBundles, isDriftReplay } from "../export/collect.js";
import { CertificateReportSchema, type CertificateReport } from "../schema/certificate.js";
import {
  ECONOMICS_GENERATED_BY,
  EconomicsBodyCheckedSchema,
  EconomicsFileSchema,
  type CfoPlan,
  type EconomicsBody,
  type EconomicsFile,
} from "../schema/economics.js";
import type { RunBundle } from "../schema/index.js";
import { importCfoPlanFile } from "./cfo-import.js";
import { combine, computeEconomics } from "./compute.js";
import { renderBusinessMd } from "./business-md.js";
import { renderCfoInputsCsv } from "./cfo-inputs.js";

export { parseCfoPlanCsv, importCfoPlanFile, parseCsv, CfoImportError, CFO_PLAN_FORMAT, CFO_PLAN_HEADER } from "./cfo-import.js";
export { computeEconomics, combine, economicsRun } from "./compute.js";
export { renderBusinessMd } from "./business-md.js";
export { renderCfoInputsCsv, CFO_INPUTS_COLUMNS } from "./cfo-inputs.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export const ECONOMICS_PATHS = {
  runsDir: fileURLToPath(new URL("../../runs/", import.meta.url)),
  webBundlesDir: join(REPO_ROOT, "packages", "web", "public", "bundles"),
  certificatesReport: join(REPO_ROOT, "packages", "web", "public", "certificates", "report.json"),
  economicsJson: join(REPO_ROOT, "packages", "web", "public", "economics.json"),
  businessMd: join(REPO_ROOT, "docs", "BUSINESS.md"),
  cfoInputsCsv: join(REPO_ROOT, "export", "cfo-inputs.csv"),
};

/** sha256 hex of canonicalJson(file without contentHash). Same rule as run bundles. */
export function economicsHash(body: EconomicsBody | EconomicsFile): string {
  const { contentHash: _ignored, ...rest } = body as EconomicsFile;
  return sha256Hex(canonicalJson(rest));
}

/** Validate the body and stamp its content hash. */
export function finalizeEconomics(body: EconomicsBody): EconomicsFile {
  const parsed = EconomicsBodyCheckedSchema.parse(body);
  return EconomicsFileSchema.parse({ ...parsed, contentHash: economicsHash(parsed) });
}

export type EconomicsVerify = { ok: true; file: EconomicsFile } | { ok: false; error: string };

export function verifyEconomics(raw: unknown): EconomicsVerify {
  const parsed = EconomicsFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `economics.json fails its schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  const actual = economicsHash(parsed.data);
  if (actual !== parsed.data.contentHash) return { ok: false, error: `economics.json content hash mismatch: recorded ${parsed.data.contentHash}, computed ${actual}` };
  return { ok: true, file: parsed.data };
}

interface Source {
  bundle: RunBundle;
  file: string;
}

/** Top-level <runId>.json files of the published dashboard dir (never fixture/, never timelines). */
function publishedBundles(dir: string): { bundles: Source[]; skipped: { file: string; reason: string }[] } {
  const out = { bundles: [] as Source[], skipped: [] as { file: string; reason: string }[] };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || name === "index.json" || name.endsWith(".timeline.json")) continue;
    const file = `web/public/bundles/${name}`;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      out.skipped.push({ file, reason: "unreadable JSON" });
      continue;
    }
    const v = verifyBundle(raw);
    if (!v.ok) {
      out.skipped.push({ file, reason: v.reason === "hash" ? "content hash mismatch (tampered or edited after writing)" : "fails the bundle schema" });
      continue;
    }
    const b = v.bundle;
    if (b.sample || b.kind === "sample" || b.variant === "sample") {
      out.skipped.push({ file, reason: "SAMPLE/fixture bundle — never a source of results" });
      continue;
    }
    if (name.replace(/\.json$/, "") !== b.runId) {
      out.skipped.push({ file, reason: `file name does not match its runId (${b.runId})` });
      continue;
    }
    out.bundles.push({ bundle: b, file });
  }
  return out;
}

export interface GatherResult {
  bundles: Source[];
  skipped: { file: string; reason: string }[];
}

/** Real bundles from the runs dir and the published dir, deduplicated by runId. */
export function gatherRealBundles(runsDir: string, webBundlesDir: string): GatherResult {
  const fromRuns = collectBundles(runsDir);
  const fromWeb = publishedBundles(webBundlesDir);
  const skipped = [
    ...fromRuns.skipped.map((s) => ({ file: `core/runs/${s.file}`, reason: s.reason })),
    ...fromRuns.excluded.map((s) => ({ file: `core/runs/${s.file}`, reason: s.reason })),
    ...fromWeb.skipped,
  ];
  const byId = new Map<string, Source>();
  for (const s of [...fromRuns.bundles.map((c) => ({ bundle: c.bundle, file: `core/runs/${c.file}` })), ...fromWeb.bundles]) {
    if (isDriftReplay(s.bundle)) {
      skipped.push({ file: s.file, reason: "DRIFT FIXTURE replay (altered recording) — never a cost or safety source" });
      continue;
    }
    const prior = byId.get(s.bundle.runId);
    if (!prior) byId.set(s.bundle.runId, s);
    else if (prior.bundle.contentHash !== s.bundle.contentHash)
      skipped.push({ file: s.file, reason: `same runId as ${prior.file} with a different content hash; the first copy is used` });
  }
  const bundles = [...byId.values()].sort((x, y) => Date.parse(x.bundle.startedAt) - Date.parse(y.bundle.startedAt) || (x.bundle.runId < y.bundle.runId ? -1 : 1));
  skipped.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { bundles, skipped };
}

function readCertificates(path: string): { report: CertificateReport | null; ref: { file: string; sha256: string } | null } {
  if (!existsSync(path)) return { report: null, ref: null };
  const text = readFileSync(path, "utf8");
  const parsed = CertificateReportSchema.safeParse(JSON.parse(text));
  if (!parsed.success || parsed.data.sample) return { report: null, ref: null };
  return { report: parsed.data, ref: { file: "web/public/certificates/report.json", sha256: sha256Hex(canonicalJson(parsed.data)) } };
}

/** Assemble the file body from gathered inputs (pure; exported for tests). */
export function buildEconomicsBody(input: {
  bundles: readonly Source[];
  skipped: readonly { file: string; reason: string }[];
  certificates: CertificateReport | null;
  certificatesRef: { file: string; sha256: string } | null;
  plan: CfoPlan | null;
  planReason: string | null;
}): EconomicsBody {
  const { computed, computedReason } = computeEconomics({ bundles: input.bundles.map((s) => s.bundle), certificates: input.certificates });
  return {
    schemaVersion: 1,
    generatedBy: ECONOMICS_GENERATED_BY,
    sample: false,
    sources: {
      bundles: input.bundles.map((s) => ({ runId: s.bundle.runId, contentHash: s.bundle.contentHash, file: s.file })),
      skipped: [...input.skipped],
      certificatesReport: input.certificatesRef,
    },
    computed,
    computedReason,
    plan: input.plan,
    planReason: input.plan ? null : input.planReason ?? "No cfo.ai plan imported yet. Import your cfo.ai plan: pnpm notary economics --cfo-import <file>",
    combined: combine(computed, input.plan),
  };
}

export interface WriteEconomicsOptions {
  runsDir?: string;
  webBundlesDir?: string;
  certificatesReport?: string;
  economicsJson?: string;
  /** null = do not write docs/BUSINESS.md. */
  businessMd?: string | null;
  /** null = do not write export/cfo-inputs.csv (the inputs sheet for cfo.ai). */
  cfoInputsCsv?: string | null;
  /** Path to a cfo.ai export in notary-cfo-plan-csv/1. */
  cfoImport?: string;
  /** A plan already read and mapped (`notary cfo sync` over cfo.ai's MCP server). Exclusive with cfoImport. */
  plan?: CfoPlan;
  now?: () => Date;
}

export function writeEconomics(opts: WriteEconomicsOptions = {}): { file: EconomicsFile; lines: string[] } {
  const { plan: _plan, ...pathOpts } = opts;
  const paths = { ...ECONOMICS_PATHS, ...Object.fromEntries(Object.entries(pathOpts).filter(([, v]) => v !== undefined)) } as typeof ECONOMICS_PATHS & { businessMd: string | null; cfoInputsCsv: string | null };
  const lines: string[] = [];
  const gathered = gatherRealBundles(paths.runsDir, paths.webBundlesDir);
  const certs = readCertificates(paths.certificatesReport);

  let plan: CfoPlan | null = null;
  let planReason: string | null = null;
  if (opts.plan && opts.cfoImport) throw new Error("writeEconomics: pass either cfoImport or plan, not both");
  if (opts.plan) {
    plan = opts.plan;
    lines.push(`cfo.ai plan synced over MCP (payload sha256 ${plan.source.fileSha256.slice(0, 12)}): ${plan.tiers.length} tiers, ${plan.series.length} series, ${plan.figures.length} figures`);
  } else if (opts.cfoImport) {
    plan = importCfoPlanFile(opts.cfoImport, (opts.now ?? (() => new Date()))().toISOString());
    lines.push(`cfo.ai plan imported from ${basename(opts.cfoImport)} (sha256 ${plan.source.fileSha256.slice(0, 12)}): ${plan.tiers.length} tiers, ${plan.series.length} series, ${plan.figures.length} figures`);
  } else if (existsSync(paths.economicsJson)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(paths.economicsJson, "utf8"));
    } catch {
      raw = undefined;
    }
    const prior = verifyEconomics(raw);
    if (prior.ok) {
      plan = prior.file.plan;
      if (plan) lines.push(`kept the cfo.ai plan ${plan.source.format === "cfo.ai-mcp/1" ? "synced over MCP" : "imported"} ${plan.source.importedAt} from ${plan.source.file}`);
    } else {
      planReason = `The previous economics.json did not verify (${prior.error}), so its plan was dropped. Re-import: pnpm notary economics --cfo-import <file>`;
      lines.push(planReason);
    }
  }

  const file = finalizeEconomics(
    buildEconomicsBody({ bundles: gathered.bundles, skipped: gathered.skipped, certificates: certs.report, certificatesRef: certs.ref, plan, planReason }),
  );
  mkdirSync(dirname(paths.economicsJson), { recursive: true });
  writeFileSync(paths.economicsJson, `${JSON.stringify(file, null, 2)}\n`);
  lines.push(`economics written to ${paths.economicsJson} (contentHash ${file.contentHash.slice(0, 12)})`);
  lines.push(
    file.computed
      ? `  computed from ${file.computed.totals.runs} real bundles (${file.computed.totals.liveRuns} live, ${file.computed.totals.replayRuns} replay); ${gathered.skipped.length} files skipped`
      : `  computed: null — ${file.computedReason}`,
  );
  lines.push(file.plan ? `  plan: cfo.ai, ${file.plan.source.format === "cfo.ai-mcp/1" ? "synced" : "imported"} ${file.plan.source.importedAt}` : `  plan: null — ${file.planReason}`);
  if (paths.businessMd) {
    mkdirSync(dirname(paths.businessMd), { recursive: true });
    writeFileSync(paths.businessMd, renderBusinessMd(file));
    lines.push(`summary written to ${paths.businessMd}`);
  }
  if (paths.cfoInputsCsv) {
    mkdirSync(dirname(paths.cfoInputsCsv), { recursive: true });
    writeFileSync(paths.cfoInputsCsv, renderCfoInputsCsv(file));
    lines.push(
      `cfo.ai inputs sheet written to ${paths.cfoInputsCsv} (${file.computed?.runs.length ?? 0} real runs${file.computed ? "" : "; header only"}) — upload it in cfo.ai: Connections → Add → Upload`,
    );
  }
  return { file, lines };
}
