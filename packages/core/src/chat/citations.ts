// Citations for Notary Chat answers, validated by code against THIS turn's step outputs only.
//
// The final answer is markdown with [n] markers, followed (by protocol) by one line
//   CITATIONS: [{"n": 1, "type": "certificate", "id": "cert-…", "stepId": "s2"}, …]
// which the server strips from the streamed text (AnswerSplitter) and checks:
//   certificate / approval / run_event  -> RecordIndex (src/explain/citations.ts) built from the
//                                          citables of this turn's ok steps (kinds certificate /
//                                          revocation, approval, timeline_event "<runId>#<seq>")
//   run                                 -> a run id one of this turn's steps returned
//   doc                                 -> a URL a fetch_doc step of this turn actually read
//   api_response                        -> the id of an ok step of this turn
// A citation that matches nothing is sent with valid:false (the UI flags it), a marker with no entry
// in the block is sent as an invalid placeholder, and block entries whose marker isn't in the text are
// dropped. Labels come from the step outputs (code), never from the model.
import { z } from "zod";
import { RecordIndex } from "../explain/citations.js";
import type { CitationKind } from "../schema/explain.js";
import { ChatCitationTypeSchema } from "../schema/chat.js";
import type { ChatCitation, ChatCitationType } from "../schema/chat.js";
import type { Citable } from "./tools.js";

export const CITATIONS_SENTINEL = "CITATIONS:";

/**
 * Splits the streamed final answer into the visible text and the trailing CITATIONS block. Text is
 * released as it arrives, except a tail that could still be the start of the sentinel line.
 */
export class AnswerSplitter {
  private buf = "";
  private inBlock = false;
  private blockText = "";
  private emitted = "";

  /** Feed one delta; returns the text that is safe to show now ("" when held back). */
  push(delta: string): string {
    if (this.inBlock) {
      this.blockText += delta;
      return "";
    }
    this.buf += delta;
    const hit = this.findSentinel(this.buf);
    if (hit) {
      const out = this.buf.slice(0, hit.cut);
      this.blockText = this.buf.slice(hit.after);
      this.inBlock = true;
      this.buf = "";
      this.emitted += out;
      return out;
    }
    // Hold back a tail that might be the beginning of "\nCITATIONS:".
    const hold = this.holdLength(this.buf);
    const out = this.buf.slice(0, this.buf.length - hold);
    this.buf = this.buf.slice(this.buf.length - hold);
    this.emitted += out;
    return out;
  }

  /** End of stream: the remaining visible text and the raw block (null when there was none). */
  end(): { text: string; block: string | null } {
    const tail = this.inBlock ? "" : this.buf;
    this.emitted += tail;
    this.buf = "";
    return { text: tail, block: this.inBlock ? this.blockText : null };
  }

  /** The raw CITATIONS block after end() (null when the answer had none). */
  get block(): string | null {
    return this.inBlock ? this.blockText : null;
  }

  /** All visible text so far (trailing whitespace before the block trimmed by the caller). */
  get text(): string {
    return this.emitted;
  }

  /** The sentinel at the start of the text or of a line: where the visible text ends and the block starts. */
  private findSentinel(s: string): { cut: number; after: number } | null {
    const lineStart = this.atLineStart();
    const m = /(^|\n)[ \t]*(?:\*\*)?CITATIONS:(?:\*\*)?/.exec(lineStart ? s : `\u0000${s}`);
    if (!m) return null;
    const shift = lineStart ? 0 : 1;
    return { cut: m.index + m[1]!.length - shift, after: m.index + m[0].length - shift };
  }

  private atLineStart(): boolean {
    return this.emitted === "" || this.emitted.endsWith("\n");
  }

  private holdLength(s: string): number {
    // Longest suffix that is a prefix of "\n" + optional spaces/** + "CITATIONS:".
    const lastNl = s.lastIndexOf("\n");
    const candidates: string[] = [];
    if (lastNl >= 0) candidates.push(s.slice(lastNl));
    // Nothing shown yet and no newline: the text itself could be the start of the sentinel.
    if (this.atLineStart() && !s.includes("\n")) candidates.push(s);
    for (const c of candidates) {
      const body = c.replace(/^\n/, "").replace(/^[ \t]*(\*\*)?/, "");
      if (CITATIONS_SENTINEL.startsWith(body) && c.length <= CITATIONS_SENTINEL.length + 8) return c.length;
    }
    return 0;
  }
}

const BlockEntrySchema = z.object({
  n: z.number().int().positive(),
  type: ChatCitationTypeSchema,
  id: z.string(),
  stepId: z.string().optional(),
  label: z.string().optional(),
  url: z.string().optional(),
});
export type BlockEntry = z.infer<typeof BlockEntrySchema>;

