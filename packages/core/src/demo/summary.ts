/**
 * Stage-by-stage text summary for `notary demo --fixture`. Pure formatting over bundles and cassettes
 * the demo wrote; no I/O and no clock, so two demo runs print the same lines (timestamps aside).
 */
import { canonicalJson } from "../bundle/hash.js";
import { contractFor } from "../contracts/index.js";
import { REQUIRED_CLAIMS } from "../queue/required.js";
import type { Belief, Decision, Hypothesis, Probe, RunBundle, Tool } from "../schema/index.js";
import type { Cassette } from "../tools/index.js";

export function short(text: string, max = 110): string {
  const t = text.replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const json = (v: unknown, max = 90): string => short(canonicalJson(v ?? null), max);

export function heading(n: number | null, title: string): string {
  return n === null ? `\n== ${title} ==` : `\n== Stage ${n} · ${title} ==`;
}

// ---------------------------------------------------------------------------------------------
// Stage 1–7 (notarize bundles)

export function reconLines(tool: Tool, bundle: RunBundle, recon: Cassette | null): string[] {
  const entries = contractFor(tool);
  const exercised = entries.filter((e) => e.recon.length > 0);
  const neverExercised = entries.filter((e) => e.recon.length === 0).map((e) => e.claim.id);
  const exchanges = recon?.exchanges ?? [];
  const credits = exchanges.reduce((s, e) => s + (e.credits ?? 0), 0);
  const byOp = new Map<string, number>();
  for (const e of exchanges) byOp.set(e.op, (byOp.get(e.op) ?? 0) + 1);
  const statuses = new Map<number, number>();
  for (const e of exchanges) statuses.set(e.status, (statuses.get(e.status) ?? 0) + 1);
  return [
    `${tool}: ${entries.length} claims, ${exercised.length} exercised by recon steps, ${exchanges.length} exchanges, ${credits} credits (cassette ${recon?.name ?? "none"}${recon?.fixture ? ", fixture: true" : ""})`,
    `  ops: ${[...byOp.entries()].map(([op, n]) => `${op}×${n}`).join(", ") || "none"}`,
    `  statuses: ${[...statuses.entries()].sort(([a], [b]) => a - b).map(([s, n]) => `${s}×${n}`).join(", ") || "none"}`,
    ...(neverExercised.length ? [`  no recon steps (recon: [], "observed from queue traffic"): ${neverExercised.join(", ")}`] : []),
  ];
}

export function anomalyLines(bundle: RunBundle): string[] {
  if (bundle.anomalies.length === 0) return [`${bundle.tool}: 0 anomalies (every exercised claim held on recon traffic)`];
  return [
    `${bundle.tool}: ${bundle.anomalies.length} anomal${bundle.anomalies.length === 1 ? "y" : "ies"}`,
    ...[...bundle.anomalies]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((a) => `  ${a.id}  ${a.claimId}\n      observed ${json(a.observed, 120)}\n      expected ${json(a.expected, 120)}`),
  ];
}

/** Hypothesis.anomalyId of a verification rival (src/reflect/loop.ts verificationSubjectId). */
const VERIFY_PREFIX = "verify:";

function isVerificationProbe(bundle: RunBundle, p: Probe): boolean {
  return p.hypothesisIds.some((id) => bundle.hypotheses.find((h) => h.id === id)?.anomalyId.startsWith(VERIFY_PREFIX));
}

export function hypothesisLines(bundle: RunBundle): string[] {
  const out: string[] = [];
  const byAnomaly = new Map<string, Hypothesis[]>();
  for (const h of bundle.hypotheses) byAnomaly.set(h.anomalyId, [...(byAnomaly.get(h.anomalyId) ?? []), h]);
  const proposed = bundle.hypotheses.filter((h) => !h.anomalyId.startsWith(VERIFY_PREFIX));
  const verifyIds = [...byAnomaly.keys()].filter((k) => k.startsWith(VERIFY_PREFIX)).sort();
  const n = bundle.anomalies.length;
  const u = bundle.usageByRole.reflector;
  out.push(`${bundle.tool}: ${proposed.length} hypotheses for ${n} anomal${n === 1 ? "y" : "ies"} — reflector double: ${u.calls} call(s), ${u.inputTokens} in / ${u.outputTokens} out tokens, ${u.usd} (fixture model, no cost)`);
  for (const a of [...bundle.anomalies].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const hs = byAnomaly.get(a.id) ?? [];
    out.push(`  ${a.id} (${a.claimId}):${hs.length ? "" : " no valid hypotheses"}`);
    for (const h of hs) out.push(`    - ${h.class} [${h.distinguishingTest}] ${h.id}: ${short(h.statement, 96)}`);
  }
  if (verifyIds.length) {
    out.push(`${bundle.tool}: verification rivals for ${verifyIds.length} required claim(s) with no anomaly — {honored, suspected class} built by code from src/contracts/priors-map.ts, no model call`);
    for (const id of verifyIds) {
      const hs = byAnomaly.get(id)!;
      out.push(`  ${id.slice(VERIFY_PREFIX.length)}: ${hs.map((h) => `${h.class} ${h.id}`).join(" vs ")} [${hs[0]!.distinguishingTest}]`);
    }
  }
  return out;
}

function winnerClass(bundle: RunBundle, p: Probe): string | null {
  if (!p.winningHypothesisId) return null;
  return bundle.hypotheses.find((h) => h.id === p.winningHypothesisId)?.class ?? p.winningHypothesisId;
}

export function probeLines(bundle: RunBundle): { lines: string[]; orderOk: boolean } {
  const out: string[] = [`${bundle.tool}: ${bundle.probes.length} probe(s)`];
  let orderOk = true;
  for (const p of bundle.probes) {
    const variant = typeof (p.params as { variant?: unknown }).variant === "number" ? `#v${(p.params as { variant: number }).variant}` : "#v0";
    const ok = p.ranAt !== undefined && p.committedAt < p.ranAt;
    if (!ok) orderOk = false;
    const outcome = (p.observed as { outcome?: unknown } | undefined)?.outcome;
    const note = (p.observed as { note?: unknown } | undefined)?.note;
    const w = winnerClass(bundle, p);
    out.push(`  ${p.id}  ${p.claimId}  ${p.template}${variant}${isVerificationProbe(bundle, p) ? "  [verification]" : ""}`);
    out.push(
      `      prediction sha256 ${p.predictionHash.slice(0, 16)}…  committedAt ${p.committedAt} ${ok ? "<" : "NOT BEFORE"} ranAt ${p.ranAt ?? "?"}`,
    );
    out.push(`      verdict ${p.verdict ?? "none"}${w ? ` -> winner ${w}` : ""}  outcome=${outcome === undefined ? "?" : JSON.stringify(outcome)}${typeof note === "string" ? ` (${short(note, 70)})` : ""}`);
  }
  return { lines: out, orderOk };
}

export function beliefLines(beliefs: readonly Belief[]): string[] {
  const touched = beliefs.filter((b) => b.status !== "hypothesis" || b.evidence.length > 0 || b.adversary);
  const untouched = beliefs.filter((b) => !touched.includes(b));
  const out = touched.map(
    (b) =>
      `  ${b.status.padEnd(10)} ${b.claimId}  P(holds)=${b.confidence.toFixed(4)}  α=${b.alpha} β=${b.beta}  cited probes=${b.evidence.length}${b.class ? `  class=${b.class}` : ""}`,
  );
  out.push(`  ${untouched.length} belief(s) untouched at Beta(1,1), status hypothesis (no anomaly on their claim and no verification probe for it: verification covers the required-beliefs map only)`);
  return out;
}

export function adversaryLines(beliefs: readonly Belief[], usage: { calls: number; inputTokens: number; outputTokens: number; usd: number }): string[] {
  const reviewed = beliefs.filter((b) => b.adversary);
  const out = [`adversary double: ${usage.calls} call(s), ${usage.inputTokens} in / ${usage.outputTokens} out tokens, $${usage.usd} (fixture model, no cost)`];
  if (reviewed.length === 0) out.push("  no belief reached candidate, so nothing was reviewed");
  for (const b of reviewed) {
    const a = b.adversary!;
    out.push(`  ${a.verdict.toUpperCase()} ${b.claimId} -> ${b.status}`);
    out.push(`      ${short(a.reason, 480)}`);
    if (a.scope) out.push(`      scope: ${short(a.scope, 200)}`);
  }
  return out;
}

export function guardLines(bundles: readonly RunBundle[]): string[] {
  const guards = bundles.flatMap((b) => b.guards);
  if (guards.length === 0) return ["  no guards: no belief is notarized on the violated side"];
  return guards.map((g) => `  ${g.kind} on ${g.operation} (${g.class}, ${g.active ? "active" : "retired"}) ${g.id}\n      ${short(g.reason, 200)}`);
}

// ---------------------------------------------------------------------------------------------
// Stage 8–9 (run bundles)

function metric(b: RunBundle, k: string): string {
  const v = b.metrics[k];
  if (v === undefined || v === null) return "null";
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function amountOf(d: Decision): string {
  const w = d.effects.filter((e) => e.op === d.action && e.amount !== undefined);
  return w.length ? ` ${w.map((e) => `${e.amount}${e.status === null ? "(no answer)" : ""}`).join("+")}` : "";
}

export function runLines(b: RunBundle, opts: { guarded: boolean; beliefs?: readonly Belief[] }): string[] {
  const out = [
    `${b.runId}: ${metric(b, "items_total")} items  executed=${metric(b, "executed")} held=${metric(b, "holds")} escalated=${metric(b, "escalations")} denied=${metric(b, "denials")}`,
    `  unsafe actions: total=${metric(b, "unsafe_actions_total")}  duplicate=${metric(b, "unsafe_duplicates")}  wrong_unit=${metric(b, "unsafe_wrong_unit")}  missed_existing_refund=${metric(b, "unsafe_missed_existing_refund")}`,
    `  decision_accuracy=${metric(b, "decision_accuracy")}  tier_accuracy=${metric(b, "tier_accuracy")}  automation_rate=${metric(b, "automation_rate")}  credits=${b.credits.total}`,
  ];
  const status = new Map((opts.beliefs ?? []).map((x) => [x.id, x.status]));
  const packsShown = new Map<string, string>();
  for (const d of b.decisions) {
    const unsafe = d.grade?.unsafe.length ? `  UNSAFE: ${d.grade.unsafe.join(", ")}` : "";
    const graded = d.grade ? (d.grade.correct ? "correct" : `WRONG (expected ${d.grade.expectedOutcome})`) : "ungraded";
    const action = d.status === "executed" && d.action !== "none" ? ` ${d.action}${amountOf(d)}` : "";
    out.push(`  ${d.requestId} ${d.requestType} ${d.tier} ${d.policyOutcome} -> ${d.status}${action}  [${graded}]${unsafe}`);
    if (d.guardsApplied.length) out.push(`      guards fired: ${d.guardsApplied.join(", ")}`);
    if (opts.guarded && d.status === "held" && d.evidencePack) {
      const missing = d.evidencePack.missingBeliefs.map((id) => `${id.replace(/^belief-/, "")} (${status.get(id) ?? "no belief"})`);
      const probes = d.evidencePack.relatedProbeIds;
      const key = canonicalJson([missing, probes]);
      const seen = packsShown.get(key);
      if (seen) {
        out.push(`      evidence pack: same ${missing.length} missing belief(s) and ${probes.length} related probe(s) as ${seen}`);
      } else {
        packsShown.set(key, d.requestId);
        out.push(`      evidence pack: ${missing.length} missing belief(s): ${short(missing.join(", "), 600)}`);
        out.push(`      related probes: ${probes.length ? probes.join(", ") : "none"}`);
      }
    } else if (d.status === "held" && d.error) {
      out.push(`      ${short(d.error, 200)}`);
    } else if (d.status === "denied" && d.error) {
      out.push(`      ${short(d.error, 160)}`);
    }
  }
  const notes = b.disclosure.filter((x) => x.startsWith("Client timeout:") || x.startsWith("Note:"));
  for (const n of notes) out.push(`  ${short(n, 240)}`);
  return out;
}

/** Why the gate can or cannot pass, computed from the contracts and the final beliefs. */
export function requiredBeliefLines(beliefs: readonly Belief[]): string[] {
  const byClaim = new Map(beliefs.map((b) => [b.claimId, b]));
  const allEntries = [...contractFor("crustdata"), ...contractFor("dodo")];
  const out: string[] = [];
  for (const [action, claims] of Object.entries(REQUIRED_CLAIMS)) {
    const parts = claims.map((c) => {
      const b = byClaim.get(c);
      const entry = allEntries.find((e) => e.claim.id === c);
      const recon = entry && entry.recon.length === 0 ? ", no recon steps" : "";
      return `${c}=${b?.status ?? "none"}${recon}`;
    });
    const ok = claims.every((c) => byClaim.get(c)?.status === "notarized");
    out.push(`  ${action}: ${ok ? "PASS" : "HOLD"} — ${parts.join("; ")}`);
  }
  return out;
}
