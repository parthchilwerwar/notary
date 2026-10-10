/** Shared helpers for probe templates: predictions, step execution, cost estimates, tool adapter. */
import { canonicalJson } from "../../bundle/hash.js";
import { resolveRefs, argsFor } from "../../checker/recon.js";
import { resolvePath, valuesAt } from "../../checker/path.js";
import { contractEntryById } from "../../contracts/index.js";
import type { ContractEntry } from "../../contracts/types.js";
import type { Claim, DefectClass, Hypothesis } from "../../schema/index.js";
import {
  CRUSTDATA_LIST_PRICE,
  CRUSTDATA_OPS,
  DODO_OPS,
  ToolHttpError,
  ToolNetworkError,
} from "../../tools/index.js";
import type { Exchange, LedgerSnapshot, Tools } from "../../tools/index.js";
import { ANY } from "./types.js";
import type {
  CostModel,
  PredictedObservation,
  ProbeContext,
  ProbeDesign,
  ProbeIo,
  ProbeObservation,
  ProbeStep,
  TaggedExchange,
  Variant,
} from "./types.js";

/** retry_after_timeout and every other step: a step never repeats more than this. */
export const MAX_STEP_REPEAT = 3;
/** Longest wait before a step (consistency reads, polite delays). */
export const MAX_STEP_DELAY_MS = 5000;

export type ClassTable = Partial<Record<DefectClass, readonly string[]>>;

/** Predictions by code: each hypothesis's class looked up in the template's table; unknown -> "*". */
export function predictionsFor(hypotheses: readonly Hypothesis[], table: ClassTable): Record<string, PredictedObservation> {
  const out: Record<string, PredictedObservation> = {};
  for (const h of hypotheses) {
    const outcomes = table[h.class];
    out[h.id] = { class: h.class, outcomes: outcomes ? [...outcomes].sort() : [ANY] };
  }
  return out;
}

export function matchesOutcome(prediction: PredictedObservation, observation: ProbeObservation): boolean {
  if (observation.outcome === null) return false;
  return prediction.outcomes.includes(ANY) || prediction.outcomes.includes(observation.outcome);
}

export function informativeOutcome(observation: ProbeObservation): boolean {
  return observation.outcome !== null && !observation.missingPaths?.length;
}

/**
 * True when `path` is ABSENT from `body`: it expands to at least one location and none was found.
 * An empty `[]` expansion (an empty list) is "nothing to inspect", not absent. Present-but-null is
 * present.
 */
export function pathAbsent(body: unknown, path: string): boolean {
  const hits = resolvePath(body, path);
  return hits.length > 0 && !hits.some((h) => h.found);
}

export function is2xx(ex: Exchange | undefined): boolean {
  return ex !== undefined && ex.status >= 200 && ex.status < 300;
}

export function entryFor(claim: Claim, ctx: ProbeContext): ContractEntry | undefined {
  return ctx.entry ?? contractEntryById(claim.id);
}

/** Exchanges of one variant (and optionally one tag), in order. */
export function pick(exchanges: readonly TaggedExchange[], variant: Variant, tag?: string): Exchange[] {
  return exchanges.filter((t) => t.variant === variant && (tag === undefined || t.tag === tag)).map((t) => t.exchange);
}

export function first(exchanges: readonly TaggedExchange[], variant: Variant, tag?: string): Exchange | undefined {
  return pick(exchanges, variant, tag)[0];
}

export function firstValue(body: unknown, path: string): unknown {
  return valuesAt(body, path)[0];
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** The response list (body array, or the first of items|data|results|companies|records). */
export function responseList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body !== null && typeof body === "object") {
    for (const key of ["items", "data", "results", "companies", "records"]) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

export function freshCustomerStep(tag: string): ProbeStep {
  return {
    op: "dodo.createCustomer",
    params: { name: `Notary probe ${tag}`, email: `probe+${tag}@notary.test` },
    setup: true,
    note: "Create a fresh test customer (empty wallets)",
  };
}

// ---------------------------------------------------------------------------------------------
// Execution

function clampInt(n: number | undefined, fallback: number, min: number, max: number): number {
  const v = n === undefined || !Number.isFinite(n) ? fallback : Math.floor(n);
  return Math.min(Math.max(v, min), max);
}

/**
 * Run one variant's steps in order. "$from:<i>:<path>" refs resolve against this variant's own
 * earlier steps (first 2xx body). A step whose ref can't resolve ends the variant (its remaining
 * steps would be meaningless); the observation then sees fewer exchanges and is uninformative.
 */
export async function runSteps(io: ProbeIo, steps: readonly ProbeStep[], variant: Variant): Promise<TaggedExchange[]> {
  const out: TaggedExchange[] = [];
  const bodies: Array<unknown | undefined> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    bodies.push(undefined);
    let args: unknown[];
    try {
      args = argsFor(step.op, resolveRefs(step.params, bodies) as Record<string, unknown>);
    } catch {
      break;
    }
    const repeat = clampInt(step.repeat, 1, 1, MAX_STEP_REPEAT);
    const delayMs = clampInt(step.delayMs, 0, 0, MAX_STEP_DELAY_MS);
    if (delayMs > 0) await io.sleep(delayMs);
    for (let r = 0; r < repeat; r++) {
      const exchanges = await io.call(step.op, args);
      for (const ex of exchanges) {
        out.push({ variant, step: i, ...(step.tag === undefined ? {} : { tag: step.tag }), exchange: ex });
        if (bodies[i] === undefined && is2xx(ex)) bodies[i] = ex.responseBody;
      }
    }
  }
  return out;
}

