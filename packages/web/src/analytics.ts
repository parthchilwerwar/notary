import type { RunBundle } from "../../core/src/schema";

export const totalUsd = (bundle: RunBundle) =>
  Object.values(bundle.usageByRole).reduce((sum, role) => sum + role.usd, 0);
export function comparable(a: RunBundle, b: RunBundle) {
  return a.sample === b.sample;
}
export function unsafeDelta(
  focus: RunBundle,
  comparison?: RunBundle,
): number | null {
  if (!comparison || !comparable(focus, comparison)) return null;
  const a = focus.metrics.unsafe_actions_total;
  const b = comparison.metrics.unsafe_actions_total;
  return a == null || b == null ? null : a - b;
}
export function beliefBreakdown(bundle: RunBundle) {
  const beliefs = bundle.beliefs.after;
  // A settled belief's side is encoded by its Beta evidence. Neutral posteriors
  // cannot be classified as documentation matches or contradictions.
  const rows = [
    {
      name: "Notarized · matches docs",
      value: beliefs.filter(
        (b) => b.status === "notarized" && b.confidence > 0.5,
      ).length,
    },
    {
      name: "Notarized · contradicts docs",
      value: beliefs.filter(
        (b) => b.status === "notarized" && b.confidence < 0.5,
      ).length,
    },
    {
      name: "Abstained",
      value: beliefs.filter((b) => b.status === "abstained").length,
    },
    {
      name: "Downgraded by adversary",
      value: beliefs.filter(
        (b) => b.status !== "notarized" && b.adversary?.verdict === "downgrade",
      ).length,
    },
  ];
  // Downgraded and abstained may overlap; make breakdown categories disjoint.
  rows[2].value = beliefs.filter(
    (b) => b.status === "abstained" && b.adversary?.verdict !== "downgrade",
  ).length;
  const accounted = rows.reduce((sum, row) => sum + row.value, 0);
  return [
    ...rows,
    { name: "Other / unresolved", value: beliefs.length - accounted },
  ];
}
export function queueFlow(bundle: RunBundle) {
  const statuses = (status: string) =>
    bundle.decisions.filter((d) => d.status === status).length;
  const rows = [
    { name: "Requests", value: bundle.queue.length },
    {
      name: "Decided",
      value: new Set(bundle.decisions.map((d) => d.requestId)).size,
    },
    { name: "Executed", value: statuses("executed") },
    { name: "Held", value: statuses("held") },
    { name: "Escalated", value: statuses("escalated") },
  ];
  return rows.map((row, i) => ({
    ...row,
    drop: i ? rows[i - 1].value - row.value : null,
  }));
}
export function insight(focus: RunBundle, comparison?: RunBundle) {
  const delta = unsafeDelta(focus, comparison);
  const held = focus.decisions.filter(
    (d) =>
      d.status === "held" &&
      d.missingBeliefs.length > 0 &&
      ["refund", "partial_refund"].includes(d.requestType),
  ).length;
  const safety =
    delta === null
      ? "A same-kind baseline is needed to measure the safety difference."
      : delta < 0
        ? `This run recorded ${Math.abs(delta)} fewer unsafe actions than ${comparison!.runId}.`
        : delta > 0
          ? `This run recorded ${delta} more unsafe actions than ${comparison!.runId}.`
          : "Both runs recorded the same number of unsafe actions.";
  return `${safety} ${held} refund requests were held with required beliefs still unproven.`;
}