/** Parse the CITATIONS block: a JSON array (a code fence and trailing ** tolerated). Invalid entries are dropped. */
export function parseCitationBlock(raw: string | null): { entries: BlockEntry[]; ok: boolean } {
  if (raw === null) return { entries: [], ok: false };
  let body = raw.trim().replace(/^\*\*\s*/, "");
  const fence = /^```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fence) body = fence[1]!.trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end < start) return { entries: [], ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { entries: [], ok: false };
  }
  if (!Array.isArray(parsed)) return { entries: [], ok: false };
  const entries: BlockEntry[] = [];
  for (const x of parsed) {
    const e = BlockEntrySchema.safeParse(x);
    if (e.success) entries.push(e.data);
  }
  return { entries, ok: true };
}

/** [n] markers in the answer text, in order of first appearance. */
export function markersIn(text: string): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(/\[(\d{1,3})\](?!\()/g)) seen.add(Number(m[1]));
  return [...seen];
}

export interface TurnStep {
  id: string;
  status: "ok" | "error" | "unavailable" | "aborted";
  citables: Citable[];
}

const KIND_OF: Partial<Record<ChatCitationType, CitationKind[]>> = {
  certificate: ["certificate", "revocation"],
  approval: ["approval"],
  run_event: ["timeline_event"],
};

function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString().replace(/\/$/, "");
  } catch {
    return u.trim();
  }
}

/** What this turn's ok steps let an answer cite. */
export class TurnCitables {
  readonly index = new RecordIndex();
  private readonly runs = new Map<string, { stepId: string; label: string }>();
  private readonly docs = new Map<string, { stepId: string; label: string; url: string }>();
  private readonly steps = new Map<string, { label: string }>();

  constructor(steps: readonly TurnStep[]) {
    for (const s of steps) {
      if (s.status !== "ok") continue;
      for (const c of s.citables) {
        const rec = { stepId: s.id, label: c.label };
        if (c.type === "certificate") this.index.add({ kind: c.id.startsWith("rev-") ? "revocation" : "certificate", id: c.id, sample: false, record: rec });
        else if (c.type === "approval") this.index.add({ kind: "approval", id: c.id, sample: false, record: rec });
        else if (c.type === "run_event") this.index.add({ kind: "timeline_event", id: c.id, sample: false, record: rec });
        else if (c.type === "run") {
          if (!this.runs.has(c.id)) this.runs.set(c.id, rec);
        } else if (c.type === "doc") {
          const key = normUrl(c.url ?? c.id);
          if (!this.docs.has(key)) this.docs.set(key, { ...rec, url: c.url ?? c.id });
        } else if (c.type === "api_response") {
          if (!this.steps.has(s.id)) this.steps.set(s.id, { label: c.label });
        }
      }
      if (!this.steps.has(s.id)) this.steps.set(s.id, { label: `Step ${s.id}` });
    }
  }

  /** The step + code-written label holding this record, or null. */
  resolve(type: ChatCitationType, id: string, url?: string): { stepId: string; label: string; url?: string } | null {
    const kinds = KIND_OF[type];
    if (kinds) {
      for (const k of kinds) {
        const hit = this.index.find(k, id)[0];
        if (hit) return hit.record as { stepId: string; label: string };
      }
      return null;
    }
    if (type === "run") return this.runs.get(id) ?? null;
    if (type === "doc") {
      const d = this.docs.get(normUrl(url ?? id)) ?? this.docs.get(normUrl(id));
      return d ? { stepId: d.stepId, label: d.label, url: d.url } : null;
    }
    // api_response: the id is a step id of this turn.
    const s = this.steps.get(id);
    return s ? { stepId: id, label: s.label } : null;
  }
}

/**
 * Validate an answer's citations. Every marker in the text yields exactly one ChatCitation; valid
 * only when its block entry resolves to a record in this turn's step outputs.
 */
export function validateChatCitations(text: string, block: string | null, steps: readonly TurnStep[]): { items: ChatCitation[]; invalid: number; blockOk: boolean } {
  const { entries, ok } = parseCitationBlock(block);
  const citables = new TurnCitables(steps);
  const byN = new Map<number, BlockEntry>();
  for (const e of entries) if (!byN.has(e.n)) byN.set(e.n, e);
  const items: ChatCitation[] = [];
  for (const n of markersIn(text).sort((a, b) => a - b)) {
    const e = byN.get(n);
    if (!e) {
      items.push({ n, type: "api_response", id: "", label: `[${n}] has no source listed`, valid: false });
      continue;
    }
    const hit = citables.resolve(e.type, e.id, e.url);
    if (hit) {
      items.push({
        n,
        type: e.type,
        id: e.type === "doc" ? (hit.url ?? e.id) : e.id,
        label: hit.label,
        stepId: hit.stepId,
        ...(e.type === "doc" ? { url: hit.url ?? e.id } : {}),
        valid: true,
      });
    } else {
      items.push({
        n,
        type: e.type,
        id: e.id,
        label: `${e.type} ${e.id || "(no id)"} — not in this turn's step outputs`,
        ...(e.stepId ? { stepId: e.stepId } : {}),
        ...(e.type === "doc" ? { url: e.url ?? e.id } : {}),
        valid: false,
      });
    }
  }
  return { items, invalid: items.filter((i) => !i.valid).length, blockOk: ok };
}
