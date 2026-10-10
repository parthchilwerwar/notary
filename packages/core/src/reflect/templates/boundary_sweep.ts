/**
 * boundary_sweep — values around a documented limit (TDD step 3).
 *
 * For a maxItems claim on a paged list op: treatment asks for max+1; control asks for 1 and for
 * max (the control at max also tells whether the data set can fill a page at all).
 * Outcome from the treatment (max+1):
 *   rejected   non-2xx (4xx): the limit is enforced visibly
 *   clamped    2xx, exactly max items
 *   reduced    2xx, fewer than max although the control filled a page of max (coerced to a default)
 *   over_limit 2xx, more than max items (no limit)
 * Predictions by class:
 *   honored -> rejected; silent_truncation -> clamped; silent_coercion -> reduced;
 *   undocumented_flag / mislabelled_semantics -> over_limit.
 * Uninformative ("a sweep that saw nothing"): treatment 2xx but the data set can't fill a page of
 * max (control at max returned fewer than max), or no usable response.
 * Instrument: the control at size 1 and the treatment at max+1 must read differently
 * (status + list length); if they read the same, the size parameter isn't reaching the API.
 */
import type { Exchange } from "../../tools/index.js";
import {
  executeVariants,
  finishDesign,
  first,
  informativeOutcome,
  is2xx,
  matchesOutcome,
  predictionsFor,
  responseList,
} from "./common.js";
import type { ClassTable } from "./common.js";
import type { ProbeObservation, ProbeTemplateModule } from "./types.js";

export const BOUNDARY_TABLE: ClassTable = {
  honored: ["rejected"],
  silent_truncation: ["clamped"],
  silent_coercion: ["reduced"],
  undocumented_flag: ["over_limit"],
  mislabelled_semantics: ["over_limit"],
};

/** Paged list ops whose size param is a plain number. */
export const PAGED_LIST_OPS = new Set(["dodo.listRefunds", "dodo.listPayments", "dodo.listCustomers"]);

function reading(ex: Exchange | undefined): { status: number | null; length: number | null } {
  if (!ex) return { status: null, length: null };
  const list = is2xx(ex) ? responseList(ex.responseBody) : null;
  return { status: ex.status, length: list ? list.length : null };
}

/** Treatment sizes per variant: all above the documented max, each a distinct design. */
export function boundaryOverValues(max: number): number[] {
  return [max + 1, max + 10, max * 2];
}

export const boundarySweep: ProbeTemplateModule = {
  name: "boundary_sweep",
  classTable: BOUNDARY_TABLE,
  variants: 3,

  appliesTo(claim) {
    return claim.expect.kind === "maxItems" && claim.param !== "" && PAGED_LIST_OPS.has(claim.operation);
  },

  design(claim, hypotheses, ctx) {
    if (!boundarySweep.appliesTo(claim) || claim.expect.kind !== "maxItems") {
      return { skip: "boundary_sweep needs a maxItems claim with a page-size param on a paged list op" };
    }
    const max = claim.expect.max;
    const op = claim.operation;
    const p = claim.param;
    const k = ctx.variant ?? 0;
    const over = boundaryOverValues(max)[k];
    if (over === undefined) return { skip: `boundary_sweep: no variant ${k}` };
    return finishDesign(
      {
        template: "boundary_sweep",
        params: {
          steps: [{ op, params: { [p]: over }, tag: "over", note: `${p}=${over} (${over - max} over the documented max)` }],
          max,
          ...(k > 0 ? { variant: k } : {}),
        },
        control: {
          params: {
            steps: [
              { op, params: { [p]: 1 }, tag: "one", note: `${p}=1 (instrument: the size param must matter)` },
              { op, params: { [p]: max }, tag: "max", note: `${p}=${max} (can the data fill a page?)` },
            ],
          },
        },
        predictions: predictionsFor(hypotheses, BOUNDARY_TABLE),
      },
      ctx.costs,
    );
  },

  execute(io, design) {
    return executeVariants(io, design);
  },

  observe(exchanges, design): ProbeObservation {
    const max = Number(design.params.max);
    const over = reading(first(exchanges, "treatment", "over"));
    const one = reading(first(exchanges, "control", "one"));
    const atMax = reading(first(exchanges, "control", "max"));
    let outcome: string | null = null;
    let note: string | undefined;
    if (over.status === null || over.status === 0 || over.status >= 500) {
      note = "no usable response at max+1";
    } else if (over.status < 200 || over.status >= 300) {
      outcome = "rejected";
    } else if (over.length === null) {
      note = "2xx at max+1 without a list";
    } else if (over.length > max) {
      outcome = "over_limit";
    } else if (atMax.length === null || atMax.length < max) {
      note = `sweep saw nothing: the data set does not fill a page of ${max}`;
    } else if (over.length === max) {
      outcome = "clamped";
    } else {
      outcome = "reduced";
    }
    if (outcome !== null && one.status === null) {
      outcome = null;
      note = "control (size 1) missing";
    }
    return {
      outcome,
      treatment: { over },
      control: { one, atMax },
      instrument: outcome === null ? null : { treatment: over, control: one },
      ...(note ? { note } : {}),
    };
  },

  matches: matchesOutcome,
  informative: informativeOutcome,
};
