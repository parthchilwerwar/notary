import { z } from "zod";
import { ToolSchema } from "./common.js";

// Emitted only by the deterministic checker. traceId/spanId are "" when tracing was off.
export const AnomalySchema = z.object({
  id: z.string(),
  claimId: z.string(),
  tool: ToolSchema,
  observed: z.unknown(),
  expected: z.unknown(),
  // Stable request hash (cassette key) of the recorded exchange the checker read.
  exchangeId: z.string().optional(),
  traceId: z.string(),
  spanId: z.string(),
});
