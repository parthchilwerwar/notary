/**
 * Per-tool ledger for certificates (DATA ONLY: verified bundles in, no model, no clock).
 *
 * Merges the bundles that speak about one tool into a single chronological view:
 *   sources     the bundles used, oldest first (startedAt, then runId). `run` bundles (queue runs)
 *               are not sources: they carry belief snapshots but no belief events. A `replay` bundle
 *               whose `replayOf` run is also in the input is skipped (it reproduces that run).
 *   latest      each belief's newest snapshot (beliefs.after of the newest source that carries it)
 *   events      every BeliefEvent from every source, de-duplicated (a later bundle may repeat an
 *               event) and ordered by `at`, then source order, then position in the bundle
 *   probes / hypotheses / guards   lookups across sources (newest copy of a guard wins)
 *
 * Browser-safe: imports only zod-backed schema types and pure helpers.
 */
import { canonicalJson, sha256Hex } from "../bundle/hash.js";
import type { Belief, BeliefEvent, Claim, Guard, Hypothesis, Probe, RunBundle, Tool } from "../schema/index.js";

export interface LedgerEvent {
  event: BeliefEvent;
  bundle: RunBundle;
}

export interface IgnoredSource {
  runId: string;
  reason: string;
}

export interface ToolLedger {
  tool: Tool;
  sources: RunBundle[];
  ignored: IgnoredSource[];
  claims: Map<string, Claim>;
  latest: Map<string, { belief: Belief; bundle: RunBundle }>;
  events: LedgerEvent[];
  probes: Map<string, { probe: Probe; bundle: RunBundle }>;
  hypotheses: Map<string, Hypothesis>;
  guards: Map<string, Guard>;
}

export function bundleOrder(x: RunBundle, y: RunBundle): number {
  return Date.parse(x.startedAt) - Date.parse(y.startedAt) || (x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0);
}

function speaksAbout(b: RunBundle, tool: Tool): boolean {
  return b.tool === tool || b.beliefs.after.some((x) => x.tool === tool) || b.beliefEvents.length > 0 && b.beliefs.before.some((x) => x.tool === tool);
}

/** Which input bundles feed `tool`'s certificates, and which were set aside (with the reason). */
export function selectSources(bundles: readonly RunBundle[], tool: Tool): { sources: RunBundle[]; ignored: IgnoredSource[] } {
  const ids = new Set(bundles.map((b) => b.runId));
  const sources: RunBundle[] = [];
  const ignored: IgnoredSource[] = [];
  for (const b of [...bundles].sort(bundleOrder)) {
    if (!speaksAbout(b, tool)) continue;
    if (b.kind === "run") {
      ignored.push({ runId: b.runId, reason: "queue run bundle: carries belief snapshots but no belief events" });
      continue;
    }
    if (b.mode === "replay" && b.replayOf && ids.has(b.replayOf)) {
      ignored.push({ runId: b.runId, reason: `replay of ${b.replayOf}, which is already a source` });
      continue;
    }
    sources.push(b);
  }
  return { sources, ignored };
}

const eventKey = (e: BeliefEvent): string => canonicalJson([e.beliefId, e.at, e.from, e.to, e.reason, e.probeId ?? null]);

export function buildLedger(bundles: readonly RunBundle[], tool: Tool, contractClaims: readonly Claim[]): ToolLedger {
  const { sources, ignored } = selectSources(bundles, tool);
  const claims = new Map<string, Claim>();
  for (const c of contractClaims) if (c.tool === tool) claims.set(c.id, c);
  const latest: ToolLedger["latest"] = new Map();
  const probes: ToolLedger["probes"] = new Map();
  const hypotheses: ToolLedger["hypotheses"] = new Map();
  const guards: ToolLedger["guards"] = new Map();
  const seen = new Set<string>();
  const raw: Array<LedgerEvent & { order: number }> = [];
  let order = 0;
  const beliefIds = new Set<string>();
  for (const b of sources) {
    for (const c of b.claims) if (c.tool === tool) claims.set(c.id, c);
    for (const x of [...b.beliefs.before, ...b.beliefs.after]) if (x.tool === tool) beliefIds.add(x.id);
    for (const x of b.beliefs.after) if (x.tool === tool) latest.set(x.id, { belief: x, bundle: b });
    for (const p of b.probes) if (p.tool === tool) probes.set(p.id, { probe: p, bundle: b });
    for (const h of b.hypotheses) hypotheses.set(h.id, h);
    for (const g of b.guards) guards.set(g.id, g);
  }
  for (const b of sources) {
    for (const e of b.beliefEvents) {
      if (!beliefIds.has(e.beliefId)) continue;
      const k = eventKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      raw.push({ event: e, bundle: b, order: order++ });
    }
  }
  raw.sort((x, y) => Date.parse(x.event.at) - Date.parse(y.event.at) || x.order - y.order);
  return { tool, sources, ignored, claims, latest, events: raw.map(({ event, bundle }) => ({ event, bundle })), probes, hypotheses, guards };
}

