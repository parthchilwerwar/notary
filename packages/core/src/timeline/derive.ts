/**
 * v2 run timeline, derived from ONE bundle's records (plus, optionally, earlier bundles of the same
 * world for certificate ids). Pure and deterministic: no clock, no model, no I/O; the same inputs give
 * byte-identical output. Browser-safe (schema + certify ledger helpers only).
 *
 * Events and their timestamps (bundle records carry no single "when" for every record, so each rule
 * says which recorded time is used):
 *   anomaly.detected    read       bundle.startedAt (anomalies have no timestamp; recon runs first)
 *   probe.committed     test       probe.committedAt
 *   probe.verdict       test       probe.ranAt (committedAt when absent); only probes with a verdict
 *   adversary.verdict   challenge  one per belief event the adversary caused (from `candidate`, reason
 *                                  written by BeliefStore.applyAdversary: "adversary <verdict> (…)" or
 *                                  "adversary review unavailable …"); at = the belief's recorded review
 *                                  reviewedAt when that review has the same verdict and is not later than
 *                                  the event, else the event's `at`
 *   belief.changed      certify    one per belief event, at its `at`
 *   certificate.issued  certify    belief event → notarized (from ≠ notarized), at its `at`
 *   certificate.revoked certify    belief event notarized → anything else, at its `at`
 *   decision            enforce    the decision is final after its own effects and after any probe /
 *                                  belief record that precedes the NEXT decision's first effect (the
 *                                  re-verification sentinel runs between items); never earlier than the
 *                                  previous decision; bundle.startedAt when nothing else applies
 *   budget, run.finished           at bundle.finishedAt (else the latest event time, else startedAt);
 *                                  stage = the last stage of the bundle kind: notarize → certify,
 *                                  run and sample → enforce
 *
 * Order: `at`, then TYPE_RANK, then the primary record id, then the record's position in the bundle.
 *
 * Certificate ids are the ones `notary export --certificates` computes (certify/ledger.ts
 * certificateId/revocationId via buildLedger + issuances + buildRevocations over `context` + this
 * bundle). A revocation whose issuing `→ notarized` event is in neither this bundle nor `context`
 * has no computable certificate id: recordIds are [beliefId, claimId], data.certificateId and
 * data.revocationId are null, and the summary says so.
 *
 * Budget snapshot: credits = credits.total / credits.budget (the configured credit budget); tool
 * calls = Σ probe.calls + Σ decision.effects.length (every external call the bundle records; recon
 * calls are not records and are not counted), cap null (no tool-call cap is configured anywhere);
 * usdByRole = usageByRole.*.usd; usdCap = the NOTARY_MAX_USD named in a USD-cap stopReason, else null
 * (the bundle records no cap otherwise); stopReason = the
 * bundle's stopReason.
 */
import { TOOLS } from "../certify/certificates.js";
import { buildLedger, certificateId, issuances, sideOfConfidence } from "../certify/ledger.js";
import type { Issuance } from "../certify/ledger.js";
import { buildRevocations } from "../certify/revocations.js";
import type { Revocation } from "../certify/revocations.js";
import type { Belief, BeliefEvent, Decision, Probe, RunBundle } from "../schema/index.js";
import type { BudgetSnapshot, TimelineEvent, TimelineEventType, TimelineStage } from "../schema/timeline.js";
import { usdCapFromStopReason } from "../llm/budget.js";

export type DerivedTimelineEvent = Omit<TimelineEvent, "seq">;

export interface DeriveTimelineOptions {
  /**
   * Other bundles of the same world (same `sample` flag), used ONLY to compute certificate and
   * revocation ids exactly as certify does when a revocation's notarization happened in an earlier
   * bundle. Bundles that start after `bundle`, the bundle itself and the run it replays are ignored.
   */
  context?: readonly RunBundle[];
}

/** Tie-break when two events share a timestamp: cause before effect. */
export const TYPE_RANK: Readonly<Record<TimelineEventType, number>> = {
  "anomaly.detected": 0,
  "probe.committed": 1,
  "probe.verdict": 2,
  "adversary.verdict": 3,
  "belief.changed": 4,
  "certificate.issued": 5,
  "certificate.revoked": 6,
  decision: 7,
  "approval.decided": 8,
  budget: 9,
  "run.finished": 10,
};

