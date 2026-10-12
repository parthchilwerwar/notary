/**
 * Deterministic incident derivation: from recorded data only (never a model).
 *
 * Inputs: the run bundle, its timeline (approval.decided events), the approvals file and the run's
 * local span log (runs/<runId>/spans.jsonl). Each rule below turns facts into incidents; the same
 * input always yields the same incidents, ids and order.
 *
 *   kind                      fact                                                    subject (id input)
 *   checker_anomaly           bundle.anomalies[i]                                      anomaly.id
 *   probe_contradiction       probe verdict confirmed, winning hypothesis class ≠ honored   probe.id
 *   belief_unlearned          beliefEvent → unlearned                                  beliefId|at
 *   adversary_downgrade       belief.adversary.verdict ∈ {downgrade, narrow}           beliefId|reviewedAt
 *   guard_hold                decision.status = held with missing beliefs              decision.id
 *   guard_block               a fired block guard / guard refusal on a decision        decision.id|guardId
 *   unsafe_action_prevented   a fired transform guard, or a precheck that stopped a write   decision.id|guardId
 *   unsafe_action_executed    grader: decision.grade.unsafe non-empty                  decision.id
 *   budget_stop               bundle.status = stopped_budget, or a USD-cap error span  runId / spanId
 *   rate_limited              notary.llm span with llm.attempts > 1; tool span with status 429   spanId
 *   model_error               notary.llm span with status error                        spanId
 *   tool_error                notary.tool.call span with status error or HTTP 5xx      spanId
 *
 * Resolutions come from the same records: guards compiled/retired, belief status, approvals,
 * the retry outcome, the parent span's status. Nothing is inferred beyond what the records show;
 * when nothing resolved an incident its resolution is { status: "open", action: "none" }.
 */
import { AGENTS } from "../schema/agents.js";
import type { AgentId } from "../schema/agents.js";
import type { ApprovalRecord } from "../schema/approval.js";
import type { Anomaly, Belief, Guard, Probe, RunBundle } from "../schema/index.js";
import { IncidentSchema } from "../schema/incidents.js";
import type { Incident, IncidentKind, IncidentResolution } from "../schema/incidents.js";
import type { TimelineEvent } from "../schema/timeline.js";
import type { SpanRecord } from "../trace/index.js";
import { incidentId } from "./live.js";

export type DeriveIncidentsInput = {
  bundle: RunBundle;
  timeline?: readonly TimelineEvent[];
  spans?: readonly SpanRecord[];
  approvals?: readonly ApprovalRecord[];
  /** neatlogs URL for an exported trace id (links.ts template); undefined = no link. */
  traceUrlFor?: (traceId: string) => string | undefined;
};

const TRACE_RE = /^[0-9a-f]{32}$/;
const SPAN_RE = /^[0-9a-f]{16}$/;
const AGENT_BY_NAME = new Map<string, AgentId>(Object.values(AGENTS).map((a) => [a.name, a.id]));

function short(v: unknown, max = 100): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = "undefined";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The checker_anomaly sentence (shared with the live report in src/checker/recon.ts). */
export function anomalySummary(a: Pick<Anomaly, "claimId" | "expected" | "observed">): string {
  return `The checker saw ${a.claimId} disagree with the docs: expected ${short(a.expected)}, observed ${short(a.observed)}.`;
}

/** The probe_contradiction sentence (shared with the live report in src/reflect/runner.ts). */
export function probeContradictionSummary(p: { id: string; template: string; claimId: string }, cls: string): string {
  return `Probe ${p.id} (${p.template}) on ${p.claimId}: the committed prediction for "${cls}" won, so the documented behavior does not hold.`;
}

/** The Adversary-failure sentence (shared with the live report in src/adversary/index.ts). */
export function adversaryFailureSummary(beliefId: string, failure: string): string {
  return `The Adversary could not review ${beliefId}: ${short(failure, 180)}`;
}

