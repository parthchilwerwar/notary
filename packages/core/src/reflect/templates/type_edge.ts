/**
 * type_edge — large numbers, edge values (TDD step 3).
 *
 * For a `type` claim: the treatment reads the field where an edge value is likely (a large company,
 * a balance just past int32), the control reads the same field on an ordinary subject. Every
 * non-null value found at the claim's field (both variants) is classified against the documented
 * type:
 *   doc_type          every value has the documented type
 *   numeric_string    a number sent as a string ("1234")
 *   float             a non-integer where an integer is documented
 *   formatted_string  a non-numeric string where a number is documented ("$141M")
 *   other_type        anything else (object, boolean, wrong kind of string)
 * Predictions by class:
 *   honored -> doc_type; silent_coercion -> numeric_string | float | formatted_string;
 *   mislabelled_semantics -> other_type.
 * Uninformative: no non-null value at the field in either variant (null-only is allowed by the doc),
 * or the claim's field path is ABSENT from a variant's 2xx reads (the path expands to locations but
 * none exists, e.g. `headcount.total` against a response carrying `headcount.count`): a path that
 * doesn't match the real response says nothing about the claim, so it can never read as doc_type.
 * Present-but-null is present (it is skipped as a value, as before). An empty list is nothing to
 * inspect, not absent.
 * Instrument: the values read must differ between treatment and control (different subjects);
 * identical values mean both reads hit the same record.
 *
 * Edge recipes per op (others are skipped):
 *   crustdata.enrichCompany        variant k: treatment = domain k, control = domain k+1 of the
 *                                  record list (the recon's domains, then the seeded queue's company
 *                                  domains, src/queue/seed-plan.ts queueCompanyDomains); up to
 *                                  ENRICH_EDGE_VARIANTS designs, 2 enrich calls of 1 domain each
 *                                  (4 credits at list price) per probe
 *   dodo.createWalletLedgerEntry   credit 2^31 (treatment) vs 1 (control), each on a fresh customer
 *   dodo.listCustomerWallets       fresh customer credited 2^31 (treatment) vs untouched (control)
 *   dodo.listRefunds               v0 page of 100 vs page of 1; v1 page 1 (size 10) vs page of 1;
 *                                  v2 page 2 (size 10) vs page of 2 — different records each time
 */
import { resolvePath } from "../../checker/path.js";
import { queueCompanyDomains } from "../../queue/seed-plan.js";
import {
  entryFor,
  executeVariants,
  finishDesign,
  freshCustomerStep,
  informativeOutcome,
  is2xx,
  matchesOutcome,
  pick,
  predictionsFor,
} from "./common.js";
import type { ClassTable } from "./common.js";
import type { ProbeObservation, ProbeStep, ProbeTemplateModule } from "./types.js";

export const TYPE_EDGE_TABLE: ClassTable = {
  honored: ["doc_type"],
  silent_coercion: ["float", "formatted_string", "numeric_string"],
  mislabelled_semantics: ["other_type"],
};

/** int32 max + 1: the edge where a 32-bit integer field would overflow or be coerced. */
export const EDGE_AMOUNT = 2 ** 31;

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function matchesType(type: string, v: unknown): boolean {
  return type.split("|").some((t) => {
    switch (t.trim()) {
      case "string":
        return typeof v === "string";
      case "number":
        return typeof v === "number" && Number.isFinite(v);
      case "integer":
        return typeof v === "number" && Number.isInteger(v);
      case "boolean":
        return typeof v === "boolean";
      case "null":
        return v === null;
      case "array":
        return Array.isArray(v);
      case "object":
        return v !== null && typeof v === "object" && !Array.isArray(v);
      case "iso-datetime":
        return typeof v === "string" && ISO_DATETIME.test(v);
      default:
        return false;
    }
  });
}

/** Classify one non-null value against the documented type. */
export function classifyValue(type: string, v: unknown): string {
  if (matchesType(type, v)) return "doc_type";
  const wantsNumber = /(^|\|)\s*(number|integer)\s*($|\|)/.test(type);
  if (wantsNumber && typeof v === "string") {
    return v.trim() !== "" && Number.isFinite(Number(v)) ? "numeric_string" : "formatted_string";
  }
  if (/(^|\|)\s*integer\s*($|\|)/.test(type) && typeof v === "number" && !Number.isInteger(v)) return "float";
  return "other_type";
}

const PRIORITY = ["other_type", "formatted_string", "numeric_string", "float"];

/** Crustdata enrich designs per claim (each costs 2 single-domain enrich calls). */
export const ENRICH_EDGE_VARIANTS = 5;
/** listRefunds designs: [treatment params, control params] per variant. */
export const REFUND_LIST_EDGE_VARIANTS = [
  [{ page_size: 100 }, { page_size: 1 }],
  [{ page_size: 10, page_number: 1 }, { page_size: 1 }],
  [{ page_size: 10, page_number: 2 }, { page_size: 2 }],
] as const;

/** The records enrich type probes read: the recon's domains first, then the seeded queue's companies. */
export function enrichEdgeDomains(reconDomains: readonly string[]): string[] {
  return [...new Set([...reconDomains, ...queueCompanyDomains()])];
}

/**
 * Variants (k > 0) exist for Crustdata enrich (treatment = record k, control = record k+1 of
 * enrichEdgeDomains) and dodo.listRefunds (different pages); other recipes have a single design.
 */
