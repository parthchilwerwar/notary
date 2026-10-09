import { z } from "zod";
import { RequestTypeSchema } from "./common.js";

// One billing request in the queue (seeded fixture, P3). Money amounts are integer minor units (cents).
export const QueueRequestSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  customerEmail: z.string().optional(),
  companyDomain: z.string(),
  type: RequestTypeSchema,
  plan: z.string(),
  paymentId: z.string().optional(),
  subscriptionId: z.string().optional(),
  amount: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  targetPlan: z.string().optional(),
  reason: z.string(),
  note: z.string().optional(),
});
