/**
 * Unit economics from REAL run bundles: pure, deterministic code over the bundles' own recorded
 * usage, credits and grader metrics. Same input, identical output (no clock, no environment, no
 * model). A figure that cannot be computed is null with the reason, never 0 as a stand-in.
 *
 * Rules (each also written into the output as `basis`, so the page can say how a number was made):
 *   - costs come from LIVE bundles only; a replay re-reads cassettes and spends nothing new, so
 *     counting it would understate the cost per run
 *   - Crustdata credits have no USD price (DECISIONS #167): credits and model USD stay separate
 *   - unsafe actions prevented = naive minus guarded `unsafe_actions_total` of the newest live
 *     naive and guarded queue runs of the same world (seed), summed over worlds
 *   - cost per notarized belief = all live notarize spend / distinct notarized beliefs in each
 *     tool's newest full notarize bundle (beliefs persist across runs, so they are not summed)
 *   - cost per certificate = the same spend / certified claims in public/certificates/report.json,
 *     only when every bundle that report counted is among the real bundles here (else stale)
 */
import { classify } from "../export/collect.js";
import type { CertificateReport } from "../schema/certificate.js";
import type { RunBundle, Tool } from "../schema/index.js";
import type {
  CfoPlan,
  EconomicsCombined,
  EconomicsComputed,
  EconomicsPair,
  EconomicsRatio,
  EconomicsRun,
  EconomicsTool,
} from "../schema/economics.js";

const ROLES = ["executor", "reflector", "adversary"] as const;
const TOOLS: readonly Tool[] = ["crustdata", "dodo"];

/** Sums of float USD rounded to 1e-9 so binary noise never reaches the file (still deterministic). */
const round = (n: number): number => Math.round(n * 1e9) / 1e9;
const sum = (xs: readonly number[]): number => round(xs.reduce((a, b) => a + b, 0));

const byStart = (x: { startedAt: string; runId: string }, y: { startedAt: string; runId: string }): number =>
  Date.parse(x.startedAt) - Date.parse(y.startedAt) || (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0);

const metric = (b: RunBundle, key: string): number | null => {
  const v = b.metrics[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

function notarizedIds(b: RunBundle): string[] {
  return [...new Set(b.beliefs.after.filter((x) => x.status === "notarized").map((x) => x.id))].sort();
}

export function economicsRun(b: RunBundle): EconomicsRun {
  if (b.kind === "sample" || b.variant === "sample" || b.sample) throw new Error(`economicsRun: ${b.runId} is a sample bundle`);
  const usdByRole = { executor: round(b.usageByRole.executor.usd), reflector: round(b.usageByRole.reflector.usd), adversary: round(b.usageByRole.adversary.usd) };
  const creditsByEndpoint = Object.fromEntries(Object.entries(b.credits.byEndpoint).sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0)));
  return {
    runId: b.runId,
    contentHash: b.contentHash,
    kind: b.kind,
    variant: b.variant as EconomicsRun["variant"],
    mode: b.mode,
    tool: b.tool ?? null,
    seed: b.seed,
    startedAt: b.startedAt,
    status: b.status,
    modelUsd: sum(ROLES.map((r) => usdByRole[r])),
    usdByRole,
    tokens: ROLES.reduce((n, r) => n + b.usageByRole[r].inputTokens + b.usageByRole[r].outputTokens, 0),
    credits: round(b.credits.total),
    creditsByEndpoint,
    unsafeActions: b.kind === "run" ? metric(b, "unsafe_actions_total") : null,
    holds: b.kind === "run" ? metric(b, "holds") : null,
    beliefsNotarized: b.kind === "notarize" ? notarizedIds(b).length : null,
  };
}

function ratio(usdTotal: number, creditsTotal: number, denominator: number | null, basis: string, reasonIfNone: string): EconomicsRatio {
  if (denominator === null || denominator === 0) return { usd: null, credits: null, basis, reason: reasonIfNone };
  return { usd: round(usdTotal / denominator), credits: round(creditsTotal / denominator), basis, reason: null };
}

export interface ComputeInput {
  /** Verified, real (sample:false) run/notarize bundles. Drift fixtures must already be removed. */
  bundles: readonly RunBundle[];
  /** public/certificates/report.json when it exists and is real; null otherwise. */
  certificates: CertificateReport | null;
}

