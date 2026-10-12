/**
 * The guarded variant's gate (TDD "Queue execution and guards", PRD FR-9): before an irreversible
 * action, every required belief (src/queue/required.ts) must be NOTARIZED in the belief store. Any
 * missing one -> not allowed; the executor holds the item with an evidence pack built from this
 * verdict: the missing beliefs, the probes run on their claims, those probes' span ids and trace
 * receipts. A trace receipt is the local span log the probe's run wrote
 * (`runs/<runId>/spans.jsonl#trace=<traceId>`, DECISIONS #48): verifiable offline, no invented URL.
 *
 * This check is the Guard (src/schema/agents.ts: a deterministic rule, not a model). Each verdict on
 * a money action is one `notary.guard` GUARDRAIL span with `notary.agent` = "Guard", the action,
 * the counts of required / missing beliefs and the outcome (allow); never a prompt or a secret.
 */
import { beliefIdFor } from "../beliefs/store.js";
import { AGENT_SPAN_ATTR } from "../llm/agents.js";
import { AGENTS } from "../schema/agents.js";
import { withSpan } from "../trace/index.js";
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
    let set: (k: string, v: string | number | boolean) => void = () => {};
    return withSpan(
      "notary.guard",
      { [AGENT_SPAN_ATTR]: AGENTS.guard.name, "notary.agent_id": "guard", "notary.guard.id": "certificate-gate", "notary.requestId": ctx.request.id, "notary.guard.action": action, "notary.guard.forEscalation": ctx.forEscalation === true },
      () => {
        const v = verdictFor(action);
        set("notary.guard.allow", v.allow);
        set("notary.guard.required", v.requiredBeliefs.length);
        set("notary.guard.missing", v.missingBeliefs.length);
        set("notary.guard.decision", v.allow ? "allow" : "hold");
        if (v.missingBeliefs.length) set("notary.guard.missingBeliefs", v.missingBeliefs.join(","));
        set("notary.guard.requiredBeliefs", v.requiredBeliefs.join(","));
        return v;
      },
      { kind: "GUARDRAIL", onSpan: (_ids, setter) => (set = setter) },
    );
  };

  function verdictFor(action: NonNullable<ReturnType<typeof requiredActionFor>>): GateVerdict {
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
  }
}
