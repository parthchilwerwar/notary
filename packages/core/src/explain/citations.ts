// Record index + citation validation shared by the explain engine and POST /api/ask.
// A citation is valid only if the record it names exists in the loaded data (and, when the
// citation names a run, in that run). Nothing a model says is trusted without this check.
import type { Citation, CitationKind } from "../schema/explain.js";
import type { RunBundle } from "../schema/index.js";

export interface IndexedRecord {
  kind: CitationKind;
  id: string;
  runId?: string;
  traceId?: string;
  sample: boolean;
  record: unknown;
}

export class RecordIndex {
  private readonly byKey = new Map<string, IndexedRecord[]>();

  add(rec: IndexedRecord): void {
    const key = `${rec.kind}:${rec.id}`;
    const list = this.byKey.get(key) ?? [];
    list.push(rec);
    this.byKey.set(key, list);
  }

  /** Every record with this kind and id (optionally only in one run). */
  find(kind: CitationKind, id: string, runId?: string): IndexedRecord[] {
    const list = this.byKey.get(`${kind}:${id}`) ?? [];
    return runId === undefined ? list : list.filter((r) => r.runId === runId);
  }

  has(c: Citation): boolean {
    return this.find(c.kind, c.id, c.runId).length > 0;
  }

  get size(): number {
    let n = 0;
    for (const list of this.byKey.values()) n += list.length;
    return n;
  }

  all(): IndexedRecord[] {
    return [...this.byKey.values()].flat();
  }
}

/** Index every citable record in the bundles (decisions, probes, hypotheses, beliefs, events, claims, anomalies, guards). */
export function indexBundles(bundles: readonly RunBundle[], index = new RecordIndex()): RecordIndex {
  for (const b of bundles) {
    const base = { runId: b.runId, sample: b.sample };
    for (const d of b.decisions) index.add({ ...base, kind: "decision", id: d.id, traceId: d.traceId || undefined, record: d });
    for (const p of b.probes) index.add({ ...base, kind: "probe", id: p.id, traceId: p.traceId || undefined, record: p });
    for (const h of b.hypotheses) index.add({ ...base, kind: "hypothesis", id: h.id, record: h });
    for (const bl of [...b.beliefs.before, ...b.beliefs.after]) {
      if (!index.find("belief", bl.id, b.runId).length) index.add({ ...base, kind: "belief", id: bl.id, record: bl });
    }
    b.beliefEvents.forEach((e, i) => index.add({ ...base, kind: "belief_event", id: `${e.beliefId}#${i}`, record: e }));
    for (const c of b.claims) {
      if (!index.find("claim", c.id, b.runId).length) index.add({ ...base, kind: "claim", id: c.id, record: c });
    }
    for (const a of b.anomalies) index.add({ ...base, kind: "anomaly", id: a.id, record: a });
    for (const g of b.guards) index.add({ ...base, kind: "guard", id: g.id, record: g });
  }
  return index;
}

export interface CitationCheck {
  ok: boolean;
  invalid: Citation[];
}

/** Every citation must resolve; an empty list is invalid (an answer needs evidence). */
export function validateCitations(citations: readonly Citation[], index: RecordIndex): CitationCheck {
  const invalid = citations.filter((c) => !index.has(c));
  return { ok: citations.length > 0 && invalid.length === 0, invalid };
}

// --- certificates, revocations, timelines, approvals ---------------------------------------------
// Structural types so this module stays independent of where the certificate schemas live.

export interface CitableCertificate {
  id: string;
  sample: boolean;
  sourceBundle: { runId: string };
}

export interface CitableRevocation {
  id: string;
  sample: boolean;
  sourceBundle: { runId: string };
  triggerTraceIds?: readonly string[];
}

/**
 * Index certificates and revocations (one entry per tool file: `{ certificates, revocations }`).
 * Their `runId` is the source bundle they were derived from, so a citation naming a run must name
 * that one.
 */
export function indexCertificates(
  sets: readonly { certificates: readonly CitableCertificate[]; revocations: readonly CitableRevocation[] }[],
  index = new RecordIndex(),
): RecordIndex {
  for (const s of sets) {
    for (const c of s.certificates) {
      if (!index.find("certificate", c.id, c.sourceBundle.runId).length) {
        index.add({ kind: "certificate", id: c.id, runId: c.sourceBundle.runId, sample: c.sample, record: c });
      }
    }
    for (const r of s.revocations) {
      if (!index.find("revocation", r.id, r.sourceBundle.runId).length) {
        index.add({ kind: "revocation", id: r.id, runId: r.sourceBundle.runId, sample: r.sample, traceId: r.triggerTraceIds?.[0], record: r });
      }
    }
  }
  return index;
}

/** Timeline event citation id: "<runId>#<seq>" (events carry no id of their own). */
export function timelineEventId(runId: string, seq: number): string {
  return `${runId}#${seq}`;
}

/** Index published timelines (TimelineFile shape). */
export function indexTimelines(
  files: readonly { runId: string; sample: boolean; events: readonly { seq: number; traceIds: readonly string[] }[] }[],
  index = new RecordIndex(),
): RecordIndex {
  for (const f of files) {
    for (const e of f.events) {
      index.add({ kind: "timeline_event", id: timelineEventId(f.runId, e.seq), runId: f.runId, sample: f.sample, traceId: e.traceIds[0], record: e });
    }
  }
  return index;
}

/** Index approval records (ApprovalsFile shape); `sample` is the run's flag. */
export function indexApprovals(
  files: readonly { runId: string; sample: boolean; approvals: readonly { id: string; traceId?: string }[] }[],
  index = new RecordIndex(),
): RecordIndex {
  for (const f of files) {
    for (const a of f.approvals) index.add({ kind: "approval", id: a.id, runId: f.runId, sample: f.sample, traceId: a.traceId, record: a });
  }
  return index;
}
