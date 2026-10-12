// Report: pure helpers (no React). Comparisons only within one world; costs only as recorded.
import type { RunBundle } from "../../../../core/src/schema";
import { liveFirst, scenarioKey } from "../../app/links";
import { worldKeyOf } from "../../data/world";

// ---------------------------------------------------------------------------- run comparison

export type ComparisonPair = {
  /** "real:<seed>" or "fixture:<scenario key>". One world per pair, never mixed. */
  world: string;
  sample: boolean;
  naive: RunBundle;
  guarded: RunBundle;
};

const newestFirst = (a: RunBundle, b: RunBundle) => b.startedAt.localeCompare(a.startedAt);

/** The world a queue run belongs to: same seed for real runs, same scenario for fixture runs. */
export function worldOf(b: RunBundle): string {
  return b.sample ? `fixture:${scenarioKey(b.runId)}` : `real:${b.seed}`;
}

/**
 * Naive vs guarded queue runs of the same world: for every world with both variants, the newest
 * guarded run against the newest naive run. Real and fixture runs are never paired.
 */
export function comparisonPairs(bundles: readonly RunBundle[]): ComparisonPair[] {
  const runs = bundles.filter((b) => b.kind === "run" && (b.variant === "naive" || b.variant === "guarded"));
  const worlds = new Map<string, RunBundle[]>();
  for (const b of runs) worlds.set(worldOf(b), [...(worlds.get(worldOf(b)) ?? []), b]);
  const pairs: ComparisonPair[] = [];
  for (const [world, list] of worlds) {
    const sorted = [...list].sort(newestFirst);
    const guarded = sorted.find((b) => b.variant === "guarded");
    const naive = sorted.find((b) => b.variant === "naive");
    if (guarded && naive && guarded.sample === naive.sample) pairs.push({ world, sample: guarded.sample, naive, guarded });
  }
  // Real worlds first, then fixture; newest guarded first within each.
  return pairs.sort((a, b) => Number(a.sample) - Number(b.sample) || newestFirst(a.guarded, b.guarded));
}

/** The pair of the selected run's world, else the first pair (real before fixture). */
export function pickPair(pairs: readonly ComparisonPair[], selected?: RunBundle): ComparisonPair | undefined {
  if (selected) {
    const own = pairs.find((p) => p.world === worldOf(selected) && p.sample === selected.sample);
    if (own) return own;
  }
  return pairs[0];
}

export type MetricFormat = "count" | "ratio";
export type MetricRow = {
  key: string;
  label: string;
  format: MetricFormat;
  /** Larger is worse (unsafe counts): a positive value is shown in red. */
  unsafe?: boolean;
  naive: number | null;
  guarded: number | null;
  /** guarded − naive (counts) or percentage points (ratios); null when either is missing. */
  delta: number | null;
};

/** Metric keys the comparison shows, in order (labels are presentation; values come from bundles). */
export const COMPARISON_METRICS: { key: string; label: string; format: MetricFormat; unsafe?: boolean }[] = [
  { key: "unsafe_actions_total", label: "Unsafe money actions", format: "count", unsafe: true },
  { key: "unsafe_duplicates", label: "Duplicate refunds", format: "count", unsafe: true },
  { key: "unsafe_wrong_unit", label: "Wrong-unit amounts", format: "count", unsafe: true },
  { key: "unsafe_missed_existing_refund", label: "Missed existing refunds", format: "count", unsafe: true },
  { key: "decision_accuracy", label: "Decision accuracy", format: "ratio" },
  { key: "automation_rate", label: "Automation rate", format: "ratio" },
  { key: "items_total", label: "Requests", format: "count" },
  { key: "executed", label: "Executed", format: "count" },
  { key: "holds", label: "Held for a human", format: "count" },
  { key: "escalations", label: "Escalated", format: "count" },
  { key: "denials", label: "Denied", format: "count" },
];

const metric = (b: RunBundle, key: string): number | null => {
  const v = b.metrics[key];
  return typeof v === "number" ? v : null;
};

export function comparisonRows(pair: Pick<ComparisonPair, "naive" | "guarded">): MetricRow[] {
  const rows = COMPARISON_METRICS.map((m) => {
    const naive = metric(pair.naive, m.key);
    const guarded = metric(pair.guarded, m.key);
    const delta =
      naive === null || guarded === null
        ? null
        : m.format === "ratio"
          ? Math.round((guarded - naive) * 1000) / 10
          : guarded - naive;
    return { ...m, naive, guarded, delta };
  });
  rows.push({
    key: "credits",
    label: "Credits used",
    format: "count",
    naive: pair.naive.credits.total,
    guarded: pair.guarded.credits.total,
    delta: pair.guarded.credits.total - pair.naive.credits.total,
  });
  // A metric neither run recorded says nothing; drop it.
  return rows.filter((r) => r.naive !== null || r.guarded !== null);
}