export const STAGE_OF_TYPE: Readonly<Record<Exclude<TimelineEventType, "budget" | "run.finished">, TimelineStage>> = {
  "anomaly.detected": "read",
  "probe.committed": "test",
  "probe.verdict": "test",
  "adversary.verdict": "challenge",
  "belief.changed": "certify",
  "certificate.issued": "certify",
  "certificate.revoked": "certify",
  decision: "enforce",
  "approval.decided": "enforce",
};

/** Stage of `budget` and `run.finished`: the last stage the bundle kind reaches. */
export function finalStageOf(kind: RunBundle["kind"]): TimelineStage {
  return kind === "notarize" ? "certify" : "enforce";
}

interface Draft {
  event: DerivedTimelineEvent;
  pos: number;
}

const ADVERSARY_REASON = /^adversary (uphold|narrow|downgrade) \(/;
const ADVERSARY_UNAVAILABLE = /^adversary review unavailable/;

function ids(...xs: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const x of xs) if (x && !out.includes(x)) out.push(x);
  return out;
}

const p3 = (x: number): string => x.toFixed(3);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

function cmp(a: Draft, b: Draft): number {
  const ta = Date.parse(a.event.at);
  const tb = Date.parse(b.event.at);
  if (ta !== tb) return ta - tb;
  const ra = TYPE_RANK[a.event.type];
  const rb = TYPE_RANK[b.event.type];
  if (ra !== rb) return ra - rb;
  const ia = a.event.recordIds[0] ?? "";
  const ib = b.event.recordIds[0] ?? "";
  if (ia !== ib) return ia < ib ? -1 : 1;
  return a.pos - b.pos;
}

function maxIso(xs: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const x of xs) if (best === undefined || Date.parse(x) > Date.parse(best)) best = x;
  return best;
}

/** BudgetSnapshot from the bundle (rules in the module comment). */
export function budgetSnapshot(bundle: RunBundle): BudgetSnapshot {
  const toolCalls = bundle.probes.reduce((n, p) => n + p.calls, 0) + bundle.decisions.reduce((n, d) => n + d.effects.length, 0);
  return {
    credits: { used: bundle.credits.total, cap: bundle.credits.budget },
    toolCalls: { used: toolCalls, cap: null },
    usdByRole: {
      executor: bundle.usageByRole.executor.usd,
      reflector: bundle.usageByRole.reflector.usd,
      adversary: bundle.usageByRole.adversary.usd,
    },
    // The frozen bundle schema has no USD-cap field; the cap is known only when the run stopped on it
    // (its stopReason states "NOTARY_MAX_USD=<n>"). Otherwise null (no cap, or a cap never reached).
    usdCap: usdCapFromStopReason(bundle.stopReason),
    ...(bundle.stopReason ? { stopReason: bundle.stopReason } : {}),
  };
}

function snapshotOf(bundle: RunBundle, beliefId: string): Belief | undefined {
  return bundle.beliefs.after.find((b) => b.id === beliefId) ?? bundle.beliefs.before.find((b) => b.id === beliefId);
}

function claimIdOf(bundle: RunBundle, beliefId: string): string {
  return snapshotOf(bundle, beliefId)?.claimId ?? beliefId.replace(/^belief-/, "");
}

/** Certificate issuances and revocations certify would compute, from `context` + `bundle`. */
function certifyView(bundle: RunBundle, context: readonly RunBundle[]): { issued: Issuance[]; revoked: Revocation[] } {
  if (bundle.beliefEvents.length === 0) return { issued: [], revoked: [] };
  const t0 = Date.parse(bundle.startedAt);
  const ctx = context.filter(
    (b) => b.runId !== bundle.runId && b.runId !== bundle.replayOf && b.sample === bundle.sample && Date.parse(b.startedAt) <= t0,
  );
  const all = [...ctx, bundle];
  const issued: Issuance[] = [];
  const revoked: Revocation[] = [];
  for (const tool of TOOLS) {
    const ledger = buildLedger(all, tool, []);
    const iss = issuances(ledger);
    issued.push(...iss);
    revoked.push(...buildRevocations(ledger, iss, { sample: bundle.sample, disclosure: [] }));
  }
  return { issued, revoked };
}

