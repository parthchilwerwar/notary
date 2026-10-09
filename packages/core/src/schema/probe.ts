import { z } from "zod";
import { ProbeTemplateSchema } from "./common.js";

export const ProbeVerdictSchema = z.enum([
  "confirmed",
  "refuted",
  "inconclusive",
  "uninformative",
  "invalid",
]);

export const ProbeSchema = z.object({
  id: z.string(),
  hypothesisIds: z.array(z.string()),
  template: ProbeTemplateSchema,
  params: z.record(z.string(), z.unknown()),
  // hypothesis id -> predicted observation; immutable after committedAt
  prediction: z.record(z.string(), z.unknown()),
  committedAt: z.iso.datetime(),
  observed: z.unknown().optional(),
  verdict: ProbeVerdictSchema.optional(),
  costCredits: z.number().nonnegative(),
  traceId: z.string(),
});