// ---------------------------------------------------------------------------- cost per run

export type Role = keyof RunBundle["usageByRole"];
export const ROLES: Role[] = ["executor", "reflector", "adversary"];

/**
 * none     = the role made no model calls (USD 0 is a fact).
 * recorded = calls with a recorded USD amount.
 * unknown  = calls or tokens with USD 0: no price was known when the run recorded it (the price
 *            source records unknown prices as $0), so the cost is unknown, never $0.
 */
export type PriceState = "none" | "recorded" | "unknown";

export type RoleCost = {
  role: Role;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  price: PriceState;
};

export function roleCosts(b: RunBundle): RoleCost[] {
  return ROLES.map((role) => {
    const u = b.usageByRole[role];
    const used = u.calls > 0 || u.inputTokens + u.outputTokens > 0;
    return {
      role,
      calls: u.calls,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      usd: u.usd,
      price: !used ? "none" : u.usd > 0 ? "recorded" : "unknown",
    };
  });
}

export type RunCost = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of recorded USD (roles with a known price only). */
  recordedUsd: number;
  /** Roles whose price is unknown; the run's total model cost is unknown when any exist. */
  unknownRoles: Role[];
  creditsUsed: number;
  creditsBudget: number;
};

export function runCost(b: RunBundle): RunCost {
  const roles = roleCosts(b);
  return {
    calls: roles.reduce((n, r) => n + r.calls, 0),
    inputTokens: roles.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: roles.reduce((n, r) => n + r.outputTokens, 0),
    recordedUsd: roles.reduce((n, r) => n + (r.price === "recorded" ? r.usd : 0), 0),
    unknownRoles: roles.filter((r) => r.price === "unknown").map((r) => r.role),
    creditsUsed: b.credits.total,
    creditsBudget: b.credits.budget,
  };
}

export type Cohort = "real" | "fixture" | "synthetic";

/** Fixture runs are sample:true demo-world bundles; the synthetic SAMPLE bundle (kind "sample") is
 *  neither real nor fixture and gets its own cohort with its own disclosure. */
export const cohortOf = (b: RunBundle): Cohort => (!b.sample ? "real" : b.kind === "sample" ? "synthetic" : "fixture");

/** Bundles split by cohort (real, fixture, synthetic — in that order); a list never mixes them. */
export function byCohort(bundles: readonly RunBundle[]): { cohort: Cohort; sample: boolean; runs: RunBundle[] }[] {
  return (["real", "fixture", "synthetic"] as const)
    .map((cohort) => ({ cohort, sample: cohort !== "real", runs: bundles.filter((b) => cohortOf(b) === cohort).sort(newestFirst) }))
    .filter((g) => g.runs.length > 0);
}

export type WorldTable = { key: string; cohort: Cohort; label: string; sample: boolean; runs: RunBundle[] };

/**
 * The cost tables: one per data world (real runs; each fixture scenario on its own; the synthetic
 * sample), so no table mixes worlds. Within a table, live recordings come first, then replays.
 */
export function byWorld(bundles: readonly RunBundle[]): WorldTable[] {
  return byCohort(bundles).flatMap((g): WorldTable[] => {
    if (g.cohort !== "fixture")
      return [{ key: g.cohort, cohort: g.cohort, label: g.cohort === "real" ? "Recorded runs" : "Synthetic sample", sample: g.sample, runs: liveFirst(g.runs) }];
    const keys = [...new Set(g.runs.map((b) => worldKeyOf(b)))];
    return keys.map((key) => ({
      key,
      cohort: g.cohort,
      label: `Fixture scenario ${key.replace(/^fixture:/, "")}`,
      sample: true,
      runs: liveFirst(g.runs.filter((b) => worldKeyOf(b) === key)),
    }));
  });
}

// ---------------------------------------------------------------------------- traces

export type TraceRow = { traceId: string; recorded?: string; source: "traceLinks" | "records" };

/**
 * The run's trace receipts: every traceLinks entry as recorded; when there are none, the distinct
 * trace ids its probes and decisions carry (shown as text, no link was recorded).
 */
export function runTraces(b: RunBundle): TraceRow[] {
  const linked = Object.entries(b.traceLinks).map(([traceId, recorded]) => ({
    traceId,
    recorded,
    source: "traceLinks" as const,
  }));
  if (linked.length) return linked;
  const ids = new Set([...b.probes.map((p) => p.traceId), ...b.decisions.map((d) => d.traceId)].filter(Boolean));
  return [...ids].map((traceId) => ({ traceId, source: "records" as const }));
}
