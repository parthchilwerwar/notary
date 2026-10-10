/**
 * write_then_read — timed reads after a write (TDD step 3).
 *
 * For a consistentWithin{ms} claim on dodo.createRefund (does the payment's refunds[] list a new
 * refund within ms?): treatment = full refund on a probe-reserved payment, then getPayment reads
 * right away, at ~ms and at ~3*ms, then a direct getRefund by id. Control = getPayment before
 * the write.
 * Outcome (by which read first contains the new refund id):
 *   within  the immediate read or the read issued at ~ms
 *   after   only the late read (~3*ms)
 *   never   no read
 * Predictions by class:
 *   honored -> within; eventual_consistency -> after; mislabelled_semantics -> never.
 * Uninformative: the write returned no id (a 2xx write whose id path is absent is recorded in
 * `missingPaths`), or a read failed.
 * Instrument: "the refund exists" must read differently before the write (control: its id in the
 * payment) and after it (treatment: direct getRefund found it). Equal readings mean the write
 * never landed, so a "never" would say nothing about refunds[].
 *
 * DESIGN VARIANTS (each on its own probe-reserved payment, stamped `variant: k`): v0 full refund;
 * v1 partial refund of 100; v2 partial refund of 150 (minor units, on the payment's first line).
 * The precheck reads refunds[] after both kinds of refund, so both kinds are exercised.
 */
import { containsValue } from "../../checker/path.js";
import { executeVariants, finishDesign, first, firstValue, informativeOutcome, is2xx, matchesOutcome, pathAbsent, predictionsFor } from "./common.js";
import type { ClassTable } from "./common.js";
import type { ProbeObservation, ProbeStep, ProbeTemplateModule } from "./types.js";

export const WRITE_READ_TABLE: ClassTable = {
  honored: ["within"],
  eventual_consistency: ["after"],
  mislabelled_semantics: ["never"],
};

export const LATE_READ_FACTOR = 3;
/** Partial amount per variant (undefined = full refund). */
export const WRITE_READ_VARIANTS: ReadonlyArray<number | undefined> = [undefined, 100, 150];

export const writeThenRead: ProbeTemplateModule = {
  name: "write_then_read",
  classTable: WRITE_READ_TABLE,
  variants: WRITE_READ_VARIANTS.length,

  appliesTo(claim) {
    return claim.expect.kind === "consistentWithin" && claim.operation === "dodo.createRefund";
  },

  design(claim, hypotheses, ctx) {
    if (!writeThenRead.appliesTo(claim) || claim.expect.kind !== "consistentWithin") {
      return { skip: "write_then_read needs a consistentWithin claim on dodo.createRefund" };
    }
    const k = ctx.variant ?? 0;
    if (k >= WRITE_READ_VARIANTS.length) return { skip: `write_then_read: no variant ${k}` };
    const pool = ctx.payments.available();
    if (pool.length < 1) return { skip: "write_then_read on refunds needs a probe-reserved succeeded payment (seed manifest)" };
    const paymentId = pool[0]!;
    const ms = claim.expect.ms;
    const read = { op: "dodo.getPayment", params: { payment_id: paymentId } };
    const partial = WRITE_READ_VARIANTS[k];
    const writeSteps: ProbeStep[] =
      partial === undefined
        ? [{ op: "dodo.createRefund", params: { payment_id: paymentId, reason: `notary probe consistency ${ctx.tag}` }, tag: "write", note: "Full refund" }]
        : [
            { ...read, setup: true, note: "Read the payment's product" },
            {
              op: "dodo.createRefund",
              params: { payment_id: paymentId, items: [{ item_id: "$from:0:product_cart[0].product_id", amount: partial }], reason: `notary probe consistency ${ctx.tag}` },
              tag: "write",
              note: `Partial refund of ${partial}`,
            },
          ];
    const w = writeSteps.length - 1;
    return finishDesign(
      {
        template: "write_then_read",
        params: {
          steps: [
            ...writeSteps,
            { ...read, tag: "read_now", note: "Read right away" },
            { ...read, delayMs: ms, tag: "read_window", note: `Read at ~${ms} ms` },
            { ...read, delayMs: (LATE_READ_FACTOR - 1) * ms, tag: "read_late", note: `Read at ~${LATE_READ_FACTOR * ms} ms` },
            { op: "dodo.getRefund", params: { refund_id: `$from:${w}:refund_id` }, tag: "direct", note: "Read the refund by id" },
          ],
          windowMs: ms,
          idPath: claim.param,
          ...(k > 0 ? { variant: k } : {}),
        },
        control: { params: { steps: [{ ...read, tag: "before", note: "Payment before the write" }] } },
        predictions: predictionsFor(hypotheses, WRITE_READ_TABLE),
        paymentIds: [paymentId],
      },
      ctx.costs,
    );
  },

  execute(io, design) {
    return executeVariants(io, design);
  },

  observe(exchanges, design): ProbeObservation {
    const idPath = String(design.params.idPath ?? "refund_id");
    const write = first(exchanges, "treatment", "write");
    const id = is2xx(write) ? firstValue(write!.responseBody, idPath) : undefined;
    const idAbsent = is2xx(write) && pathAbsent(write!.responseBody, idPath);
    const tags = ["read_now", "read_window", "read_late"] as const;
    const reads = tags.map((t) => first(exchanges, "treatment", t));
    const before = first(exchanges, "control", "before");
    const direct = first(exchanges, "treatment", "direct");
    const writeAt = write ? Date.parse(write.recordedAt) : NaN;
    const seen = reads.map((r) => (r && is2xx(r) && id !== undefined && id !== null ? containsValue(r.responseBody, id) : null));
    const afterMs = reads.map((r) => (r ? Date.parse(r.recordedAt) - writeAt : null));

    let outcome: string | null = null;
    let note: string | undefined;
    if (id === undefined || id === null) note = idAbsent ? `the write returned no id (claim path ${idPath} absent)` : "the write returned no id";
    else if (seen.some((s) => s === null) || !is2xx(before)) note = "a read failed";
    else if (seen[0] || seen[1]) outcome = "within";
    else if (seen[2]) outcome = "after";
    else outcome = "never";

    const existsBefore = id != null && is2xx(before) ? containsValue(before!.responseBody, id) : null;
    const existsAfter = is2xx(direct);
    return {
      outcome,
      treatment: { id: id ?? null, seen, afterMs, directStatus: direct?.status ?? null },
      control: { existsBefore },
      instrument: outcome === null ? null : { treatment: existsAfter, control: existsBefore },
      ...(note ? { note } : {}),
      ...(idAbsent ? { missingPaths: [idPath] } : {}),
    };
  },

  matches: matchesOutcome,
  informative: informativeOutcome,
};