/** When each decision became final (module comment). Index-aligned with bundle.decisions. */
function decisionTimes(bundle: RunBundle): string[] {
  const others: string[] = [];
  for (const p of bundle.probes) others.push(p.committedAt, ...(p.ranAt ? [p.ranAt] : []));
  for (const e of bundle.beliefEvents) others.push(e.at);
  const firstEffect = bundle.decisions.map((d) => (d.effects.length ? Math.min(...d.effects.map((e) => Date.parse(e.at))) : Infinity));
  const out: string[] = [];
  let prev = bundle.startedAt;
  bundle.decisions.forEach((d, i) => {
    let nextStart = Infinity;
    for (let j = i + 1; j < bundle.decisions.length; j++) nextStart = Math.min(nextStart, firstEffect[j]!);
    const own = d.effects.map((e) => e.at);
    const between = others.filter((t) => Date.parse(t) > Date.parse(prev) && Date.parse(t) < nextStart);
    const at = maxIso([prev, ...own, ...between])!;
    out.push(at);
    prev = at;
  });
  return out;
}

function decisionAmount(bundle: RunBundle, d: Decision): { amount?: number; currency?: string } {
  const write = [...d.effects].reverse().find((e) => e.op === d.action && e.amount !== undefined);
  const req = bundle.queue.find((q) => q.id === d.requestId);
  const amount = write?.amount ?? req?.amount;
  const currency = write?.currency ?? req?.currency;
  return { ...(amount !== undefined ? { amount } : {}), ...(currency !== undefined ? { currency } : {}) };
}

function decisionSummary(d: Decision, money: { amount?: number; currency?: string }): string {
  const what = d.action === "none" ? "no action" : `${d.action}${money.amount !== undefined ? ` of ${money.amount}${money.currency ? ` ${money.currency}` : ""} (minor units)` : ""}`;
  const missing = d.missingBeliefs.length ? `; missing notarized beliefs: ${d.missingBeliefs.join(", ")}` : "";
  const guards = d.guardsApplied.length ? `; guards applied: ${d.guardsApplied.join(", ")}` : "";
  return `Request ${d.requestId} ${d.status}: ${what}${missing}${guards}.`;
}

function probeWinningClass(bundle: RunBundle, p: Probe): string | undefined {
  if (p.verdict !== "confirmed" || !p.winningHypothesisId) return undefined;
  return bundle.hypotheses.find((h) => h.id === p.winningHypothesisId)?.class;
}

