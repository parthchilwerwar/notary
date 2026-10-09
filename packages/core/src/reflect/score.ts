/**
 * Greedy, cost-aware probe selection (TDD "The notarization loop", step 4):
 *
 *   score(t) = (rival classes t separates) / (credits(t) + λ · calls(t))
 *
 * "Separates" = the number of hypothesis pairs whose predictions differ under t. Two predictions
 * differ when their outcome sets are not identical and neither is the "*" wildcard (a template
 * that can't speak to a class separates nothing for it).
 * credits(t) = the design's estimated Crustdata credits (ledger-observed per-endpoint costs, else
 * claim.costCredits, else list price; see buildCostModel); calls(t) = its HTTP calls (treatment +
 * control).
 * λ (credits per call) comes from NOTARY_PROBE_LAMBDA; default 1: one HTTP call weighs as much as
 * one Crustdata credit, so a free Dodo or identify call still costs something and an enrich call
 * (2 credits + 1 call) costs 3.
 * Zero cost (only possible with λ = 0 and free calls): score is +Infinity when it separates
 * anything, else 0.
 * Ties (equal score) break deterministically: more pairs separated, then fewer credits, then fewer
 * calls, then template name.
 */
import { canonicalJson } from "../bundle/hash.js";
import { ANY } from "./templates/types.js";
import type { PredictedObservation, ProbeDesign } from "./templates/types.js";

export const DEFAULT_PROBE_LAMBDA = 1;

export function lambdaFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NOTARY_PROBE_LAMBDA?.trim();
  if (!raw) return DEFAULT_PROBE_LAMBDA;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PROBE_LAMBDA;
}

function key(p: PredictedObservation): string {
  return canonicalJson([...p.outcomes].sort());
}

export function predictionsDiffer(a: PredictedObservation, b: PredictedObservation): boolean {
  if (a.outcomes.includes(ANY) || b.outcomes.includes(ANY)) return false;
  return key(a) !== key(b);
}

/** Number of hypothesis pairs whose predictions differ under this design. */
export function separates(predictions: Record<string, PredictedObservation>): number {
  const list = Object.keys(predictions)
    .sort()
    .map((id) => predictions[id]!);
  let n = 0;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (predictionsDiffer(list[i]!, list[j]!)) n++;
  return n;
}

export interface Scored<D extends ProbeDesign = ProbeDesign> {
  design: D;
  separates: number;
  cost: number;
  score: number;
}

export function scoreDesign<D extends ProbeDesign>(design: D, lambda: number): Scored<D> {
  const sep = separates(design.predictions);
  const cost = design.estCredits + lambda * design.estCalls;
  const score = cost > 0 ? sep / cost : sep > 0 ? Number.POSITIVE_INFINITY : 0;
  return { design, separates: sep, cost, score };
}

function compare(a: Scored, b: Scored): number {
  if (a.score !== b.score) return b.score - a.score > 0 ? 1 : -1;
  if (a.separates !== b.separates) return b.separates - a.separates;
  if (a.design.estCredits !== b.design.estCredits) return a.design.estCredits - b.design.estCredits;
  if (a.design.estCalls !== b.design.estCalls) return a.design.estCalls - b.design.estCalls;
  return a.design.template < b.design.template ? -1 : a.design.template > b.design.template ? 1 : 0;
}

/** Designs ranked best-first; designs that separate nothing are dropped. */
export function rankDesigns<D extends ProbeDesign>(designs: readonly D[], lambda: number = lambdaFromEnv()): Scored<D>[] {
  return designs
    .map((d) => scoreDesign(d, lambda))
    .filter((s) => s.separates > 0)
    .sort(compare as (a: Scored<D>, b: Scored<D>) => number);
}
