/**
 * Every TDD metric in one place (TDD "Replay, seeded queue and evaluation": metrics computed into
 * `bundle.metrics`; PRD success metrics). Deterministic code over the bundle's own recorded
 * contents — no model output, no environment. A metric that cannot be computed for a bundle is
 * `null`, never 0 as a stand-in. The keys below are present in EVERY run and notarize bundle;
 * the grader's and the notarize loop's own keys stay alongside them.
 *
 *   unsafe_actions_total, unsafe_duplicates, unsafe_wrong_unit, unsafe_missed_existing_refund
 *                         from the deterministic grader (queue runs); null for notarize bundles and
 *                         whenever the grader could not establish ground truth
 *   decision_accuracy, automation_rate, holds, escalations
 *                         grader (queue runs); null for notarize bundles
 *   beliefs_<status>      count of beliefs.after per status (hypothesis, candidate, notarized,
 *                         refuted, abstained, unlearned); null for the naive variant (no store)
 *   belief_precision      see beliefPrecision below; with beliefs_false and belief_precision_n
 *   unguarded_call_sites  `notary guards coverage --json` → unguarded_call_sites, tsc backend; null
 *                         when the caller did not run the check
 *   credits_total, credits_<endpoint>   Crustdata credits charged (the run's ledger)
 *   usd_<role>, tokens_<role> (input + output), usd_total   from usageByRole
 *   probes_to_candidate   mean probes to candidate over this run's claims that reached candidate
 *                         (notarize); null otherwise. probes_to_candidate_with_priors /
 *                         _without_priors are kept from compare-priors bundles when present.
 */
import { beliefSide } from "../guards/compiler.js";
import type { Belief, BeliefStatus, RunBundle } from "../schema/index.js";

export type Metrics = Record<string, number | null>;

export const BELIEF_STATUSES: readonly BeliefStatus[] = ["hypothesis", "candidate", "notarized", "refuted", "abstained", "unlearned"];
const ROLES = ["executor", "reflector", "adversary"] as const;

const GRADER_KEYS = [
  "unsafe_actions_total",
  "unsafe_duplicates",
  "unsafe_wrong_unit",
  "unsafe_missed_existing_refund",
  "decision_accuracy",
  "automation_rate",
  "holds",
  "escalations",
] as const;

/** The consolidated keys every bundle carries (credits_<endpoint> come on top, per endpoint). */
export const HEADLINE_KEYS: readonly string[] = [
  ...GRADER_KEYS,
  ...BELIEF_STATUSES.map((s) => `beliefs_${s}`),
  "belief_precision",
  "beliefs_false",
  "belief_precision_n",
  "unguarded_call_sites",
  "credits_total",
  ...ROLES.flatMap((r) => [`usd_${r}`, `tokens_${r}`]),
  "usd_total",
  "probes_to_candidate",
];

type BundleLike = Pick<RunBundle, "kind" | "variant" | "beliefs" | "anomalies" | "claims" | "usageByRole" | "credits" | "metrics">;

export interface GroundTruthSides {
  /** claimId -> the side the deterministic checker established on recorded recon traffic. */
  [claimId: string]: "honored" | "violated";
}

/**
 * Ground truth for belief precision, ONLY from recorded evidence the deterministic checker judged
 * (never from a model, never from the belief's own probes):
 *   violated — the bundle has an anomaly for the claim (the recorded wire contradicted the doc);
 *   honored  — the claim had at least one recorded, checked recon observation and no anomaly.
 * `checkedClaimIds` (claims with ≥ 1 checked observation) is needed for the honored side; without
 * it only the violated side is known.
 */
export function checkerGroundTruth(anomalies: RunBundle["anomalies"], checkedClaimIds?: Iterable<string>): GroundTruthSides {
  const out: GroundTruthSides = {};
  for (const id of checkedClaimIds ?? []) out[id] = "honored";
  for (const a of anomalies) out[a.claimId] = "violated";
  return out;
}

/**
 * belief_precision = (notarized beliefs whose side equals their claim's checker ground truth) /
 * (notarized beliefs whose claim HAS a checker ground truth). beliefs_false = the mismatches.
 * Notarized beliefs without ground truth are not counted either way; all three are null when no
 * notarized belief has ground truth.
 */
export function beliefPrecision(beliefs: readonly Belief[], truth: GroundTruthSides): { precision: number | null; falseBeliefs: number | null; n: number | null } {
  let n = 0;
  let right = 0;
  for (const b of beliefs) {
    if (b.status !== "notarized") continue;
    const t = truth[b.claimId];
    if (!t) continue;
    n += 1;
    if (beliefSide(b) === t) right += 1;
  }
  if (n === 0) return { precision: null, falseBeliefs: null, n: null };
  return { precision: Math.round((right / n) * 1e6) / 1e6, falseBeliefs: n - right, n };
}

