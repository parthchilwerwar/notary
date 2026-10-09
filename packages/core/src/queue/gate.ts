/**
 * The guarded variant's gate (TDD "Queue execution and guards", PRD FR-9): before an irreversible
 * action, every required belief (src/queue/required.ts) must be NOTARIZED in the belief store. Any
 * missing one -> not allowed; the executor holds the item with an evidence pack built from this
 * verdict: the missing beliefs, the probes run on their claims, those probes' span ids and trace
 * receipts. A trace receipt is the local span log the probe's run wrote
 * (`runs/<runId>/spans.jsonl#trace=<traceId>`, DECISIONS #48): verifiable offline, no invented URL.
 */
import { beliefIdFor } from "../beliefs/store.js";
import type { Belief, Probe } from "../schema/index.js";
import type { GateContext, GateHook, GateVerdict } from "./executor.js";
import { REQUIRED_GAPS, requiredActionFor, requiredActionForRequestType, requiredClaims } from "./required.js";

export interface GateSources {
  /** Current beliefs (read per call, so a belief that changes mid-run is seen). */
  beliefs: () => readonly Belief[];
  /** Probes run on these claims, with the run that ran them. */
  probesForClaims: (claimIds: readonly string[]) => Array<{ runId: string; probe: Probe }>;
}

export function traceReceipt(runId: string, traceId: string): string {
  return `runs/${runId}/spans.jsonl#trace=${traceId}`;
}

export function createGate(src: GateSources): GateHook {
  return async (ctx: GateContext): Promise<GateVerdict> => {
    const action = ctx.forEscalation
      ? requiredActionForRequestType(ctx.request.type)
      : requiredActionFor(ctx.policy.action, ctx.policy.refundAmount, ctx.paymentAmount, ctx.request.type);
    if (action === null) return { allow: true, requiredBeliefs: [], missingBeliefs: [] };

    const claims = requiredClaims(action);
    const byId = new Map(src.beliefs().map((b) => [b.id, b]));
    const missingClaims = claims.filter((c) => byId.get(beliefIdFor(c))?.status !== "notarized");
    const requiredBeliefs = claims.map(beliefIdFor);
    const missingBeliefs = missingClaims.map(beliefIdFor);

    const related = src.probesForClaims(missingClaims);
    const relatedProbeIds = related.map((r) => r.probe.id);
    const spanIds = related.flatMap((r) => (r.probe.spanId ? [r.probe.spanId] : []));
    const traceLinks: Record<string, string> = {};
    for (const r of related) if (r.probe.traceId) traceLinks[r.probe.traceId] = traceReceipt(r.runId, r.probe.traceId);

    const status = (c: string) => byId.get(beliefIdFor(c))?.status ?? "no belief yet";
    const gap = REQUIRED_GAPS[action];
    const reason = missingClaims.length
      ? `${action.replace("_", " ")} needs ${claims.length} notarized belief(s); ${missingClaims.length} missing: ${missingClaims
          .map((c) => `${c} (${status(c)})`)
          .join(", ")}${related.length ? `; ${related.length} related probe(s)` : "; no probes run on them yet"}`
      : `all ${claims.length} required belief(s) notarized`;
    return {
      allow: missingClaims.length === 0,
      requiredBeliefs,
      missingBeliefs,
      reason: gap ? `${reason}. Gap: ${gap}` : reason,
      evidence: { relatedProbeIds, spanIds, traceLinks },
    };
  };
}
