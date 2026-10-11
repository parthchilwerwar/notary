// The shape of src/data.json: exactly what the film shows, written by scripts/props.ts from the
// published, hash-verified records in packages/web/public (never typed in). The composition parses
// data.json with this schema before rendering a single frame, so a missing or malformed value
// fails the render instead of being papered over.
import { z } from "zod";

const Counts = z.object({ executed: z.number().int().nonnegative(), held: z.number().int().nonnegative(), unsafe: z.number().int().nonnegative() });

export const ShowreelDataSchema = z.object({
  /** Where every value came from (not shown on screen). */
  source: z.object({
    scenario: z.string(),
    naive: z.object({ runId: z.string(), contentHash: z.string() }),
    guarded: z.object({ runId: z.string(), contentHash: z.string() }),
    notarize: z.array(z.object({ runId: z.string(), contentHash: z.string() })),
    certificateReport: z.string(),
  }),
  /** The naive run: grader total and the money-action rows the transcript streams. */
  naive: z.object({
    unsafe: z.number().int().nonnegative(),
    rows: z
      .array(
        z.object({
          requestId: z.string(),
          type: z.string(),
          action: z.string(),
          amount: z.string().nullable(),
          /** Grader's unsafe kinds for this decision ([] = graded safe). */
          unsafe: z.array(z.string()),
          /** True for the second call of a write retried after a client timeout. */
          retry: z.boolean(),
        }),
      )
      .min(4),
  }),
  guarded: z.object({
    unsafe: z.number().int().nonnegative(),
    refundsHeld: z.number().int().nonnegative(),
    queueSize: z.number().int().positive(),
  }),
  predict: z.object({
    probe: z.string(),
    claimId: z.string(),
    template: z.string(),
    committedClock: z.string(),
    expected: z.string(),
    call: z.object({ op: z.string(), args: z.string() }).nullable(),
    observed: z.array(z.object({ key: z.string(), value: z.string(), mismatch: z.boolean() })).min(1),
  }),
  challenge: z.object({
    claimId: z.string(),
    hypothesis: z.string(),
    counter: z.string(),
    verdict: z.enum(["uphold", "narrow", "downgrade"]),
    challenges: z.number().int().positive(),
    survived: z.number().int().nonnegative(),
  }),
  certificate: z.object({
    id: z.string(),
    tool: z.string(),
    claimId: z.string(),
    scope: z.string(),
    evidence: z.number().int().positive(),
    issued: z.string(),
    sha256: z.string(),
  }),
  guard: z.object({
    allowed: z.object({ requestId: z.string(), type: z.string(), action: z.string(), amount: z.string().nullable(), detail: z.string() }),
    held: z.object({ requestId: z.string(), type: z.string(), action: z.string(), amount: z.string().nullable(), detail: z.string() }),
  }),
  chart: z.object({
    rows: z.array(z.object({ type: z.string(), label: z.string(), naive: Counts, guarded: Counts })).min(1),
  }),
  chat: z.object({
    question: z.string(),
    steps: z.array(z.object({ title: z.string(), output: z.string(), durationMs: z.number().nullable() })).min(2),
    answer: z.string(),
    citations: z.array(z.object({ n: z.number().int().positive(), label: z.string() })).min(1),
  }),
  /** Credits line from the landing ("Built with"): text only, no status claimed. */
  builtWith: z.array(z.string()).min(3),
  github: z.string(),
});

export type ShowreelData = z.infer<typeof ShowreelDataSchema>;
