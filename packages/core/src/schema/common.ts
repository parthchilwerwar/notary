import { z } from "zod";

export const ToolSchema = z.enum(["crustdata", "dodo"]);

export const DefectClassSchema = z.enum([
  "silent_truncation",
  "silent_coercion",
  "unit_mismatch",
  "undocumented_flag",
  "eventual_consistency",
  "idempotency_hazard",
  "rate_limit",
  "expiry",
  "mislabelled_semantics",
  "honored",
]);

export const ProbeTemplateSchema = z.enum([
  "boundary_sweep",
  "unit_roundtrip",
  "retry_after_timeout",
  "pagination_completeness",
  "write_then_read",
  "unknown_param",
  "type_edge",
  "header_burst",
]);

export const RoleSchema = z.enum(["executor", "reflector", "adversary"]);

export const ExpectRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("maxItems"), max: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("type"), field: z.string(), type: z.string() }),
  z.object({ kind: z.literal("unit"), field: z.string(), unit: z.string() }),
  z.object({ kind: z.literal("statusOnError"), status: z.number().int() }),
  z.object({ kind: z.literal("idempotentOnRetry") }),
  z.object({ kind: z.literal("errorOnUnknownParam") }),
  z.object({ kind: z.literal("fieldPresent"), field: z.string() }),
  z.object({ kind: z.literal("consistentWithin"), ms: z.number().int().nonnegative() }),
]);
