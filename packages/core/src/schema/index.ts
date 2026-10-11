import type { z } from "zod";
import type {
  DefectClassSchema,
  ExpectRuleSchema,
  ProbeTemplateSchema,
  RequestTypeSchema,
  RoleSchema,
  TierSchema,
  ToolSchema,
} from "./common.js";
import type { QueueRequestSchema } from "./queue.js";
import type { ClaimSchema } from "./claim.js";
import type { AnomalySchema } from "./anomaly.js";
import type { HypothesisSchema } from "./hypothesis.js";
import type { ProbeControlSchema, ProbeSchema, ProbeVerdictSchema } from "./probe.js";
import type {
  AdversaryBackendSchema,
  AdversaryReviewSchema,
  AdversaryVerdictSchema,
  BeliefEventSchema,
  BeliefPriorSchema,
  BeliefSchema,
  BeliefStatusSchema,
  EvidenceSchema,
} from "./belief.js";
import type { GuardKindSchema, GuardSchema } from "./guard.js";
import type {
  DecisionGradeSchema,
  DecisionSchema,
  DecisionStatusSchema,
  EffectSchema,
  EvidencePackSchema,
  PolicyOutcomeSchema,
  UnsafeActionSchema,
} from "./decision.js";
import type {
  BundleIndexEntrySchema,
  BundleKindSchema,
  BundleVariantSchema,
  CreditsSchema,
  RoleUsageSchema,
  RunBundleSchema,
  RunModeSchema,
  RunStatusSchema,
  UsageByRoleSchema,
} from "./bundle.js";

export * from "./common.js";
export * from "./queue.js";
export * from "./claim.js";
export * from "./anomaly.js";
export * from "./hypothesis.js";
export * from "./probe.js";
export * from "./belief.js";
export * from "./guard.js";
export * from "./decision.js";
export * from "./bundle.js";

export type Tool = z.infer<typeof ToolSchema>;
export type DefectClass = z.infer<typeof DefectClassSchema>;
export type ProbeTemplate = z.infer<typeof ProbeTemplateSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Tier = z.infer<typeof TierSchema>;
export type RequestType = z.infer<typeof RequestTypeSchema>;
export type ExpectRule = z.infer<typeof ExpectRuleSchema>;
export type QueueRequest = z.infer<typeof QueueRequestSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Anomaly = z.infer<typeof AnomalySchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type ProbeVerdict = z.infer<typeof ProbeVerdictSchema>;
export type ProbeControl = z.infer<typeof ProbeControlSchema>;
export type Probe = z.infer<typeof ProbeSchema>;
export type BeliefStatus = z.infer<typeof BeliefStatusSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type AdversaryVerdict = z.infer<typeof AdversaryVerdictSchema>;
export type AdversaryBackend = z.infer<typeof AdversaryBackendSchema>;
export type AdversaryReview = z.infer<typeof AdversaryReviewSchema>;
export type BeliefPrior = z.infer<typeof BeliefPriorSchema>;
export type Belief = z.infer<typeof BeliefSchema>;
export type BeliefEvent = z.infer<typeof BeliefEventSchema>;
export type GuardKind = z.infer<typeof GuardKindSchema>;
export type Guard = z.infer<typeof GuardSchema>;
export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type EvidencePack = z.infer<typeof EvidencePackSchema>;
export type UnsafeAction = z.infer<typeof UnsafeActionSchema>;
export type DecisionGrade = z.infer<typeof DecisionGradeSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type RunMode = z.infer<typeof RunModeSchema>;
export type BundleKind = z.infer<typeof BundleKindSchema>;
export type BundleVariant = z.infer<typeof BundleVariantSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RoleUsage = z.infer<typeof RoleUsageSchema>;
export type UsageByRole = z.infer<typeof UsageByRoleSchema>;
export type Credits = z.infer<typeof CreditsSchema>;
export type RunBundle = z.infer<typeof RunBundleSchema>;
export type BundleIndexEntry = z.infer<typeof BundleIndexEntrySchema>;

// v2 contracts (new files; the bundle schema above stays frozen).
export * from "./timeline.js";
export * from "./explain.js";
export * from "./approval.js";

// Certificates, revocations and certificate reports (packages/web/public/certificates/**).
export * from "./certificate.js";
export * from "./api.js";
export * from "./chat.js";
