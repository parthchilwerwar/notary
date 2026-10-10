// Pure derivation of the Decision trail and the Certificate trail. No React here.
//
// A trail is five steps, each a list of lines (and, for evidence, one collapsible group per
// required belief). Every line carries exactly one provenance tag from `classifySource`:
//   "verified"  computed by deterministic code or observed from an API (hashes, commit times,
//               observations, verdicts, belief math, policy, guards, effects, grades, records)
//   "model"     produced by a model (reflector hypotheses, adversary review text, narrowed scope
//               text, executor/reflector output). Unknown sources are "model".
// Every value is read from the bundles and the certificate world; nothing is invented. Trace URLs
// come only from recorded trace links (passed through `safeLink`); otherwise the id stays text.
import type {
  Belief,
  BeliefEvent,
  Certificate,
  Decision,
  Hypothesis,
  NoCertificate,
  Probe,
  QueueRequest,
  Revocation,
  RunBundle,
} from "../../../../core/src/schema";
import { canonicalJson, sha256Hex } from "../../../../core/src/bundle/hash";
import type { CertificateWorld } from "../../state/certificates";
import { scenarioKey } from "../../state/data-mode";
import { safeLink } from "../../data";

// ------------------------------------------------------------------------------ classification

export type TrailTag = "model" | "verified";

/** Where a line's content came from. */
export type TrailSource =
  | "request" // queue request record (seeded input)
  | "enrichment" // Crustdata response fields recorded on the decision
  | "tier" // tier derived by code from enrichment
  | "claim" // documented claim text and URL, as recorded
  | "scope" // as-probed scope, computed by src/certify
  | "scope.narrowed" // narrowed scope text, written by the adversary model
  | "certificate" // certificate status / verdict / seal, computed by src/certify
  | "revocation" // revocation record, computed by src/certify
  | "belief.math" // Beta(α, β), P(holds), status
  | "belief.event" // recorded belief status change
  | "hypothesis.code" // code-built verification rival (DECISIONS #81), not model-proposed
  | "hypothesis.model" // reflector-proposed hypothesis
  | "prediction" // committed prediction, its sha256 and commit time
  | "observation" // probe observation
  | "verdict" // probe verdict
  | "adversary" // adversary review text
  | "policy" // policy outcome, tier, action
  | "guard" // guard applied / retired
  | "effect" // recorded API effect
  | "grade" // deterministic grade
  | "evidence-pack" // reason text written by the gate / guards / sentinel code
  | "executor" // executor model output
  | "reflector" // reflector model output
  | "record"; // a statement the trail code makes about records (e.g. "not published")

const VERIFIED_SOURCES: ReadonlySet<string> = new Set<TrailSource>([
  "request",
  "enrichment",
  "tier",
  "claim",
  "scope",
  "certificate",
  "revocation",
  "belief.math",
  "belief.event",
  "hypothesis.code",
  "prediction",
  "observation",
  "verdict",
  "policy",
  "guard",
  "effect",
  "grade",
  "evidence-pack",
  "record",
]);

/**
 * THE classification rule. "verified" only for sources produced by deterministic code or observed
 * from an API; everything else, including any source this list does not know, is "model".
 */
export function classifySource(source: string): TrailTag {
  return VERIFIED_SOURCES.has(source) ? "verified" : "model";
}

/** Code-built verification rivals carry an anomaly id of `verify:<claimId>` (DECISIONS #81). */
export function hypothesisSource(h: Pick<Hypothesis, "anomalyId">): TrailSource {
  return h.anomalyId.startsWith("verify:") ? "hypothesis.code" : "hypothesis.model";
}

export const TAG_LABEL: Record<TrailTag, string> = {
  verified: "Verified",
  model: "Model said",
};

// ------------------------------------------------------------------------------------- shapes

export type RecordRef = {
  kind: "decision" | "probe" | "belief" | "certificate" | "run";
  id: string;
  /** Run to open the record in (certificates: the selected run). */
  runId?: string;
};

export type TrailLine = {
  key: string;
  source: TrailSource;
  tag: TrailTag;
  label: string;
  text: string;
  /** Secondary, usually monospace detail (hashes, times, model names). */
  detail?: string;
  /** Status value rendered as a pill. */
  status?: string;
  traceId?: string;
  /** Recorded trace URL (already passed through safeLink); absent when none was recorded. */
  traceUrl?: string;
  record?: RecordRef;
  /** External documentation link, as recorded. */
  href?: string;
  /** A check the trail ran that failed (hash mismatch, commit after run), or a graded unsafe action. Shown as a warning. */
  warning?: string;
  decisive?: boolean;
};

export type TrailGroup = {
  key: string;
  title: string;
  subtitle?: string;
  status?: string;
  decisive?: boolean;
  record?: RecordRef;
  lines: TrailLine[];
};

export type TrailStepKey = "request" | "context" | "certificates" | "evidence" | "decision";

export type TrailStep = {
  key: TrailStepKey;
  title: string;
  summary: string;
  lines: TrailLine[];
  groups: TrailGroup[];
};

export type DecidedByKind =
  | "revoked_certificate"
  | "missing_certificate"
  | "guard"
  | "certificates_held"
  | "policy";

export type DecidedBy = {
  kind: DecidedByKind;
  text: string;
  /** Certificate, belief or guard ids that decided it. */
  ids: string[];
};

