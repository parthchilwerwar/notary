// FROZEN at end of P1; changes need user approval and a Codex sample regeneration.
// This file is the dashboard contract (TDD "Dashboard contract"). Schema files import only zod
// so packages/web can use them in the browser.
import { z } from "zod";
import { AnomalySchema } from "./anomaly.js";
import { BeliefEventSchema, BeliefSchema } from "./belief.js";
import { ClaimSchema } from "./claim.js";
import { Sha256HexSchema, ToolSchema } from "./common.js";
import { DecisionSchema } from "./decision.js";
import { GuardSchema } from "./guard.js";
import { HypothesisSchema } from "./hypothesis.js";
import { ProbeSchema } from "./probe.js";
import { QueueRequestSchema } from "./queue.js";

export const RunModeSchema = z.enum(["live", "replay"]);

// What produced the bundle: a queue run, a notarization run, or synthetic sample data.
export const BundleKindSchema = z.enum(["run", "notarize", "sample"]);

export const BundleVariantSchema = z.enum(["naive", "guarded", "notarize", "sample"]);

export const RunStatusSchema = z.enum(["completed", "stopped_budget", "blocked", "failed"]);

export const RoleUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
});

// All three roles are always present (zeros when a role made no calls).
export const UsageByRoleSchema = z.object({
  executor: RoleUsageSchema,
  reflector: RoleUsageSchema,
  adversary: RoleUsageSchema,
});

export const CreditsSchema = z.object({
  byEndpoint: z.record(z.string(), z.number().nonnegative()),
  total: z.number().nonnegative(),
  budget: z.number().nonnegative(),
});

export const RunBundleSchema = z.object({
  runId: z.string(),
  kind: BundleKindSchema,
  variant: BundleVariantSchema,
  mode: RunModeSchema,
  sample: z.boolean(),
  // Human-readable labels the dashboard must show (seeded data, sample data, drift fixture).
  disclosure: z.array(z.string()),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  status: RunStatusSchema,
  stopReason: z.string().optional(),
  seed: z.number().int(),
  tool: ToolSchema.optional(), // notarize bundles
  priorsFrom: ToolSchema.optional(),
  replayOf: z.string().optional(), // runId this replay reproduces
  queue: z.array(QueueRequestSchema),
  decisions: z.array(DecisionSchema),
  claims: z.array(ClaimSchema),
  anomalies: z.array(AnomalySchema),
  hypotheses: z.array(HypothesisSchema),
  probes: z.array(ProbeSchema),
  beliefs: z.object({
    before: z.array(BeliefSchema),
    after: z.array(BeliefSchema),
  }),
  beliefEvents: z.array(BeliefEventSchema),
  guards: z.array(GuardSchema),
  usageByRole: UsageByRoleSchema,
  credits: CreditsSchema,
  // null = not computable for this run (e.g. no data).
  metrics: z.record(z.string(), z.number().nullable()),
  noiseFloor: z.record(z.string(), z.number()).optional(),
  // trace id -> URL; when a trace id is absent, show the id as text.
  traceLinks: z.record(z.string(), z.string()),
  cassettes: z.array(z.string()),
  // sha256 hex of canonicalJson(bundle without contentHash); see core/src/bundle/hash.ts.
  contentHash: Sha256HexSchema,
});

// public/bundles/index.json: one entry per bundle, sorted by startedAt.
export const BundleIndexEntrySchema = z.object({
  runId: z.string(),
  kind: BundleKindSchema,
  variant: BundleVariantSchema,
  mode: RunModeSchema,
  sample: z.boolean(),
  startedAt: z.iso.datetime(),
  status: RunStatusSchema,
  contentHash: Sha256HexSchema,
});

export const BundleIndexSchema = z.array(BundleIndexEntrySchema);
