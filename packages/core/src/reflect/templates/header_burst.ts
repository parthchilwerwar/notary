/**
 * header_burst — rate limits, hard-capped (TDD step 3 and "Security and safety controls").
 *
 * Only free, read-only ops are ever burst (crustdata.getCreditBalance, dodo.listPayments with a
 * page of 1). Control = one request; then, after a polite pause, the treatment sends up to
 * BURST_SIZE requests spaced BURST_DELAY_MS apart. EVERY request (control included) takes one unit
 * from the run's BurstCounter, which never exceeds HEADER_BURST_MAX_REQUESTS_PER_RUN (10) across
 * all probes; the counter throws instead of sending request 11.
 * Outcome: limited (any 429, or x-ratelimit-remaining reached 0) | not_limited (all 2xx).
 * Predictions by class: rate_limit -> limited; every other class -> not_limited (a short burst
 * well inside the documented rate must not be throttled unless rate limiting explains the anomaly).
 * Uninformative: fewer than 2 treatment responses, or a non-2xx/non-429 status.
 * Instrument: when the API sends x-ratelimit-remaining, the control's value and the treatment's
 * last value must differ (the counter moves with requests); null when the header is absent.
 */
import type { DefectClass } from "../../schema/index.js";
import type { Exchange } from "../../tools/index.js";
import { argsFor } from "../../checker/recon.js";
import { finishDesign, informativeOutcome, is2xx, matchesOutcome, pick, predictionsFor } from "./common.js";
import type { ClassTable } from "./common.js";
import type { ProbeObservation, ProbeStep, ProbeTemplateModule, TaggedExchange } from "./types.js";
import { DefectClassSchema } from "../../schema/index.js";

export const BURST_SIZE = 5;
export const BURST_DELAY_MS = 250;
export const BURST_PAUSE_MS = 1000;

export const BURST_TABLE: ClassTable = Object.fromEntries(
  DefectClassSchema.options.map((c: DefectClass) => [c, c === "rate_limit" ? ["limited"] : ["not_limited"]]),
);

const BURST_TARGET: Record<string, ProbeStep> = {
  crustdata: { op: "crustdata.getCreditBalance", params: {}, note: "Free credit-balance read" },
  dodo: { op: "dodo.listPayments", params: { page_size: 1 }, note: "One-item payments page" },
};

function remainingHeader(ex: Exchange | undefined): number | null {
  const raw = ex?.responseHeaders["x-ratelimit-remaining"];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export const headerBurst: ProbeTemplateModule = {
  name: "header_burst",
  classTable: BURST_TABLE,

  appliesTo(claim) {
    return BURST_TARGET[claim.tool] !== undefined;
  },

  design(claim, hypotheses, ctx) {
    const target = BURST_TARGET[claim.tool];
    if (!target) return { skip: `header_burst: no free read op for ${claim.tool}` };
    const n = Math.min(BURST_SIZE, ctx.burst.remaining - 1);
    if (n < 2) return { skip: `header_burst cap: ${ctx.burst.remaining} of ${ctx.burst.max} burst requests left this run` };
    const treatment: ProbeStep[] = [];
    for (let i = 0; i < n; i++) {
      treatment.push({ ...target, delayMs: i === 0 ? BURST_PAUSE_MS : BURST_DELAY_MS, tag: "burst" });
    }
    return finishDesign(
      {
        template: "header_burst",
        params: { steps: treatment, burst: n },
        control: { params: { steps: [{ ...target, tag: "single" }] } },
        predictions: predictionsFor(hypotheses, BURST_TABLE),
      },
      ctx.costs,
    );
  },

  /** Custom executor: every request is charged to the run's burst counter BEFORE it is sent. */
  async execute(io, design, ctx) {
    const out: TaggedExchange[] = [];
    const run = async (steps: readonly ProbeStep[], variant: "treatment" | "control") => {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!;
        if (s.delayMs) await io.sleep(Math.min(s.delayMs, 5000));
        ctx.burst.take(); // throws BurstCapError instead of exceeding the per-run cap
        for (const ex of await io.call(s.op, argsFor(s.op, s.params))) {
          out.push({ variant, step: i, ...(s.tag ? { tag: s.tag } : {}), exchange: ex });
        }
      }
    };
    await run(design.control.params.steps, "control");
    await run(design.params.steps, "treatment");
    return out;
  },

  observe(exchanges): ProbeObservation {
    const burst = pick(exchanges, "treatment", "burst");
    const single = pick(exchanges, "control", "single")[0];
    const statuses = burst.map((e) => e.status);
    const remaining = burst.map((e) => remainingHeader(e));
    let outcome: string | null = null;
    let note: string | undefined;
    if (burst.length < 2) note = "fewer than 2 burst responses";
    else if (statuses.includes(429) || remaining.some((r) => r === 0)) outcome = "limited";
    else if (burst.every((e) => is2xx(e))) outcome = "not_limited";
    else note = `unexpected statuses ${statuses.join(",")}`;
    const controlRemaining = remainingHeader(single);
    const lastRemaining = remaining[remaining.length - 1] ?? null;
    return {
      outcome,
      treatment: { statuses, remaining },
      control: { status: single?.status ?? null, remaining: controlRemaining },
      instrument: outcome !== null && controlRemaining !== null && lastRemaining !== null ? { treatment: lastRemaining, control: controlRemaining } : null,
      ...(note ? { note } : {}),
    };
  },

  matches: matchesOutcome,
  informative: informativeOutcome,
};
