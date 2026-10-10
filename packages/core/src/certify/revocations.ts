/**
 * Revocations: derived from bundle data only. A belief event `notarized → unlearned` (P(holds)
 * crossed back over 0.5 against the notarized side; BeliefStore records the probe that tipped it as
 * the event's `probeId`) revokes the certificate issued at the preceding `→ notarized` event. Any
 * other exit from `notarized` (e.g. invalid evidence → hypothesis, which also retires guards) is a
 * revocation too; `to` says which.
 *
 *   triggerProbeIds   the event's own probe first, then every probe applied to the belief between
 *                     the notarization and the revocation that was confirmed AGAINST the notarized side
 *   triggerTraceIds   their trace ids, from the probes in the source bundles
 *   guardsRetired     the belief's guards (newest copy across sources) with a retiredAt after the
 *                     notarization (and before any re-notarization)
 *
 * `sha256` = sha256(canonicalJson(revocation without sha256)), pure JS (bundle/hash.ts) so a browser
 * can verify it. Browser-safe module.
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../bundle/hash.js";
import { RevocationSchema } from "../schema/certificate.js";
import type { RetiredGuard, Revocation } from "../schema/certificate.js";
import type { Guard } from "../schema/index.js";
import type { Issuance, LedgerEvent, ToolLedger } from "./ledger.js";
import { eventsOf, revocationId } from "./ledger.js";

// The zod schemas live in src/schema/certificate.ts (browser-safe, shared with packages/web).
export { RetiredGuardSchema, RevocationSchema, SourceRefSchema } from "../schema/certificate.js";
export type { RetiredGuard, Revocation } from "../schema/certificate.js";

/** sha256 hex of canonicalJson(value without its `sha256` field). */
export function sealOf(value: Record<string, unknown>): string {
  const { sha256: _ignored, ...rest } = value;
  return sha256Hex(canonicalJson(rest));
}

/** True when the record's sha256 matches its content. */
export function verifySeal(value: { sha256: string } & Record<string, unknown>): boolean {
  return sealOf(value) === value.sha256;
}

/** Winning class of a confirmed probe, or null. */
function winningClass(ledger: ToolLedger, probeId: string): string | null {
  const p = ledger.probes.get(probeId)?.probe;
  if (!p || p.verdict !== "confirmed" || !p.winningHypothesisId) return null;
  return ledger.hypotheses.get(p.winningHypothesisId)?.class ?? null;
}

function triggerProbes(ledger: ToolLedger, iss: Issuance, leave: LedgerEvent): string[] {
  const evs = eventsOf(ledger, iss.beliefId);
  const start = iss.eventIndex + 1;
  const end = evs.indexOf(leave);
  const against = (id: string): boolean => {
    const cls = winningClass(ledger, id);
    if (cls === null) return false;
    return iss.side === "honored" ? cls !== "honored" : cls === "honored";
  };
  const ids: string[] = [];
  if (leave.event.probeId) ids.push(leave.event.probeId);
  for (const e of evs.slice(start, end >= 0 ? end : evs.length)) {
    const id = e.event.probeId;
    if (id && !ids.includes(id) && against(id)) ids.push(id);
  }
  return ids;
}

function retiredGuards(ledger: ToolLedger, iss: Issuance, nextIssuedAt: string | undefined): RetiredGuard[] {
  const t0 = Date.parse(iss.issuedAt);
  const t1 = nextIssuedAt === undefined ? Infinity : Date.parse(nextIssuedAt);
  const out: Guard[] = [];
  for (const g of ledger.guards.values()) {
    if (g.beliefId !== iss.beliefId || g.active || !g.retiredAt) continue;
    const t = Date.parse(g.retiredAt);
    if (t >= t0 && t <= t1) out.push(g);
  }
  return out
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((g) => ({ id: g.id, kind: g.kind, operation: g.operation, retiredAt: g.retiredAt! }));
}

/** Revocations for every issuance that later left `notarized`, in issuance order. */
export function buildRevocations(ledger: ToolLedger, issued: readonly Issuance[], opts: { sample: boolean; disclosure: readonly string[] }): Revocation[] {
  const out: Revocation[] = [];
  for (const [i, iss] of issued.entries()) {
    const leave = iss.leave;
    if (!leave) continue;
    const next = issued.slice(i + 1).find((x) => x.beliefId === iss.beliefId);
    const probeIds = triggerProbes(ledger, iss, leave);
    const traceIds: string[] = [];
    for (const id of probeIds) {
      const t = ledger.probes.get(id)?.probe.traceId;
      if (t && !traceIds.includes(t)) traceIds.push(t);
    }
    const body = {
      id: revocationId(iss.certificateId, leave.event.at),
      certificateId: iss.certificateId,
      tool: iss.tool,
      claimId: iss.claimId,
      beliefId: iss.beliefId,
      revokedAt: leave.event.at,
      from: "notarized" as const,
      to: leave.event.to,
      reason: leave.event.reason,
      alpha: leave.event.alpha,
      beta: leave.event.beta,
      confidence: leave.event.confidence,
      triggerProbeIds: probeIds,
      triggerTraceIds: traceIds,
      guardsRetired: retiredGuards(ledger, iss, next?.issuedAt),
      sourceBundle: { runId: leave.bundle.runId, contentHash: leave.bundle.contentHash },
      sample: opts.sample,
      disclosure: [...opts.disclosure],
    };
    out.push(RevocationSchema.parse({ ...body, sha256: sealOf(body) }));
  }
  return out;
}

/** Schema-check a revocation and recompute its sha256. */
export function verifyRevocation(raw: unknown): { ok: true; revocation: Revocation } | { ok: false; error: string } {
  const parsed = RevocationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `revocation failed schema validation: ${z.prettifyError(parsed.error)}` };
  const actual = sealOf(parsed.data);
  if (actual !== parsed.data.sha256) return { ok: false, error: `sha256 mismatch for ${parsed.data.id}: recorded ${parsed.data.sha256}, computed ${actual}` };
  return { ok: true, revocation: parsed.data };
}
