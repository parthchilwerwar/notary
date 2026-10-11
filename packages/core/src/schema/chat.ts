// Notary Chat contract (C1–C3). Browser-safe: zod only.
//
// REST (local `notary serve`, localhost + session token like /api/ask):
//   POST   /api/chat                         -> { conversation }            (create)
//   GET    /api/chat                         -> { conversations }           (newest first)
//   GET    /api/chat/:id                     -> { conversation, messages }
//   DELETE /api/chat/:id                     -> 204
//   POST   /api/chat/:id/messages {content}  -> text/event-stream of ChatEvent, one `data:` JSON per event,
//                                               `event:` = the event's `type`. Client abort = Stop.
// The same ChatEvent shapes are produced by the web's replay chat engine (deterministic, no backend).
import { z } from "zod";

export const ChatToolNameSchema = z.enum([
  "search_certificates",
  "get_certificate",
  "list_runs",
  "get_run",
  "get_run_events",
  "list_approvals",
  "get_approval",
  "fetch_doc",
  "crustdata_lookup",
  "dodo_lookup",
  "get_health",
]);

// ok = tool ran; error = tool ran and failed (detail in output); unavailable = not connected / not in
// replay / not allowlisted — `fix` says what to do (e.g. "Not connected — set CRUSTDATA_API_KEY").
export const ChatStepStatusSchema = z.enum(["ok", "error", "unavailable", "aborted"]);

export const ChatCitationTypeSchema = z.enum(["certificate", "run_event", "run", "approval", "doc", "api_response"]);

export const ChatCitationSchema = z.object({
  n: z.number().int().positive(), // the [n] marker in the answer text
  type: ChatCitationTypeSchema,
  id: z.string(), // certificate id, "<runId>#<seq>", runId, approval id, doc URL, or "<stepId>" for api_response
  label: z.string(),
  stepId: z.string().optional(), // the step whose output contains it (validated server-side)
  url: z.string().optional(), // doc URL when type = doc
  valid: z.boolean(), // false = flagged: did not match any step output of this turn
});

export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("step_started"),
    id: z.string(),
    tool: ChatToolNameSchema,
    title: z.string(), // plain language, e.g. "Looking up Acme Corp in Crustdata"
    input: z.string(), // short input summary, no secrets
  }),
  z.object({
    type: z.literal("step_finished"),
    id: z.string(),
    status: ChatStepStatusSchema,
    durationMs: z.number().nonnegative(),
    costUsd: z.number().nonnegative().nullable(), // null = unknown price / not a priced call
    credits: z.number().nonnegative().optional(), // Crustdata credits used
    output: z.string(), // one-line output summary
    data: z.unknown().optional(), // structured result for the UI card (size-capped)
    fix: z.string().optional(),
  }),
  z.object({
    type: z.literal("note"),
    text: z.string().max(200), // short line (~20 words) explaining the next step
    // model = written by the executor model (shown "Model said"); replay = written by the web's
    // deterministic replay engine (shown "Replay engine" — no model ran).
    source: z.enum(["model", "replay"]),
  }),
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("citations"), items: z.array(ChatCitationSchema) }),
  z.object({
    type: z.literal("done"),
    costUsd: z.number().nonnegative().nullable(), // null when any priced call had an unknown price
    tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }),
    traceId: z.string().optional(),
    steps: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    mode: z.enum(["live", "replay"]),
  }),
  z.object({ type: z.literal("error"), message: z.string(), fix: z.string().optional() }),
]);

export const ChatConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const ChatMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(["user", "assistant"]),
  // user: the question; assistant: the final answer markdown (with [n] markers)
  content: z.string(),
  // assistant only: the full event stream as recorded, so a reload re-renders steps and citations
  events: z.array(ChatEventSchema).optional(),
  createdAt: z.iso.datetime(),
});

export const CreateConversationResponseSchema = z.object({ conversation: ChatConversationSchema });
export const ConversationsListSchema = z.object({ conversations: z.array(ChatConversationSchema) });
export const ConversationDetailSchema = z.object({
  conversation: ChatConversationSchema,
  messages: z.array(ChatMessageSchema),
});
export const SendMessageBodySchema = z.object({ content: z.string().trim().min(1).max(4000) });

export type ChatToolName = z.infer<typeof ChatToolNameSchema>;
export type ChatStepStatus = z.infer<typeof ChatStepStatusSchema>;
export type ChatCitationType = z.infer<typeof ChatCitationTypeSchema>;
export type ChatCitation = z.infer<typeof ChatCitationSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;
export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;
