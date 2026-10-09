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
 * Uninformative: no non-null value at the field in either variant (null-only is allowed by the doc).
 * Instrument: the values read must differ between treatment and control (different subjects);
 * identical values mean both reads hit the same record.
 *
 * Edge recipes per op (others are skipped):
 *   crustdata.enrichCompany        recon's two domains split: treatment the first, control the second
 *   dodo.createWalletLedgerEntry   credit 2^31 (treatment) vs 1 (control), each on a fresh customer
 *   dodo.listCustomerWallets       fresh customer credited 2^31 (treatment) vs untouched (control)
 *   dodo.listRefunds               page of 100 (treatment) vs page of 1 (control)
 */
import { resolvePath } from "../../checker/path.js";
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

function edgeRecipe(op: string, steps: readonly ProbeStep[], tag: string): { t: ProbeStep[]; c: ProbeStep[] } | null {
  if (op === "crustdata.enrichCompany") {
    const base = steps.find((s) => s.op === op && Array.isArray(s.params.domains) && (s.params.domains as unknown[]).length >= 2);
    if (!base) return null;
    const [a, b] = base.params.domains as string[];
    return {
      t: [{ ...base, params: { ...base.params, domains: [a] }, tag: "read", note: `Enrich ${a}` }],
      c: [{ ...base, params: { ...base.params, domains: [b] }, tag: "read", note: `Enrich ${b}` }],
    };
  }
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
  if (op === "dodo.listRefunds") {
    return {
      t: [{ op, params: { page_size: 100 }, tag: "read", note: "Refunds, page of 100" }],
      c: [{ op, params: { page_size: 1 }, tag: "read", note: "Refunds, page of 1" }],
    };
  }
  return null;
}

export const typeEdge: ProbeTemplateModule = {
  name: "type_edge",

  appliesTo(claim) {
    return claim.expect.kind === "type";
  },

  design(claim, hypotheses, ctx) {
    if (claim.expect.kind !== "type") return { skip: "type_edge needs a type claim" };
    const recipe = edgeRecipe(claim.operation, entryFor(claim, ctx)?.recon ?? [], ctx.tag);
    if (!recipe) return { skip: `type_edge: no edge recipe for ${claim.operation}` };
    return finishDesign(
      {
        template: "type_edge",
        params: { steps: recipe.t, field: claim.expect.field, type: claim.expect.type },
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
      for (const ex of reads) for (const h of resolvePath(ex.responseBody, field)) if (h.found) values.push(h.value ?? null);
      return { reads: reads.length, values };
    };
    const t = valuesOf("treatment");
    const c = valuesOf("control");
    const nonNull = [...t.values, ...c.values].filter((v) => v !== null);
    const classes = [...new Set(nonNull.map((v) => classifyValue(type, v)))];
    let outcome: string | null = null;
    let note: string | undefined;
    if (t.reads === 0 || c.reads === 0) note = "a read failed";
    else if (nonNull.length === 0) note = `no non-null value at ${field}`;
    else outcome = PRIORITY.find((p) => classes.includes(p)) ?? "doc_type";
    return {
      outcome,
      treatment: { values: t.values.slice(0, 10), count: t.values.length },
      control: { values: c.values.slice(0, 10), count: c.values.length },
      instrument: outcome === null ? null : { treatment: t.values, control: c.values },
      ...(note ? { note } : {}),
    };
  },

  matches: matchesOutcome,
  informative: informativeOutcome,
};
