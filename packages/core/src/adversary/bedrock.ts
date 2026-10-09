/**
 * `bedrock` adversary backend: one `llm.complete` call with role "adversary". The llm module picks
 * NOTARY_MODEL_ADVERSARY and rejects a roster where it equals the reflector (separation of duties).
 *
 * Fail safe: a malformed, prose-only or schema-violating reply, or a non-credential transport
 * error, yields {review: null, failure} — never a thrown error and never a guessed verdict.
 * BLOCKED (missing model id / AWS credentials) and ModelConfigError propagate unchanged.
 */
import type { LlmLike } from "../llm/index.js";
import type { AdversaryReview } from "../schema/index.js";
import { isBlocked } from "../tools/errors.js";
import { REVIEWER_SYSTEM_PROMPT, parseReviewerText, reviewReason, reviewerUserMessage } from "./prompt.js";
import type { ReviewOutcome } from "./types.js";

export const ADVERSARY_MAX_TOKENS = 1500;

function mustPropagate(err: unknown): boolean {
  return isBlocked(err) || (err instanceof Error && err.name === "ModelConfigError");
}

export async function reviewWithBedrock(args: {
  packetJson: string;
  llm: LlmLike;
  now?: () => Date;
}): Promise<ReviewOutcome> {
  let text: string;
  let modelId: string;
  try {
    const res = await args.llm.complete({
      role: "adversary",
      system: REVIEWER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: reviewerUserMessage(args.packetJson) }],
      maxTokens: ADVERSARY_MAX_TOKENS,
    });
    text = res.text;
    modelId = res.modelId;
  } catch (err) {
    if (mustPropagate(err)) throw err;
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { review: null, failure: `adversary (bedrock) call failed: ${msg}` };
  }

  const parsed = parseReviewerText(text);
  if (!parsed.ok) return { review: null, failure: `adversary (bedrock): ${parsed.failure}` };

  const review: AdversaryReview = {
    verdict: parsed.reply.verdict,
    reason: reviewReason(parsed.reply),
    model: modelId,
    backend: "bedrock",
    ...(parsed.reply.scope ? { scope: parsed.reply.scope } : {}),
    reviewedAt: (args.now ?? (() => new Date()))().toISOString(),
  };
  return { review };
}