export type TrailModel = {
  kind: "decision" | "certificate";
  runId?: string;
  sample: boolean;
  steps: TrailStep[];
  decidedBy?: DecidedBy;
  /** Unsafe actions the deterministic grader recorded on this decision (decision trails only). */
  unsafe?: string[];
  /** Shown above the steps when part of the trail could not be resolved in this data world. */
  notes: string[];
};

export type RequiredStatus = "certified" | "unproven" | "revoked" | "missing";

// ------------------------------------------------------------------------------------ helpers

type LineInit = Omit<TrailLine, "tag" | "source" | "key"> & { key?: string };

/** Every line is built here, so every line gets exactly one tag from `classifySource`. */
function line(source: TrailSource, init: LineInit): TrailLine {
  return {
    ...init,
    key: init.key ?? source,
    source,
    tag: classifySource(source),
  };
}

const fmtNumber = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n);

const fmtProb = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n);

const words = (s: string) => s.replaceAll("_", " ");

/** Compact, lossless-enough text for a recorded value. */
export function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "not recorded";
  if (typeof value === "number") return fmtNumber(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatValue).join(" | ");
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) =>
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? `${k} {${formatValue(v)}}`
          : `${k} ${formatValue(v)}`,
      )
      .join(" · ");
  return String(value);
}

/** Trace id plus the first recorded URL for it among the given link maps. */
export function resolveTrace(
  traceId: string | undefined,
  maps: (Record<string, string> | undefined)[],
): { traceId?: string; traceUrl?: string } {
  if (!traceId) return {};
  for (const m of maps) {
    const url = safeLink(m?.[traceId]);
    if (url) return { traceId, traceUrl: url };
  }
  return { traceId };
}

/** Does this certificate world belong to the bundle's data world? */
export function worldMatches(
  world: CertificateWorld | undefined,
  bundle: Pick<RunBundle, "sample" | "runId">,
): world is CertificateWorld {
  if (!world || world.sample !== bundle.sample) return false;
  if (!world.sample) return true;
  const key = scenarioKey(bundle.runId);
  return world.report.sourceBundles.some((s) => scenarioKey(s.runId) === key);
}

/**
 * Bundles of one data world: the bundle itself, the certificate world's source bundles (same
 * run id AND content hash), and, for fixture runs, runs of the same fixture scenario. Never mixes
 * fixture with real data.
 */
export function worldPool(
  bundle: RunBundle | undefined,
  bundles: RunBundle[],
  world: CertificateWorld | undefined,
): RunBundle[] {
  const sample = bundle?.sample ?? world?.sample;
  if (sample === undefined) return [];
  const sources = new Set(
    world && world.sample === sample
      ? world.report.sourceBundles.map((s) => `${s.runId}\n${s.contentHash}`)
      : [],
  );
  const keys = new Set<string>();
  if (sample) {
    if (bundle) keys.add(scenarioKey(bundle.runId));
    else if (world)
      for (const s of world.report.sourceBundles) keys.add(scenarioKey(s.runId));
  }
  const pool = bundles.filter(
    (b) =>
      b.sample === sample &&
      b.runId !== bundle?.runId &&
      (sources.has(`${b.runId}\n${b.contentHash}`) ||
        (b.sample && keys.has(scenarioKey(b.runId)))),
  );
  return bundle ? [bundle, ...pool] : pool;
}

function findProbe(
  pool: RunBundle[],
  id: string,
): { probe: Probe; bundle: RunBundle } | undefined {
  for (const b of pool) {
    const probe = b.probes.find((p) => p.id === id);
    if (probe) return { probe, bundle: b };
  }
}

function findHypothesis(
  pool: RunBundle[],
  first: RunBundle,
  id: string,
): Hypothesis | undefined {
  for (const b of [first, ...pool]) {
    const h = b.hypotheses.find((x) => x.id === id);
    if (h) return h;
  }
}

function findBelief(
  pool: RunBundle[],
  id: string,
): { belief: Belief; bundle: RunBundle } | undefined {
  for (const b of pool) {
    const belief =
      b.beliefs.after.find((x) => x.id === id) ??
      b.beliefs.before.find((x) => x.id === id);
    if (belief) return { belief, bundle: b };
  }
}

/** The certificate for a belief: the active one, else the most recently issued. */
export function certificateFor(
  world: CertificateWorld | undefined,
  beliefId: string,
): Certificate | undefined {
  if (!world) return;
  const certs = world.certificates.filter((c) => c.beliefId === beliefId);
  return (
    certs.find((c) => c.status === "active") ??
    [...certs].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0]
  );
}

export function requiredStatus(
  world: CertificateWorld | undefined,
  beliefId: string,
  claimId: string | undefined,
): {
  status: RequiredStatus;
  certificate?: Certificate;
  revocation?: Revocation;
  noCertificate?: NoCertificate;
} {
  const certificate = certificateFor(world, beliefId);
  if (certificate) {
    if (certificate.status === "active") return { status: "certified", certificate };
    return {
      status: "revoked",
      certificate,
      revocation: world?.revocations.find((r) => r.certificateId === certificate.id),
    };
  }
  const noCertificate = claimId
    ? world?.noCertificates.find((n) => n.claimId === claimId)
    : undefined;
  if (noCertificate) return { status: "unproven", noCertificate };
  return { status: "missing" };
}

/**
 * When an executed decision's write happened: its last recorded effect. Undefined for decisions
 * that did not execute (their last effect is a pre-write read, not the moment of the decision).
 */
function executedAt(d: Decision): string | undefined {
  if (d.status !== "executed") return;
  return d.effects.map((e) => e.at).sort().at(-1);
}

