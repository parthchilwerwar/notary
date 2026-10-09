import { z } from "zod";
import { DefectClassSchema, ProbeTemplateSchema } from "./common.js";

export const HypothesisSchema = z.object({
  id: z.string(),
  anomalyId: z.string(),
  class: DefectClassSchema,
  statement: z.string(),
  distinguishingTest: ProbeTemplateSchema,
});
