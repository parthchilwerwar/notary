/**
 * Metric comparison for EVALUATION.md (TDD "Noise floor": a change no larger than the floor is
 * reported as no change).
 *
 * NOTE: src/eval/ (owned by the replay/metrics workstream) has no `compareRuns`; it only has
 * `compareExact` for replay-vs-original, which EVALUATION.md uses for reproducibility. The
 * naive-vs-guarded rule with a noise floor is therefore implemented here. If src/eval gains a
 * compareRuns, switch to it and keep the notes' wording.
 *
 * Notes never contain a number that is not one of the two compared values or the floor, all of
 * which come from bundles (EVALUATION.md must not introduce numbers of its own). Identifiers are
 * wrapped in backticks.
 */

export type Direction = "lower" | "higher" | "none";

/** Which way is better, per metric key. Unknown keys have no preferred direction. */
export function directionOf(key: string): Direction {
  if (/^unsafe_|^items_not_processed$|^unguarded_call_sites$|^probes_to_candidate|^evidence\.invalid$|^adversary\.failed$|^credits|^usd|^false_beliefs/.test(key)) {
    return "lower";
  }
  if (/^decision_accuracy$|^tier_accuracy$|^belief_precision$/.test(key)) return "higher";
  // automation_rate: PRD "Reported honestly, not maximized" — no preferred direction on purpose.
  return "none";
}

export interface Comparison {
  verdict: "no_change" | "lower" | "higher" | "not_comparable";
  wrongWay: boolean;
  note: string;
}

const fmt = (v: number | null | undefined): string => (v === null || v === undefined ? "null" : String(v));

/**
 * Compare `after` (e.g. guarded) to `before` (e.g. naive). `labels` name the two sides in the note.
 */
export function compareValues(opts: {
  key: string;
  before: number | null | undefined;
  after: number | null | undefined;
  floor?: number | undefined;
  labels: [string, string];
  direction?: Direction;
}): Comparison {
  const [lb, la] = opts.labels;
  const { before, after } = opts;
  const dir = opts.direction ?? directionOf(opts.key);
  const pair = `${lb} ${fmt(before)} → ${la} ${fmt(after)}`;
  if (before === null || before === undefined || after === null || after === undefined) {
    return { verdict: "not_comparable", wrongWay: false, note: `not comparable (${pair})` };
  }
  const delta = Math.abs(after - before);
  const floorKnown = opts.floor !== undefined;
  if (after === before || (floorKnown && delta <= opts.floor!)) {
    const why = after === before ? "identical" : `within noise floor ${opts.floor}`;
    return { verdict: "no_change", wrongWay: false, note: `no change (${pair}; ${why})` };
  }
  const verdict = after < before ? "lower" : "higher";
  const wrongWay = dir !== "none" && verdict !== dir;
  let note = `${la} ${verdict} than ${lb} (${pair})`;
  if (dir !== "none") note += wrongWay ? " — WENT THE WRONG WAY" : " — better";
  if (!floorKnown) note += "; noise floor unknown, so not yet a claimed improvement";
  return { verdict, wrongWay, note };
}