const short = (hash: string) => `${hash.slice(0, 12)}…`;

// ------------------------------------------------------------------- shared evidence group

/**
 * Hypotheses, committed predictions, observations, verdicts, status changes and the adversary
 * challenge behind one belief. `belief` is the snapshot to read evidence from; `pool` is the
 * data world the probe records are looked up in.
 */
export function beliefEvidenceLines(
  belief: Belief,
  beliefBundle: RunBundle,
  pool: RunBundle[],
  linkMaps: (Record<string, string> | undefined)[],
): TrailLine[] {
  const lines: TrailLine[] = [];
  const beliefRef: RecordRef = { kind: "belief", id: belief.id, runId: beliefBundle.runId };
  lines.push(
    line("belief.math", {
      label: "Belief",
      text: `Beta(${fmtNumber(belief.alpha)}, ${fmtNumber(belief.beta)}) · P(holds) = ${fmtProb(belief.confidence)}`,
      status: belief.status,
      detail: `${belief.evidence.length} cited probe(s) · updated ${belief.updatedAt}`,
      record: beliefRef,
    }),
  );

  const found = belief.evidence.map((e) => ({ e, hit: findProbe(pool, e.probeId) }));

  // Hypotheses, once each, in the order the probes cite them.
  const seen = new Set<string>();
  for (const { hit } of found) {
    if (!hit) continue;
    for (const hid of hit.probe.hypothesisIds) {
      if (seen.has(hid)) continue;
      seen.add(hid);
      const h = findHypothesis(pool, hit.bundle, hid);
      lines.push(
        h
          ? line(hypothesisSource(h), {
              label: `Hypothesis · ${words(h.class)}`,
              text: h.statement,
              detail: `${h.id} · test ${words(h.distinguishingTest)}`,
            })
          : line("record", {
              label: "Hypothesis",
              text: `${hid} is cited by ${hit.probe.id} but not recorded in this data world.`,
            }),
      );
    }
  }

  for (const { e, hit } of found) {
    if (!hit) {
      lines.push(
        line("record", {
          label: `Probe ${e.probeId}`,
          text: "Cited by the belief; the probe record is not in this data world's published bundles.",
          ...resolveTrace(e.traceId, linkMaps),
        }),
      );
      continue;
    }
    const { probe, bundle } = hit;
    const trace = resolveTrace(probe.traceId, [bundle.traceLinks, ...linkMaps]);
    const record: RecordRef = { kind: "probe", id: probe.id, runId: bundle.runId };
    const recomputed = sha256Hex(canonicalJson(probe.prediction));
    const hashOk = recomputed === probe.predictionHash;
    const beforeRun = probe.ranAt ? probe.committedAt <= probe.ranAt : undefined;
    const warnings = [
      !hashOk && `prediction hash mismatch: recomputed ${short(recomputed)}`,
      beforeRun === false && `committed at ${probe.committedAt}, after the call at ${probe.ranAt}`,
    ].filter(Boolean);
    lines.push(
      line("prediction", {
        key: `prediction-${bundle.runId}-${probe.id}`,
        label: `Committed prediction · ${probe.id}`,
        text: Object.entries(probe.prediction)
          .map(([hid, v]) => `${hid}: ${formatValue(v)}`)
          .join("; "),
        detail: `sha256 ${short(probe.predictionHash)}${hashOk ? " (recomputed, matches)" : ""} · committed ${probe.committedAt}${probe.ranAt ? ` · ran ${probe.ranAt}` : " · not run"}`,
        warning: warnings.length ? warnings.join("; ") : undefined,
        record,
        ...trace,
      }),
      line("observation", {
        key: `observation-${bundle.runId}-${probe.id}`,
        label: `Observation · ${words(probe.template)}`,
        text:
          probe.observed === undefined ? "Not observed (probe did not run)." : formatValue(probe.observed),
        detail: `${fmtNumber(probe.calls)} call(s) · ${fmtNumber(probe.costCredits)} credit(s)`,
        record,
        ...trace,
      }),
    );
    const winner = probe.winningHypothesisId
      ? findHypothesis(pool, bundle, probe.winningHypothesisId)
      : undefined;
    lines.push(
      line("verdict", {
        key: `verdict-${bundle.runId}-${probe.id}`,
        label: "Verdict",
        text: probe.verdict
          ? `${words(probe.verdict)}${probe.winningHypothesisId ? ` → ${probe.winningHypothesisId}${winner ? ` (${words(winner.class)})` : ""}` : ""}`
          : "No verdict recorded.",
        status: probe.verdict,
        detail:
          e.valid === false
            ? "rejected as evidence by the evidence-validity check"
            : e.valid
              ? "passed the evidence-validity check"
              : undefined,
        record,
        ...trace,
      }),
    );
  }

  // Recorded status changes for this belief across the data world, oldest first.
  const events: { ev: BeliefEvent; bundle: RunBundle }[] = [];
  const evSeen = new Set<string>();
  for (const b of pool)
    for (const ev of b.beliefEvents)
      if (ev.beliefId === belief.id && ev.from !== null && ev.from !== ev.to) {
        const k = `${ev.at}|${ev.from}|${ev.to}|${ev.probeId ?? ""}`;
        if (evSeen.has(k)) continue;
        evSeen.add(k);
        events.push({ ev, bundle: b });
      }
  events.sort((a, b) => a.ev.at.localeCompare(b.ev.at));
  for (const { ev, bundle } of events) {
    const p = ev.probeId ? findProbe(pool, ev.probeId) : undefined;
    // The status change is code; an adversary's own words inside its reason are not, so they are
    // shown once, on the "Model said" adversary line below.
    const modelText = belief.adversary?.reason;
    const stripped = !!modelText && ev.reason.includes(modelText);
    const text = stripped
      ? ev.reason.replace(modelText, "(adversary's reason: see the challenge below)")
      : ev.reason;
    // Unsure whether model words remain (an adversary event whose text we could not separate)?
    // Then the whole line is "Model said".
    const source: TrailSource =
      !stripped && ev.reason.startsWith("adversary ") ? "adversary" : "belief.event";
    lines.push(
      line(source, {
        label: `Status ${ev.from} → ${ev.to}`,
        text,
        detail: `Beta(${fmtNumber(ev.alpha)}, ${fmtNumber(ev.beta)}) · P(holds) = ${fmtProb(ev.confidence)} · ${ev.at}${ev.probeId ? ` · probe ${ev.probeId}` : ""}`,
        status: ev.to,
        record: { kind: "belief", id: belief.id, runId: bundle.runId },
        ...(p ? resolveTrace(p.probe.traceId, [p.bundle.traceLinks, ...linkMaps]) : {}),
      }),
    );
  }

  const a = belief.adversary;
  lines.push(
    a
      ? line("adversary", {
          label: `Adversary challenge · ${words(a.verdict)}`,
          text: a.reason,
          status: a.verdict,
          detail: [
            `model ${a.model}`,
            a.backend && `backend ${a.backend}`,
            a.scope && `scope ${a.scope}`,
            a.reviewedAt && `reviewed ${a.reviewedAt}`,
          ]
            .filter(Boolean)
            .join(" · "),
          record: beliefRef,
        })
      : line("record", {
          label: "Adversary challenge",
          text: "No adversary review recorded for this belief.",
          record: beliefRef,
        }),
  );
  return lines;
}