function edgeRecipe(op: string, steps: readonly ProbeStep[], tag: string, k = 0): { t: ProbeStep[]; c: ProbeStep[] } | null {
  if (op === "crustdata.enrichCompany") {
    const base = steps.find((s) => s.op === op && Array.isArray(s.params.domains) && (s.params.domains as unknown[]).length >= 2);
    if (!base) return null;
    const domains = enrichEdgeDomains(base.params.domains as string[]);
    if (k >= ENRICH_EDGE_VARIANTS || k + 1 >= domains.length) return null;
    const a = domains[k]!;
    const b = domains[k + 1]!;
    return {
      t: [{ ...base, params: { ...base.params, domains: [a] }, tag: "read", note: `Enrich ${a}` }],
      c: [{ ...base, params: { ...base.params, domains: [b] }, tag: "read", note: `Enrich ${b}` }],
    };
  }
  if (op === "dodo.listRefunds") {
    const v = REFUND_LIST_EDGE_VARIANTS[k];
    if (!v) return null;
    const [t, c] = v;
    const label = (q: Record<string, number>) => `page_size ${q.page_size}${q.page_number ? `, page ${q.page_number}` : ""}`;
    return {
      t: [{ op, params: { ...t }, tag: "read", note: `Refunds, ${label(t)}` }],
      c: [{ op, params: { ...c }, tag: "read", note: `Refunds, ${label(c)}` }],
    };
  }
  if (k > 0) return null;
  const credit = (amount: number, currency = "USD"): ProbeStep => ({
    op: "dodo.createWalletLedgerEntry",
    params: { customer_id: "$from:0:customer_id", amount, currency, entry_type: "credit", reason: `notary probe type_edge ${tag}` },
    note: `Credit ${amount}`,
  });
  if (op === "dodo.createWalletLedgerEntry") {
    return {
      t: [freshCustomerStep(`${tag}-t`), { ...credit(EDGE_AMOUNT), tag: "read" }],
      c: [freshCustomerStep(`${tag}-c`), { ...credit(1), tag: "read" }],
    };
  }
  if (op === "dodo.listCustomerWallets") {
    const list: ProbeStep = { op, params: { customer_id: "$from:0:customer_id" }, tag: "read", note: "Read wallets" };
    return {
      t: [freshCustomerStep(`${tag}-t`), { ...credit(EDGE_AMOUNT), setup: true }, list],
      c: [freshCustomerStep(`${tag}-c`), list],
    };
  }
  return null;
}

export const typeEdge: ProbeTemplateModule = {
  name: "type_edge",
  classTable: TYPE_EDGE_TABLE,
  variants: ENRICH_EDGE_VARIANTS,

  appliesTo(claim) {
    return claim.expect.kind === "type";
  },

  design(claim, hypotheses, ctx) {
    if (claim.expect.kind !== "type") return { skip: "type_edge needs a type claim" };
    const k = ctx.variant ?? 0;
    const recipe = edgeRecipe(claim.operation, entryFor(claim, ctx)?.recon ?? [], ctx.tag, k);
    if (!recipe) return { skip: k > 0 ? `type_edge: no variant ${k} for ${claim.operation}` : `type_edge: no edge recipe for ${claim.operation}` };
    return finishDesign(
      {
        template: "type_edge",
        params: { steps: recipe.t, field: claim.expect.field, type: claim.expect.type, ...(k > 0 ? { variant: k } : {}) },
        control: { params: { steps: recipe.c } },
        predictions: predictionsFor(hypotheses, TYPE_EDGE_TABLE),
      },
      ctx.costs,
    );
  },

  execute(io, design) {
    return executeVariants(io, design);
  },

  observe(exchanges, design): ProbeObservation {
    const field = String(design.params.field);
    const type = String(design.params.type);
    const valuesOf = (variant: "treatment" | "control") => {
      const reads = pick(exchanges, variant, "read").filter((ex) => is2xx(ex));
      const values: unknown[] = [];
      let misses = 0;
      for (const ex of reads) {
        for (const h of resolvePath(ex.responseBody, field)) {
          if (h.found) values.push(h.value ?? null);
          else misses += 1;
        }
      }
      // Absent: the path pointed somewhere in this variant's reads and resolved nowhere.
      return { reads: reads.length, values, absent: misses > 0 && values.length === 0 };
    };
    const t = valuesOf("treatment");
    const c = valuesOf("control");
    const nonNull = [...t.values, ...c.values].filter((v) => v !== null);
    const classes = [...new Set(nonNull.map((v) => classifyValue(type, v)))];
    let outcome: string | null = null;
    let note: string | undefined;
    const absentIn = [t.absent ? "treatment" : null, c.absent ? "control" : null].filter((v): v is string => v !== null);
    if (t.reads === 0 || c.reads === 0) note = "a read failed";
    else if (absentIn.length > 0) note = `claim path ${field} absent in the ${absentIn.join(" and ")} response: uninformative, not honored`;
    else if (nonNull.length === 0) note = `no non-null value at ${field}`;
    else outcome = PRIORITY.find((p) => classes.includes(p)) ?? "doc_type";
    return {
      outcome,
      treatment: { values: t.values.slice(0, 10), count: t.values.length },
      control: { values: c.values.slice(0, 10), count: c.values.length },
      instrument: outcome === null ? null : { treatment: t.values, control: c.values },
      ...(note ? { note } : {}),
      ...(absentIn.length > 0 ? { missingPaths: [field] } : {}),
    };
  },

  matches: matchesOutcome,
  informative: informativeOutcome,
};
