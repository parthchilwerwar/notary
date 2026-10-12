// Pure data-world helpers shared by the provider, the shell and tests. No React here.
import type { BundleIndexEntry, RunBundle } from "../../../core/src/schema";
import type { Certificate } from "../../../core/src/schema";
import type { CatalogOrigin as DataSource } from "../data";

/**
 * Live     = the data layer is in live mode (a local `notary serve` answered /api/health) and the selected run is real.
 * Recorded = real published bundles from static files.
 * Fixture  = the selected run is fixture data (bundle.sample), wherever it came from.
 */
export type DataMode = "live" | "recorded" | "fixture";

export function resolveDataMode(
  source: DataSource,
  selected?: Pick<BundleIndexEntry, "sample">,
): DataMode {
  if (selected?.sample) return "fixture";
  return source === "api" ? "live" : "recorded";
}

/**
 * `?fixtures=1`: the development-only view of the fixture runs (bundles/fixture, sample: true).
 * Without it the dashboard and the landing show real runs only, and an empty state when none is
 * published; with it they show fixture runs only, under the fixture disclosure. Never both at once.
 */
export const FIXTURES_PARAM = "fixtures";

/** True when a query string (or URLSearchParams) asks for the fixture view. */
export function fixturesRequested(search: string | URLSearchParams | null | undefined): boolean {
  if (!search) return false;
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get(FIXTURES_PARAM) === "1";
}

/** The fixture flag of the page the browser is on (false outside a browser). */
export const fixturesInLocation = (): boolean => fixturesRequested(globalThis.location?.search);

/**
 * The runs a view may show. Default: real runs only (live ones still running included). With the
 * fixture flag: finished fixture runs only. A fixture run is never shown without the flag, and a
 * real run is never mixed into the fixture view.
 */
export function visibleRuns<T extends { sample?: boolean; state?: string }>(entries: readonly T[], fixtures: boolean): T[] {
  return entries.filter((e) => {
    const sample = e.state === "running" ? false : !!e.sample;
    return fixtures ? sample && e.state !== "running" : !sample;
  });
}

/** The empty state's next step when no real run is published. */
export const NO_RUNS_COMMANDS = ["pnpm notary notarize --tool crustdata", "pnpm notary export"] as const;

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

/**
 * Run picker sections: real runs first, then recorded fixtures. Fixture and real runs are never in
 * the same section. Empty sections are dropped.
 */
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
      ? { kind: "live", label: "Live runs", runs: real }
      : { kind: "recorded", label: "Recorded runs", runs: real },
    {
      kind: "fixture",
      label: "Fixture runs",
      runs: fixture,
    },
  ];
  return groups.filter((g) => g.runs.length > 0);
}

/**
 * Default selection: a guarded queue run, preferring real data; else the newest run. Within a
 * cohort, live recordings come before their replays (a replay re-serves cassettes and carries
 * fewer events).
 */
export function defaultRunId(
  entries: Pick<BundleIndexEntry, "runId" | "sample" | "kind" | "variant" | "startedAt" | "mode">[],
): string | undefined {
  const sorted = [...entries].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  const real = sorted.some((e) => !e.sample)
    ? sorted.filter((e) => !e.sample)
    : sorted;
  const cohort = [...real.filter((e) => e.mode !== "replay"), ...real.filter((e) => e.mode === "replay")];
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
        // Fixture scenarios share a runId prefix; prefer the same scenario.
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

/**
 * `/app/...` path with the selected run (and optional extra params) in the query string. A query
 * already in `path` is kept (its `run` wins, so a record path can pin the run it belongs to).
 */
export function withRun(
  path: string,
  runId: string | undefined,
  extra: Record<string, string | undefined> = {},
): string {
  const [base, query = ""] = path.split("?", 2) as [string, string?];
  const own = new URLSearchParams(query);
  const params = new URLSearchParams();
  const run = own.get("run") ?? runId;
  if (run) params.set("run", run);
  for (const [k, v] of own) if (k !== "run") params.set(k, v);
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  // The development-only fixture view stays on while navigating inside the dashboard.
  if (fixturesInLocation() && !params.has(FIXTURES_PARAM)) params.set(FIXTURES_PARAM, "1");
  const q = params.toString();
  return q ? `${base}?${q}` : base;
}

/**
 * Where each record kind is shown. Decisions and probes live in the Run page's transcript
 * (`?decision=` / `?probe=` focus the record); beliefs and claims live with their certificates;
 * certificates have their own page.
 */
export const recordPath = {
  decision: (id: string) => keepView(`/app/run?decision=${encodeURIComponent(id)}`),
  probe: (id: string) => keepView(`/app/run?probe=${encodeURIComponent(id)}`),
  belief: (id: string) => keepView(`/app/certificates?belief=${encodeURIComponent(id)}`),
  certificate: (id: string) => keepView(`/app/certificates/${encodeURIComponent(id)}`),
  run: (id: string) => keepView(`/app/run?run=${encodeURIComponent(id)}`),
  report: (tool: string) => keepView(`/app/certificates?tool=${encodeURIComponent(tool)}`),
};

/** Keep the development-only fixture view (`?fixtures=1`) on a dashboard path when it is on now. */
export function keepView(path: string): string {
  if (!fixturesInLocation() || /[?&]fixtures=1(&|$)/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${FIXTURES_PARAM}=1`;
}

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