export function deriveTimeline(bundle: RunBundle, opts: DeriveTimelineOptions = {}): DerivedTimelineEvent[] {
  const runId = bundle.runId;
  const drafts: Draft[] = [];
  let pos = 0;
  const push = (event: DerivedTimelineEvent): void => {
    drafts.push({ event, pos: pos++ });
  };
  const probeById = new Map(bundle.probes.map((p) => [p.id, p] as const));

  // ---- read
  for (const a of bundle.anomalies) {
    push({
      runId,
      at: bundle.startedAt,
      stage: "read",
      type: "anomaly.detected",
      recordIds: ids(a.id, a.claimId),
      traceIds: ids(a.traceId),
      summary: `The checker found a recorded ${a.tool} response that does not match documented claim ${a.claimId}.`,
      data: { claimId: a.claimId, tool: a.tool },
    });
  }

  // ---- test
  for (const p of bundle.probes) {
    push({
      runId,
      at: p.committedAt,
      stage: "test",
      type: "probe.committed",
      recordIds: ids(p.id, ...p.hypothesisIds, p.claimId),
      traceIds: ids(p.traceId),
      summary: `Probe ${p.id} (${p.template}) committed its predictions for ${p.claimId} before running.`,
      data: { claimId: p.claimId, template: p.template, tool: p.tool, hypotheses: p.hypothesisIds.length },
    });
    if (p.verdict) {
      const cls = probeWinningClass(bundle, p);
      push({
        runId,
        at: p.ranAt ?? p.committedAt,
        stage: "test",
        type: "probe.verdict",
        recordIds: ids(p.id, p.winningHypothesisId, p.claimId),
        traceIds: ids(p.traceId),
        summary: `Probe ${p.id} (${p.template}) on ${p.claimId}: ${p.verdict}${cls ? ` (${cls})` : ""}, ${plural(p.calls, "call")}, ${plural(p.costCredits, "credit")}.`,
        data: {
          claimId: p.claimId,
          template: p.template,
          verdict: p.verdict,
          costCredits: p.costCredits,
          calls: p.calls,
          ...(p.winningHypothesisId ? { winningHypothesisId: p.winningHypothesisId } : {}),
          ...(cls ? { winningClass: cls } : {}),
        },
      });
    }
  }

  // ---- challenge + certify (belief events, in bundle order)
  const view = certifyView(bundle, opts.context ?? []);
  bundle.beliefEvents.forEach((e: BeliefEvent) => {
    const claimId = claimIdOf(bundle, e.beliefId);
    const probe = e.probeId ? probeById.get(e.probeId) : undefined;
    const probeTrace = probe ? ids(probe.traceId) : [];
    const snap = snapshotOf(bundle, e.beliefId);

    if (e.from === "candidate" && (ADVERSARY_REASON.test(e.reason) || ADVERSARY_UNAVAILABLE.test(e.reason))) {
      const verdict = ADVERSARY_REASON.exec(e.reason)?.[1] ?? null;
      const review = snap?.adversary;
      const matched = review && verdict !== null && review.verdict === verdict && (!review.reviewedAt || Date.parse(review.reviewedAt) <= Date.parse(e.at)) ? review : undefined;
      push({
        runId,
        at: matched?.reviewedAt ?? e.at,
        stage: "challenge",
        type: "adversary.verdict",
        recordIds: ids(e.beliefId, claimId),
        traceIds: [],
        summary:
          verdict === null
            ? `Adversary review of ${claimId} was unavailable; the belief stays candidate (fail safe).`
            : `Adversary ${verdict === "uphold" ? "upheld" : verdict === "narrow" ? "narrowed" : "downgraded"} ${claimId}: belief ${e.from} → ${e.to}.`,
        data: {
          beliefId: e.beliefId,
          claimId,
          verdict,
          to: e.to,
          ...(matched ? { model: matched.model, ...(matched.backend ? { backend: matched.backend } : {}), ...(matched.scope ? { scope: matched.scope } : {}) } : {}),
        },
      });
    }

    push({
      runId,
      at: e.at,
      stage: "certify",
      type: "belief.changed",
      recordIds: ids(e.beliefId, claimId, e.probeId),
      traceIds: probeTrace,
      summary:
        e.from === null
          ? `Belief in ${claimId} created as ${e.to} at P(holds)=${p3(e.confidence)}.`
          : e.from === e.to
            ? `Belief in ${claimId} stays ${e.to}, P(holds)=${p3(e.confidence)} (Beta(${e.alpha}, ${e.beta})).`
            : `Belief in ${claimId}: ${e.from} → ${e.to}, P(holds)=${p3(e.confidence)} (Beta(${e.alpha}, ${e.beta})).`,
      data: {
        beliefId: e.beliefId,
        claimId,
        from: e.from,
        to: e.to,
        confidence: e.confidence,
        alpha: e.alpha,
        beta: e.beta,
        ...(e.probeId ? { probeId: e.probeId } : {}),
      },
    });

    if (e.to === "notarized" && e.from !== "notarized") {
      const iss = view.issued.find((x) => x.issuedFrom === "event" && x.beliefId === e.beliefId && x.issuedAt === e.at);
      const tool = iss?.tool ?? snap?.tool;
      if (tool) {
        const side = iss?.side ?? sideOfConfidence(e.confidence);
        const certId = iss?.certificateId ?? certificateId(tool, claimId, side, e.at);
        // Evidence applied up to this notarization (same rule as certify's evidenceAt).
        const applied = new Map<string, number>();
        bundle.beliefEvents.forEach((x, i) => {
          if (x.beliefId === e.beliefId && x.probeId && !applied.has(x.probeId)) applied.set(x.probeId, i);
        });
        const at = bundle.beliefEvents.indexOf(e);
        const evidence = (snap?.evidence ?? []).filter((ev) => (applied.get(ev.probeId) ?? -1) <= at);
        push({
          runId,
          at: e.at,
          stage: "certify",
          type: "certificate.issued",
          recordIds: ids(certId, e.beliefId, claimId),
          traceIds: ids(...probeTrace, ...evidence.map((ev) => ev.traceId)),
          summary: `Certificate ${certId} issued: ${claimId} ${side === "honored" ? "matches the docs" : "contradicts the docs"} (P(holds)=${p3(e.confidence)}).`,
          data: { certificateId: certId, beliefId: e.beliefId, claimId, tool, side, confidence: e.confidence },
        });
      }
    }

    if (e.from === "notarized" && e.to !== "notarized") {
      const rev = view.revoked.find((r) => r.beliefId === e.beliefId && r.revokedAt === e.at && r.to === e.to);
      push({
        runId,
        at: e.at,
        stage: "certify",
        type: "certificate.revoked",
        recordIds: rev ? ids(rev.id, rev.certificateId, e.beliefId, claimId, ...rev.triggerProbeIds) : ids(e.beliefId, claimId, e.probeId),
        traceIds: rev ? ids(...rev.triggerTraceIds) : probeTrace,
        summary: rev
          ? `Certificate ${rev.certificateId} revoked: ${claimId} left notarized (now ${e.to}, P(holds)=${p3(e.confidence)}).`
          : `The certificate for ${claimId} was revoked: the belief left notarized (now ${e.to}, P(holds)=${p3(e.confidence)}); the notarization that issued it is not in this bundle, so its certificate id is not computed here.`,
        data: {
          revocationId: rev?.id ?? null,
          certificateId: rev?.certificateId ?? null,
          beliefId: e.beliefId,
          claimId,
          to: e.to,
          confidence: e.confidence,
          triggerProbeIds: rev ? rev.triggerProbeIds : ids(e.probeId),
          ...(rev ? { guardsRetired: rev.guardsRetired.map((g) => g.id) } : {}),
        },
      });
    }
  });

  // ---- enforce
  const times = decisionTimes(bundle);
  bundle.decisions.forEach((d, i) => {
    const money = decisionAmount(bundle, d);
    push({
      runId,
      at: times[i]!,
      stage: "enforce",
      type: "decision",
      recordIds: ids(d.id, d.requestId, ...d.missingBeliefs, ...d.guardsApplied),
      traceIds: ids(d.traceId),
      summary: decisionSummary(d, money),
      data: {
        requestId: d.requestId,
        requestType: d.requestType,
        tier: d.tier,
        policyOutcome: d.policyOutcome,
        status: d.status,
        action: d.action,
        ...money,
        guardsApplied: [...d.guardsApplied],
        missingBeliefs: [...d.missingBeliefs],
        effects: d.effects.length,
      },
    });
  });

  drafts.sort(cmp);
  const events = drafts.map((d) => d.event);

  // ---- budget + run.finished (always last)
  const end = bundle.finishedAt ?? maxIso(events.map((e) => e.at)) ?? bundle.startedAt;
  const stage = finalStageOf(bundle.kind);
  const budget = budgetSnapshot(bundle);
  const usd = budget.usdByRole.executor + budget.usdByRole.reflector + budget.usdByRole.adversary;
  events.push({
    runId,
    at: end,
    stage,
    type: "budget",
    recordIds: [runId],
    traceIds: [],
    summary: `Budget: ${budget.credits.used} of ${budget.credits.cap} credits, ${plural(budget.toolCalls.used, "recorded tool call")} (probe calls + decision effects), $${usd.toFixed(4)} model spend${budget.stopReason ? `; stopped: ${budget.stopReason}` : ""}.`,
    data: { budget },
  });
  events.push({
    runId,
    at: end,
    stage,
    type: "run.finished",
    recordIds: [runId],
    traceIds: [],
    summary: `${bundle.kind === "notarize" ? "Notarization" : "Run"} ${runId} finished: ${bundle.status}${bundle.stopReason ? ` (${bundle.stopReason})` : ""}.`,
    data: { status: bundle.status, ...(bundle.stopReason ? { stopReason: bundle.stopReason } : {}), metrics: { ...bundle.metrics }, budget },
  });
  return events;
}