function certificateLines(
  status: ReturnType<typeof requiredStatus>,
  linkMaps: (Record<string, string> | undefined)[],
  selectedRunId: string | undefined,
  decidedAt?: string,
): TrailLine[] {
  const out: TrailLine[] = [];
  const c = status.certificate;
  if (c) {
    out.push(
      line("certificate", {
        label: `Certificate ${c.id}`,
        text: c.verdict,
        status: c.status,
        detail: `${words(c.side)} · Beta(${fmtNumber(c.alpha)}, ${fmtNumber(c.beta)}) · issued ${c.issuedAt} · seal ${short(c.sha256)}`,
        record: { kind: "certificate", id: c.id, runId: selectedRunId },
      }),
    );
  }
  const r = status.revocation;
  if (r) {
    const after = decidedAt && r.revokedAt > decidedAt;
    out.push(
      line("revocation", {
        label: `Revoked ${r.id}`,
        text: r.reason,
        status: r.to,
        detail: `revoked ${r.revokedAt}${after ? " (after this decision ran)" : ""} · Beta(${fmtNumber(r.alpha)}, ${fmtNumber(r.beta)}) · trigger probes ${r.triggerProbeIds.join(", ")}${r.guardsRetired.length ? ` · guards retired ${r.guardsRetired.map((g) => `${g.id} (${words(g.kind)})`).join(", ")}` : ""} · source ${r.sourceBundle.runId}`,
        record: { kind: "certificate", id: r.certificateId, runId: selectedRunId },
        ...resolveTrace(r.triggerTraceIds[0], linkMaps),
      }),
    );
  }
  const n = status.noCertificate;
  if (n)
    out.push(
      line("certificate", {
        label: `No certificate · ${words(n.kind)}`,
        text: n.reason,
        status: n.status,
        detail:
          n.alpha !== undefined && n.beta !== undefined
            ? `Beta(${fmtNumber(n.alpha)}, ${fmtNumber(n.beta)})`
            : undefined,
      }),
    );
  return out;
}

// --------------------------------------------------------------------------- decision trail

export function decidedBy(
  decision: Decision,
  statuses: Map<string, ReturnType<typeof requiredStatus>>,
  runId: string,
): DecidedBy {
  const missing = decision.missingBeliefs;
  if (missing.length) {
    const revoked = missing.filter((id) => statuses.get(id)?.status === "revoked");
    if (revoked.length) {
      const certIds = revoked.map((id) => statuses.get(id)!.certificate!.id);
      const during = revoked.some(
        (id) => statuses.get(id)?.revocation?.sourceBundle.runId === runId,
      );
      return {
        kind: "revoked_certificate",
        ids: [...certIds, ...revoked],
        text: `${words(decision.status)}: required certificate ${certIds.join(", ")} was revoked${during ? " during this run" : ""} (${revoked.join(", ")}), so the gate had ${missing.length} missing belief(s).`,
      };
    }
    return {
      kind: "missing_certificate",
      ids: missing,
      text: `${words(decision.status)}: the gate found ${missing.length} required belief(s) missing: ${missing.join(", ")}.`,
    };
  }
  if (decision.guardsApplied.length) {
    const reason = decision.evidencePack?.reason ?? "";
    const named = decision.guardsApplied.filter((g) => reason.includes(g));
    const ids = named.length ? named : decision.guardsApplied;
    return {
      kind: "guard",
      ids,
      text:
        decision.status === "executed"
          ? `executed under guard ${ids.join(", ")}.`
          : `${words(decision.status)}: guard ${ids.join(", ")} decided it.`,
    };
  }
  if (decision.status === "executed" && decision.requiredBeliefs.length)
    return {
      kind: "certificates_held",
      ids: decision.requiredBeliefs,
      text: `executed: policy ${words(decision.policyOutcome)} and all ${decision.requiredBeliefs.length} required belief(s) present.`,
    };
  return {
    kind: "policy",
    ids: [],
    text: `${words(decision.status)}: policy outcome ${words(decision.policyOutcome)}${decision.evidencePack?.reason ? ` (${decision.evidencePack.reason})` : decision.error ? ` (${decision.error})` : ""}.`,
  };
}