function pct(p: number): string {
  return p.toFixed(3);
}

function minor(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined) return "an unknown amount";
  return `${amount} ${currency ?? ""} (minor units)`.replace("  ", " ");
}

function isoOr(at: string | undefined, fallback: string): string {
  return at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : fallback;
}

type Draft = Omit<Incident, "id" | "runId" | "exported" | "traceUrl" | "traceId" | "spanId"> & {
  subject: string;
  traceId?: string;
  spanId?: string;
};

export function deriveIncidents(input: DeriveIncidentsInput): Incident[] {
  const b = input.bundle;
  const spans = input.spans ?? [];
  const timeline = input.timeline ?? [];
  const approvals = input.approvals ?? [];
  const runStart = isoOr(b.startedAt, new Date(0).toISOString());

  const exportedTraces = new Set(spans.filter((s) => s.exported === true).map((s) => s.traceId.toLowerCase()));
  const spanById = new Map(spans.map((s) => [s.spanId, s]));
  const beliefByClaim = new Map<string, Belief>(b.beliefs.after.map((x) => [x.claimId, x]));
  const beliefById = new Map<string, Belief>(b.beliefs.after.map((x) => [x.id, x]));
  const guardById = new Map<string, Guard>(b.guards.map((g) => [g.id, g]));
  const hypClass = new Map(b.hypotheses.map((h) => [h.id, h.class]));
  const eventAt = (type: TimelineEvent["type"], recordId: string): string | undefined => timeline.find((e) => e.type === type && e.recordIds[0] === recordId)?.at;

  const drafts: Draft[] = [];

  /** What happened to the belief behind a claim, as a resolution. */
  const resolveClaim = (claimId: string): IncidentResolution => {
    const belief = beliefByClaim.get(claimId);
    if (!belief) return { status: "open", action: "none", summary: `No belief was formed for ${claimId} in this run.`, recordIds: [] };
    const guard = b.guards.find((g) => g.beliefId === belief.id && g.active);
    if (belief.status === "notarized" && guard) {
      return {
        status: "resolved",
        action: "guard_compiled",
        summary: `Guard ${guard.id} (${guard.kind} on ${guard.operation}) was compiled from the notarized belief ${belief.id}.`,
        at: isoOr(guard.compiledAt, runStart),
        recordIds: [guard.id, belief.id],
      };
    }
    if (belief.status === "notarized") {
      return {
        status: "resolved",
        action: "certified",
        summary: `${belief.statement.startsWith("Doc claim violated") ? "The corrected behavior" : "The documented behavior"} was notarized at P(holds)=${pct(belief.confidence)}.`,
        at: isoOr(belief.updatedAt, runStart),
        recordIds: [belief.id],
      };
    }
    if (belief.status === "refuted") {
      return { status: "resolved", action: "belief_refuted", summary: `The claim was refuted (P(holds)=${pct(belief.confidence)}) and recorded as a correction.`, at: isoOr(belief.updatedAt, runStart), recordIds: [belief.id] };
    }
    if (belief.status === "abstained") {
      return { status: "open", action: "belief_abstained", summary: `Notary abstained on ${belief.id}: not enough evidence to certify; no guard relies on it.`, at: isoOr(belief.updatedAt, runStart), recordIds: [belief.id] };
    }
    return { status: "open", action: "none", summary: `Still under investigation: ${belief.id} is ${belief.status} at P(holds)=${pct(belief.confidence)}.`, recordIds: [belief.id] };
  };

  // checker_anomaly
  for (const a of b.anomalies) {
    drafts.push({
      subject: a.id,
      kind: "checker_anomaly",
      severity: "warning",
      at: isoOr(eventAt("anomaly.detected", a.id), runStart),
      tool: a.tool,
      summary: anomalySummary(a),
      recordIds: [a.id, a.claimId],
      claimId: a.claimId,
      ...(beliefByClaim.get(a.claimId) ? { beliefId: beliefByClaim.get(a.claimId)!.id } : {}),
      traceId: a.traceId,
      spanId: a.spanId,
      resolution: resolveClaim(a.claimId),
    });
  }

  // probe_contradiction
  for (const p of b.probes) {
    if (p.verdict !== "confirmed" || !p.winningHypothesisId) continue;
    const cls = hypClass.get(p.winningHypothesisId) ?? predictedClass(p);
    if (!cls || cls === "honored") continue;
    drafts.push({
      subject: p.id,
      kind: "probe_contradiction",
      severity: "warning",
      at: isoOr(p.ranAt ?? p.committedAt, runStart),
      agent: "reflector",
      tool: p.tool,
      summary: probeContradictionSummary(p, cls),
      recordIds: [p.id, p.claimId, p.winningHypothesisId],
      claimId: p.claimId,
      ...(beliefByClaim.get(p.claimId) ? { beliefId: beliefByClaim.get(p.claimId)!.id } : {}),
      traceId: p.traceId,
      ...(p.spanId ? { spanId: p.spanId } : {}),
      data: { class: cls, template: p.template, credits: p.costCredits },
      resolution: resolveClaim(p.claimId),
    });
  }

  // belief_unlearned
  for (const e of b.beliefEvents) {
    if (e.to !== "unlearned") continue;
    const probe = e.probeId ? b.probes.find((p) => p.id === e.probeId) : undefined;
    const retired = b.guards.find((g) => g.beliefId === e.beliefId && !g.active && g.retiredAt);
    const recert = b.beliefEvents.find((x) => x.beliefId === e.beliefId && x.to === "notarized" && Date.parse(x.at) > Date.parse(e.at));
    const resolution: IncidentResolution = recert
      ? { status: "resolved", action: "recertified", summary: `${e.beliefId} was notarized again at P(holds)=${pct(recert.confidence)}.`, at: isoOr(recert.at, runStart), recordIds: [e.beliefId] }
      : retired
        ? { status: "resolved", action: "guard_retired", summary: `Guard ${retired.id} was retired; actions that need ${e.beliefId} are held again.`, at: isoOr(retired.retiredAt, runStart), recordIds: [retired.id, e.beliefId] }
        : { status: "open", action: "none", summary: `${e.beliefId} lost its certificate and has not been re-certified.`, recordIds: [e.beliefId] };
    drafts.push({
      subject: `${e.beliefId}|${e.at}`,
      kind: "belief_unlearned",
      severity: "error",
      at: isoOr(e.at, runStart),
      ...(probe ? { agent: "reflector" as const, tool: probe.tool } : {}),
      summary: `${e.beliefId} was unlearned (from ${e.from ?? "new"}, P(holds)=${pct(e.confidence)}): the API no longer behaves as certified.`,
      recordIds: [e.beliefId, ...(e.probeId ? [e.probeId] : [])],
      beliefId: e.beliefId,
      ...(probe?.traceId ? { traceId: probe.traceId } : {}),
      ...(probe?.spanId ? { spanId: probe.spanId } : {}),
      resolution,
    });
  }

  // adversary_downgrade
  for (const belief of b.beliefs.after) {
    const rev = belief.adversary;
    if (!rev || (rev.verdict !== "downgrade" && rev.verdict !== "narrow")) continue;
    const span = spans.find((s) => (s.name === "notary.adversary" || s.name === "notary.agent.adversary") && s.attrs["notary.beliefId"] === belief.id);
    const resolution: IncidentResolution =
      belief.status === "notarized"
        ? {
            status: "resolved",
            action: "certified",
            summary: rev.verdict === "narrow" ? `Certified only within the narrowed scope${rev.scope ? ` (${short(rev.scope, 80)})` : ""}; guards refuse calls outside it.` : `${belief.id} was notarized after further evidence.`,
            at: isoOr(belief.updatedAt, runStart),
            recordIds: [belief.id],
          }
        : {
            status: "resolved",
            action: "belief_abstained",
            summary: `The objection kept ${belief.id} out of certification (status ${belief.status}); no guard relies on it and money actions that need it are held.`,
            at: isoOr(belief.updatedAt, runStart),
            recordIds: [belief.id],
          };
    drafts.push({
      subject: `${belief.id}|${rev.reviewedAt ?? ""}`,
      kind: "adversary_downgrade",
      severity: "warning",
      at: isoOr(rev.reviewedAt ?? belief.updatedAt, runStart),
      agent: "adversary",
      tool: belief.tool,
      summary: `The Adversary ${rev.verdict === "narrow" ? "narrowed" : "downgraded"} ${belief.id} instead of upholding it (model ${rev.model}).`,
      recordIds: [belief.id, belief.claimId],
      claimId: belief.claimId,
      beliefId: belief.id,
      ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
      data: { verdict: rev.verdict, backend: rev.backend ?? null },
      resolution,
    });
  }

  // decisions: guard_hold, guard_block, unsafe_action_prevented, unsafe_action_executed
  for (const d of b.decisions) {
    const req = b.queue.find((q) => q.id === d.requestId);
    const amount = minor(req?.amount, req?.currency);
    const at = isoOr(eventAt("decision", d.id) ?? d.effects[0]?.at, runStart);
    const spanId = d.evidencePack?.spanIds[0];
    const where = { traceId: d.traceId, ...(spanId ? { spanId } : {}) };

    if (d.status === "held" && d.missingBeliefs.length > 0) {
      const appr = approvals.find((a) => a.decisionId === d.id);
      const resolution: IncidentResolution = appr
        ? {
            status: "resolved",
            action: appr.decision,
            summary: appr.decision === "approved" ? `A person approved it (human override); the action ${appr.status}.` : `A person rejected it${appr.reason ? `: ${short(appr.reason, 120)}` : ""}.`,
            at: isoOr(appr.decidedAt, runStart),
            recordIds: [appr.id],
          }
        : {
            status: "awaiting_human",
            action: "held_for_person",
            summary: `Held with an evidence pack (${d.evidencePack?.relatedProbeIds.length ?? 0} related probe(s)) for a person in Approvals.`,
            at,
            recordIds: [d.id],
          };
      drafts.push({
        subject: d.id,
        kind: "guard_hold",
        severity: "warning",
        at,
        agent: "guard",
        tool: "dodo",
        summary: `The Guard held ${d.action} for ${d.requestId} (${amount}): ${d.missingBeliefs.length} required belief(s) not notarized (${d.missingBeliefs.join(", ")}).`,
        recordIds: [d.id, d.requestId, ...d.missingBeliefs],
        decisionId: d.id,
        ...(d.missingBeliefs[0] ? { beliefId: d.missingBeliefs[0] } : {}),
        ...where,
        data: { action: d.action, missing: d.missingBeliefs.length, ...(req?.amount !== undefined ? { amount: req.amount } : {}), ...(req?.currency ? { currency: req.currency } : {}) },
        resolution,
      });
    }

    for (const gid of d.guardsApplied) {
      const g = guardById.get(gid);
      if (!g) continue;
      const refused = d.status !== "executed" && (g.kind === "block" || (d.error ?? "").includes(g.id));
      let kind: IncidentKind | null = null;
      let summary = "";
      let resolution: IncidentResolution | null = null;
      if (g.kind === "transform") {
        kind = "unsafe_action_prevented";
        summary = `Guard ${g.id} rewrote ${g.operation} for ${d.requestId} (${g.class}): ${short(g.rule.param ?? "the amount", 40)} scaled by ${short(g.rule.scale ?? "?", 20)} before the call left the process.`;
        resolution = { status: "resolved", action: "action_rewritten", summary: `The call went out in the unit the API really uses; decision ${d.status}.`, at, recordIds: [g.id, g.beliefId] };
      } else if (g.kind === "precheck" && d.status !== "executed") {
        kind = "unsafe_action_prevented";
        summary = `Guard ${g.id} (${g.class}) stopped ${d.action} for ${d.requestId}: its precheck found the write unsafe (e.g. an existing refund).`;
        resolution = { status: "resolved", action: "action_refused", summary: `No money moved; decision ${d.status}.`, at, recordIds: [g.id, g.beliefId] };
      } else if (refused) {
        kind = "guard_block";
        summary = `Guard ${g.id} (${g.kind}, ${g.class}) refused ${g.operation} for ${d.requestId}.`;
        resolution = { status: "resolved", action: "action_refused", summary: `No money moved; decision ${d.status}.`, at, recordIds: [g.id, g.beliefId] };
      }
      if (!kind || !resolution) continue;
      drafts.push({
        subject: `${d.id}|${g.id}`,
        kind,
        severity: "warning",
        at,
        agent: "guard",
        tool: g.operation.startsWith("crustdata.") ? "crustdata" : "dodo",
        summary,
        recordIds: [d.id, g.id, g.beliefId],
        decisionId: d.id,
        beliefId: g.beliefId,
        ...where,
        data: { guardKind: g.kind, class: g.class, decision: d.status },
        resolution,
      });
    }

    const unsafe = d.grade?.unsafe ?? [];
    if (unsafe.length) {
      drafts.push({
        subject: d.id,
        kind: "unsafe_action_executed",
        severity: "error",
        at,
        agent: "executor",
        tool: "dodo",
        summary: `The grader found ${d.action} for ${d.requestId} unsafe (${unsafe.join(", ")}) in the ${b.variant} run.`,
        recordIds: [d.id, d.requestId],
        decisionId: d.id,
        ...where,
        data: { unsafe: unsafe.join(","), variant: b.variant },
        resolution:
          b.variant === "naive"
            ? { status: "open", action: "none", summary: "Executed without guards; the guarded variant exists to prevent exactly this.", recordIds: [d.id] }
            : { status: "open", action: "none", summary: "Executed despite guards; needs investigation.", recordIds: [d.id] },
      });
    }
  }

  // budget_stop (run level)
  if (b.status === "stopped_budget") {
    drafts.push({
      subject: b.runId,
      kind: "budget_stop",
      severity: "error",
      at: isoOr(b.finishedAt, runStart),
      ...(b.tool ? { tool: b.tool } : {}),
      summary: `The run stopped at its budget: ${short(b.stopReason ?? "budget reached", 240)}`,
      recordIds: [b.runId],
      resolution: { status: "resolved", action: "run_stopped", summary: "Stopped cleanly at the cap; nothing past it was called.", at: isoOr(b.finishedAt, runStart), recordIds: [b.runId] },
    });
  }

  // span-based: rate_limited, model_error, tool_error, USD-cap budget_stop
  for (const s of spans) {
    const agent = agentOf(s, spanById);
    const parent = s.parentSpanId ? spanById.get(s.parentSpanId) : undefined;
    if (s.name === "notary.adversary" && typeof s.attrs["notary.adversary.failure"] === "string") {
      // The Adversary ran but produced no usable review (invalid reply, CLI failure, ...).
      const beliefId = typeof s.attrs["notary.beliefId"] === "string" ? s.attrs["notary.beliefId"] : undefined;
      const belief = beliefId ? beliefById.get(beliefId) : undefined;
      drafts.push({
        subject: s.spanId,
        kind: "model_error",
        severity: "error",
        at: isoOr(s.startedAt, runStart),
        agent: "adversary",
        ...(belief ? { tool: belief.tool, claimId: belief.claimId } : {}),
        summary: adversaryFailureSummary(beliefId ?? "a belief", String(s.attrs["notary.adversary.failure"])),
        recordIds: [s.spanId, ...(beliefId ? [beliefId] : [])],
        ...(beliefId ? { beliefId } : {}),
        traceId: s.traceId,
        spanId: s.spanId,
        resolution: {
          status: "resolved",
          action: "failed_safe",
          summary: `No review, no certificate: ${beliefId ?? "the belief"} stays ${belief?.status ?? "uncertified"} and no guard relies on it.`,
          at: isoOr(s.endedAt, runStart),
          recordIds: beliefId ? [beliefId] : [],
        },
      });
      continue;
    }
    if (s.name === "notary.llm") {
      const attempts = num(s.attrs["llm.attempts"]);
      const model = String(s.attrs["llm.model_id"] ?? "model");
      if (s.status === "ok" && attempts !== undefined && attempts > 1) {
        const backoff = num(s.attrs["llm.retry_after_ms"]);
        drafts.push({
          subject: s.spanId,
          kind: "rate_limited",
          severity: "warning",
          at: isoOr(s.startedAt, runStart),
          ...(agent ? { agent } : {}),
          summary: `${model} answered 429 (rate limited) for the ${agent ? AGENTS[agent].name : "agent"}; the call was retried.`,
          recordIds: [s.spanId],
          traceId: s.traceId,
          spanId: s.spanId,
          data: { attempts, ...(backoff !== undefined ? { retryAfterMs: backoff } : {}), provider: String(s.attrs["llm.provider"] ?? "") },
          resolution: { status: "resolved", action: "retried", summary: `Succeeded on attempt ${attempts}${backoff !== undefined ? ` after a ${backoff} ms back-off` : ""}.`, at: isoOr(s.endedAt, runStart), recordIds: [s.spanId] },
        });
      }
      if (s.status === "error") {
        const usdCap = (s.error ?? "").startsWith("UsdCapExceededError");
        drafts.push({
          subject: s.spanId,
          kind: usdCap ? "budget_stop" : "model_error",
          severity: "error",
          at: isoOr(s.startedAt, runStart),
          ...(agent ? { agent } : {}),
          summary: usdCap ? `The ${agent ? AGENTS[agent].name : "agent"}'s next ${model} call would exceed NOTARY_MAX_USD; it was not sent.` : `A ${model} call by the ${agent ? AGENTS[agent].name : "agent"} failed: ${short(s.error ?? "error", 160)}`,
          recordIds: [s.spanId],
          traceId: s.traceId,
          spanId: s.spanId,
          resolution: parentResolution(parent, s, usdCap ? "run_stopped" : "failed_safe", runStart),
        });
      }
    } else if (s.name === "notary.tool.call") {
      const code = num(s.attrs["http.status_code"]);
      const op = String(s.attrs["notary.tool.op"] ?? "tool call");
      const tool = toolOf(s.attrs["notary.tool"]);
      if (code === 429) {
        const later = spans.find((x) => x.name === "notary.tool.call" && x.traceId === s.traceId && x.attrs["notary.tool.op"] === s.attrs["notary.tool.op"] && Date.parse(x.startedAt) > Date.parse(s.startedAt) && (num(x.attrs["http.status_code"]) ?? 0) >= 200 && (num(x.attrs["http.status_code"]) ?? 0) < 300);
        drafts.push({
          subject: s.spanId,
          kind: "rate_limited",
          severity: "warning",
          at: isoOr(s.startedAt, runStart),
          ...(agent ? { agent } : {}),
          ...(tool ? { tool } : {}),
          summary: `${op} answered 429 (rate limited).`,
          recordIds: [s.spanId],
          traceId: s.traceId,
          spanId: s.spanId,
          data: { status: 429, op },
          resolution: later
            ? { status: "resolved", action: "retried", summary: `A later ${op} call in the same trace succeeded (HTTP ${num(later.attrs["http.status_code"])}).`, at: isoOr(later.endedAt, runStart), recordIds: [later.spanId] }
            : { status: "open", action: "none", summary: `No later successful ${op} call in this trace.`, recordIds: [] },
        });
      } else if (s.status === "error" || (code !== undefined && code >= 500)) {
        drafts.push({
          subject: s.spanId,
          kind: "tool_error",
          severity: s.status === "error" ? "error" : "warning",
          at: isoOr(s.startedAt, runStart),
          ...(agent ? { agent } : {}),
          ...(tool ? { tool } : {}),
          summary: s.status === "error" ? `${op} failed without an answer: ${short(s.error ?? "error", 160)}` : `${op} answered HTTP ${code}.`,
          recordIds: [s.spanId],
          traceId: s.traceId,
          spanId: s.spanId,
          data: { op, ...(code !== undefined ? { status: code } : {}) },
          resolution: parentResolution(parent, s, "failed_safe", runStart),
        });
      }
    }
  }

  const seen = new Set<string>();
  const out: Incident[] = [];
  for (const d of drafts) {
    const id = incidentId(d.kind, d.subject);
    if (seen.has(id)) continue;
    seen.add(id);
    const traceId = d.traceId && TRACE_RE.test(d.traceId.toLowerCase()) ? d.traceId.toLowerCase() : undefined;
    const spanId = traceId && d.spanId && SPAN_RE.test(d.spanId.toLowerCase()) ? d.spanId.toLowerCase() : undefined;
    const exported = traceId ? exportedTraces.has(traceId) : false;
    const url = traceId && exported ? input.traceUrlFor?.(traceId) : undefined;
    const { subject: _s, traceId: _t, spanId: _sp, ...rest } = d;
    out.push(
      IncidentSchema.parse({
        ...rest,
        id,
        runId: b.runId,
        ...(traceId ? { traceId } : {}),
        ...(spanId ? { spanId } : {}),
        exported,
        ...(url ? { traceUrl: url } : {}),
      }),
    );
  }
  // Chronological, then by kind and id: stable for identical input.
  return out.sort((x, y) => x.at.localeCompare(y.at) || x.kind.localeCompare(y.kind) || x.id.localeCompare(y.id));
}

