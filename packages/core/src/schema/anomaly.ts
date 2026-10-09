import { z } from "zod";

export const AnomalySchema = z.object({
  id: z.string(),
  claimId: z.string(),
  observed: z.unknown(),
  expected: z.unknown(),
  traceId: z.string(),
  spanId: z.string(),
});
