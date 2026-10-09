// P0 stub: the run bundle schema freezes at the end of P1.
import { z } from "zod";
import { AnomalySchema } from "./anomaly.js";
import { BeliefSchema } from "./belief.js";
import { ClaimSchema } from "./claim.js";
import { RoleSchema } from "./common.js";
import { DecisionSchema } from "./decision.js";
import { GuardSchema } from "./guard.js";
import { ProbeSchema } from "./probe.js";

export const RunModeSchema = z.enum(["live", "replay"]);

export const RoleUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});

export const RunBundleSchema = z.object({
  runId: z.string(),
  mode: RunModeSchema,
  startedAt: z.iso.datetime(),
  seed: z.number().int(),
  queue: z.array(z.unknown()),
  decisions: z.array(DecisionSchema),
  claims: z.array(ClaimSchema),
  anomalies: z.array(AnomalySchema),
  probes: z.array(ProbeSchema),
  beliefs: z.object({
    before: z.array(BeliefSchema),
    after: z.array(BeliefSchema),
  }),
  guards: z.array(GuardSchema),
  usageByRole: z.record(RoleSchema, RoleUsageSchema),
  credits: z.record(z.string(), z.number().nonnegative()),
  metrics: z.record(z.string(), z.number()),
  traceLinks: z.record(z.string(), z.string()),
  contentHash: z.string(),
});
