import { z } from "zod";

export const PolicyOutcomeSchema = z.enum(["approve", "partial", "deny", "escalate"]);

export const DecisionStatusSchema = z.enum(["executed", "held", "escalated", "denied"]);

export const DecisionSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  policyOutcome: PolicyOutcomeSchema,
  action: z.string(),
  requiredBeliefs: z.array(z.string()),
  missingBeliefs: z.array(z.string()),
  status: DecisionStatusSchema,
  guardsApplied: z.array(z.string()),
  traceId: z.string(),
});
