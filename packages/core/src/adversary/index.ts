/**
 * Adversary (TDD "The notarization loop", step 8; PRD FR-7). A stronger model — or a headless
 * Claude Code session — receives a belief plus the raw probe records (never reflector prose) and
 * answers uphold / narrow / downgrade with a reason.
 *
 * reviewBelief never invents a verdict: on any malformed output or backend failure it returns
 * {review: null, failure} so the caller leaves the belief unchanged. BLOCKED (missing model id or
 * AWS credentials) and a separation-of-duties ModelConfigError propagate from the bedrock backend.
 */
import { AGENT_SPAN_ATTR, LlmClient } from "../llm/index.js";
import { AGENTS } from "../schema/agents.js";
import type { LlmLike } from "../llm/index.js";
import type { Belief, Claim, Probe } from "../schema/index.js";
import { withSpan } from "../trace/index.js";
import { withAgent } from "../trace/agent.js";
import { reportIncident } from "../incidents/live.js";
import { adversaryFailureSummary } from "../incidents/derive.js";
import type { SpanIds } from "../trace/index.js";
import { reviewWithBedrock } from "./bedrock.js";
import { buildEvidencePacket } from "./evidence-packet.js";
import { reviewWithSession } from "./session.js";
import type { GitRunner, ReviewOutcome, SessionRunner } from "./types.js";

export type AdversaryBackend = "bedrock" | "session";

export type ReviewBeliefArgs = {
  belief: Belief;
  claim: Claim;
  probes: readonly Probe[];
  backend: AdversaryBackend;
  /** bedrock: the LLM client (defaults to a new LlmClient from env). */
  llm?: LlmLike;
  /** session: replaces the real `claude` spawn (tests). */
  sessionRunner?: SessionRunner;
  /** session: the repo the inbox/verdict files live in (default: nearest ancestor with .git). */
  repoRoot?: string;
  /** session: commit the verdict + inbox files (default true). */
  commit?: boolean;
  /** session: replaces the real `git` spawn (tests). */
  gitRunner?: GitRunner;
  /** session: CLI timeout in ms (default 5 minutes). */
  timeoutMs?: number;
};

export async function reviewBelief(args: ReviewBeliefArgs): Promise<ReviewOutcome> {
  let built: ReturnType<typeof buildEvidencePacket>;
  try {
    built = buildEvidencePacket({ belief: args.belief, claim: args.claim, probes: args.probes });
  } catch (err) {
    return { review: null, failure: `adversary: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { packet, json } = built;
  let setAttr: ((k: string, v: string | number | boolean) => void) | undefined;
  let setAgentAttr: ((k: string, v: string | number | boolean) => void) | undefined;
  let reviewSpan: SpanIds | undefined;
  // One Adversary run = one AGENT span; its review is the EVALUATOR span inside (model call under it).
  return withAgent("adversary", { "notary.beliefId": args.belief.id, "notary.claimId": args.claim.id, "notary.adversary.backend": args.backend }, () => withSpan(
    "notary.adversary",
    {
      [AGENT_SPAN_ATTR]: AGENTS.adversary.name,
      "notary.beliefId": args.belief.id,
      "notary.claimId": args.claim.id,
      "notary.adversary.backend": args.backend,
      "notary.adversary.probes": packet.probes.length,
    },
    async () => {
      const outcome =
        args.backend === "bedrock"
          ? await reviewWithBedrock({ packetJson: json, llm: args.llm ?? new LlmClient() })
          : await reviewWithSession({
              beliefId: args.belief.id,
              packetJson: json,
              ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
              ...(args.commit !== undefined ? { commit: args.commit } : {}),
              ...(args.sessionRunner ? { sessionRunner: args.sessionRunner } : {}),
              ...(args.gitRunner ? { gitRunner: args.gitRunner } : {}),
              ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
            });
      if (setAttr) {
        setAttr("notary.verdict", outcome.review?.verdict ?? "none");
        if (outcome.failure) setAttr("notary.adversary.failure", outcome.failure.slice(0, 300));
      }
      setAgentAttr?.("notary.verdict", outcome.review?.verdict ?? "none");
      if (outcome.failure && reviewSpan) {
        // Incident: no usable review (fail-safe: the belief is not certified). Same id as derive.ts.
        reportIncident({
          kind: "model_error",
          subject: reviewSpan.spanId,
          severity: "error",
          summary: adversaryFailureSummary(args.belief.id, outcome.failure),
          attrs: { "notary.beliefId": args.belief.id, "notary.claimId": args.claim.id, "notary.agent_id": "adversary" },
        });
      }
      const review = outcome.review;
      if (review && (review.verdict === "downgrade" || review.verdict === "narrow")) {
        // Incident: the Adversary refused to uphold a belief the Reflector wanted certified.
        reportIncident({
          kind: "adversary_downgrade",
          subject: `${args.belief.id}|${review.reviewedAt ?? ""}`,
          severity: "warning",
          summary: `The Adversary ${review.verdict === "narrow" ? "narrowed" : "downgraded"} ${args.belief.id} instead of upholding it (model ${review.model}).`,
          attrs: { "notary.beliefId": args.belief.id, "notary.claimId": args.claim.id, "notary.verdict": review.verdict, "notary.tool": args.belief.tool },
        });
      }
      return outcome;
    },
    { kind: "EVALUATOR", onSpan: (ids, set) => ((reviewSpan = ids), (setAttr = set)) },
  ), { onSpan: (_ids, set) => (setAgentAttr = set) });
}

export {
  FORBIDDEN_PROSE_FIELDS,
  PACKET_KIND,
  PACKET_VERSION,
  assertNoReflectorProse,
  buildEvidencePacket,
  scrubSecrets,
} from "./evidence-packet.js";
export type { BuiltPacket, EvidencePacket, PacketPrediction, PacketProbe } from "./evidence-packet.js";
export {
  REVIEWER_QUESTIONS,
  REVIEWER_SYSTEM_PROMPT,
  ReviewerReplySchema,
  parseReviewerText,
  sessionReviewerPrompt,
  validateReply,
} from "./prompt.js";
export type { ReviewerReply } from "./prompt.js";
export { ADVERSARY_MAX_TOKENS, reviewWithBedrock } from "./bedrock.js";
export {
  CLAUDE_COMMAND,
  SESSION_MODEL,
  childEnv,
  claudeArgs,
  findRepoRoot,
  inboxRelPath,
  parseSessionResult,
  reviewWithSession,
  spawnGitRunner,
  spawnSessionRunner,
  verdictRelPath,
} from "./session.js";
export type { GitRunner, ProcessResult, ReviewOutcome, SessionRunner } from "./types.js";
