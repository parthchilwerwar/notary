import type { AdversaryReview } from "../schema/index.js";

/**
 * The session backend's verdict commit and the Entire checkpoint linked to it (the commit's
 * `Entire-Checkpoint` trailer; null when Entire did not checkpoint it, e.g. Entire not enabled).
 */
export type EntireLink = { commit: string; checkpointId: string | null };

/** Result of one adversary review. `review` is null whenever anything failed (fail safe). */
export type ReviewOutcome = { review: AdversaryReview | null; failure?: string; entire?: EntireLink };

export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean };

/** Runs the headless Claude Code CLI. Injectable so tests never spawn a real session. */
export type SessionRunner = (req: {
  /** Executable name ("claude"). */
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
}) => Promise<ProcessResult>;

/** Runs `git <args>` in `cwd`. Injectable so tests never touch the real repo's history. */
export type GitRunner = (args: string[], cwd: string) => Promise<ProcessResult>;
