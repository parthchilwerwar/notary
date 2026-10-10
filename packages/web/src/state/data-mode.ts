// Pure data-world helpers shared by the provider, the shell and tests. No React here.
import type { BundleIndexEntry, RunBundle } from "../../../core/src/schema";
import type { Certificate } from "../../../core/src/schema";
import type { DataSource } from "../data";

/**
 * Live     = a local `notary serve` answered at /api/bundles and the selected run is real.
 * Recorded = real published bundles from static files.
 * Fixture  = the selected run is sample data (simulated APIs), wherever it came from.
 */
export type DataMode = "live" | "recorded" | "fixture";

export function resolveDataMode(
  source: DataSource,
  selected?: Pick<BundleIndexEntry, "sample">,
): DataMode {
  if (selected?.sample) return "fixture";
  return source === "api" ? "live" : "recorded";
}

export const MODE_LABEL: Record<DataMode, string> = {
  live: "Live",
  recorded: "Recorded",
  fixture: "Fixture",
};

export type RunGroup = {
  kind: "live" | "recorded" | "fixture";
  label: string;
  runs: BundleIndexEntry[];
};

/** Run picker sections. Fixture and real runs are never in the same section. Empty sections are dropped. */
export function groupRuns(
  entries: BundleIndexEntry[],
  source: DataSource,
): RunGroup[] {
  const sorted = [...entries].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  const real = sorted.filter((e) => !e.sample);
  const fixture = sorted.filter((e) => e.sample);
  const groups: RunGroup[] = [
    source === "api"
      ? { kind: "live", label: "Live runs (local API)", runs: real }
      : { kind: "recorded", label: "Recorded runs", runs: real },
    {
      kind: "fixture",
      label: "Fixture runs (simulated APIs)",
      runs: fixture,
    },
  ];
  return groups.filter((g) => g.runs.length > 0);
}

/** Default selection: a guarded queue run, preferring real data; else the newest run. */
export function defaultRunId(
  entries: Pick<BundleIndexEntry, "runId" | "sample" | "kind" | "variant" | "startedAt">[],
): string | undefined {
  const sorted = [...entries].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  const cohort = sorted.some((e) => !e.sample)
    ? sorted.filter((e) => !e.sample)
    : sorted;
  return (
    cohort.find((e) => e.kind === "run" && e.variant === "guarded") ??
    cohort[0]
  )?.runId;
}

/** Same-cohort baseline candidates (fixture with fixture, real with real), never the run itself. */
export function baselineCandidates(
  bundle: RunBundle | undefined,
  bundles: RunBundle[],
): RunBundle[] {
  if (!bundle) return [];
  return bundles.filter(
    (b) => b.runId !== bundle.runId && b.sample === bundle.sample,
  );
}

export function pickBaseline(
  bundle: RunBundle | undefined,
  bundles: RunBundle[],
  requested: string | null,
): RunBundle | undefined {
  const candidates = baselineCandidates(bundle, bundles);
  return (
    candidates.find((b) => b.runId === requested) ??
    candidates.find(
      (b) =>
        b.kind === "run" &&
        b.variant === (bundle?.variant === "naive" ? "guarded" : "naive") &&
        // Fixture scenarios share a runId prefix; prefer the same simulated world.
        scenarioKey(b.runId) === scenarioKey(bundle!.runId),
    ) ??
    candidates.find(
      (b) =>
        b.kind === "run" &&
        b.variant === (bundle?.variant === "naive" ? "guarded" : "naive"),
    ) ??
    candidates.find((b) => b.kind === bundle?.kind) ??
    candidates[0]
  );
}

/** Runs whose ids differ only in their trailing kind/variant share a key ("demo-change-api"). */
export function scenarioKey(runId: string): string {
  return runId.replace(/-(run|notarize)-[a-z]+$/, "");
}

export const heldCount = (bundle?: RunBundle) =>
  bundle ? bundle.decisions.filter((d) => d.status === "held").length : 0;

/** `/app/...` path with the selected run (and optional extra params) in the query string. */
export function withRun(
  path: string,
  runId: string | undefined,
  extra: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams();
  if (runId) params.set("run", runId);
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

export const recordPath = {
  decision: (id: string) => `/app/queue/${encodeURIComponent(id)}`,
  probe: (id: string) => `/app/probes/${encodeURIComponent(id)}`,
  belief: (id: string) => `/app/beliefs/${encodeURIComponent(id)}`,
  certificate: (id: string) => `/app/certificates/${encodeURIComponent(id)}`,
  run: (id: string) => `/app/runs/${encodeURIComponent(id)}`,
  report: (tool: string) => `/app/reports/${encodeURIComponent(tool)}`,
};

export type PaletteEntry = {
  group: "Decisions" | "Probes" | "Beliefs" | "Certificates";
  id: string;
  label: string;
  hint: string;
  path: string;
};

/** Command-palette records for the selected run, all derived from its bundle (and its certificate world). */
export function paletteEntries(
  bundle: RunBundle | undefined,
  certificates: Certificate[] = [],
): PaletteEntry[] {
  if (!bundle) return [];
  const beliefs = new Map(
    [...bundle.beliefs.before, ...bundle.beliefs.after].map((b) => [b.id, b]),
  );
  return [
    ...bundle.decisions.map((d) => ({
      group: "Decisions" as const,
      id: d.id,
      label: `${d.requestId} · ${d.requestType.replaceAll("_", " ")}`,
      hint: `${d.status} · ${d.customerId}`,
      path: withRun(recordPath.decision(d.id), bundle.runId),
    })),
    ...bundle.probes.map((p) => ({
      group: "Probes" as const,
      id: p.id,
      label: `${p.id} · ${p.template.replaceAll("_", " ")}`,
      hint: `${p.verdict ?? "pending"} · ${p.claimId}`,
      path: withRun(recordPath.probe(p.id), bundle.runId),
    })),
    ...[...beliefs.values()].map((b) => ({
      group: "Beliefs" as const,
      id: b.id,
      label: b.statement,
      hint: `${b.status} · ${b.claimId}`,
      path: withRun(recordPath.belief(b.id), bundle.runId),
    })),
    ...certificates.map((c) => ({
      group: "Certificates" as const,
      id: c.id,
      label: `${c.claimId} · ${c.verdict}`,
      hint: `${c.status} · ${c.tool}`,
      path: withRun(recordPath.certificate(c.id), bundle.runId),
    })),
  ];
}