/** Control first (the baseline), then treatment. */
export async function executeVariants(io: ProbeIo, design: ProbeDesign): Promise<TaggedExchange[]> {
  const control = await runSteps(io, design.control.params.steps, "control");
  const treatment = await runSteps(io, design.params.steps, "treatment");
  return [...control, ...treatment];
}

// ---------------------------------------------------------------------------------------------
// Cost

/** Calls and credits of a set of steps (refs count as their op's base cost). */
export function estimateSteps(steps: readonly ProbeStep[], costs: CostModel): { credits: number; calls: number } {
  let credits = 0;
  let calls = 0;
  for (const s of steps) {
    const repeat = clampInt(s.repeat, 1, 1, MAX_STEP_REPEAT);
    calls += repeat;
    credits += repeat * costs.creditsPerCall(s.op, s.params);
  }
  return { credits: Math.round(credits * 1e6) / 1e6, calls };
}

export function finishDesign(d: Omit<ProbeDesign, "estCredits" | "estCalls">, costs: CostModel): ProbeDesign {
  const t = estimateSteps(d.params.steps, costs);
  const c = estimateSteps(d.control.params.steps, costs);
  return { ...d, estCredits: Math.round((t.credits + c.credits) * 1e6) / 1e6, estCalls: t.calls + c.calls };
}

function identifierCount(params: Record<string, unknown>): number {
  for (const key of ["domains", "names", "crustdata_company_ids", "professional_network_profile_urls"]) {
    const v = params[key];
    if (Array.isArray(v)) return v.length;
  }
  return 1;
}

/**
 * Credits per call, from real numbers first:
 *   1. the ledger's observed average for the op this run (settled credits / calls),
 *   2. the claim's `costCredits` for that operation (hand-written from the pricing page in P2),
 *   3. the documented list price. Dodo calls cost 0 credits (they still count as calls).
 * Enrich is priced per identifier instead (its charge depends on how many are sent):
 * claim costCredits (else list price) x identifiers, + the technographics surcharge.
 */
export function buildCostModel(opts: { claims?: readonly Claim[]; ledger?: LedgerSnapshot } = {}): CostModel {
  const claimCost = new Map<string, number>();
  for (const c of opts.claims ?? []) {
    if (c.costCredits === undefined) continue;
    claimCost.set(c.operation, Math.max(claimCost.get(c.operation) ?? 0, c.costCredits));
  }
  const observed = (op: string): number | undefined => {
    const calls = opts.ledger?.calls[op] ?? 0;
    const credits = opts.ledger?.byEndpoint[op];
    return calls > 0 && credits !== undefined ? credits / calls : undefined;
  };
  return {
    creditsPerCall(op, params) {
      if (op.startsWith("dodo.")) return 0;
      if (op === CRUSTDATA_OPS.enrichCompany) {
        const perRecord = claimCost.get(op) ?? CRUSTDATA_LIST_PRICE.enrichPerRecord;
        const fields = params.fields;
        const techno = Array.isArray(fields) && fields.includes("technographics") ? CRUSTDATA_LIST_PRICE.technographicsPerRecord : 0;
        return identifierCount(params) * (perRecord + techno);
      }
      const seen = observed(op);
      if (seen !== undefined) return seen;
      if (claimCost.has(op)) return claimCost.get(op)!;
      if (op === CRUSTDATA_OPS.identifyCompany) return CRUSTDATA_LIST_PRICE.identify;
      if (op === CRUSTDATA_OPS.getCreditBalance) return CRUSTDATA_LIST_PRICE.creditBalance;
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Real tools -> ProbeIo

type AnyFn = (...args: unknown[]) => Promise<unknown>;

function methodFor(tools: Tools, op: string): AnyFn {
  for (const [tool, ops] of [
    ["crustdata", CRUSTDATA_OPS],
    ["dodo", DODO_OPS],
  ] as const) {
    for (const [method, name] of Object.entries(ops)) {
      if (name === op) {
        const fn = (tools[tool] as unknown as Record<string, AnyFn>)[method];
        if (fn) return fn;
      }
    }
  }
  throw new Error(`unknown op ${op}`);
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Adapt createTools() output to a ProbeIo. Exchanges are collected through the recorder's listener.
 * HTTP errors and network errors are data (their exchange is returned); everything else
 * (MissingCredentialError, BudgetExceededError, TestModeLockError, CassetteMissError) propagates.
 */
export function probeIoFromTools(tools: Tools, opts: { sleep?: (ms: number) => Promise<void> } = {}): ProbeIo {
  const sleep = opts.sleep ?? (tools.recorder.mode === "replay" ? async () => {} : realSleep);
  return {
    sleep,
    async call(op, args) {
      const fn = methodFor(tools, op);
      const got: Exchange[] = [];
      const off = tools.recorder.onExchange((ex) => {
        got.push(ex);
      });
      try {
        await fn(...args);
      } catch (err) {
        if (!(err instanceof ToolHttpError || err instanceof ToolNetworkError)) throw err;
      } finally {
        off();
      }
      return got;
    },
  };
}
