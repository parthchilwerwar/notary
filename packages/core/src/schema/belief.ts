import { z } from "zod";
import { DefectClassSchema, ToolSchema } from "./common.js";

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
  // Evidence-validity check (P5): did the cited span actually vary the claim's param? Absent until checked.
  valid: z.boolean().optional(),
});

export const AdversaryVerdictSchema = z.enum(["uphold", "narrow", "downgrade"]);

export const AdversaryBackendSchema = z.enum(["bedrock", "session"]);

export const AdversaryReviewSchema = z.object({
  verdict: AdversaryVerdictSchema,
  reason: z.string(),
  model: z.string(),
  sessionId: z.string().optional(),
  backend: AdversaryBackendSchema.optional(),
  // The narrowed scope when verdict is `narrow`.
  scope: z.string().optional(),
  reviewedAt: z.iso.datetime().optional(),
});

// The Beta prior a belief started from when transfer priors were used (TDD step 9).
export const BeliefPriorSchema = z.object({
  alpha: z.number().positive(),
  beta: z.number().positive(),
  from: ToolSchema,
});

export const BeliefSchema = z.object({
  id: z.string(),
  claimId: z.string(),
  tool: ToolSchema,
  class: DefectClassSchema.optional(),
  statement: z.string(),
  alpha: z.number().positive(),
  beta: z.number().positive(),
  // P(doc claim holds) under Beta(alpha, beta).
  confidence: z.number().min(0).max(1),
  status: BeliefStatusSchema,
  evidence: z.array(EvidenceSchema),
  adversary: AdversaryReviewSchema.optional(),
  prior: BeliefPriorSchema.optional(),
  probesToCandidate: z.number().int().nonnegative().optional(),
  updatedAt: z.iso.datetime(),
});

// Append-only log of status/confidence changes (TDD `belief_events`). `from` is null on creation.
export const BeliefEventSchema = z.object({
  beliefId: z.string(),
  at: z.iso.datetime(),
  from: BeliefStatusSchema.nullable(),
  to: BeliefStatusSchema,
  alpha: z.number().positive(),
  beta: z.number().positive(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  probeId: z.string().optional(),
});
