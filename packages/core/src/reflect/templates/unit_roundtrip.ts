/**
 * unit_roundtrip — create a known amount, read it back (TDD step 3).
 *
 * Treatment writes amount A, control writes a different amount B, each on its own fresh subject.
 * Outcome from the treatment's echo/sent ratio:
 *   equal (1) | x100 (echo = sent*100) | div100 (echo = sent/100) | other
 * Predictions by class:
 *   honored              -> equal          (echo == sent)
 *   unit_mismatch        -> x100 | div100  (major/minor confusion)
 *   silent_coercion      -> other          (rounded, truncated, re-typed)
 *   mislabelled_semantics-> other          (the field echoes something else)
 * Instrument: control and treatment echoes must differ (A != B); equal echoes mean the read-back
 * does not reflect what was sent.
 * Uninformative: either variant lacks a 2xx write with numeric sent and echoed amounts.
 */
import type { Claim, Hypothesis } from "../../schema/index.js";
import {
  asNumber,
  entryFor,
  executeVariants,
  finishDesign,
  first,
  firstValue,
  freshCustomerStep,
  informativeOutcome,
  is2xx,
  matchesOutcome,
  predictionsFor,
} from "./common.js";
import type { ClassTable } from "./common.js";
import type { ProbeContext, ProbeDesign, ProbeObservation, ProbeStep, ProbeTemplateModule, Skip, TaggedExchange } from "./types.js";

export const UNIT_TABLE: ClassTable = {
  honored: ["equal"],
  unit_mismatch: ["div100", "x100"],
  silent_coercion: ["other"],
  mislabelled_semantics: ["other"],
};

const OPS = new Set(["dodo.createProduct", "dodo.createWalletLedgerEntry", "dodo.createRefund"]);

/** Treatment and control amounts (minor units if the doc is right). */
export const UNIT_AMOUNTS = { treatment: 1234, control: 2468 } as const;
/** Refund amounts stay small: they must fit inside a seeded payment. */
export const REFUND_UNIT_AMOUNTS = { treatment: 100, control: 150 } as const;
/** Treatment amounts per design variant (control stays fixed); index 0 is the base amount. */
export const UNIT_TREATMENT_VARIANTS = [UNIT_AMOUNTS.treatment, 3517, 4321] as const;
export const REFUND_TREATMENT_VARIANTS = [REFUND_UNIT_AMOUNTS.treatment, 120, 130] as const;

export function classifyRatio(sent: number, echoed: number): string {
  if (echoed === sent) return "equal";
  if (sent !== 0 && Math.abs(echoed - sent * 100) < 1e-9) return "x100";
  if (sent !== 0 && Math.abs(echoed - sent / 100) < 1e-9) return "div100";
  return "other";
}

function writeSteps(claim: Claim, ctx: ProbeContext, variant: "t" | "c", amount: number, paymentId?: string): ProbeStep[] | null {
  const op = claim.operation;
  if (op === "dodo.createProduct") {
    const base = entryFor(claim, ctx)?.recon.find((s) => s.op === op && !s.setup) ?? entryFor(claim, ctx)?.recon.find((s) => s.op === op);
    const price = (base?.params.price as Record<string, unknown> | undefined) ?? {
      type: "one_time_price",
      currency: "USD",
      discount_bps: 0,
      purchasing_power_parity: false,
    };
    return [
      {
        op,
        params: { ...(base?.params ?? { tax_category: "saas" }), name: `Notary probe ${ctx.tag}-${variant} ${amount}`, price: { ...price, price: amount } },
        tag: "write",
        note: `Create a one-time product priced ${amount}`,
      },
    ];
  }
  if (op === "dodo.createWalletLedgerEntry") {
    return [
      freshCustomerStep(`${ctx.tag}-${variant}`),
      {
        op,
        params: { customer_id: "$from:0:customer_id", amount, currency: "USD", entry_type: "credit", reason: `notary probe unit ${ctx.tag}` },
        tag: "write",
        note: `Credit ${amount} to an empty USD wallet`,
      },
    ];
  }
  if (op === "dodo.createRefund" && paymentId) {
    return [
      { op: "dodo.getPayment", params: { payment_id: paymentId }, setup: true, note: "Read the payment's product" },
      {
        op,
        params: {
          payment_id: paymentId,
          items: [{ item_id: "$from:0:product_cart[0].product_id", amount }],
          reason: `notary probe unit ${ctx.tag}`,
        },
        tag: "write",
        note: `Partial refund of ${amount}`,
      },
    ];
  }
  return null;
}

