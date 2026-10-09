import { describe, expect, it } from "vitest";
import { decideVerdict, judge } from "../src/reflect/verdict.js";
import { unitRoundtrip } from "../src/reflect/templates/index.js";
import type { ProbeDesign, ProbeObservation } from "../src/reflect/templates/index.js";

const IDS = ["hyp-a", "hyp-b", "hyp-c"];

function input(matches: Record<string, boolean>, over: Partial<Parameters<typeof decideVerdict>[0]> = {}) {
  return {
    hypothesisIds: IDS,
    matches,
    informative: true,
    instrument: { treatment: 1234, control: 2468 },
    ...over,
  };
}

describe("verdict rules (TDD step 6)", () => {
  it("confirms a hypothesis only when it matches and every rival is contradicted", () => {
    const v = decideVerdict(input({ "hyp-a": false, "hyp-b": true, "hyp-c": false }));
    expect(v.verdict).toBe("confirmed");
    expect(v.winningHypothesisId).toBe("hyp-b");
    expect(v.refutedIds).toEqual(["hyp-a", "hyp-c"]);
    expect(v.needsRepropose).toBe(false);
  });

  it("matches more than one rival -> inconclusive, no update (nothing refuted, no winner)", () => {
    const v = decideVerdict(input({ "hyp-a": true, "hyp-b": true, "hyp-c": false }));
    expect(v.verdict).toBe("inconclusive");
    expect(v.winningHypothesisId).toBeUndefined();
    expect(v.refutedIds).toEqual([]);
    expect(v.needsRepropose).toBe(false);
  });

  it("uninformative observation -> uninformative, no update in either direction", () => {
    // Even a would-be confirmation or a would-be total refutation does nothing.
    for (const matches of [{ "hyp-a": true }, {}] as Array<Record<string, boolean>>) {
      const v = decideVerdict(input(matches, { informative: false }));
      expect(v.verdict).toBe("uninformative");
      expect(v.refutedIds).toEqual([]);
      expect(v.winningHypothesisId).toBeUndefined();
      expect(v.needsRepropose).toBe(false);
    }
  });

  it("instrument check: control equal to treatment where they should differ -> invalid", () => {
    const v = decideVerdict(input({ "hyp-a": true, "hyp-b": false, "hyp-c": false }, { instrument: { treatment: 1234, control: 1234 } }));
    expect(v.verdict).toBe("invalid");
    expect(v.refutedIds).toEqual([]);
    expect(v.winningHypothesisId).toBeUndefined();
    // structural equality, not identity
    const w = decideVerdict(input({ "hyp-a": true }, { instrument: { treatment: { s: 200, n: 3 }, control: { n: 3, s: 200 } } }));
    expect(w.verdict).toBe("invalid");
  });

  it("no should-differ reading (instrument null) skips the instrument check", () => {
    const v = decideVerdict(input({ "hyp-a": true, "hyp-b": false, "hyp-c": false }, { instrument: null }));
    expect(v.verdict).toBe("confirmed");
  });

  it("all rivals refuted -> refuted for all, needsRepropose", () => {
    const v = decideVerdict(input({ "hyp-a": false, "hyp-b": false, "hyp-c": false }));
    expect(v.verdict).toBe("refuted");
    expect(v.refutedIds).toEqual(IDS);
    expect(v.needsRepropose).toBe(true);
    expect(v.winningHypothesisId).toBeUndefined();
  });

  it("uninformative is decided before the instrument check (an empty read is not a broken instrument)", () => {
    const v = decideVerdict(input({}, { informative: false, instrument: { treatment: null, control: null } }));
    expect(v.verdict).toBe("uninformative");
  });

  it("judge() wires a template's matches/informative into the rules", () => {
    const design = {
      template: "unit_roundtrip",
      params: { steps: [] },
      control: { params: { steps: [] } },
      predictions: {
        "hyp-honored": { class: "honored", outcomes: ["equal"] },
        "hyp-unit": { class: "unit_mismatch", outcomes: ["div100", "x100"] },
        "hyp-flag": { class: "undocumented_flag", outcomes: ["*"] },
      },
      estCredits: 0,
      estCalls: 2,
    } as ProbeDesign;
    const obs = (outcome: string | null, echo = 123400): ProbeObservation => ({
      outcome,
      treatment: {},
      control: {},
      instrument: outcome === null ? null : { treatment: echo, control: 246800 },
    });
    // x100 matches unit_mismatch AND the wildcard -> inconclusive (a wildcard can never be beaten)
    expect(judge(unitRoundtrip, design, obs("x100")).verdict).toBe("inconclusive");
    const two = { ...design, predictions: { "hyp-honored": design.predictions["hyp-honored"]!, "hyp-unit": design.predictions["hyp-unit"]! } };
    const c = judge(unitRoundtrip, two, obs("x100"));
    expect(c).toMatchObject({ verdict: "confirmed", winningHypothesisId: "hyp-unit", refutedIds: ["hyp-honored"] });
    expect(judge(unitRoundtrip, two, obs("other")).verdict).toBe("refuted");
    expect(judge(unitRoundtrip, two, obs(null)).verdict).toBe("uninformative");
    expect(judge(unitRoundtrip, two, obs("x100", 246800)).verdict).toBe("invalid");
  });
});