function predictedClass(p: Probe): string | undefined {
  const pred = p.winningHypothesisId ? p.prediction[p.winningHypothesisId] : undefined;
  if (pred && typeof pred === "object" && "class" in pred && typeof (pred as { class: unknown }).class === "string") return (pred as { class: string }).class;
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toolOf(v: unknown): "crustdata" | "dodo" | undefined {
  return v === "crustdata" || v === "dodo" ? v : undefined;
}

/** The agent a span belongs to: its own notary.agent_id / notary.agent, else the nearest ancestor's. */
function agentOf(s: SpanRecord, byId: ReadonlyMap<string, SpanRecord>): AgentId | undefined {
  let cur: SpanRecord | undefined = s;
  for (let depth = 0; cur && depth < 32; depth++) {
    const id = cur.attrs["notary.agent_id"];
    if (typeof id === "string" && id in AGENTS) return id as AgentId;
    const name = cur.attrs["notary.agent"];
    if (typeof name === "string" && AGENT_BY_NAME.has(name)) return AGENT_BY_NAME.get(name);
    cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
  }
  return undefined;
}

/** A child failure is "failed safe" when the span that called it finished ok. */
function parentResolution(parent: SpanRecord | undefined, s: SpanRecord, action: "failed_safe" | "run_stopped", runStart: string): IncidentResolution {
  if (action === "run_stopped") return { status: "resolved", action, summary: "Stopped before the call: the USD cap held.", at: isoOr(s.endedAt, runStart), recordIds: [s.spanId] };
  if (parent && parent.status === "ok") {
    return { status: "resolved", action, summary: `${parent.name} handled the failure and finished normally (fail-safe path).`, at: isoOr(parent.endedAt, runStart), recordIds: [parent.spanId] };
  }
  return { status: "open", action: "none", summary: parent ? `${parent.name} failed too.` : "No caller span recorded a recovery.", recordIds: [] };
}

