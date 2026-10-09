import { z } from "zod";

// TDD data-model table and "Queue execution and guards" disagree; using the fuller snake_case list (see docs/DECISIONS.md).
export const GuardKindSchema = z.enum([
  "transform",
  "require_param",
  "precheck",
  "retry_policy",
  "paginate_fully",
  "block",
]);

export const GuardSchema = z.object({
  id: z.string(),
  beliefId: z.string(),
  operation: z.string(),
  kind: GuardKindSchema,
  rule: z.record(z.string(), z.unknown()),
});
