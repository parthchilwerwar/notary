/**
 * Live incidents for one queue decision, reported by the executor inside the item's AGENT span:
 * a guard hold (a money action held because required beliefs are not notarized) is a warn log in
 * neatlogs, immediately followed by its resolution so far ("held for a person"). Same id as
 * derive.ts's guard_hold (subject = decision id). Guard firings (block / transform / precheck) are
 * reported where they happen, in src/guards/guarded.ts.
 */
import type { Decision, QueueRequest } from "../schema/index.js";
import { currentIncidentRun, incidentId, reportIncident, reportResolution } from "./live.js";

export function reportDecisionIncidents(d: Decision, req?: Pick<QueueRequest, "amount" | "currency">): void {
  try {
    if (d.status !== "held" || d.missingBeliefs.length === 0) return;
    const amount = req?.amount === undefined ? "an unknown amount" : `${req.amount} ${req.currency ?? ""} (minor units)`.replace("  ", " ");
    const id = reportIncident({
      kind: "guard_hold",
      subject: d.id,
      severity: "warning",
      summary: `The Guard held ${d.action} for ${d.requestId} (${amount}): ${d.missingBeliefs.length} required belief(s) not notarized (${d.missingBeliefs.join(", ")}).`,
      attrs: { "notary.decisionId": d.id, "notary.requestId": d.requestId, "notary.guard.action": d.action, "notary.guard.missingBeliefs": d.missingBeliefs.join(","), "notary.agent_id": "guard" },
    });
    reportResolution(id || incidentId("guard_hold", d.id, currentIncidentRun()), {
      status: "awaiting_human",
      action: "held_for_person",
      summary: `Held with an evidence pack (${d.evidencePack?.relatedProbeIds.length ?? 0} related probe(s)) for a person in Approvals.`,
      recordIds: [d.id],
    });
  } catch {
    // never break the run
  }
}
