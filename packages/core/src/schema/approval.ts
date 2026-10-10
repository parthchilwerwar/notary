// v2 approval desk contract. Browser-safe: zod only.
// Records live in runs/<runId>/approvals.json (an ApprovalsFile); GET/POST /api/approvals on the
// local `notary serve` only (localhost + per-session token, Dodo test mode only).
import { z } from "zod";
import { EffectSchema } from "./decision.js";

export const ApprovalDecisionSchema = z.enum(["approved", "rejected"]);

export const ApprovalRecordSchema = z.object({
  id: z.string(), // "appr-" + sha256(runId, decisionId)[:16]; one record per held decision
  runId: z.string(),
  decisionId: z.string(),
  requestId: z.string(),
  action: z.string(),
  decision: ApprovalDecisionSchema,
  // Minor units the human typed to confirm (approve only); must equal the held amount.
  confirmedAmount: z.number().int().optional(),
  currency: z.string().optional(),
  // Required, non-empty for rejections.
  reason: z.string().optional(),
  // Always true: the action bypassed the certificate gate because a human said so.
  humanOverride: z.literal(true),
  // External calls the approved action made through the guarded clients (empty for rejections).
  effects: z.array(EffectSchema),
  status: z.enum(["executed", "failed", "closed"]),
  error: z.string().optional(),
  decidedAt: z.iso.datetime(),
  traceId: z.string().optional(),
});

export const ApprovalsFileSchema = z.object({
  runId: z.string(),
  approvals: z.array(ApprovalRecordSchema),
});

// One held item as GET /api/approvals lists it.
export const PendingApprovalSchema = z.object({
  // Same id the ApprovalRecord will carry; used by POST /api/approvals/:id/approve|reject.
  id: z.string().optional(),
  runId: z.string(),
  decisionId: z.string(),
  requestId: z.string(),
  action: z.string(),
  amount: z.number().int().optional(),
  currency: z.string().optional(),
  reason: z.string(),
  missingBeliefs: z.array(z.string()),
});

export const ApprovalsListSchema = z.object({
  testMode: z.boolean(),
  pending: z.array(PendingApprovalSchema),
  decided: z.array(ApprovalRecordSchema),
});

export const ApprovalRequestSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    runId: z.string(),
    decisionId: z.string(),
    confirmedAmount: z.number().int(),
  }),
  z.object({
    decision: z.literal("rejected"),
    runId: z.string(),
    decisionId: z.string(),
    reason: z.string().trim().min(1),
  }),
]);

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type ApprovalsFile = z.infer<typeof ApprovalsFileSchema>;
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;
export type ApprovalsList = z.infer<typeof ApprovalsListSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