/**
 * A live, best-effort timeline event for a decision the moment the runner reports it (before the
 * bundle exists). Same shape and summary as the derived one; `at` is the decision's last effect
 * (or `now` when it made none). The file written at the end of the run is the source of truth.
 */
export function liveDecisionEvent(runId: string, d: Decision, request: { amount?: number; currency?: string } | undefined, now: string): DerivedTimelineEvent {
  const write = [...d.effects].reverse().find((e) => e.op === d.action && e.amount !== undefined);
  const amount = write?.amount ?? request?.amount;
  const currency = write?.currency ?? request?.currency;
  const money = { ...(amount !== undefined ? { amount } : {}), ...(currency !== undefined ? { currency } : {}) };
  return {
    runId,
    at: maxIso(d.effects.map((e) => e.at)) ?? now,
    stage: "enforce",
    type: "decision",
    recordIds: ids(d.id, d.requestId, ...d.missingBeliefs, ...d.guardsApplied),
    traceIds: ids(d.traceId),
    summary: decisionSummary(d, money),
    data: {
      requestId: d.requestId,
      requestType: d.requestType,
      tier: d.tier,
      policyOutcome: d.policyOutcome,
      status: d.status,
      action: d.action,
      ...money,
      guardsApplied: [...d.guardsApplied],
      missingBeliefs: [...d.missingBeliefs],
      effects: d.effects.length,
    },
  };
}
