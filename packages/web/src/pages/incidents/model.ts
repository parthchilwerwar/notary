// /app/incidents: pure derivations from the published incidents file. No I/O, no React. Every count
// the page shows is computed here from the file; nothing is invented.
import {
  IncidentKindSchema,
  IncidentResolutionStatusSchema,
  IncidentSeveritySchema,
  type BundleIndexEntry,
  type Incident,
  type IncidentKind,
  type IncidentResolutionAction,
  type IncidentResolutionStatus,
  type IncidentSeverity,
  type IncidentsFile,
} from "../../../../core/src/schema";
import type { IncidentsLoad, IndexRead } from "../../data/incidents";
import { recordPath, withRun } from "../../app/links";

/** A human label for every incident kind (typed against the schema enum: a new kind is a type error). */
export const KIND_LABEL: Record<IncidentKind, string> = {
  checker_anomaly: "Checker anomaly",
  probe_contradiction: "Probe contradicted the docs",
  belief_unlearned: "Certificate lost (drift)",
  adversary_downgrade: "Adversary downgrade",
  guard_hold: "Held for a person",
  guard_block: "Guard blocked a call",
  unsafe_action_prevented: "Unsafe action prevented",
  unsafe_action_executed: "Unsafe action executed",
  budget_stop: "Budget stop",
  rate_limited: "Rate limited",
  model_error: "Model error",
  tool_error: "Tool error",
};

export const SEVERITY_LABEL: Record<IncidentSeverity, string> = { warning: "Warning", error: "Error" };

export const STATUS_LABEL: Record<IncidentResolutionStatus, string> = {
  resolved: "Resolved",
  awaiting_human: "Awaiting a human",
  open: "Open",
};

export const ACTION_LABEL: Record<IncidentResolutionAction, string> = {
  guard_compiled: "Guard compiled",
  certified: "Certified",
  belief_refuted: "Doc claim refuted",
  belief_abstained: "Not certified (too little evidence)",
  guard_retired: "Guard retired",
  recertified: "Recertified",
  held_for_person: "Held for a person",
  approved: "Approved by a person",
  rejected: "Rejected by a person",
  action_refused: "Action refused",
  action_rewritten: "Action rewritten",
  retried: "Retried",
  run_stopped: "Run stopped",
  failed_safe: "Failed safe",
  none: "No action yet",
};

export const KINDS = IncidentKindSchema.options;
export const SEVERITIES = IncidentSeveritySchema.options;
export const STATUSES = IncidentResolutionStatusSchema.options;

/** How a run's incidents tie to the published bundle. */
export type RunCheck =
  | { state: "verified"; entry: BundleIndexEntry }
  /** The index lists the run with a different contentHash: incidents withheld. */
  | { state: "mismatch"; indexHash: string; bundleHash: string }
  /** The index lists the run, but in the other data world (sample flag differs): withheld. */
  | { state: "world_mismatch" }
  /** No index lists the run. Incidents shown, marked "bundle not published". */
  | { state: "unpublished" }
  /** An index could not be read, so the tie-in could not be checked. Incidents shown, marked. */
  | { state: "unchecked"; reason: string };

export type RunView = {
  runId: string;
  sample: boolean;
  bundleHash: string;
  sources: IncidentsFile["sources"];
  check: RunCheck;
  /** Incidents whose runId differs from the file's runId (a malformed file): withheld. */
  foreign: number;
  /** false when the run's incidents are withheld (hash or world mismatch, foreign incidents). */
  shown: boolean;
  incidents: Incident[];
};

export type IncidentStats = {
  total: number;
  resolved: number;
  awaitingHuman: number;
  open: number;
  errors: number;
  warnings: number;
  byKind: Partial<Record<IncidentKind, number>>;
  bySeverity: Record<IncidentSeverity, number>;
  byStatus: Record<IncidentResolutionStatus, number>;
};

export type Cohort = "real" | "fixture";

export type IncidentsView = {
  cohort: Cohort;
  /** Runs of the shown cohort, in file order (newest first). */
  runs: RunView[];
  /** Stats over the shown cohort's runs whose incidents are shown. */
  stats: IncidentStats;
  /** Runs published in the other cohort (fixture runs in the real view and vice versa). */
  otherCohortRuns: number;
};

/** A run is fixture data when its file, or the whole index, says so (never shown as real). */
export const isSampleRun = (file: IncidentsFile, indexSample: boolean) => file.sample || indexSample;

function lookup(runId: string, reads: IndexRead[]): { entry?: BundleIndexEntry; unreadable?: string } {
  for (const r of reads) {
    const entry = r.entries?.find((e) => e.runId === runId);
    if (entry) return { entry };
  }
  // Not found, and some index could not be read: the run may be listed there, so say "unchecked".
  for (const r of reads) if (r.entries === null && r.error) return { unreadable: r.error };
  return {};
}

/** Tie one run's incidents to its published index entry. */
export function checkRun(file: IncidentsFile, sample: boolean, primary: IndexRead, fixture: IndexRead): RunCheck {
  const { entry, unreadable } = lookup(file.runId, sample ? [fixture, primary] : [primary, fixture]);
  if (!entry) return unreadable ? { state: "unchecked", reason: unreadable } : { state: "unpublished" };
  if (entry.sample !== sample) return { state: "world_mismatch" };
  if (entry.contentHash !== file.bundleHash)
    return { state: "mismatch", indexHash: entry.contentHash, bundleHash: file.bundleHash };
  return { state: "verified", entry };
}