/** null + reason when there are no real bundles; otherwise every computed figure. */
export function computeEconomics(input: ComputeInput): { computed: EconomicsComputed | null; computedReason: string | null } {
  const bundles = [...input.bundles].sort(byStart);
  for (const b of bundles) if (b.sample || b.kind === "sample") throw new Error(`computeEconomics: ${b.runId} is a sample bundle; fixtures are never a source`);
  if (!bundles.length)
    return {
      computed: null,
      computedReason:
        "No real run bundles yet (sample:false). Run `pnpm notary notarize --tool dodo` and `pnpm notary run --queue …` live, then `pnpm notary economics`. Fixture runs are never counted.",
    };

  const runs = bundles.map(economicsRun);
  const live = runs.filter((r) => r.mode === "live");
  const liveBundles = bundles.filter((b) => b.mode === "live");

  const usdByRole = { executor: sum(live.map((r) => r.usdByRole.executor)), reflector: sum(live.map((r) => r.usdByRole.reflector)), adversary: sum(live.map((r) => r.usdByRole.adversary)) };
  const endpoints = [...new Set(live.flatMap((r) => Object.keys(r.creditsByEndpoint)))].sort();
  const creditsByEndpoint = Object.fromEntries(endpoints.map((e) => [e, sum(live.map((r) => r.creditsByEndpoint[e] ?? 0))]));
  const totals = {
    runs: runs.length,
    liveRuns: live.length,
    replayRuns: runs.length - live.length,
    modelUsd: sum(live.map((r) => r.modelUsd)),
    credits: sum(live.map((r) => r.credits)),
    tokens: live.reduce((n, r) => n + r.tokens, 0),
  };

  const costPerRun = ratio(
    totals.modelUsd,
    totals.credits,
    live.length,
    "Model USD (executor + reflector + adversary) and Crustdata credits summed over live real bundles, divided by the number of live bundles. Replays are excluded: they spend nothing new.",
    "No live real bundle yet: replays spend nothing, so there is no cost per run to show.",
  );

  // --- notarize spend per tool and what it bought
  const certByTool = new Map<Tool, number>();
  let certReason: string | null = null;
  if (!input.certificates) certReason = "No real certificates report (public/certificates/report.json). Run `pnpm notary export --certificates`.";
  else if (input.certificates.sample) certReason = "The certificates report is fixture data and is never counted.";
  else {
    const have = new Set(bundles.map((b) => `${b.runId}@${b.contentHash}`));
    const counted = new Set(input.certificates.sourceBundles.map((s) => `${s.runId}@${s.contentHash}`));
    const missing = input.certificates.sourceBundles.filter((s) => !have.has(`${s.runId}@${s.contentHash}`));
    // The newest full notarize bundle of each tool is what certificates are issued from; a report
    // that did not count it predates it.
    const newer = TOOLS.flatMap((tool) => {
      const newest = bundles.filter((b) => b.kind === "notarize" && b.tool === tool && classify(b) === "notarize-full").at(-1);
      return newest && !counted.has(`${newest.runId}@${newest.contentHash}`) ? [newest.runId] : [];
    });
    if (missing.length)
      certReason = `The certificates report counted bundles that are not among the real bundles here (${missing.map((m) => m.runId).join(", ")}). Re-run \`pnpm notary export --certificates\`.`;
    else if (newer.length)
      certReason = `The certificates report predates ${newer.join(", ")}. Re-run \`pnpm notary export --certificates\`, then \`pnpm notary economics\`.`;
    else for (const t of input.certificates.tools) certByTool.set(t.tool, t.counts.certified);
  }

  const tools: EconomicsTool[] = TOOLS.flatMap((tool) => {
    const own = liveBundles.filter((b) => b.kind === "notarize" && b.tool === tool);
    const fulls = bundles.filter((b) => b.kind === "notarize" && b.tool === tool && classify(b) === "notarize-full");
    const newest = fulls[fulls.length - 1];
    const certified = certReason === null ? certByTool.get(tool) ?? 0 : null;
    if (!own.length && !newest && !certified) return [];
    const modelUsd = sum(own.map((b) => economicsRun(b).modelUsd));
    return [
      {
        tool,
        runs: own.length,
        modelUsd,
        credits: sum(own.map((b) => b.credits.total)),
        notarizedBeliefs: newest ? notarizedIds(newest).length : null,
        certified,
        costPerCertificateUsd: certified ? round(modelUsd / certified) : null,
      },
    ];
  });
  const notarizeUsd = sum(tools.map((t) => t.modelUsd));
  const notarizeCredits = sum(tools.map((t) => t.credits));
  const notarizeRuns = tools.reduce((n, t) => n + t.runs, 0);
  const beliefs = tools.some((t) => t.notarizedBeliefs !== null) ? tools.reduce((n, t) => n + (t.notarizedBeliefs ?? 0), 0) : null;

  const costPerNotarizedBelief = ratio(
    notarizeUsd,
    notarizeCredits,
    notarizeRuns ? beliefs : null,
    "Model USD and credits of every live notarize bundle, divided by the distinct notarized beliefs in each tool's newest full notarize bundle (beliefs persist across runs, so they are counted once).",
    !notarizeRuns ? "No live notarize bundle yet." : beliefs === null ? "No full notarize bundle yet, so no belief has been notarized." : "No belief is notarized yet.",
  );

  const certified = certReason === null ? [...certByTool.values()].reduce((a, b) => a + b, 0) : null;
  const costPerCertificate = ratio(
    notarizeUsd,
    notarizeCredits,
    notarizeRuns ? certified : null,
    "The same live notarize spend, divided by the certified claims in public/certificates/report.json (only when that report counted exactly bundles found here).",
    certReason ?? (!notarizeRuns ? "No live notarize bundle yet." : "No certificate is issued yet (certified = 0)."),
  );

  // --- naive vs guarded: prevented and held, per world (seed), newest live pair
  const queueRuns = liveBundles.filter((b) => b.kind === "run" && (b.variant === "naive" || b.variant === "guarded"));
  const seeds = [...new Set(queueRuns.map((b) => b.seed))].sort((a, b) => a - b);
  const pairs: EconomicsPair[] = seeds.flatMap((seed) => {
    const world = queueRuns.filter((b) => b.seed === seed);
    const naive = world.filter((b) => b.variant === "naive").at(-1);
    const guarded = world.filter((b) => b.variant === "guarded").at(-1);
    if (!naive || !guarded) return [];
    const naiveUnsafe = metric(naive, "unsafe_actions_total");
    const guardedUnsafe = metric(guarded, "unsafe_actions_total");
    return [
      {
        seed,
        naiveRunId: naive.runId,
        guardedRunId: guarded.runId,
        naiveUnsafe,
        guardedUnsafe,
        prevented: naiveUnsafe !== null && guardedUnsafe !== null ? naiveUnsafe - guardedUnsafe : null,
        held: metric(guarded, "holds"),
      },
    ];
  });
  const prevented = pairs.filter((p) => p.prevented !== null);
  const held = pairs.filter((p) => p.held !== null);
  const noPair = "No world has both a live naive and a live guarded queue run yet. Run `pnpm notary run --queue <file> --naive` and `pnpm notary run --queue <file>` with the same seed.";

  return {
    computedReason: null,
    computed: {
      runs,
      totals,
      usdByRole,
      creditsByEndpoint,
      costPerRun,
      costPerNotarizedBelief,
      costPerCertificate,
      tools,
      pairs,
      unsafeActionsPrevented: {
        value: prevented.length ? prevented.reduce((n, p) => n + p.prevented!, 0) : null,
        basis: "Grader `unsafe_actions_total`, naive minus guarded, newest live pair per world (seed), summed over worlds.",
        reason: prevented.length ? null : pairs.length ? "The grader could not establish ground truth for any pair (unsafe_actions_total is null)." : noPair,
      },
      heldActions: {
        value: held.length ? held.reduce((n, p) => n + p.held!, 0) : null,
        basis: "Grader `holds` of the guarded run in each pair: money actions held for a person instead of executed.",
        reason: held.length ? null : pairs.length ? "The guarded runs recorded no holds metric." : noPair,
      },
    },
  };
}

/**
 * Figures that need both sources. Only one today: unsafe actions prevented (computed) × the plan's
 * `cost_per_incident` figure (as exported). null unless both exist.
 */
export function combine(computed: EconomicsComputed | null, plan: CfoPlan | null): EconomicsCombined {
  const prevented = computed?.unsafeActionsPrevented.value ?? null;
  const perIncident = plan?.figures.find((f) => f.key === "cost_per_incident");
  if (prevented === null || !perIncident) return { incidentsPreventedValue: null };
  return {
    incidentsPreventedValue: {
      value: round(prevented * perIncident.value),
      unit: perIncident.unit,
      basis: `${prevented} unsafe actions prevented (grader, real runs) × cost per incident ${perIncident.value} ${perIncident.unit} (cfo.ai plan, "${perIncident.label}").`,
    },
  };
}
