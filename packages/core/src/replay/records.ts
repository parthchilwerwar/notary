/**
 * Record-level identity for `notary replay` (P9 AUDIT-19). Metrics alone can match while the records
 * behind them differ (a different probe verdict, belief or decision that happens to give the same
 * counts), so the command also compares the records themselves, section by section. Only fields a
 * replay must reproduce are compared: run-local values (trace/span ids, commit timestamps, the
 * replay's own runId) are left out, exactly as the replay identity tests do.
 */
import { canonicalJson } from "../bundle/hash.js";
import type { RunBundle } from "../schema/index.js";

type Records = Pick<RunBundle, "probes" | "hypotheses" | "anomalies" | "beliefs" | "decisions">;

export interface RecordRow {
  section: "probes" | "hypotheses" | "anomalies" | "beliefs" | "decisions";
  original: number;
  replay: number;
  match: boolean;
  /** First difference, when there is one. */
  detail?: string;
}

const probeView = (p: RunBundle["probes"][number]) => ({
  id: p.id,
  claimId: p.claimId,
  template: p.template,
  params: p.params,
  control: p.control,
  prediction: p.prediction,
  predictionHash: p.predictionHash,
  observed: p.observed,
  verdict: p.verdict,
  winningHypothesisId: p.winningHypothesisId,
  costCredits: p.costCredits,
  calls: p.calls,
});

const anomalyView = (a: RunBundle["anomalies"][number]) => ({ ...a, traceId: "", spanId: "" });

const beliefView = (b: RunBundle["beliefs"]["after"][number]) => ({
  id: b.id,
  status: b.status,
  alpha: b.alpha,
  beta: b.beta,
  confidence: b.confidence,
  class: b.class,
  statement: b.statement,
  evidence: b.evidence.map((e) => [e.probeId, e.valid]),
  adversary: b.adversary?.verdict,
});

const decisionView = (d: RunBundle["decisions"][number]) => ({
  id: d.requestId,
  status: d.status,
  action: d.action,
  grade: d.grade,
  guards: d.guardsApplied,
  missing: d.missingBeliefs,
  pack: d.evidencePack ? { reason: d.evidencePack.reason, missing: d.evidencePack.missingBeliefs, probes: d.evidencePack.relatedProbeIds } : null,
  effects: d.effects.map((e) => [e.op, e.status, e.amount]),
});

function keyOf(v: unknown, i: number): string {
  const o = v as { id?: unknown };
  return typeof o?.id === "string" ? o.id : `#${i}`;
}

function compareSection(section: RecordRow["section"], a: readonly unknown[], b: readonly unknown[]): RecordRow {
  const row: RecordRow = { section, original: a.length, replay: b.length, match: true };
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i >= a.length || i >= b.length) {
      row.match = false;
      row.detail = `${section}: ${a.length} original vs ${b.length} replayed`;
      break;
    }
    if (canonicalJson(a[i]) !== canonicalJson(b[i])) {
      row.match = false;
      row.detail = `${section}: ${keyOf(a[i], i)} differs`;
      break;
    }
  }
  return row;
}

/** Compare the records a replay must reproduce; allMatch only when every section is identical. */
export function compareRecords(original: Records, replay: Records): { rows: RecordRow[]; allMatch: boolean } {
  const rows = [
    compareSection("probes", original.probes.map(probeView), replay.probes.map(probeView)),
    compareSection("hypotheses", original.hypotheses, replay.hypotheses),
    compareSection("anomalies", original.anomalies.map(anomalyView), replay.anomalies.map(anomalyView)),
    compareSection("beliefs", original.beliefs.after.map(beliefView), replay.beliefs.after.map(beliefView)),
    compareSection("decisions", original.decisions.map(decisionView), replay.decisions.map(decisionView)),
  ];
  return { rows, allMatch: rows.every((r) => r.match) };
}

export function formatRecords(rows: readonly RecordRow[]): string[] {
  return rows.map((r) => `  records ${r.section.padEnd(10)} ${String(r.original).padStart(4)} | ${String(r.replay).padStart(4)} | ${r.match ? "yes" : `NO (${r.detail ?? "differs"})`}`);
}
