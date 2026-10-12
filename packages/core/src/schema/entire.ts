// packages/web/public/evidence/entire.json: what Entire recorded for this repo, written by
// `notary export --entire` from the real Entire CLI (src/entire/). Never typed by hand.
//
//   - checkpoints: Entire checkpoints on the current branch (`entire checkpoint list --json`), each
//     enriched with `entire checkpoint explain <id> --json` (files touched, model, tokens) and the
//     commit that carries its `Entire-Checkpoint` trailer. An adversary verdict commit
//     (`adversary: <verdict> <beliefId>`) is marked as a review, so the dashboard can tie a
//     checkpointed review to the belief and to the bundle's adversary.sessionId.
//   - coverage: the guard-coverage result of the `entire` backend (`entire graph edges`).
// Empty lists always come with the reason (`checkpointsNote`, `coverageNote`). No prompts or
// transcripts are copied: Entire keeps those in its own refs.
import { z } from "zod";
import { AdversaryVerdictSchema } from "./belief.js";

export const ENTIRE_FILE_KIND = "notary-entire/1";

/** 26-char ULID (current) or 12-char hex (legacy), per the Entire CLI README. */
export const EntireCheckpointIdSchema = z.string().regex(/^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{12})$/);

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const EntireTokensSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheCreation: z.number().int().nonnegative(),
    apiCalls: z.number().int().nonnegative(),
  })
  .strict();

export const EntireCheckpointSchema = z
  .object({
    id: EntireCheckpointIdSchema,
    /** When the checkpoint was condensed (Entire's `date`), as UTC ISO. */
    at: z.iso.datetime(),
    /** Entire's agent label, e.g. "Claude Code". */
    agent: z.string().min(1),
    /** Agent session ids in the checkpoint (for Claude Code, the `claude` session_id). */
    sessionIds: z.array(z.string().min(1)).min(1),
    model: z.string().min(1).nullable(),
    /** Commit carrying `Entire-Checkpoint: <id>` on the current branch; null when not found. */
    commit: Sha.nullable(),
    /** The commit subject Entire recorded. */
    message: z.string(),
    filesTouched: z.array(z.string().min(1)),
    tokens: EntireTokensSchema.nullable(),
    kind: z.enum(["adversary-review", "coding-session"]),
    /** Set for adversary verdict commits only. */
    review: z.object({ verdict: AdversaryVerdictSchema, beliefId: z.string().min(1) }).strict().nullable(),
    /** Entire's is_logs_only: the checkpoint holds session logs without a code snapshot. */
    logsOnly: z.boolean(),
  })
  .strict();

export const EntireCoverageSiteSchema = z
  .object({ op: z.string().min(1), file: z.string().min(1), line: z.number().int().nonnegative(), detail: z.string() })
  .strict();

export const EntireCoverageSchema = z
  .object({
    backend: z.literal("entire"),
    command: z.string().min(1),
    graphProvider: z.string().min(1),
    graphVersion: z.string().min(1),
    /** HEAD the graph was built on, and whether the working tree on top of it was read. */
    commit: Sha.nullable(),
    worktree: z.boolean(),
    completeness: z.string().min(1),
    skippedFiles: z.array(z.string()),
    callEdges: z.number().int().nonnegative(),
    constructEdges: z.number().int().nonnegative(),
    clientEdges: z.number().int().nonnegative(),
    ops: z.number().int().nonnegative(),
    sites: z.number().int().nonnegative(),
    guarded: z.number().int().nonnegative(),
    rawByDesign: z.number().int().nonnegative(),
    unguardedCallSites: z.number().int().nonnegative(),
    unguarded: z.array(EntireCoverageSiteSchema),
  })
  .strict()
  .refine((c) => c.unguarded.length === c.unguardedCallSites, { message: "unguarded list must match unguardedCallSites" });

export const EntireFileSchema = z
  .object({
    kind: z.literal(ENTIRE_FILE_KIND),
    /** HEAD of the repo when the file was written. */
    repoHead: Sha.nullable(),
    branch: z.string().min(1).nullable(),
    cli: z
      .object({
        installed: z.boolean(),
        version: z.string().min(1).nullable(),
        graphPlugin: z.string().min(1).nullable(),
      })
      .strict(),
    repo: z
      .object({
        enabled: z.boolean(),
        agents: z.array(z.string().min(1)),
        /** .entire/settings.json checkpoints.primary.type, e.g. "git-refs". */
        checkpointStore: z.string().min(1).nullable(),
        commitLinking: z.enum(["always", "prompt"]).nullable(),
      })
      .strict(),
    checkpoints: z.array(EntireCheckpointSchema),
    /** Why `checkpoints` is empty (null when it is not). */
    checkpointsNote: z.string().min(1).nullable(),
    coverage: EntireCoverageSchema.nullable(),
    /** Why `coverage` is null (null when it is not). */
    coverageNote: z.string().min(1).nullable(),
  })
  .strict()
  .refine((f) => (f.checkpoints.length === 0) === (f.checkpointsNote !== null), {
    message: "checkpointsNote is required exactly when there are no checkpoints",
  })
  .refine((f) => (f.coverage === null) === (f.coverageNote !== null), {
    message: "coverageNote is required exactly when coverage is null",
  })
  .refine((f) => f.cli.installed || (f.checkpoints.length === 0 && f.coverage === null), {
    message: "checkpoints and coverage need the Entire CLI",
  });

export type EntireCheckpoint = z.infer<typeof EntireCheckpointSchema>;
export type EntireCoverage = z.infer<typeof EntireCoverageSchema>;
export type EntireFile = z.infer<typeof EntireFileSchema>;
