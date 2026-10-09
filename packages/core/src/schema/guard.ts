import { z } from "zod";
import { DefectClassSchema } from "./common.js";

// TDD data-model table and "Queue execution and guards" disagree; using the fuller snake_case list (see docs/DECISIONS.md).
export const GuardKindSchema = z.enum([
  "transform",
  "require_param",
  "precheck",
  "retry_policy",
  "paginate_fully",
  "block",
]);

// Compiled from notarized beliefs only; retired (active=false, retiredAt set) when its belief is unlearned.
export const GuardSchema = z.object({
  id: z.string(),
  beliefId: z.string(),
  operation: z.string(),
  kind: GuardKindSchema,
  class: DefectClassSchema,
  rule: z.record(z.string(), z.unknown()),
  reason: z.string(),
  active: z.boolean(),
  compiledAt: z.iso.datetime(),
  retiredAt: z.iso.datetime().optional(),
});
