// Ask Notary: pure logic (no React). World filtering, grouping, citation -> URL mapping and
// response validation. Tested in test/ask.test.ts against the published explain.json.
import {
  AskRequestSchema,
  AskResponseSchema,
  ExplainFileSchema,
  ToolSchema,
  type AskRequest,
  type AskResponse,
  type Citation,
  type ExplainAnswer,
  type ExplainQuestionKind,
  type RunBundle,
} from "../../../../core/src/schema";
import { recordPath, withRun } from "../../app/links";

/** The only failure text an ask may show (AskResponseSchema's literal). */
export const ASK_FAILED_TEXT = "couldn't answer from the evidence" as const;

/** One line under every Ask surface. */
export const READ_ONLY_NOTE = "Ask Notary is read-only.";

// ---------------------------------------------------------------------------------------------
// Data worlds. Mirrors packages/core/src/explain/world.ts `worldKeyOf` (web may not import it):
// "real" for sample:false, "synthetic" for the dashboard's SAMPLE bundle, else
// "fixture:<scenario>" from the "(fixture scenario <name>)" disclosure; none = "default".

export type WorldKey = string;
type WorldFields = Pick<RunBundle, "sample" | "kind" | "variant" | "disclosure">;

const SCENARIO_RE = /\(fixture scenario ([A-Za-z0-9_-]+)\)/;

export function worldKeyOf(b: WorldFields): WorldKey {
  if (!b.sample) return "real";
  if (b.kind === "sample" || b.variant === "sample") return "synthetic";
  for (const d of b.disclosure) {
    const m = SCENARIO_RE.exec(d);
    if (m) return `fixture:${m[1]}`;
  }
  return "fixture:default";
}

export function worldLabel(key: WorldKey): string {
  if (key === "real") return "Real runs";
  if (key === "synthetic") return "Synthetic sample data";
  if (key.startsWith("fixture:"))
    return `Fixture scenario ${key.slice("fixture:".length)} (simulated APIs)`;
  return key;
}

/** runId -> world key for every verified bundle. */
export function worldIndex(bundles: readonly (WorldFields & { runId: string })[]): Map<string, WorldKey> {
  return new Map(bundles.map((b) => [b.runId, worldKeyOf(b)]));
}

/**
 * The one world an answer belongs to, from the bundles its runIds name. Undefined when a run is
 * unknown, the runs span worlds, or the answer's `sample` flag disagrees: such an answer is never
 * shown (a world we can't prove is a world we might mix).
 */
export function answerWorld(answer: Pick<ExplainAnswer, "runIds" | "sample">, worlds: Map<string, WorldKey>): WorldKey | undefined {
  if (!answer.runIds.length) return undefined;
  const keys = new Set(answer.runIds.map((id) => worlds.get(id)));
  if (keys.size !== 1) return undefined;
  const [key] = keys;
  if (key === undefined) return undefined;
  if ((key !== "real") !== answer.sample) return undefined;
  return key;
}

/**
 * Answers of the selected run's world only, answers naming the selected run first (stable
 * otherwise). Never mixes fixture scenarios, fixture with real, or synthetic with either.
 */
export function answersForRun(
  answers: readonly ExplainAnswer[],
  bundles: readonly (WorldFields & { runId: string })[],
  selectedRunId: string,
): { world: WorldKey | undefined; answers: ExplainAnswer[] } {
  const worlds = worldIndex(bundles);
  const world = worlds.get(selectedRunId);
  if (world === undefined) return { world, answers: [] };
  const inWorld = answers.filter((a) => answerWorld(a, worlds) === world);
  const named = inWorld.filter((a) => a.runIds.includes(selectedRunId));
  const rest = inWorld.filter((a) => !a.runIds.includes(selectedRunId));
  return { world, answers: [...named, ...rest] };
}

// ---------------------------------------------------------------------------------------------
// Grouping

export const KIND_GROUPS: { kind: ExplainQuestionKind; title: string }[] = [
  { kind: "why_held", title: "Why held" },
  { kind: "tool_knowledge", title: "Tool knowledge" },
  { kind: "run_diff", title: "What changed" },
  { kind: "revocations", title: "Revocations" },
];

export type AnswerGroup = { kind: ExplainQuestionKind; title: string; answers: ExplainAnswer[] };

/** Answers grouped by question kind in a fixed order; empty groups dropped. */
export function groupAnswers(answers: readonly ExplainAnswer[]): AnswerGroup[] {
  return KIND_GROUPS.map((g) => ({ ...g, answers: answers.filter((a) => a.kind === g.kind) })).filter(
    (g) => g.answers.length > 0,
  );
}

// ---------------------------------------------------------------------------------------------
// Citations

export type CitationTarget =
  | { type: "link"; to: string; kind: string; id: string; title: string }
  | { type: "text"; kind: string; id: string; title: string };

export type CitationContext = {
  /** Run to keep in `?run=` when a citation names none. */
  fallbackRunId?: string;
  /** revocation id -> certificate id, from the loaded certificate world (when known). */
  revocationCertificate?: (revocationId: string) => string | undefined;
};

