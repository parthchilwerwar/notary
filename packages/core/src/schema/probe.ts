import { z } from "zod";
import { ProbeTemplateSchema, Sha256HexSchema, ToolSchema } from "./common.js";

export const ProbeVerdictSchema = z.enum([
  "confirmed",
  "refuted",
  "inconclusive",
  "uninformative",
  "invalid",
]);

// Instrument check (TDD verdict rules): if control and treatment read the same where they
// should differ, the probe is `invalid`.
export const ProbeControlSchema = z.object({
  params: z.record(z.string(), z.unknown()),
  observed: z.unknown().optional(),
});

export const ProbeSchema = z.object({
  id: z.string(),
  tool: ToolSchema,
  claimId: z.string(),
  hypothesisIds: z.array(z.string()),
  template: ProbeTemplateSchema,
  params: z.record(z.string(), z.unknown()),
  control: ProbeControlSchema.optional(),
  // hypothesis id -> predicted observation; immutable after committedAt
  prediction: z.record(z.string(), z.unknown()),
  // sha256 hex of canonicalJson(prediction) taken at commit time; proves the prediction never changed.
  predictionHash: Sha256HexSchema,
  committedAt: z.iso.datetime(),
  ranAt: z.iso.datetime().optional(),
  observed: z.unknown().optional(),
  verdict: ProbeVerdictSchema.optional(),
  // Set only when verdict is `confirmed`.
  winningHypothesisId: z.string().optional(),
  costCredits: z.number().nonnegative(),
  // HTTP calls the probe made (treatment + control).
  calls: z.number().int().nonnegative(),
  traceId: z.string(),
  spanId: z.string().optional(),
});
