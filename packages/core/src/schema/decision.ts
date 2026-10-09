import { z } from "zod";
import { RequestTypeSchema, TierSchema } from "./common.js";

export const PolicyOutcomeSchema = z.enum(["approve", "partial", "deny", "escalate"]);

export const DecisionStatusSchema = z.enum(["executed", "held", "escalated", "denied"]);

// One external call a decision made; reads are included so read-backs are visible.
export const EffectSchema = z.object({
  op: z.string(), // e.g. "dodo.createRefund"
  params: z.record(z.string(), z.unknown()),
  // HTTP status; null when the outcome is unknown (timeout, connection reset).
  status: z.number().int().nullable(),
  resultId: z.string().optional(),
  amount: z.number().int().optional(), // minor units
  currency: z.string().optional(),
  at: z.iso.datetime(),
});

// Attached to held and escalated items for the human reviewer.
export const EvidencePackSchema = z.object({
  reason: z.string(),
  missingBeliefs: z.array(z.string()),
  relatedProbeIds: z.array(z.string()),
  spanIds: z.array(z.string()),
  traceLinks: z.record(z.string(), z.string()),
});

// Unsafe money actions counted by the deterministic grader (TDD "Metrics").
export const UnsafeActionSchema = z.enum(["duplicate", "wrong_unit", "missed_existing_refund"]);

// Deterministic grade against fixtures/queue/expected.json; absent when there is no ground truth.
export const DecisionGradeSchema = z.object({
  expectedOutcome: PolicyOutcomeSchema,
  expectedStatus: DecisionStatusSchema.optional(),
  correct: z.boolean(),
  unsafe: z.array(UnsafeActionSchema),
});

export const DecisionSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  customerId: z.string(),
  tier: TierSchema,
  requestType: RequestTypeSchema,
  policyOutcome: PolicyOutcomeSchema,
  action: z.string(),
  requiredBeliefs: z.array(z.string()),
  missingBeliefs: z.array(z.string()),
  status: DecisionStatusSchema,
  guardsApplied: z.array(z.string()),
  effects: z.array(EffectSchema),
  evidencePack: EvidencePackSchema.optional(),
  grade: DecisionGradeSchema.optional(),
  // Raw enrichment fields the tier was derived from (e.g. headcount, funding).
  enrichment: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  traceId: z.string(), // "" when tracing was off
});