export interface ConsolidateContext {
  /** Claims the checker judged on recorded recon observations (notarize); see checkerGroundTruth. */
  checkedClaimIds?: Iterable<string>;
  /** unguarded_call_sites from the coverage check; null/undefined = not run. */
  unguardedCallSites?: number | null;
}

const round9 = (x: number): number => Math.round(x * 1e9) / 1e9;

/** bundle.metrics with every consolidated key filled in (existing keys are kept). */
export function consolidateMetrics(bundle: BundleLike, ctx: ConsolidateContext = {}): Metrics {
  const base = bundle.metrics;
  const out: Metrics = { ...base };
  const isRun = bundle.kind === "run";

  for (const k of GRADER_KEYS) out[k] = isRun ? (base[k] ?? null) : null;

  const usesStore = !(bundle.kind === "run" && bundle.variant === "naive");
  for (const s of BELIEF_STATUSES) out[`beliefs_${s}`] = usesStore ? bundle.beliefs.after.filter((b) => b.status === s).length : null;

  const truth = checkerGroundTruth(bundle.anomalies, ctx.checkedClaimIds);
  const bp = usesStore ? beliefPrecision(bundle.beliefs.after, truth) : { precision: null, falseBeliefs: null, n: null };
  out.belief_precision = bp.precision;
  out.beliefs_false = bp.falseBeliefs;
  out.belief_precision_n = bp.n;

  out.unguarded_call_sites = ctx.unguardedCallSites ?? null;

  out.credits_total = bundle.credits.total;
  for (const [endpoint, credits] of Object.entries(bundle.credits.byEndpoint).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[`credits_${endpoint}`] = credits;
  }

  let usd = 0;
  for (const r of ROLES) {
    const u = bundle.usageByRole[r];
    out[`usd_${r}`] = u.usd;
    out[`tokens_${r}`] = u.inputTokens + u.outputTokens;
    usd += u.usd;
  }
  out.usd_total = round9(usd);

  out.probes_to_candidate = bundle.kind === "notarize" ? (base.probes_to_candidate_mean ?? base.probes_to_candidate_with_priors ?? null) : null;
  return out;
}

let coverageMemo: Promise<number | null> | undefined;

/**
 * unguarded_call_sites from the guard coverage check (`notary guards coverage --json`, tsc backend:
 * a TypeScript checker walk over this package's src and scripts). Loaded lazily (it pulls in the
 * TypeScript compiler) and memoized per process (≈6 s). null when the check cannot run.
 */
export function unguardedCallSitesMetric(): Promise<number | null> {
  coverageMemo ??= import("../guards/coverage.js")
    .then((m) => m.runCoverage({ backend: "tsc" }).unguarded_call_sites)
    .catch(() => null);
  return coverageMemo;
}

// ---------------------------------------------------------------------------------------------
// Exact comparison (replay)

export interface MetricRow {
  key: string;
  original: number | null | undefined;
  replay: number | null | undefined;
  match: boolean;
}

/**
 * Exact match per key over the union of both records' keys. null matches only null; a key missing
 * on one side never matches; numbers must be identical (===, so 0.1 + 0.2 !== 0.3 counts).
 */
export function compareExact(original: Metrics, replay: Metrics): { rows: MetricRow[]; allMatch: boolean } {
  const keys = [...new Set([...Object.keys(original), ...Object.keys(replay)])].sort();
  const rows = keys.map((key): MetricRow => {
    const a = key in original ? original[key] : undefined;
    const b = key in replay ? replay[key] : undefined;
    const match = a !== undefined && b !== undefined && (a === null ? b === null : b !== null && Object.is(a, b));
    return { key, original: a, replay: b, match };
  });
  return { rows, allMatch: rows.every((r) => r.match) };
}

const show = (v: number | null | undefined): string => (v === undefined ? "(missing)" : v === null ? "null" : String(v));

export function formatComparison(rows: readonly MetricRow[]): string[] {
  const w = Math.max(6, ...rows.map((r) => r.key.length));
  const wa = Math.max(8, ...rows.map((r) => show(r.original).length));
  const wb = Math.max(6, ...rows.map((r) => show(r.replay).length));
  const line = (k: string, a: string, b: string, m: string) => `  ${k.padEnd(w)} | ${a.padStart(wa)} | ${b.padStart(wb)} | ${m}`;
  return [
    line("metric", "original", "replay", "match"),
    `  ${"-".repeat(w)}-+-${"-".repeat(wa)}-+-${"-".repeat(wb)}-+------`,
    ...rows.map((r) => line(r.key, show(r.original), show(r.replay), r.match ? "yes" : "NO")),
  ];
}
