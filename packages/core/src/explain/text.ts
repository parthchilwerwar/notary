// Answer assembly: every factual sentence is added together with the records it is read from.
// A sentence without a citation is refused, except an explicit `absent` sentence that states a
// record does not exist (there is nothing to cite for something that is not there).
import type { Certificate, Revocation } from "../schema/certificate.js";
import type { Citation, ExplainAnswer, ExplainQuestionKind } from "../schema/explain.js";
import { ExplainAnswerSchema } from "../schema/explain.js";
import type { Decision, Guard, Probe } from "../schema/index.js";

const key = (c: Citation): string => `${c.kind}\u0000${c.id}\u0000${c.runId ?? ""}`;

export class AnswerWriter {
  private readonly parts: string[] = [];
  private readonly cites: Citation[] = [];
  private readonly seen = new Set<string>();
  private readonly runs = new Set<string>();

  constructor(prefix?: string) {
    if (prefix) this.parts.push(prefix);
  }

  /** A sentence read from `cites` (at least one). */
  say(text: string, cites: readonly Citation[]): void {
    if (!cites.length) throw new Error(`explain: refusing an uncited sentence: ${text}`);
    this.parts.push(sentence(text));
    for (const c of cites) this.cite(c);
  }

  /** A sentence stating that a record is absent (no record to cite). */
  absent(text: string): void {
    this.parts.push(sentence(text));
  }

  /** Runs the answer is about (also added from every citation's runId). */
  run(runId: string): void {
    this.runs.add(runId);
  }

  get citationCount(): number {
    return this.cites.length;
  }

  private cite(c: Citation): void {
    const k = key(c);
    if (c.runId) this.runs.add(c.runId);
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.cites.push(c);
  }

  build(meta: { id: string; kind: ExplainQuestionKind; question: string; sample: boolean }): ExplainAnswer {
    return ExplainAnswerSchema.parse({
      ...meta,
      answer: this.parts.join(" "),
      citations: this.cites,
      runIds: [...this.runs].sort(),
    });
  }
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// --- citations ---------------------------------------------------------------------------------

const withTrace = (c: Citation, traceId: string | undefined): Citation => (traceId ? { ...c, traceId } : c);

export const cite = {
  decision: (runId: string, d: Decision): Citation => withTrace({ kind: "decision", id: d.id, runId }, d.traceId || undefined),
  probe: (runId: string, p: Probe): Citation => withTrace({ kind: "probe", id: p.id, runId }, p.traceId || undefined),
  belief: (runId: string, beliefId: string): Citation => ({ kind: "belief", id: beliefId, runId }),
  beliefEvent: (runId: string, beliefId: string, index: number): Citation => ({ kind: "belief_event", id: `${beliefId}#${index}`, runId }),
  claim: (runId: string, claimId: string): Citation => ({ kind: "claim", id: claimId, runId }),
  guard: (runId: string, g: Guard): Citation => ({ kind: "guard", id: g.id, runId }),
  certificate: (c: Certificate): Citation => ({ kind: "certificate", id: c.id, runId: c.sourceBundle.runId }),
  revocation: (r: Revocation): Citation => withTrace({ kind: "revocation", id: r.id, runId: r.sourceBundle.runId }, r.triggerTraceIds[0]),
};

// --- formatting (numbers are computed from records, never typed in) ------------------------------

/** Probability with 4 decimals. */
export const p4 = (x: number): string => x.toFixed(4);

/** A number as recorded, with float noise removed (6 decimals). */
export function num(x: number): string {
  return String(Math.round(x * 1e6) / 1e6);
}

export function signed(x: number): string {
  const r = Math.round(x * 1e6) / 1e6;
  return r > 0 ? `+${r}` : String(r);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a, b and c". */
export function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Counts of values, in first-seen order: "confirmed ×5, uninformative ×1". */
export function tally(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([v, n]) => `${v} ×${n}`).join(", ");
}

/** Strip the "belief-" prefix for readability (ids stay intact in citations). */
export function claimOfBelief(beliefId: string): string {
  return beliefId.startsWith("belief-") ? beliefId.slice("belief-".length) : beliefId;
}

/** Recorded free text, quoted, on one line. */
export function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim().replace(/[.]$/, "")}"`;
}