function requestLines(
  request: QueueRequest | undefined,
  decision: Decision,
  trace: { traceId?: string; traceUrl?: string },
  record: RecordRef,
): TrailLine[] {
  if (!request)
    return [
      line("record", {
        label: "Request",
        text: `Request ${decision.requestId} is not included in this bundle; the decision records type ${words(decision.requestType)} for ${decision.customerId}.`,
        record,
        ...trace,
      }),
    ];
  const base = { record, ...trace };
  const out: TrailLine[] = [
    line("request", { label: "Type", text: `${words(request.type)} · plan ${request.plan}`, ...base }),
    line("request", {
      label: "Amount",
      text:
        request.amount === undefined
          ? "No amount on the request."
          : `${fmtNumber(request.amount)} ${request.currency ?? "(currency not recorded)"} minor units`,
      ...base,
    }),
    line("request", {
      label: "Customer",
      text: [request.customerId, request.companyDomain, request.customerEmail].filter(Boolean).join(" · "),
      detail: `decision customer ${decision.customerId}`,
      ...base,
    }),
  ];
  const refs = [
    request.paymentId && `payment ${request.paymentId}`,
    request.subscriptionId && `subscription ${request.subscriptionId}`,
    request.targetPlan && `target plan ${request.targetPlan}`,
  ].filter(Boolean);
  if (refs.length) out.push(line("request", { label: "References", text: refs.join(" · "), ...base }));
  out.push(line("request", { label: "Reason", text: request.reason, detail: request.note, ...base }));
  return out;
}

function contextLines(
  decision: Decision,
  trace: { traceId?: string; traceUrl?: string },
  record: RecordRef,
): TrailLine[] {
  const e = decision.enrichment;
  const basis = e && typeof e.tierBasis === "string" ? e.tierBasis : undefined;
  const out: TrailLine[] = [
    line("tier", {
      label: "Tier",
      text: words(decision.tier),
      detail: basis ? `basis ${basis}` : "basis not recorded",
      record,
      ...trace,
    }),
  ];
  if (!e) {
    out.push(
      line("record", { label: "Crustdata", text: "No enrichment recorded on this decision.", record, ...trace }),
    );
    return out;
  }
  const empty: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === "tierBasis") continue;
    if (v === null || v === undefined) {
      empty.push(k);
      continue;
    }
    // Identifiers are shown verbatim, never number-formatted.
    const text = /id$/i.test(k) && typeof v === "number" ? String(v) : formatValue(v);
    out.push(line("enrichment", { label: k, text, record, ...trace }));
  }
  if (empty.length)
    out.push(line("enrichment", { label: "Not returned", text: empty.join(", "), record, ...trace }));
  return out;
}

export type DecisionTrailInput = {
  bundle: RunBundle;
  decisionId: string;
  /** Every verified bundle; filtered to this run's data world here. */
  bundles: RunBundle[];
  /** The certificate world for the selected run (ignored unless it matches this run's world). */
  world?: CertificateWorld;
};