export const unitRoundtrip: ProbeTemplateModule = {
  name: "unit_roundtrip",
  variants: 3,

  appliesTo(claim) {
    return claim.expect.kind === "unit" && OPS.has(claim.operation);
  },

  design(claim, hypotheses: readonly Hypothesis[], ctx): ProbeDesign | Skip {
    if (!unitRoundtrip.appliesTo(claim)) return { skip: "unit_roundtrip needs a unit claim on a known write op" };
    let paymentIds: string[] | undefined;
    const k = ctx.variant ?? 0;
    if (k >= UNIT_TREATMENT_VARIANTS.length) return { skip: `unit_roundtrip: no variant ${k}` };
    let amounts: { treatment: number; control: number } = { treatment: UNIT_TREATMENT_VARIANTS[k]!, control: UNIT_AMOUNTS.control };
    if (claim.operation === "dodo.createRefund") {
      const pool = ctx.payments.available();
      if (pool.length < 2) return { skip: "unit_roundtrip on refunds needs 2 probe-reserved succeeded payments (seed manifest)" };
      paymentIds = [pool[0]!, pool[1]!];
      amounts = { treatment: REFUND_TREATMENT_VARIANTS[k]!, control: REFUND_UNIT_AMOUNTS.control };
    }
    const t = writeSteps(claim, ctx, "t", amounts.treatment, paymentIds?.[0]);
    const c = writeSteps(claim, ctx, "c", amounts.control, paymentIds?.[1]);
    if (!t || !c) return { skip: `unit_roundtrip: no write recipe for ${claim.operation}` };
    return finishDesign(
      {
        template: "unit_roundtrip",
        params: {
          steps: t,
          sent: amounts.treatment,
          sentPath: claim.param,
          echoPath: claim.expect.kind === "unit" ? claim.expect.field : "",
          ...(k > 0 ? { variant: k } : {}),
        },
        control: { params: { steps: c, sent: amounts.control } },
        predictions: predictionsFor(hypotheses, UNIT_TABLE),
        ...(paymentIds ? { paymentIds } : {}),
      },
      ctx.costs,
    );
  },

  execute(io, design) {
    return executeVariants(io, design);
  },

  observe(exchanges: readonly TaggedExchange[], design, claim): ProbeObservation {
    const echoPath = claim.expect.kind === "unit" ? claim.expect.field : "";
    const read = (variant: "treatment" | "control") => {
      const ex = first(exchanges, variant, "write");
      if (!is2xx(ex)) return { status: ex?.status ?? null, sent: null, echoed: null };
      return {
        status: ex!.status,
        sent: asNumber(firstValue(ex!.requestBody, claim.param)),
        echoed: asNumber(firstValue(ex!.responseBody, echoPath)),
      };
    };
    const treatment = read("treatment");
    const control = read("control");
    // Both variants must read back a number: without the control there is no instrument check.
    const ok = treatment.sent !== null && treatment.echoed !== null && control.echoed !== null;
    const outcome = ok ? classifyRatio(treatment.sent!, treatment.echoed!) : null;
    const ratio = ok && treatment.sent !== 0 ? treatment.echoed! / treatment.sent! : null;
    return {
      outcome,
      treatment: { ...treatment, ratio },
      control,
      instrument: ok ? { treatment: treatment.echoed, control: control.echoed } : null,
      ...(ok ? {} : { note: "treatment or control has no 2xx write with a numeric sent and echoed amount" }),
    };
  },

  matches: matchesOutcome,
  informative: informativeOutcome,
};
