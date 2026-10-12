// Certificates: pure helpers (no React). Everything is read from one certificate world (real, or
// one fixture scenario) and the hash-verified bundles of the same cohort; never mixed.
import type {
  Certificate,
  NoCertificate,
  Revocation,
  RunBundle,
} from "../../../../core/src/schema";
import type { CertificateView } from "../../data";
import { label, number } from "../../data";

/**
 * The run (same cohort) that carries a probe record, for linking evidence to its run. A replay
 * re-serves its original's probe ids with the replay's own timestamps, so the live run that
 * actually ran the probe wins; a replay is used only when no live run carries the probe.
 */
export function runWithProbe(bundles: readonly RunBundle[], probeId: string, sample: boolean): RunBundle | undefined {
  const carriers = bundles.filter((b) => b.sample === sample && b.probes.some((p) => p.id === probeId));
  return carriers.find((b) => b.mode !== "replay") ?? carriers[0];
}

/** Tools present in the world's report, in report order. */
export const worldTools = (world: CertificateView): string[] => world.report.tools.map((t) => t.tool);

/** Certificates, revocations and not-certified rows of one tool (or all when `tool` is unset). */
export function filterWorld(world: CertificateView, tool: string | null) {
  const keep = <T extends { tool: string }>(rows: T[]) => (tool ? rows.filter((r) => r.tool === tool) : rows);
  return {
    certificates: keep(world.certificates),
    revocations: keep(world.revocations),
    noCertificates: keep(world.noCertificates),
    counts: tool ? world.report.tools.find((t) => t.tool === tool)?.counts : world.report.overall,
  };
}

/**
 * The page header's summary. It counts the same rows as the stat row and the tables below: active
 * and revoked certificates, and the claims listed without a certificate (never report.overall,
 * which counts every claim the report knows of and can disagree with the rows shown).
 */
export function certificatesSummary(view: Pick<ReturnType<typeof filterWorld>, "certificates" | "noCertificates">): string {
  const active = view.certificates.filter((c) => c.status !== "revoked").length;
  const revoked = view.certificates.length - active;
  const unproven = view.noCertificates.length;
  return [`${number(active)} active`, `${number(revoked)} revoked`, `${number(unproven)} ${unproven === 1 ? "claim" : "claims"} without a certificate`].join(
    " · ",
  );
}

/** The recorded reason, without repeating the status word shown beside it. */
export function reasonText(row: Pick<NoCertificate, "kind" | "reason">): string {
  const kind = label(row.kind).toLowerCase();
  const reason = row.reason.trim();
  if (reason.toLowerCase() === kind) return "";
  const prefix = `${kind}: `;
  return reason.toLowerCase().startsWith(prefix) ? reason.slice(prefix.length) : reason;
}

/**
 * Where an old belief link (/app/beliefs/:id) lands: the certificate built from that belief if
 * there is one, else the claim it belongs to (for the not-certified table), else nothing.
 */
export function resolveBelief(
  world: CertificateView,
  bundles: readonly RunBundle[],
  beliefId: string,
): { certificate?: Certificate; claimId?: string } {
  const certificate = world.certificates.find((c) => c.beliefId === beliefId);
  if (certificate) return { certificate };
  for (const b of bundles) {
    if (b.sample !== world.sample) continue;
    const belief = [...b.beliefs.after, ...b.beliefs.before].find((x) => x.id === beliefId);
    if (belief) return { claimId: belief.claimId };
  }
  return {};
}

export type HeldAfter = { run: RunBundle; decisionIds: string[]; requestIds: string[] };

/** Decisions held in the revocation's source run for lack of the revoked belief. */
export function heldAfterRevocation(revocation: Revocation, bundles: readonly RunBundle[]): HeldAfter | undefined {
  const run = bundles.find((b) => b.runId === revocation.sourceBundle.runId);
  if (!run) return undefined;
  const held = run.decisions.filter((d) => d.status === "held" && d.missingBeliefs.includes(revocation.beliefId));
  return { run, decisionIds: held.map((d) => d.id), requestIds: held.map((d) => d.requestId) };
}

export type TraceRef = {
  probeId: string;
  runId?: string;
  traceId?: string;
  spanId?: string;
  /** As recorded in the run's traceLinks (an http(s) URL, or a local receipt path). */
  recorded?: string;
};

/** Trace ids of the probes a certificate rests on: as the certificate recorded them, else the probe record's. */
export function certificateTraces(certificate: Certificate, bundles: readonly RunBundle[]): TraceRef[] {
  return certificate.evidence.map((e) => {
    const run = runWithProbe(bundles, e.probeId, certificate.sample);
    const probe = run?.probes.find((p) => p.id === e.probeId);
    const traceId = e.traceId || probe?.traceId || undefined;
    return {
      probeId: e.probeId,
      runId: run?.runId,
      traceId,
      spanId: e.spanId || probe?.spanId || undefined,
      recorded: e.traceUrl ?? (traceId ? run?.traceLinks[traceId] : undefined),
    };
  });
}
