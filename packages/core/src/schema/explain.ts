// v2 explain engine + Ask Notary contracts. Browser-safe: zod only.
//
// Explain answers are deterministic (packages/core/src/explain/), built from records only.
// Ask answers come from the executor model but every citation is validated against loaded data.
import { z } from "zod";

export const CitationKindSchema = z.enum([
  "decision",
  "probe",
  "hypothesis",
  "belief",
  "belief_event",
  "claim",
  "anomaly",
  "guard",
  "certificate",
  "revocation",
  "approval",
  "timeline_event",
]);

export const CitationSchema = z.object({
  kind: CitationKindSchema,
  // Record id within its run (decision.id, probe.id, belief.id, certificate id, ...).
  id: z.string(),
  runId: z.string().optional(),
  traceId: z.string().optional(),
});

export const ExplainQuestionKindSchema = z.enum(["why_held", "tool_knowledge", "run_diff", "revocations"]);

export const ExplainAnswerSchema = z.object({
  // Stable id: sha-free, e.g. "why_held:<runId>:<decisionId>".
  id: z.string(),
  kind: ExplainQuestionKindSchema,
  question: z.string(),
  // Plain text; every factual sentence is backed by a citation below.
  answer: z.string(),
  citations: z.array(CitationSchema).min(1),
  runIds: z.array(z.string()),
  sample: z.boolean(),
});

// packages/web/public/content/explain.json
export const ExplainFileSchema = z.object({
  generatedBy: z.literal("notary export --explain"),
  answers: z.array(ExplainAnswerSchema),
});

// POST /api/ask (local `notary serve` only).
export const AskRequestSchema = z.object({
  question: z.string().min(1).max(2000),
  runId: z.string().optional(),
});

export const AskResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    answer: z.string(),
    citations: z.array(CitationSchema).min(1),
    traceId: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    // Always exactly this text for an answer that failed validation or had no evidence.
    answer: z.literal("couldn't answer from the evidence"),
    reason: z.string(),
    traceId: z.string().optional(),
  }),
]);

export type CitationKind = z.infer<typeof CitationKindSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type ExplainQuestionKind = z.infer<typeof ExplainQuestionKindSchema>;
export type ExplainAnswer = z.infer<typeof ExplainAnswerSchema>;
export type ExplainFile = z.infer<typeof ExplainFileSchema>;
export type AskRequest = z.infer<typeof AskRequestSchema>;
export type AskResponse = z.infer<typeof AskResponseSchema>;
