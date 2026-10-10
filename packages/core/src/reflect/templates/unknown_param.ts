/**
 * unknown_param — send an unknown field or filter (TDD step 3).
 *
 * Applies to errorOnUnknownParam claims, and to statusOnError claims about an invalid `fields`
 * value (e.g. identify asked for an enrich-only group). Treatment = the claim's crafted recon
 * request (the one carrying the unknown/invalid param); control = the identical request with that
 * param removed (the documented, valid baseline).
 * Outcome:
 *   rejected  treatment non-2xx                       (the doc's promise)
 *   ignored   treatment 2xx, body equal to the control (param silently dropped)
 *   applied   treatment 2xx, body differs              (an undocumented flag does something)
 * Predictions by class:
 *   honored -> rejected; silent_coercion -> ignored; undocumented_flag -> applied.
 * Uninformative: the control itself failed (no valid baseline) or the treatment got no response.
 * Instrument: this template has no reading that must differ — "ignored" means control and treatment
 * legitimately read the same — so its control is the baseline the outcome is computed against, and
 * a failed baseline makes the observation uninformative rather than invalid.
 */
import { entryFor, executeVariants, finishDesign, first, informativeOutcome, is2xx, matchesOutcome, predictionsFor, sameJson } from "./common.js";
import type { ClassTable } from "./common.js";
import type { ProbeObservation, ProbeStep, ProbeTemplateModule } from "./types.js";

export const UNKNOWN_PARAM_TABLE: ClassTable = {
  honored: ["rejected"],
  silent_coercion: ["ignored"],
  undocumented_flag: ["applied"],
};

/** statusOnError claims whose crafted request is an invalid value of one of these params. */
const INVALID_VALUE_PARAMS = new Set(["fields"]);

export const unknownParam: ProbeTemplateModule = {
  name: "unknown_param",
  classTable: UNKNOWN_PARAM_TABLE,

  appliesTo(claim) {
    if (claim.expect.kind === "errorOnUnknownParam") return claim.param !== "";
    return claim.expect.kind === "statusOnError" && claim.expect.status >= 400 && INVALID_VALUE_PARAMS.has(claim.param);
  },

  design(claim, hypotheses, ctx) {
    if (!unknownParam.appliesTo(claim)) return { skip: "unknown_param needs an errorOnUnknownParam / invalid-fields claim" };
    const steps = entryFor(claim, ctx)?.recon ?? [];
    const crafted = steps.findIndex((s) => !s.setup && s.op === claim.operation && claim.param in s.params);
    if (crafted < 0) return { skip: `unknown_param: no crafted recon request carrying ${claim.param}` };
    // Setup steps before the crafted one are kept in both variants so "$from" refs still resolve.
    const prefix: ProbeStep[] = steps.slice(0, crafted).filter((s) => s.setup);
    if (prefix.length !== crafted) return { skip: "unknown_param: crafted request depends on non-setup steps" };
    const base = steps[crafted]!;
    const { [claim.param]: _dropped, ...rest } = base.params;
    return finishDesign(
      {
        template: "unknown_param",
        params: { steps: [...prefix, { ...base, tag: "probe", note: `with ${claim.param}` }], param: claim.param },
        control: { params: { steps: [...prefix, { ...base, params: rest, tag: "probe", note: `without ${claim.param}` }] } },
        predictions: predictionsFor(hypotheses, UNKNOWN_PARAM_TABLE),
      },
      ctx.costs,
    );
  },

  execute(io, design) {
    return executeVariants(io, design);
  },

  observe(exchanges): ProbeObservation {
    const t = first(exchanges, "treatment", "probe");
    const c = first(exchanges, "control", "probe");
    let outcome: string | null = null;
    let note: string | undefined;
    if (!is2xx(c)) note = "control (valid baseline) failed";
    else if (!t || t.status === 0) note = "treatment got no response";
    else if (!is2xx(t)) outcome = "rejected";
    else outcome = sameJson(t.responseBody, c!.responseBody) ? "ignored" : "applied";
    return {
      outcome,
      treatment: { status: t?.status ?? null },
      control: { status: c?.status ?? null },
      instrument: null,
      ...(note ? { note } : {}),
    };
  },

  matches: matchesOutcome,
  informative: informativeOutcome,
};
