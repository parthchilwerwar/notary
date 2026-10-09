import type { z } from "zod";
import type {
  DefectClassSchema,
  ExpectRuleSchema,
  ProbeTemplateSchema,
  RoleSchema,
  ToolSchema,
} from "./common.js";
import type { ClaimSchema } from "./claim.js";
import type { AnomalySchema } from "./anomaly.js";
import type { HypothesisSchema } from "./hypothesis.js";
import type { ProbeSchema, ProbeVerdictSchema } from "./probe.js";
import type {
  AdversaryReviewSchema,
  AdversaryVerdictSchema,
  BeliefSchema,
  BeliefStatusSchema,
  EvidenceSchema,
} from "./belief.js";
import type { GuardKindSchema, GuardSchema } from "./guard.js";
import type { DecisionSchema, DecisionStatusSchema, PolicyOutcomeSchema } from "./decision.js";
import type { RoleUsageSchema, RunBundleSchema, RunModeSchema } from "./bundle.js";

export * from "./common.js";
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
export type ExpectRule = z.infer<typeof ExpectRuleSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Anomaly = z.infer<typeof AnomalySchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type ProbeVerdict = z.infer<typeof ProbeVerdictSchema>;
export type Probe = z.infer<typeof ProbeSchema>;
export type BeliefStatus = z.infer<typeof BeliefStatusSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type AdversaryVerdict = z.infer<typeof AdversaryVerdictSchema>;
export type AdversaryReview = z.infer<typeof AdversaryReviewSchema>;
export type Belief = z.infer<typeof BeliefSchema>;
export type GuardKind = z.infer<typeof GuardKindSchema>;
export type Guard = z.infer<typeof GuardSchema>;
export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type RunMode = z.infer<typeof RunModeSchema>;
export type RoleUsage = z.infer<typeof RoleUsageSchema>;
export type RunBundle = z.infer<typeof RunBundleSchema>;
