/**
 * Incidents on disk and in neatlogs (Node side of src/incidents/derive.ts).
 *
 *   recordRunIncidents   end of a run: derive the run's incidents from runs/<runId>/ (bundle passed in,
 *                        timeline.jsonl, approvals.json, spans.jsonl), write runs/<runId>/incidents.json,
 *                        and send every incident not already reported live to neatlogs as a warn/error
 *                        log() record (plus an info record per resolution), all inside one
 *                        `notary.incidents` EVALUATOR span in the run's trace.
 *   buildIncidentsFile   the IncidentsFile for a bundle + run dir (pure apart from reading files).
 *   publishIncidents     write packages/web/public/incidents/<runId>.json (fixture: .../incidents/fixture/).
 *   writeIncidentsIndex  write <incidentsDir>/index.json: every published run's incidents (one fetch).
 *
 * Never invents anything: an incident exists only when a rule in derive.ts matches recorded data.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { leakedSecretNames, verifyBundle } from "../bundle/index.js";
import { canonicalJson, sha256Hex } from "../bundle/hash.js";
import { ApprovalsFileSchema } from "../schema/approval.js";
import type { ApprovalRecord } from "../schema/approval.js";
import type { RunBundle } from "../schema/index.js";
import { IncidentsFileSchema, IncidentsIndexSchema } from "../schema/incidents.js";
import type { IncidentsFile, IncidentsIndex } from "../schema/incidents.js";
import type { TimelineEvent } from "../schema/timeline.js";
import { readTimeline } from "../timeline/store.js";
import { withSpan } from "../trace/index.js";
import type { SpanRecord } from "../trace/index.js";
import { resolveTraceLinkTemplate, traceLinkFor } from "../trace/links.js";
import type { TemplateSource } from "../trace/links.js";
import { deriveIncidents } from "./derive.js";
import { reportIncident, reportResolution, reportedIncidentIds } from "./live.js";

export const INCIDENTS_FILE = "incidents.json";
export const INCIDENTS_INDEX_FILE = "index.json";

export function incidentsPath(runDir: string): string {
  return join(runDir, INCIDENTS_FILE);
}

/** runs/<runId>/spans.jsonl records (malformed lines skipped). [] when absent. */
export function readSpanRecords(runDir: string): SpanRecord[] {
  const path = join(runDir, "spans.jsonl");
  if (!existsSync(path)) return [];
  const out: SpanRecord[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SpanRecord;
      if (r && typeof r.name === "string" && typeof r.traceId === "string" && typeof r.spanId === "string" && r.attrs && typeof r.attrs === "object") out.push(r);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function readApprovals(runDir: string, runId: string): ApprovalRecord[] {
  const path = join(runDir, "approvals.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = ApprovalsFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success && parsed.data.runId === runId ? parsed.data.approvals : [];
  } catch {
    return [];
  }
}

function safeTimeline(runDir: string): TimelineEvent[] {
  try {
    return readTimeline(runDir);
  } catch {
    return [];
  }
}

/** The IncidentsFile for `bundle`, reading timeline/approvals/spans from `runDir` when given. */
export function buildIncidentsFile(bundle: RunBundle, opts: { runDir?: string; template?: TemplateSource } = {}): IncidentsFile {
  const runDir = opts.runDir && existsSync(opts.runDir) ? opts.runDir : undefined;
  const timeline = runDir ? safeTimeline(runDir) : [];
  const approvals = runDir ? readApprovals(runDir, bundle.runId) : [];
  const spans = runDir ? readSpanRecords(runDir) : [];
  const { template } = opts.template ?? resolveTraceLinkTemplate();
  const sources: IncidentsFile["sources"] = ["bundle"];
  if (timeline.length) sources.push("timeline");
  if (spans.length) sources.push("spans");
  if (approvals.length) sources.push("approvals");
  return IncidentsFileSchema.parse({
    runId: bundle.runId,
    sample: bundle.sample,
    bundleHash: bundle.contentHash,
    sources,
    incidents: deriveIncidents({ bundle, timeline, spans, approvals, traceUrlFor: (id) => traceLinkFor(id, template) }),
  });
}

function assertNoSecrets(text: string, what: string): void {
  const leaked = leakedSecretNames(text);
  if (leaked.length) throw new Error(`refusing to write ${what}: it contains the value of secret env var(s) ${leaked.join(", ")}`);
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/**
 * Derive + write runs/<runId>/incidents.json and send the incidents to neatlogs (those not already
 * reported live in this process, and every resolution). Never throws for tracing problems; a write
 * failure is returned in `error` so a finished run is never failed by its incident report.
 */
export async function recordRunIncidents(bundle: RunBundle, runDir: string, opts: { emit?: boolean } = {}): Promise<{ file: IncidentsFile | null; path: string; emitted: number; error?: string }> {
  const path = incidentsPath(runDir);
  let file: IncidentsFile;
  try {
    file = buildIncidentsFile(bundle, { runDir });
    const text = `${JSON.stringify(file, null, 2)}\n`;
    assertNoSecrets(text, `incidents for ${bundle.runId}`);
    mkdirSync(runDir, { recursive: true });
    writeAtomic(path, text);
  } catch (err) {
    return { file: null, path, emitted: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (opts.emit === false || file.incidents.length === 0) return { file, path, emitted: 0 };

  let emitted = 0;
  try {
    await withSpan(
      "notary.incidents",
      {
        "notary.incidents.count": file.incidents.length,
        "notary.incidents.open": file.incidents.filter((i) => i.resolution.status === "open").length,
        "notary.incidents.awaitingHuman": file.incidents.filter((i) => i.resolution.status === "awaiting_human").length,
        "notary.incidents.kinds": [...new Set(file.incidents.map((i) => i.kind))].sort().join(","),
      },
      () => {
        const already = reportedIncidentIds(bundle.runId);
        for (const i of file.incidents) {
          if (!already.has(i.id)) {
            reportIncident({
              id: i.id,
              runId: bundle.runId,
              kind: i.kind,
              subject: i.recordIds[0] ?? i.id,
              severity: i.severity,
              summary: i.summary,
              ...(i.traceId && i.spanId ? { span: { traceId: i.traceId, spanId: i.spanId } } : {}),
              attrs: {
                ...(i.agent ? { "notary.agent_id": i.agent } : {}),
                ...(i.tool ? { "notary.tool": i.tool } : {}),
                ...(i.decisionId ? { "notary.decisionId": i.decisionId } : {}),
                ...(i.beliefId ? { "notary.beliefId": i.beliefId } : {}),
                ...(i.claimId ? { "notary.claimId": i.claimId } : {}),
                "notary.incident.exported": i.exported,
              },
            });
            emitted += 1;
          }
          if (i.resolution.status !== "open") reportResolution(i.id, i.resolution);
        }
        return { incidents: file.incidents.length, emitted };
      },
      { kind: "EVALUATOR" },
    );
  } catch {
    // tracing must never fail a run
  }
  return { file, path, emitted };
}

/** One CLI line for a run's incident report. */
export function incidentsLine(r: { file: IncidentsFile | null; path: string; emitted: number; error?: string }): string {
  if (!r.file) return `incidents: not written (${r.error ?? "unknown error"})`;
  const n = r.file.incidents.length;
  const open = r.file.incidents.filter((i) => i.resolution.status === "open").length;
  const human = r.file.incidents.filter((i) => i.resolution.status === "awaiting_human").length;
  return `incidents: ${n} (${n - open - human} resolved, ${human} awaiting a person, ${open} open) -> ${r.path}${r.emitted ? `; ${r.emitted} sent to neatlogs at the end of the run` : ""}`;
}

/**
 * Write `<incidentsDir>/<runId>.json` for a published bundle (verified; sample flag must match). The
 * dashboard keeps incidents in their own directory (packages/web/public/incidents[/fixture]), never
 * inside public/bundles, whose loaders treat every JSON file as a bundle or timeline.
 */
export async function publishIncidents(bundle: RunBundle, incidentsDir: string, opts: { expectSample: boolean; runDir?: string; template?: TemplateSource }): Promise<{ path: string; file: IncidentsFile }> {
  const v = verifyBundle(bundle);
  if (!v.ok) throw new Error(`refusing to publish incidents: ${v.error}`);
  if (v.bundle.sample !== opts.expectSample) {
    throw new Error(`refusing to publish incidents for ${v.bundle.runId}: sample is ${v.bundle.sample}, expected ${opts.expectSample} (fixture and real data never mix)`);
  }
  const file = buildIncidentsFile(v.bundle, { ...(opts.runDir ? { runDir: opts.runDir } : {}), ...(opts.template ? { template: opts.template } : {}) });
  const text = `${JSON.stringify(file, null, 2)}
`;
  assertNoSecrets(text, `incidents for ${v.bundle.runId}`);
  await mkdir(incidentsDir, { recursive: true });
  const path = join(incidentsDir, `${v.bundle.runId}.json`);
  await writeFile(path, text, "utf8");
  return { path, file };
}

/** Write `<incidentsDir>/index.json` (IncidentsIndex); all files must share `sample`. Newest run first. */
export async function writeIncidentsIndex(incidentsDir: string, files: readonly IncidentsFile[], sample: boolean, startedAt: (runId: string) => string = () => ""): Promise<string> {
  for (const f of files) if (f.sample !== sample) throw new Error(`refusing to mix sample and real incidents in one index (${f.runId})`);
  const runs = [...files].sort((a, b) => startedAt(b.runId).localeCompare(startedAt(a.runId)) || a.runId.localeCompare(b.runId));
  const body = IncidentsIndexSchema.omit({ contentHash: true }).parse({ sample, runs });
  // Verifiable in the browser: sha256 of canonicalJson(the file without contentHash).
  const index: IncidentsIndex = IncidentsIndexSchema.parse({ ...body, contentHash: sha256Hex(canonicalJson(body)) });
  const text = `${JSON.stringify(index, null, 2)}
`;
  assertNoSecrets(text, "incidents index");
  await mkdir(incidentsDir, { recursive: true });
  const path = join(incidentsDir, INCIDENTS_INDEX_FILE);
  await writeFile(path, text, "utf8");
  return path;
}

/**
 * Rebuild `<incidentsDir>/index.json` from every `<runId>.json` there whose run is in
 * `<bundlesDir>/index.json` with the same sample flag (stale or foreign files are left out).
 */
export async function rebuildIncidentsIndex(incidentsDir: string, opts: { sample: boolean; bundlesDir: string }): Promise<{ path: string; runs: number; incidents: number }> {
  const { BundleIndexSchema } = await import("../schema/bundle.js");
  const indexPath = join(opts.bundlesDir, "index.json");
  const entries = existsSync(indexPath) ? BundleIndexSchema.safeParse(JSON.parse(readFileSync(indexPath, "utf8"))) : null;
  const byRun = new Map((entries?.success ? entries.data : []).filter((e) => e.sample === opts.sample).map((e) => [e.runId, e]));
  const files: IncidentsFile[] = [];
  for (const name of existsSync(incidentsDir) ? readdirSync(incidentsDir).sort() : []) {
    if (!name.endsWith(".json") || name === INCIDENTS_INDEX_FILE) continue;
    try {
      const parsed = IncidentsFileSchema.safeParse(JSON.parse(readFileSync(join(incidentsDir, name), "utf8")));
      if (!parsed.success || parsed.data.sample !== opts.sample || `${parsed.data.runId}.json` !== name) continue;
      if (!byRun.has(parsed.data.runId)) continue;
      files.push(parsed.data);
    } catch {
      // unreadable or a directory: left out
    }
  }
  const path = await writeIncidentsIndex(incidentsDir, files, opts.sample, (id) => byRun.get(id)?.startedAt ?? "");
  return { path, runs: files.length, incidents: files.reduce((n, f) => n + f.incidents.length, 0) };
}

/**
 * (Re)publish incidents for every bundle already in a dashboard bundles directory (`<bundlesDir>/index.json`
 * entries with the given sample flag) into `incidentsDir`, deriving from `<runsDir>/<runId>/` for the
 * first runs dir that has the run (bundle-only when none does), then rebuild its index.json. Never
 * writes into bundlesDir. Used by `pnpm --filter @notary/core publish:incidents`.
 */
export async function publishDashboardIncidents(bundlesDir: string, incidentsDir: string, opts: { sample: boolean; runsDirs: readonly string[] }): Promise<{ published: string[]; skipped: { runId: string; reason: string }[]; index: { path: string; runs: number; incidents: number } }> {
  const { BundleIndexSchema } = await import("../schema/bundle.js");
  const indexPath = join(bundlesDir, "index.json");
  const parsed = existsSync(indexPath) ? BundleIndexSchema.safeParse(JSON.parse(readFileSync(indexPath, "utf8"))) : null;
  const published: string[] = [];
  const skipped: { runId: string; reason: string }[] = [];
  for (const e of parsed?.success ? parsed.data : []) {
    if (e.sample !== opts.sample || e.kind === "sample") continue;
    try {
      const v = verifyBundle(JSON.parse(readFileSync(join(bundlesDir, `${e.runId}.json`), "utf8")));
      if (!v.ok) {
        skipped.push({ runId: e.runId, reason: v.error });
        continue;
      }
      const runDir = opts.runsDirs.map((r) => join(r, e.runId)).find((p) => existsSync(p));
      await publishIncidents(v.bundle, incidentsDir, { expectSample: opts.sample, ...(runDir ? { runDir } : {}) });
      published.push(e.runId);
    } catch (err) {
      skipped.push({ runId: e.runId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { published, skipped, index: await rebuildIncidentsIndex(incidentsDir, { sample: opts.sample, bundlesDir }) };
}