export function deriveDecisionTrail({
  bundle,
  decisionId,
  bundles,
  world: rawWorld,
}: DecisionTrailInput): TrailModel | undefined {
  const decision = bundle.decisions.find((d) => d.id === decisionId);
  if (!decision) return;
  const notes: string[] = [];
  const world = worldMatches(rawWorld, bundle) ? rawWorld : undefined;
  if (!world)
    notes.push(
      rawWorld
        ? "The loaded certificate world belongs to a different data world; certificate statuses are not shown."
        : "No certificate world is loaded for this run; certificate statuses are not shown.",
    );
  const pool = worldPool(bundle, bundles, world);
  const linkMaps = [bundle.traceLinks, decision.evidencePack?.traceLinks];
  const dTrace = resolveTrace(decision.traceId, linkMaps);
  const dRef: RecordRef = { kind: "decision", id: decision.id, runId: bundle.runId };
  const request = bundle.queue.find((r) => r.id === decision.requestId);
  const decidedAt = executedAt(decision);

  // Required certificates.
  const statuses = new Map<string, ReturnType<typeof requiredStatus>>();
  const beliefs = new Map<string, { belief: Belief; bundle: RunBundle } | undefined>();
  for (const id of decision.requiredBeliefs) {
    const hit = findBelief(pool, id);
    beliefs.set(id, hit);
    statuses.set(id, requiredStatus(world, id, hit?.belief.claimId));
  }
  const by = decidedBy(decision, statuses, bundle.runId);
  const decisive = new Set(by.ids);
  const missing = new Set(decision.missingBeliefs);

  const certLines: TrailLine[] = decision.requiredBeliefs.map((id) => {
    const s = statuses.get(id)!;
    const c = s.certificate;
    const isMissing = missing.has(id);
    const revokedAfter =
      s.revocation && decidedAt && s.revocation.revokedAt > decidedAt
        ? ` · revoked ${s.revocation.revokedAt}, after this decision ran`
        : s.revocation
          ? ` · revoked ${s.revocation.revokedAt}`
          : "";
    return line(world ? "certificate" : "record", {
      key: `required-${id}`,
      label: id,
      text: !world
        ? "Certificate status unavailable in this data world."
        : c
          ? `${c.id}: ${c.verdict}`
          : s.noCertificate
            ? s.noCertificate.reason
            : "No certificate and no certificate record for this belief.",
      status: world ? s.status : undefined,
      detail: `${isMissing ? "missing at decision time" : "present at decision time"}${revokedAfter}`,
      record: c
        ? { kind: "certificate", id: c.id, runId: bundle.runId }
        : beliefs.get(id)
          ? { kind: "belief", id, runId: beliefs.get(id)!.bundle.runId }
          : undefined,
      decisive: decisive.has(id) || (c ? decisive.has(c.id) : false),
    });
  });

  // Evidence, one group per required belief.
  const groups: TrailGroup[] = decision.requiredBeliefs.map((id) => {
    const hit = beliefs.get(id);
    const s = statuses.get(id)!;
    const isDecisive = decisive.has(id);
    const lines = [
      ...certificateLines(s, linkMaps, bundle.runId, decidedAt),
      ...(hit
        ? beliefEvidenceLines(hit.belief, hit.bundle, pool, linkMaps)
        : [
            line("record", {
              label: "Belief",
              text: `${id} is not recorded in this data world's published bundles.`,
            }),
          ]),
    ];
    if (isDecisive) {
      // The revocation and the last recorded status change (the one that left the certificate) decided it.
      for (const l of lines) if (l.source === "revocation") l.decisive = true;
      const lastEvent = lines.filter((l) => l.source === "belief.event").at(-1);
      if (lastEvent) lastEvent.decisive = true;
    }
    return {
      key: id,
      title: id,
      subtitle: hit?.belief.statement,
      status: world ? s.status : hit?.belief.status,
      decisive: isDecisive,
      record: hit ? { kind: "belief", id, runId: hit.bundle.runId } : undefined,
      lines,
    };
  });

  // Decision.
  const decisionLines: TrailLine[] = [
    line("policy", {
      label: "Policy",
      text: `${words(decision.policyOutcome)} · action ${decision.action}`,
      detail: `${words(decision.requestType)} · tier ${words(decision.tier)}`,
      record: dRef,
      ...dTrace,
    }),
    line("policy", {
      label: "Status",
      text: words(decision.status),
      status: decision.status,
      record: dRef,
      ...dTrace,
    }),
  ];
  for (const id of decision.missingBeliefs) {
    const s = statuses.get(id);
    decisionLines.push(
      line("policy", {
        key: `missing-${id}`,
        label: "Missing belief",
        text: `${id}${s?.certificate ? ` (certificate ${s.certificate.id}, ${s.certificate.status})` : ""}`,
        status: world ? s?.status : undefined,
        record: dRef,
        decisive: decisive.has(id),
        ...dTrace,
      }),
    );
  }
  for (const gid of decision.guardsApplied) {
    const g = bundle.guards.find((x) => x.id === gid);
    decisionLines.push(
      line("guard", {
        key: `guard-${gid}`,
        label: g ? `Guard ${gid} · ${words(g.kind)}` : `Guard ${gid}`,
        text: g ? g.reason : "Guard definition not included in this bundle.",
        detail: g
          ? `${g.operation} · belief ${g.beliefId} · ${g.active ? "active" : `retired ${g.retiredAt ?? ""}`} · rule ${formatValue(g.rule)}`
          : undefined,
        status: g ? (g.active ? "active" : "retired") : undefined,
        record: dRef,
        decisive: decisive.has(gid),
        ...dTrace,
      }),
    );
  }
  if (decision.evidencePack)
    decisionLines.push(
      line("evidence-pack", {
        label: "Reason recorded",
        text: decision.evidencePack.reason,
        detail: decision.evidencePack.relatedProbeIds.length
          ? `related probes ${decision.evidencePack.relatedProbeIds.join(", ")}`
          : undefined,
        record: dRef,
        decisive: by.kind !== "certificates_held",
        ...dTrace,
      }),
    );
  if (decision.error && decision.error !== decision.evidencePack?.reason)
    decisionLines.push(
      line("evidence-pack", { label: "Error recorded", text: decision.error, record: dRef, ...dTrace }),
    );
  decision.effects.forEach((ef, i) =>
    decisionLines.push(
      line("effect", {
        key: `effect-${i}`,
        label: `Effect ${i + 1} · ${ef.op}`,
        text: `${ef.status === null ? "outcome unknown" : `HTTP ${ef.status}`}${ef.amount !== undefined ? ` · ${fmtNumber(ef.amount)} ${ef.currency ?? ""} minor units` : ""}${ef.resultId ? ` · ${ef.resultId}` : ""}`,
        detail: `${ef.at} · ${formatValue(ef.params)}`,
        record: dRef,
        ...dTrace,
      }),
    ),
  );
  if (!decision.effects.length)
    decisionLines.push(line("effect", { label: "Effects", text: "No external effects recorded.", record: dRef, ...dTrace }));
  if (decision.grade)
    decisionLines.push(
      line("grade", {
        label: "Grade",
        text: `${decision.grade.correct ? "correct" : "not correct"} · expected ${words(decision.grade.expectedOutcome)}${decision.grade.expectedStatus ? ` / ${decision.grade.expectedStatus}` : ""}`,
        detail: `unsafe actions: ${decision.grade.unsafe.length ? decision.grade.unsafe.map(words).join(", ") : "none"}`,
        status: decision.grade.unsafe.length ? "unsafe" : undefined,
        warning: decision.grade.unsafe.length
          ? `Graded unsafe: ${decision.grade.unsafe.map(words).join(", ")}`
          : undefined,
        record: dRef,
        ...dTrace,
      }),
    );

  const counts = { certified: 0, unproven: 0, revoked: 0, missing: 0 };
  for (const s of statuses.values()) counts[s.status]++;
  const probeCount = groups.reduce(
    (n, g) => n + g.lines.filter((l) => l.source === "prediction").length,
    0,
  );

  return {
    kind: "decision",
    runId: bundle.runId,
    sample: bundle.sample,
    decidedBy: by,
    unsafe: decision.grade?.unsafe.length ? decision.grade.unsafe.map(words) : undefined,
    notes,
    steps: [
      {
        key: "request",
        title: "Request",
        summary: request
          ? `${words(request.type)} from ${request.companyDomain}`
          : `Request ${decision.requestId}`,
        lines: requestLines(request, decision, dTrace, dRef),
        groups: [],
      },
      {
        key: "context",
        title: "Crustdata context and tier",
        summary: `Tier ${words(decision.tier)}${decision.enrichment && typeof decision.enrichment.source === "string" ? ` · enrichment from ${decision.enrichment.source}` : ""}`,
        lines: contextLines(decision, dTrace, dRef),
        groups: [],
      },
      {
        key: "certificates",
        title: "Required certificates",
        summary: decision.requiredBeliefs.length
          ? world
            ? `${decision.requiredBeliefs.length} required · ${counts.certified} certified · ${counts.revoked} revoked · ${counts.unproven} unproven · ${counts.missing} missing`
            : `${decision.requiredBeliefs.length} required`
          : "This action required no certificates.",
        lines: certLines,
        groups: [],
      },
      {
        key: "evidence",
        title: "Hypotheses, predictions, observations, verdicts",
        summary: decision.requiredBeliefs.length
          ? `${probeCount} probe(s) across ${groups.length} belief(s)`
          : "No beliefs to show evidence for.",
        lines: [],
        groups,
      },
      {
        key: "decision",
        title: "Decision",
        summary: by.text,
        lines: decisionLines,
        groups: [],
      },
    ],
  };
}