const KIND_LABEL: Record<string, string> = {
  decision: "Decision",
  probe: "Probe",
  hypothesis: "Hypothesis",
  belief: "Belief",
  belief_event: "Belief event",
  claim: "Claim",
  anomaly: "Anomaly",
  guard: "Guard",
  certificate: "Certificate",
  revocation: "Revocation",
  approval: "Approval",
  timeline_event: "Timeline event",
};

export const citationKindLabel = (kind: string) => KIND_LABEL[kind] ?? kind.replaceAll("_", " ");

const TOOLS = new Set<string>(ToolSchema.options);

/**
 * Where a citation leads: the record's own URL where one exists, else the most relevant page.
 * Approvals and unknown kinds are plain text (Ask Notary never links to approval actions).
 */
export function citationTarget(c: Pick<Citation, "kind" | "id" | "runId">, ctx: CitationContext = {}): CitationTarget {
  const kind = String(c.kind);
  const run = c.runId ?? ctx.fallbackRunId;
  const link = (to: string, title: string): CitationTarget => ({ type: "link", to, kind, id: c.id, title });
  const text = (title: string): CitationTarget => ({ type: "text", kind, id: c.id, title });
  switch (kind) {
    case "decision":
      return link(withRun(recordPath.decision(c.id), run), `Open decision ${c.id}`);
    case "probe":
      return link(withRun(recordPath.probe(c.id), run), `Open probe ${c.id}`);
    case "belief":
      return link(withRun(recordPath.belief(c.id), run), `Open belief ${c.id}`);
    case "belief_event": {
      // "<beliefId>#<n>": one event in that belief's history.
      const belief = c.id.replace(/#\d+$/, "");
      return belief && belief !== c.id
        ? link(withRun(recordPath.belief(belief), run), `Open belief ${belief} (event ${c.id.slice(belief.length + 1)})`)
        : text("Belief event (no belief id)");
    }
    case "certificate":
      return link(withRun(recordPath.certificate(c.id), run), `Open certificate ${c.id}`);
    case "revocation": {
      const cert = ctx.revocationCertificate?.(c.id);
      return cert
        ? link(withRun(recordPath.certificate(cert), run), `Open revoked certificate ${cert}`)
        : link(withRun("/app/certificates", run), "Open certificates (revocations are listed there)");
    }
    case "claim": {
      // Claim ids are "<tool>.<operation>.<claim>"; the tool's certificates list every claim.
      const tool = c.id.split(".")[0] ?? "";
      return TOOLS.has(tool)
        ? link(withRun(recordPath.report(tool), run), `Open ${tool} certificates (claim ${c.id})`)
        : text("Claim");
    }
    case "guard":
      // Guards are applied on decisions; the run's transcript shows each decision's guards.
      return link(withRun("/app/run", run), `Open ${run ?? "the run"} (guard ${c.id})`);
    case "anomaly":
    case "hypothesis":
      // Anomalies and rival hypotheses are what probes test; the run's transcript shows both.
      return link(withRun("/app/run", run), `Open ${run ?? "the run"} (${kind} ${c.id})`);
    case "timeline_event": {
      // "<runId>#<seq>"
      const timelineRun = c.id.replace(/#\d+$/, "");
      return timelineRun && timelineRun !== c.id
        ? link(withRun("/app/run", timelineRun), `Open the run ${timelineRun}`)
        : text("Timeline event");
    }
    default:
      // approval and any kind this build doesn't know: shown, never linked.
      return text(citationKindLabel(kind));
  }
}

/** Citations deduplicated (kind, id, runId) and grouped by kind, first-seen order. */
export function groupCitations<C extends Pick<Citation, "kind" | "id" | "runId">>(citations: readonly C[]): { kind: string; citations: C[] }[] {
  const seen = new Set<string>();
  const groups = new Map<string, C[]>();
  for (const c of citations) {
    const key = `${c.kind}\u0000${c.id}\u0000${c.runId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = groups.get(String(c.kind)) ?? [];
    list.push(c);
    groups.set(String(c.kind), list);
  }
  return [...groups].map(([kind, list]) => ({ kind, citations: list }));
}

// ---------------------------------------------------------------------------------------------
// Validation

export type Parsed<T> = { ok: true; data: T } | { ok: false; error: string };

export function parseExplainFile(raw: unknown): Parsed<ExplainAnswer[]> {
  const parsed = ExplainFileSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, data: parsed.data.answers }
    : { ok: false, error: "explain.json does not match the shared schema. Answers withheld." };
}

/** A local /api/ask response; anything schema-invalid is an error and is never rendered. */
export function parseAskResponse(raw: unknown): Parsed<AskResponse> {
  const parsed = AskResponseSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: "The local API answered with a response that does not match the shared schema. It is not shown." };
}

export function buildAskRequest(question: string, runId: string | undefined): Parsed<AskRequest> {
  const parsed = AskRequestSchema.safeParse({ question: question.trim(), ...(runId ? { runId } : {}) });
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: question.trim() ? "Questions are limited to 2000 characters." : "Type a question first." };
}