export function runView(file: IncidentsFile, indexSample: boolean, primary: IndexRead, fixture: IndexRead): RunView {
  const sample = isSampleRun(file, indexSample);
  const check = checkRun(file, sample, primary, fixture);
  const foreign = file.incidents.filter((i) => i.runId !== file.runId).length;
  const shown = check.state !== "mismatch" && check.state !== "world_mismatch" && foreign === 0;
  return {
    runId: file.runId,
    sample,
    bundleHash: file.bundleHash,
    sources: file.sources,
    check,
    foreign,
    shown,
    incidents: file.incidents,
  };
}

export function statsOf(incidents: readonly Incident[]): IncidentStats {
  const bySeverity: Record<IncidentSeverity, number> = { warning: 0, error: 0 };
  const byStatus: Record<IncidentResolutionStatus, number> = { resolved: 0, awaiting_human: 0, open: 0 };
  const byKind: Partial<Record<IncidentKind, number>> = {};
  for (const i of incidents) {
    bySeverity[i.severity] += 1;
    byStatus[i.resolution.status] += 1;
    byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  }
  return {
    total: incidents.length,
    resolved: byStatus.resolved,
    awaitingHuman: byStatus.awaiting_human,
    open: byStatus.open,
    errors: bySeverity.error,
    warnings: bySeverity.warning,
    byKind,
    bySeverity,
    byStatus,
  };
}

/** The page's view of a ready load: one cohort only (real by default, fixture under ?fixtures=1). */
export function buildView(load: Extract<IncidentsLoad, { status: "ready" }>, fixtures: boolean): IncidentsView {
  const all = load.index.runs.map((f) => runView(f, load.index.sample, load.primary, load.fixture));
  const cohort: Cohort = fixtures ? "fixture" : "real";
  const runs = all.filter((r) => r.sample === fixtures);
  return {
    cohort,
    runs,
    stats: statsOf(runs.filter((r) => r.shown).flatMap((r) => r.incidents)),
    otherCohortRuns: all.length - runs.length,
  };
}

export type IncidentFilter = {
  kind: IncidentKind | null;
  severity: IncidentSeverity | null;
  status: IncidentResolutionStatus | null;
};

const pick = <T extends string>(options: readonly T[], value: string | null): T | null =>
  value && (options as readonly string[]).includes(value) ? (value as T) : null;

/** Filters from the query string; unknown values are ignored. */
export function parseFilter(params: URLSearchParams): IncidentFilter {
  return {
    kind: pick(KINDS, params.get("kind")),
    severity: pick(SEVERITIES, params.get("severity")),
    status: pick(STATUSES, params.get("status")),
  };
}

export function matches(i: Incident, f: IncidentFilter): boolean {
  return (
    (!f.kind || i.kind === f.kind) &&
    (!f.severity || i.severity === f.severity) &&
    (!f.status || i.resolution.status === f.status)
  );
}

export const isFiltered = (f: IncidentFilter) => !!(f.kind || f.severity || f.status);

/** The Run page for a run. */
export const runLink = (runId: string) => withRun(recordPath.run(runId), runId);

/** A dashboard link to a related record. */
export type RelatedLink = { key: string; kind: string; label: string; to: string };

/**
 * Links inside the dashboard: the run (or the decision in the run's transcript), the certificate
 * of the belief when the resolution certified it or compiled a guard from it (the Certificates page
 * resolves ?belief= to that certificate), and the approvals desk for held actions.
 */
export function relatedLinks(i: Incident): RelatedLink[] {
  const out: RelatedLink[] = [{ key: "run", kind: "run", label: i.runId, to: runLink(i.runId) }];
  if (i.decisionId)
    out.push({ key: "decision", kind: "decision", label: i.decisionId, to: withRun(recordPath.decision(i.decisionId), i.runId) });
  if (i.beliefId && (i.resolution.action === "certified" || i.resolution.action === "guard_compiled"))
    out.push({ key: "certificate", kind: "certificate", label: i.beliefId, to: withRun(recordPath.belief(i.beliefId), i.runId) });
  if (i.kind === "guard_hold") out.push({ key: "approvals", kind: "approvals", label: "Approvals", to: withRun("/app/approvals", i.runId) });
  return out;
}

/** What the neatlogs cell shows. The URL is only ever the recorded traceUrl, never built here. */
export type TraceCell =
  | { kind: "link"; url: string; traceId?: string; exported: boolean }
  | { kind: "id"; traceId: string; spanId?: string; exported: boolean }
  | { kind: "none" };

export function traceCell(i: Pick<Incident, "traceUrl" | "traceId" | "spanId" | "exported">): TraceCell {
  if (i.traceUrl && /^https?:\/\//i.test(i.traceUrl)) return { kind: "link", url: i.traceUrl, traceId: i.traceId, exported: i.exported };
  if (i.traceId) return { kind: "id", traceId: i.traceId, spanId: i.spanId, exported: i.exported };
  return { kind: "none" };
}

/** "0123abcd…89ef" for long hex ids; the full id stays in the title and the clipboard. */
export const shortId = (id: string, head = 8, tail = 4) => (id.length > head + tail + 1 ? `${id.slice(0, head)}…${id.slice(-tail)}` : id);
