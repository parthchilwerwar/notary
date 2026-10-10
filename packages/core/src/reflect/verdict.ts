/**
 * Verdict rules (TDD "The notarization loop", step 6), exactly as written:
 *
 *  - Uninformative observation (empty result, null, a sweep that saw nothing): "uninformative",
 *    no update in either direction.
 *  - Instrument check: every probe has a control variant; if control and treatment read the same
 *    where they should differ, the probe is "invalid" (no update).
 *  - Confirm a hypothesis only if the observation matches its prediction and contradicts every
 *    rival: exactly one hypothesis matches -> "confirmed", the rivals are refuted.
 *  - Matches more than one rival: "inconclusive", no belief update (nothing refuted).
 *  - All rivals refuted (no hypothesis matches): "refuted" for all, and `needsRepropose` — the
 *    caller re-proposes once, using the refutation as evidence, then abstains.
 *
 * Order: uninformative is decided first (an empty read makes control and treatment trivially
 * equal; that is "saw nothing", not a broken instrument), then the instrument check, then matching.
 */
import { canonicalJson } from "../bundle/hash.js";
import type { ProbeVerdict } from "../schema/index.js";
import { ANY } from "./templates/types.js";
import type { ProbeDesign, ProbeObservation, ProbeTemplateModule } from "./templates/types.js";

export interface VerdictInput {
  hypothesisIds: readonly string[];
  /** hypothesis id -> did the observation match its prediction */
  matches: Readonly<Record<string, boolean>>;
  informative: boolean;
  /** Readings that must differ between control and treatment; null = no such reading. */
  instrument: { treatment: unknown; control: unknown } | null;
}

export interface VerdictResult {
  verdict: ProbeVerdict;
  winningHypothesisId?: string;
  refutedIds: string[];
  needsRepropose: boolean;
  reason: string;
}

export function decideVerdict(input: VerdictInput): VerdictResult {
  const ids = [...input.hypothesisIds];
  if (!input.informative) {
    return { verdict: "uninformative", refutedIds: [], needsRepropose: false, reason: "uninformative observation: no update" };
  }
  if (input.instrument && canonicalJson(input.instrument.treatment ?? null) === canonicalJson(input.instrument.control ?? null)) {
    return {
      verdict: "invalid",
      refutedIds: [],
      needsRepropose: false,
      reason: "instrument check failed: control and treatment read the same where they should differ",
    };
  }
  const matched = ids.filter((id) => input.matches[id] === true);
  if (matched.length === 1) {
    const winner = matched[0]!;
    return {
      verdict: "confirmed",
      winningHypothesisId: winner,
      refutedIds: ids.filter((id) => id !== winner),
      needsRepropose: false,
      reason: `observation matches ${winner} and contradicts every rival`,
    };
  }
  if (matched.length > 1) {
    return {
      verdict: "inconclusive",
      refutedIds: [],
      needsRepropose: false,
      reason: `observation matches ${matched.length} rivals (${matched.join(", ")}): no update`,
    };
  }
  return {
    verdict: "refuted",
    refutedIds: ids,
    needsRepropose: true,
    reason: "observation contradicts every hypothesis: re-propose once, then abstain",
  };
}

/** Apply a template's matches/informative to an observation and decide. */
export function judge(template: ProbeTemplateModule, design: ProbeDesign, observation: ProbeObservation): VerdictResult {
  const ids = Object.keys(design.predictions).sort();
  const matches: Record<string, boolean> = {};
  for (const id of ids) matches[id] = template.matches(design.predictions[id]!, observation);
  const result = decideVerdict({ hypothesisIds: ids, matches, informative: template.informative(observation), instrument: observation.instrument });
  // A hypothesis this template makes no prediction for (outcomes ["*"]) matches every observation.
  // It must never be CONFIRMED by elimination: "confirmed" needs the observation to match the
  // hypothesis's own prediction (found by `notary demo --fixture`; see test/demo.test.ts).
  const winner = result.winningHypothesisId;
  if (result.verdict === "confirmed" && winner && design.predictions[winner]?.outcomes.includes(ANY)) {
    return {
      verdict: "inconclusive",
      refutedIds: [],
      needsRepropose: false,
      reason: `only ${winner} matched, and this template makes no prediction for its class: no update`,
    };
  }
  return result;
}
