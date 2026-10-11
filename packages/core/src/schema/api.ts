// Redesign R1 contract: the `notary serve` REST surface the web data layer's LiveSource talks to.
// Browser-safe (zod only). Everything served comes from the real agent's files and integrations;
// no handler returns canned data. The bundle schema stays frozen.
import { z } from "zod";
import { AgentIdSchema } from "./agents.js";
import { BundleIndexEntrySchema } from "./bundle.js";
import { CertificateReportSchema, ToolCertificatesSchema } from "./certificate.js";
import { ToolSchema } from "./common.js";

// ---- GET /api/health ------------------------------------------------------------------------

export const IntegrationNameSchema = z.enum(["llm", "crustdata", "dodo", "neatlogs", "entire"]);

// connected  = a real check against the service succeeded (e.g. GET /v1/models, a Dodo test-mode read)
// configured = every variable is set but no zero-cost check exists, so nothing was verified
// missing    = a required variable (or CLI) is absent — `variable` names it
// error      = configured, but the check failed — `detail` is one line, secrets scrubbed
export const IntegrationStateSchema = z.enum(["connected", "configured", "missing", "error"]);

export const IntegrationStatusSchema = z.object({
  name: IntegrationNameSchema,
  state: IntegrationStateSchema,
  // Exactly "connected", "configured", "missing <VAR>" or "error <one line>".
  label: z.string(),
  variable: z.string().optional(),
  detail: z.string().optional(),
  // The exact fix, e.g. "Set DODO_PAYMENTS_API_KEY in .env (test mode key), then restart `pnpm notary serve`".
  fix: z.string().optional(),
  checkedAt: z.iso.datetime(),
});

// P2: the agent roster with the model each one runs on, from config (NOTARY_MODEL_*), never hardcoded.
// model = null when the role's variable is unset; always null for the Guard (a deterministic rule).
export const AgentStatusSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  role: z.string(),
  kind: z.enum(["model", "rule"]),
  model: z.string().nullable(),
});

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("notary serve"),
  integrations: z.array(IntegrationStatusSchema),
  agents: z.array(AgentStatusSchema).optional(),
});

// ---- runs ----------------------------------------------------------------------------------

// POST /api/runs (token + localhost). Starts a real run with the real agent.
export const StartRunRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queue"), variant: z.enum(["guarded", "naive"]) }),
  z.object({ kind: z.literal("notarize"), tool: ToolSchema }),
]);

export const StartRunResponseSchema = z.object({
  runId: z.string(),
  state: z.literal("running"),
});

// GET /api/runs: finished runs (verified bundles) plus runs started by this server still running.
export const RunListEntrySchema = BundleIndexEntrySchema.extend({
  state: z.enum(["running", "finished"]),
});
// A running run has no bundle yet; only these fields are known.
export const RunningRunSchema = z.object({
  runId: z.string(),
  state: z.literal("running"),
  kind: z.enum(["run", "notarize"]),
  startedAt: z.iso.datetime(),
});
export const RunsListResponseSchema = z.object({
  runs: z.array(z.union([RunListEntrySchema, RunningRunSchema])),
});

// GET /api/runs/:id -> the hash-verified RunBundle (RunBundleSchema) or 202 { state: "running" }.
// GET /api/runs/:id/events -> SSE; each `data:` is a TimelineEvent (schema/timeline.ts), the same
// events written to runs/<runId>/timeline.jsonl; replays the file first, then live events; a final
// `event: end` when run.finished has been sent.

// ---- certificates --------------------------------------------------------------------------

// GET /api/certificates: certificates derived from the real (non-sample) runs this server sees.
export const CertificatesResponseSchema = z.object({
  world: z.literal("real"),
  tools: z.array(ToolCertificatesSchema),
  report: CertificateReportSchema.nullable(),
});

// ---- approvals -----------------------------------------------------------------------------

// POST /api/approvals/:id/approve and /reject; :id is the pending item's `id`
// ("appr-" + sha256(runId \n decisionId)[:16], the same id its ApprovalRecord will carry).
export const ApproveBodySchema = z.object({ confirmedAmount: z.number().int() });
export const RejectBodySchema = z.object({ reason: z.string().trim().min(1) });

export type IntegrationName = z.infer<typeof IntegrationNameSchema>;
export type IntegrationState = z.infer<typeof IntegrationStateSchema>;
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type AgentStatusEntry = z.infer<typeof AgentStatusSchema>;
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;
export type RunListEntry = z.infer<typeof RunListEntrySchema>;
export type RunningRun = z.infer<typeof RunningRunSchema>;
export type RunsListResponse = z.infer<typeof RunsListResponseSchema>;
export type CertificatesResponse = z.infer<typeof CertificatesResponseSchema>;
export type ApproveBody = z.infer<typeof ApproveBodySchema>;
export type RejectBody = z.infer<typeof RejectBodySchema>;
