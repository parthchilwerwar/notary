/**
 * pagination_completeness — count the same set two ways (TDD step 3).
 *
 * Treatment walks PAGES pages of PAGE_SIZE (page_number 0..PAGES-1); control reads one page of
 * PAGES*PAGE_SIZE. Same filters, same order, so both should list the same items.
 * Outcome:
 *   same_set  the walked pages list exactly the control's ids
 *   overlap   the walked pages repeat an id (page_number not advancing / misread)
 *   mismatch  the two ways disagree (items skipped or truncated)
 * Predictions by class:
 *   honored -> same_set; silent_truncation / eventual_consistency -> mismatch;
 *   mislabelled_semantics -> overlap.
 * Uninformative: the control holds no more than one walked page (PAGE_SIZE items) — paging was
 * never exercised — or a read failed.
 * Instrument: the treatment's first page (size PAGE_SIZE) and the control (size PAGES*PAGE_SIZE)
 * must have different lengths once the set is larger than one page; equal lengths mean the size
 * parameter isn't reaching the API.
 */
import { canonicalJson } from "../../bundle/hash.js";
import { PAGED_LIST_OPS } from "./boundary_sweep.js";
import { executeVariants, finishDesign, informativeOutcome, is2xx, matchesOutcome, pick, predictionsFor, responseList } from "./common.js";
import type { ClassTable } from "./common.js";
import type { ProbeObservation, ProbeStep, ProbeTemplateModule } from "./types.js";

export const PAGINATION_TABLE: ClassTable = {
  honored: ["same_set"],
  silent_truncation: ["mismatch"],
  eventual_consistency: ["mismatch"],
  mislabelled_semantics: ["overlap"],
};

export const PAGE_SIZE = 10;
export const PAGES = 3;

/** Item id field per list op; otherwise the whole item (canonical JSON) is the identity. */
const ID_FIELD: Record<string, string> = {
  "dodo.listRefunds": "refund_id",
  "dodo.listPayments": "payment_id",
  "dodo.listCustomers": "customer_id",
};

function idsOf(body: unknown, op: string): string[] | null {
  const list = responseList(body);
  if (!list) return null;
  const field = ID_FIELD[op];
  return list.map((item) => {
    const v = field && item !== null && typeof item === "object" ? (item as Record<string, unknown>)[field] : undefined;
    return v === undefined ? canonicalJson(item) : String(v);
  });
}

export const paginationCompleteness: ProbeTemplateModule = {
  name: "pagination_completeness",

  appliesTo(claim) {
    return claim.expect.kind === "maxItems" && PAGED_LIST_OPS.has(claim.operation);
  },

  design(claim, hypotheses, ctx) {
    if (!paginationCompleteness.appliesTo(claim)) return { skip: "pagination_completeness needs a maxItems claim on a paged list op" };
    const op = claim.operation;
    const pages: ProbeStep[] = [];
    for (let n = 0; n < PAGES; n++) {
      pages.push({ op, params: { page_size: PAGE_SIZE, page_number: n }, tag: "page", note: `page ${n} of size ${PAGE_SIZE}` });
    }
    return finishDesign(
      {
        template: "pagination_completeness",
        params: { steps: pages, op },
        control: {
          params: {
            steps: [{ op, params: { page_size: PAGE_SIZE * PAGES, page_number: 0 }, tag: "all", note: `one page of ${PAGE_SIZE * PAGES}` }],
          },
        },
        predictions: predictionsFor(hypotheses, PAGINATION_TABLE),
      },
      ctx.costs,
    );
  },

  execute(io, design) {
    return executeVariants(io, design);
  },

  observe(exchanges, design): ProbeObservation {
    const op = String(design.params.op);
    const pageExchanges = pick(exchanges, "treatment", "page");
    const all = pick(exchanges, "control", "all")[0];
    const pageIds = pageExchanges.map((ex) => (is2xx(ex) ? idsOf(ex.responseBody, op) : null));
    const controlIds = is2xx(all) ? idsOf(all!.responseBody, op) : null;
    const control = { status: all?.status ?? null, count: controlIds?.length ?? null };

    let outcome: string | null = null;
    let note: string | undefined;
    const walked: string[] = [];
    if (controlIds === null || pageIds.length < PAGES || pageIds.some((p) => p === null)) {
      note = "a read failed";
    } else if (controlIds.length <= PAGE_SIZE) {
      note = `set fits on one page (${controlIds.length} items): paging not exercised`;
    } else {
      for (const p of pageIds) walked.push(...p!);
      const unique = new Set(walked);
      if (unique.size < walked.length) outcome = "overlap";
      else if (unique.size === controlIds.length && controlIds.every((id) => unique.has(id))) outcome = "same_set";
      else outcome = "mismatch";
    }
    const firstPageLength = pageIds[0]?.length ?? null;
    return {
      outcome,
      treatment: { pageCounts: pageIds.map((p) => p?.length ?? null), walked: walked.length, unique: new Set(walked).size },
      control,
      instrument: outcome === null ? null : { treatment: firstPageLength, control: controlIds!.length },
      ...(note ? { note } : {}),
    };
  },

  matches: matchesOutcome,
  informative: informativeOutcome,
};
