/**
 * Evidence-validity check (PRD FR-10; TDD "Integrations": the evidence check reads traces back via
 * `neatlogs-cli`, or runs/<runId>/spans.jsonl when the CLI isn't available).
 *
 * `checkEvidence` is a pure function over records: for each probe a belief cites it confirms
 *   1. the probe record exists and is for the belief's claim,
 *   2. a span record exists for it (by spanId, else a "notary.probe" span carrying its probeId),
 *   3. the span's traceId equals the cited traceId, and its notary.probeId / notary.claimId match
 *      (and notary.predictionHash, when present, equals the probe's committed hash),
 *   4. the span did not end in error,
 *   5. the probe actually VARIED the claim's parameter (see params.ts `paramVariation`: treatment
 *      vs control values at claim.param, or count/exercise for templates whose variable is the
 *      repeat count / the input record),
 *   6. the observation was informative: verdict confirmed, a non-null observed outcome, and the
 *      span's notary.verdict (when present) agrees.
 * Any failure → that evidence is invalid (the store marks valid:false and reverts the belief to
 * hypothesis).
 *
 * `loadSpanRecords` is the thin loader. neatlogs-cli is used only when the binary is on PATH AND
 * NEATLOGS_SERVICE_TOKEN is set. It was NOT installed on the build machine, so its query usage
 * could not be verified; rather than guess flags, the loader reports that and reads the JSONL.
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Belief, Claim, Probe } from "../schema/index.js";
import type { SpanRecord } from "../trace/index.js";
import type { EvidenceVerdict } from "./store.js";
import { paramVariation } from "./params.js";

export const PROBE_SPAN_NAME = "notary.probe";

export interface EvidenceCheck extends EvidenceVerdict {
  /** Every failed condition (empty when valid). */
  failures: string[];
  /** How the parameter was varied, when it was. */
  variation?: string;
}

function attr(span: SpanRecord, key: string): string | undefined {
  const v = span.attrs?.[key];
  return v === undefined ? undefined : String(v);
}

function outcomeOf(observed: unknown): unknown {
  return typeof observed === "object" && observed !== null && "outcome" in observed ? (observed as { outcome: unknown }).outcome : undefined;
}

/** Find the span a piece of evidence points at. */
export function findProbeSpan(spans: readonly SpanRecord[], ev: { probeId: string; spanId?: string | undefined }): SpanRecord | undefined {
  if (ev.spanId) {
    const bySpan = spans.find((s) => s.spanId === ev.spanId);
    if (bySpan) return bySpan;
  }
  return spans.find((s) => s.name === PROBE_SPAN_NAME && attr(s, "notary.probeId") === ev.probeId);
}

/** Check every cited piece of evidence of `belief`. Pure. */
export function checkEvidence(input: {
  belief: Pick<Belief, "id" | "claimId" | "evidence">;
  claim: Claim;
  probes: readonly Probe[];
  spans: readonly SpanRecord[];
}): EvidenceCheck[] {
  const { belief, claim, spans } = input;
  const probes = new Map(input.probes.map((p) => [p.id, p]));
  return belief.evidence.map((ev): EvidenceCheck => {
    const failures: string[] = [];
    let variation: string | undefined;
    const probe = probes.get(ev.probeId);
    if (claim.id !== belief.claimId) failures.push(`claim ${claim.id} is not the belief's claim ${belief.claimId}`);
    if (!probe) {
      failures.push("probe record missing");
    } else if (probe.claimId !== belief.claimId) {
      failures.push(`probe is for claim ${probe.claimId}, not ${belief.claimId}`);
    }

    const span = findProbeSpan(spans, ev);
    if (!span) {
      failures.push(`span missing (trace ${ev.traceId || "(none)"}${ev.spanId ? `, span ${ev.spanId}` : ""})`);
    } else {
      if (!ev.traceId || span.traceId !== ev.traceId) failures.push(`trace id mismatch: cited ${ev.traceId || "(none)"}, span has ${span.traceId}`);
      if (attr(span, "notary.probeId") !== ev.probeId) failures.push(`span notary.probeId ${attr(span, "notary.probeId") ?? "(none)"} != ${ev.probeId}`);
      if (attr(span, "notary.claimId") !== belief.claimId) failures.push(`span notary.claimId ${attr(span, "notary.claimId") ?? "(none)"} != ${belief.claimId}`);
      const hash = attr(span, "notary.predictionHash");
      if (probe && hash !== undefined && hash !== probe.predictionHash) failures.push("span notary.predictionHash differs from the committed prediction hash");
      if (span.status === "error") failures.push(`span ended in error${span.error ? ` (${span.error})` : ""}`);
      const spanVerdict = attr(span, "notary.verdict");
      if (probe && spanVerdict !== undefined && spanVerdict !== probe.verdict) failures.push(`span notary.verdict ${spanVerdict} != probe verdict ${probe.verdict ?? "(none)"}`);
    }

    if (probe) {
      const v = paramVariation(claim, probe);
      if (v.varied) variation = v.how;
      else failures.push(`parameter not varied: ${v.how}`);
      if (probe.verdict !== "confirmed") failures.push(`uninformative: verdict ${probe.verdict ?? "(none)"}`);
      const outcome = outcomeOf(probe.observed);
      if (outcome === null || outcome === undefined) failures.push("uninformative: no observed outcome");
    }

    return {
      probeId: ev.probeId,
      valid: failures.length === 0,
      reason: failures.length ? failures.join("; ") : `span verified; ${variation}`,
      failures,
      ...(variation ? { variation } : {}),
    };
  });
}

// ------------------------------------------------------------------ loader

/** Parse spans.jsonl text; malformed lines are skipped. */
export function parseSpanJsonl(text: string): SpanRecord[] {
  const out: SpanRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as SpanRecord;
      if (rec && typeof rec.spanId === "string" && typeof rec.traceId === "string" && typeof rec.name === "string") out.push({ ...rec, attrs: rec.attrs ?? {} });
    } catch {
      // skip
    }
  }
  return out;
}

/** Path of the neatlogs-cli binary on PATH, if any. */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".ps1"] : [""];
  for (const d of dirs) for (const e of exts) if (existsSync(join(d, bin + e))) return join(d, bin + e);
  return undefined;
}

export interface SpanSource {
  source: "neatlogs-cli" | "jsonl";
  records: SpanRecord[];
  notes: string[];
}

/** Load span records for the given runs: neatlogs-cli when usable, else runs/<runId>/spans.jsonl. */
export function loadSpanRecords(opts: { runsDir: string; runIds: readonly string[]; env?: NodeJS.ProcessEnv }): SpanSource {
  const env = opts.env ?? process.env;
  const notes: string[] = [];
  const cli = findOnPath("neatlogs-cli", env);
  if (cli && (env.NEATLOGS_SERVICE_TOKEN ?? "").trim()) {
    notes.push("neatlogs-cli found, but its query usage was not verified on the build machine; reading spans.jsonl instead");
  }
  const records: SpanRecord[] = [];
  for (const runId of [...new Set(opts.runIds)].sort()) {
    const path = join(opts.runsDir, runId, "spans.jsonl");
    if (!existsSync(path)) {
      notes.push(`no spans.jsonl for run ${runId}`);
      continue;
    }
    records.push(...parseSpanJsonl(readFileSync(path, "utf8")));
  }
  return { source: "jsonl", records, notes };
}