// ------------------------------------------------------------------------ certificate trail

export type CertificateTrailInput = {
  certificateId: string;
  world: CertificateWorld;
  bundles: RunBundle[];
  /** Selected run (record links keep it). */
  runId?: string;
};

export function deriveCertificateTrail({
  certificateId,
  world,
  bundles,
  runId,
}: CertificateTrailInput): TrailModel | undefined {
  const c = world.certificates.find((x) => x.id === certificateId);
  if (!c) return;
  const notes: string[] = [];
  const pool = worldPool(undefined, bundles, world);
  const revocation = world.revocations.find((r) => r.certificateId === c.id);
  const evidenceUrls = Object.fromEntries(
    c.evidence.filter((e) => e.traceUrl).map((e) => [e.traceId, e.traceUrl!]),
  );
  const linkMaps = [evidenceUrls, ...pool.map((b) => b.traceLinks)];
  const certRef: RecordRef = { kind: "certificate", id: c.id, runId };
  const docs = safeLink(c.docUrl);

  // Claim.
  const claimLines: TrailLine[] = [
    line("claim", {
      label: "Claim",
      text: `${c.claim.operation} · ${c.claim.param}${c.claim.endpoint ? ` · ${c.claim.endpoint}` : ""}`,
      detail: `${c.claimId} · expect ${formatValue(c.claim.expect)}`,
      record: certRef,
    }),
    line("claim", { label: "Docs say", text: c.docText, href: docs, record: certRef }),
  ];

  // Scope.
  const ap = c.scope.asProbed;
  const scopeLines: TrailLine[] = [
    line("scope", { label: "Scope", text: c.scope.text, record: certRef }),
    line("scope", {
      label: "As probed",
      text: `${ap.operations.join(", ")} · ${ap.param} ∈ {${ap.values.join(", ")}}${ap.currencies.length ? ` · ${ap.currencies.join(", ")}` : ""}`,
      detail: `${fmtNumber(ap.probes)} cited probe(s)`,
      record: certRef,
    }),
  ];
  if (c.scope.narrowed) {
    scopeLines.push(
      line("scope.narrowed", { label: "Narrowed scope (adversary)", text: c.scope.narrowed.text, record: certRef }),
      line("scope", {
        label: "Narrowed scope, machine form",
        text: c.scope.narrowed.parsed
          ? formatValue(c.scope.narrowed.parsed)
          : "Not machine-checkable; guards block out-of-scope calls.",
        record: certRef,
      }),
    );
  }

  // Certificate.
  const status = requiredStatus(world, c.beliefId, c.claimId);
  const certLines: TrailLine[] = [
    line("certificate", {
      label: `Certificate ${c.id}`,
      text: c.verdict,
      status: c.status,
      detail: `${words(c.verdictKind)} · ${words(c.side)}${c.defectClass ? ` · ${words(c.defectClass)}` : ""}`,
      record: certRef,
    }),
    line("certificate", { label: "Observed", text: c.observed, record: certRef }),
    line("belief.math", {
      label: "Evidence",
      text: `Beta(${fmtNumber(c.alpha)}, ${fmtNumber(c.beta)}) · P(holds) = ${fmtProb(c.confidence)}`,
      detail: `issued ${c.issuedAt} from ${c.issuedFrom} · source ${c.sourceBundle.runId} ${short(c.sourceBundle.contentHash)} · seal ${short(c.sha256)}`,
      record: certRef,
    }),
    ...certificateLines(
      { status: status.status, revocation: c.status === "revoked" ? revocation : undefined },
      linkMaps,
      runId,
    ),
  ];

  // Evidence: the belief as of the latest source that carries it (the revocation's bundle when revoked).
  const beliefRunId = revocation?.sourceBundle.runId ?? c.sourceBundle.runId;
  const beliefBundle = pool.find((b) => b.runId === beliefRunId);
  const beliefHit = beliefBundle
    ? findBelief([beliefBundle], c.beliefId)
    : undefined;
  const groups: TrailGroup[] = [];
  if (beliefHit) {
    groups.push({
      key: c.beliefId,
      title: c.beliefId,
      subtitle: beliefHit.belief.statement,
      status: beliefHit.belief.status,
      decisive: true,
      record: { kind: "belief", id: c.beliefId, runId: beliefHit.bundle.runId },
      lines: beliefEvidenceLines(beliefHit.belief, beliefHit.bundle, pool, linkMaps),
    });
  } else {
    notes.push(
      `Source bundle ${beliefRunId} is not published with a matching hash; showing the evidence recorded on the certificate only.`,
    );
    groups.push({
      key: c.beliefId,
      title: c.beliefId,
      decisive: true,
      lines: [
        ...c.evidence.map((e) =>
          line("observation", {
            key: `cert-evidence-${e.probeId}`,
            label: `Probe ${e.probeId}${e.template ? ` · ${words(e.template)}` : ""}`,
            text: e.observed ?? "Observation not recorded on the certificate.",
            status: e.verdict,
            ...resolveTrace(e.traceId, linkMaps),
          }),
        ),
        c.adversary
          ? line("adversary", {
              label: `Adversary challenge · ${words(c.adversary.verdict)}`,
              text: c.adversary.reason,
              status: c.adversary.verdict,
              detail: [`model ${c.adversary.model}`, c.adversary.backend && `backend ${c.adversary.backend}`]
                .filter(Boolean)
                .join(" · "),
            })
          : line("record", { label: "Adversary challenge", text: "No adversary review recorded." }),
      ],
    });
  }

  // Enforcement: guards compiled from the belief and guarded decisions that required it.
  const enforce: TrailLine[] = [];
  const guardSeen = new Set<string>();
  for (const b of pool)
    for (const g of b.guards)
      if (g.beliefId === c.beliefId && !guardSeen.has(`${g.id}|${g.active}`)) {
        guardSeen.add(`${g.id}|${g.active}`);
        enforce.push(
          line("guard", {
            key: `guard-${b.runId}-${g.id}`,
            label: `Guard ${g.id} · ${words(g.kind)}`,
            text: g.reason,
            status: g.active ? "active" : "retired",
            detail: `${g.operation} · compiled ${g.compiledAt}${g.retiredAt ? ` · retired ${g.retiredAt}` : ""} · in ${b.runId}`,
            record: { kind: "run", id: b.runId, runId: b.runId },
          }),
        );
      }
  let held = 0;
  let required = 0;
  for (const b of pool) {
    if (b.kind !== "run" || b.variant !== "guarded") continue;
    for (const d of b.decisions) {
      if (!d.requiredBeliefs.includes(c.beliefId)) continue;
      required++;
      const isMissing = d.missingBeliefs.includes(c.beliefId);
      if (isMissing) held++;
      enforce.push(
        line("policy", {
          key: `decision-${d.id}`,
          label: `Decision ${d.requestId} · ${b.runId}`,
          text: `${words(d.status)} · ${d.action}${isMissing ? " · this belief was missing" : ""}`,
          status: d.status,
          decisive: isMissing,
          record: { kind: "decision", id: d.id, runId: b.runId },
          ...resolveTrace(d.traceId, [b.traceLinks, d.evidencePack?.traceLinks]),
        }),
      );
    }
  }
  if (!enforce.length)
    enforce.push(
      line("record", {
        label: "Enforcement",
        text: "No guard or guarded decision in this data world references this certificate's belief.",
      }),
    );

  return {
    kind: "certificate",
    runId,
    sample: world.sample,
    notes,
    steps: [
      { key: "request", title: "Claim", summary: c.claimId, lines: claimLines, groups: [] },
      { key: "context", title: "Scope", summary: c.scope.text, lines: scopeLines, groups: [] },
      {
        key: "certificates",
        title: "Certificate status",
        summary: `${c.status}${revocation ? ` · revoked ${revocation.revokedAt}` : ""}`,
        lines: certLines,
        groups: [],
      },
      {
        key: "evidence",
        title: "Hypotheses, predictions, observations, verdicts",
        summary: `${groups[0].lines.filter((l) => l.source === "prediction").length || c.evidence.length} probe(s)`,
        lines: [],
        groups,
      },
      {
        key: "decision",
        title: "Enforcement",
        summary: required
          ? `${required} guarded decision(s) required this belief; ${held} found it missing`
          : "No guarded decision required this belief.",
        lines: enforce,
        groups: [],
      },
    ],
  };
}
