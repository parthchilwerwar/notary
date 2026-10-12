// The shape of src/explainer/assets.json, written by scripts/explainer-prep.ts from what is on disk:
// the voice agent's files (explainer/voice), the recording agent's clips (explainer/clips), the
// user's optional screen recording (explainer/user) and the real data (explainer/data, falling back
// to the published records in packages/web/public and the local run receipts). Every value the
// Explainer composition shows comes from here; `status` says whether an asset is the real delivered
// file or a placeholder still waiting for it.
import { z } from "zod";

export const SECTION_IDS = ["intro", "problem", "notary", "stack", "neatlogs", "entire", "cfo", "close"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const WordSchema = z.object({ text: z.string(), startSec: z.number(), endSec: z.number() });
export type Word = z.infer<typeof WordSchema>;

export const VoiceSchema = z.object({
  /** real: the voice agent's mp3 + word timings. placeholder: timings estimated from NARRATION.md, no audio. */
  status: z.enum(["real", "placeholder"]),
  /** Path under public/ of the voice audio (the mp3 as delivered), null for a placeholder. */
  src: z.string().nullable(),
  durationSec: z.number().positive(),
  words: z.array(WordSchema).min(1),
});

export const ClipEventSchema = z.object({
  tSec: z.number(),
  type: z.enum(["move", "click", "scroll", "type"]),
  x: z.number(),
  y: z.number(),
  label: z.string().optional(),
});
export type ClipEvent = z.infer<typeof ClipEventSchema>;

export const ClipSchema = z.object({
  status: z.enum(["real", "missing"]),
  src: z.string().nullable(),
  durationSec: z.number().nonnegative(),
  width: z.number(),
  height: z.number(),
  url: z.string().nullable(),
  events: z.array(ClipEventSchema),
});
export type Clip = z.infer<typeof ClipSchema>;

const Attr = z.union([z.string(), z.number(), z.boolean()]);

export const SpanSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  kind: z.string().nullable(),
  /** notary.agent attribute, when the span has one (never inferred). */
  agent: z.string().nullable(),
  model: z.string().nullable(),
  /** ms from the trace's first span start. */
  startMs: z.number(),
  endMs: z.number(),
  status: z.string().nullable(),
  /** HTTP status of the call, only when the data carries one (span attribute or the bundle probe it cites). */
  httpStatus: z.number().nullable(),
  httpStatusSource: z.string().nullable(),
  attrs: z.record(z.string(), Attr),
  /** api: the span is in the neatlogs API response. receipt: only in the run's local receipts (spans.jsonl). */
  origin: z.enum(["api", "receipt"]),
  /** True when the notary.* attributes shown come from the local receipt of the same span id. */
  attrsFromReceipt: z.boolean(),
});
export type Span = z.infer<typeof SpanSchema>;

export const TraceSchema = z.object({
  traceId: z.string(),
  runId: z.string().nullable(),
  /** Where these spans were read from, shown on screen. */
  source: z.string(),
  startedAt: z.string().nullable(),
  /** Trace summary as the source reports it (null when the source has none). */
  meta: z.object({ spanCount: z.number().nullable(), errorCount: z.number().nullable(), detections: z.number().nullable(), status: z.string().nullable(), endpoint: z.string().nullable() }),
  spans: z.array(SpanSchema),
  /** Probe receipts from the run bundle for probes in this trace (prediction committed / call ran). */
  probes: z.array(
    z.object({
      id: z.string(),
      spanId: z.string(),
      claimId: z.string(),
      committedAt: z.string(),
      ranAt: z.string().nullable(),
      predictionHash: z.string(),
      observedStatus: z.number().nullable(),
      observedOutcome: z.string().nullable(),
      verdict: z.string(),
    }),
  ),
});
export type Trace = z.infer<typeof TraceSchema>;

export const IncidentSchema = z.object({
  id: z.string(),
  runId: z.string(),
  kind: z.string(),
  severity: z.string(),
  at: z.string(),
  tool: z.string().nullable(),
  agent: z.string().nullable(),
  summary: z.string(),
  claimId: z.string().nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  expected: z.number().nullable(),
  observed: z.number().nullable(),
  resolution: z.object({ status: z.string(), action: z.string(), summary: z.string() }),
});
export type Incident = z.infer<typeof IncidentSchema>;

export const CheckpointSchema = z.object({
  id: z.string(),
  at: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  commit: z.string(),
  message: z.string(),
});

export const AssetsSchema = z.object({
  narration: z.record(z.string(), z.string()),
  voice: z.record(z.string(), VoiceSchema),
  clips: z.record(z.string(), ClipSchema),
  user: z.object({ neatlogsIncidents: z.object({ src: z.string(), durationSec: z.number().positive(), width: z.number(), height: z.number() }).nullable() }),
  data: z.object({
    traces: z.array(TraceSchema),
    tracesSource: z.string(),
    incidents: z.array(IncidentSchema),
    incidentsSource: z.string(),
    entire: z.object({
      source: z.string(),
      cliVersion: z.string().nullable(),
      checkpoints: z.array(CheckpointSchema),
      coverage: z.object({ sites: z.number(), guarded: z.number(), rawByDesign: z.number(), unguardedCallSites: z.number(), callEdges: z.number(), commit: z.string() }).nullable(),
    }),
    coverage: z.object({ source: z.string(), command: z.string().nullable(), lines: z.array(z.string()) }).nullable(),
    economics: z.object({
      source: z.string(),
      costPerRun: z.object({ usd: z.number(), credits: z.number() }),
      costPerCertificate: z.object({ usd: z.number(), credits: z.number() }),
      liveRuns: z.number(),
      certified: z.array(z.object({ tool: z.string(), certified: z.number() })),
      planImported: z.boolean(),
      exportPath: z.string(),
      exportHead: z.array(z.string()),
    }),
    evalSuite: z.object({
      source: z.string(),
      label: z.string(),
      naiveUnsafe: z.number(),
      guardedUnsafe: z.number(),
      held: z.number(),
      queueSize: z.number().nullable(),
    }),
    certificates: z.array(
      z.object({ id: z.string(), tool: z.string(), claimId: z.string(), status: z.string(), verdict: z.string(), scope: z.string(), evidence: z.number(), sha256: z.string(), adversaryVerdict: z.string().nullable(), issuedAt: z.string() }),
    ),
    certificatesSource: z.string(),
    /** The model behind each agent, read from the run traces' LLM spans (llm.model_id / llm.provider). */
    models: z.array(z.object({ agent: z.string(), model: z.string(), provider: z.string().nullable() })),
    /** The AWS deploy kit as it is in the repo (file names + the deploy doc's title); nothing about a running deployment. */
    aws: z.object({ docPath: z.string(), docTitle: z.string(), dir: z.string(), files: z.array(z.string()) }),
    github: z.string(),
  }),
});
export type Assets = z.infer<typeof AssetsSchema>;
