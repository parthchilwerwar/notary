import { z } from "zod";

export const BeliefStatusSchema = z.enum([
  "hypothesis",
  "candidate",
  "notarized",
  "refuted",
  "abstained",
  "unlearned",
]);

export const EvidenceSchema = z.object({
  probeId: z.string(),
  traceId: z.string(),
  spanId: z.string().optional(),
});

export const AdversaryVerdictSchema = z.enum(["uphold", "narrow", "downgrade"]);

export const AdversaryReviewSchema = z.object({
  verdict: AdversaryVerdictSchema,
  reason: z.string(),
  model: z.string(),
  sessionId: z.string().optional(),
});

export const BeliefSchema = z.object({
  id: z.string(),
  claimId: z.string(),
  statement: z.string(),
  alpha: z.number().positive(),
  beta: z.number().positive(),
  confidence: z.number().min(0).max(1),
  status: BeliefStatusSchema,
  evidence: z.array(EvidenceSchema),
  adversary: AdversaryReviewSchema.optional(),
});
