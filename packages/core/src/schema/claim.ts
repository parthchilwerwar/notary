import { z } from "zod";
import { ExpectRuleSchema, ToolSchema } from "./common.js";

export const ClaimSchema = z.object({
  id: z.string(),
  tool: ToolSchema,
  operation: z.string(),
  param: z.string(),
  docText: z.string(),
  expect: ExpectRuleSchema,
  docUrl: z.string(),
  // HTTP endpoint the operation maps to, e.g. "POST /refunds".
  endpoint: z.string().optional(),
  // Estimated credits per call; feeds the probe cost score.
  costCredits: z.number().nonnegative().optional(),
});