export function eventsOf(ledger: ToolLedger, beliefId: string): LedgerEvent[] {
  return ledger.events.filter((e) => e.event.beliefId === beliefId);
}

/** Side a belief was notarized on, from the notarization event's confidence (P(holds) > 0.9 or < 0.1). */
export function sideOfConfidence(confidence: number): "honored" | "violated" {
  return confidence >= 0.5 ? "honored" : "violated";
}

/** Deterministic certificate id: "cert-" + the first 16 hex of sha256(tool, claimId, side, issuedAt). */
export function certificateId(tool: Tool, claimId: string, side: "honored" | "violated", issuedAt: string): string {
  return `cert-${sha256Hex(canonicalJson([tool, claimId, side, issuedAt])).slice(0, 16)}`;
}

/** Deterministic revocation id: "rev-" + the first 16 hex of sha256(certificateId, revokedAt). */
export function revocationId(certId: string, revokedAt: string): string {
  return `rev-${sha256Hex(canonicalJson([certId, revokedAt])).slice(0, 16)}`;
}

/**
 * One notarization of a belief: the `→ notarized` event (or, when no source carries it, the
 * snapshot that shows the belief notarized), the snapshot to read evidence/adversary from, and the
 * first event after it that took the belief out of `notarized` (if any).
 */
export interface Issuance {
  beliefId: string;
  claimId: string;
  tool: Tool;
  side: "honored" | "violated";
  issuedAt: string;
  /** "event" = a `→ notarized` belief event; "snapshot" = no source carries that event. */
  issuedFrom: "event" | "snapshot";
  alpha: number;
  beta: number;
  confidence: number;
  snapshot: Belief;
  bundle: RunBundle;
  leave?: LedgerEvent;
  certificateId: string;
  /** Position of the notarization event in the belief's event list (-1 when issued from a snapshot). */
  eventIndex: number;
}

function snapshotIn(b: RunBundle, beliefId: string): Belief | undefined {
  return b.beliefs.after.find((x) => x.id === beliefId) ?? b.beliefs.before.find((x) => x.id === beliefId);
}

export function issuances(ledger: ToolLedger): Issuance[] {
  const out: Issuance[] = [];
  const beliefIds = new Set<string>([...ledger.latest.keys(), ...ledger.events.map((e) => e.event.beliefId)]);
  for (const beliefId of [...beliefIds].sort()) {
    const evs = eventsOf(ledger, beliefId);
    const latest = ledger.latest.get(beliefId);
    const found: Issuance[] = [];
    for (const [idx, n] of evs.entries()) {
      if (n.event.to !== "notarized" || n.event.from === "notarized") continue;
      const snap = n.bundle.beliefs.after.find((x) => x.id === beliefId) ?? latest?.belief ?? snapshotIn(n.bundle, beliefId);
      if (!snap) continue;
      const side = sideOfConfidence(n.event.confidence);
      found.push({
        beliefId,
        claimId: snap.claimId,
        tool: snap.tool,
        side,
        issuedAt: n.event.at,
        issuedFrom: "event",
        alpha: n.event.alpha,
        beta: n.event.beta,
        confidence: n.event.confidence,
        snapshot: snap,
        bundle: n.bundle,
        certificateId: certificateId(snap.tool, snap.claimId, side, n.event.at),
        eventIndex: idx,
      });
    }
    // The belief is notarized now but no source carries its notarization event (it happened in a run
    // whose bundle is not in the input): issue from the snapshot, at its updatedAt, and say so.
    if (found.length === 0 && latest && latest.belief.status === "notarized") {
      const b = latest.belief;
      const side = b.class === "honored" ? "honored" : b.class ? "violated" : sideOfConfidence(b.confidence);
      found.push({
        beliefId,
        claimId: b.claimId,
        tool: b.tool,
        side,
        issuedAt: b.updatedAt,
        issuedFrom: "snapshot",
        alpha: b.alpha,
        beta: b.beta,
        confidence: b.confidence,
        snapshot: b,
        bundle: latest.bundle,
        certificateId: certificateId(b.tool, b.claimId, side, b.updatedAt),
        eventIndex: -1,
      });
    }
    for (let i = 0; i < found.length; i++) {
      const iss = found[i]!;
      // Event order (not timestamps, which may tie) decides what happened after the notarization.
      const end = found[i + 1]?.eventIndex ?? evs.length;
      const leave = evs.slice(iss.eventIndex + 1, end).find((e) => e.event.from === "notarized" && e.event.to !== "notarized");
      if (leave) iss.leave = leave;
      out.push(iss);
    }
  }
  return out;
}
