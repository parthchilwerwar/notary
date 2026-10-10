/**
 * Certificates: Notary's output reframed as signed-off statements about documented API behavior,
 * derived from verified bundles ONLY (never from a model, never hand-typed). `notary export
 * --certificates` writes them; see src/certify/index.ts.
 *
 * One certificate per notarization of a belief (the `→ notarized` belief event in a source bundle):
 *   verdict      "matches docs" (the doc claim held) or
 *                "contradicts docs: docs say <expect rule in words>, observed <what the cited probes saw>"
 *                where "observed" is built from the winning-class probes' recorded observations
 *                (e.g. "amount echoed ×100 in 3 of 3 cited probes (sent 100 → read back 10000; …)")
 *   scope        "as probed: <ops, currencies, param values the cited probes exercised>", plus the
 *                adversary's narrowed scope and its machine-checkable form (guards/compiler parseScope)
 *   issuedAt     the notarization event's `at`; α/β/confidence are the event's
 *   evidence     the belief's cited probes applied up to the notarization, with trace ids
 *   id           "cert-" + sha256(tool, claimId, side, issuedAt)[0..16] — deterministic
 *   sha256       sha256(canonicalJson(certificate without sha256)) — pure JS, verifiable in a browser
 * A certificate whose belief later left `notarized` is still listed, status "revoked", pointing at its
 * revocation (revocations.ts). Beliefs that are not notarized now get a `noCertificate` entry with the
 * reason (abstain reason, adversary downgrade, refuted, candidate without review, never probed); claims
 * no source has a belief for are "not tested".
 *
 * Browser-safe module (zod + schema + pure helpers).
 */
import { z } from "zod";
import { COUNT_TEMPLATES, requestSteps, valuesAtPath } from "../beliefs/params.js";
import { allContracts } from "../contracts/index.js";
import { narrowedScopeText, parseScope } from "../guards/compiler.js";
import { AdversaryBackendSchema, AdversaryVerdictSchema, BeliefStatusSchema } from "../schema/belief.js";
import { BundleKindSchema, RunModeSchema } from "../schema/bundle.js";
import { DefectClassSchema, ExpectRuleSchema, ProbeTemplateSchema, Sha256HexSchema, ToolSchema } from "../schema/common.js";
import { ProbeVerdictSchema } from "../schema/probe.js";
import type { Belief, Claim, DefectClass, ExpectRule, Probe, RunBundle, Tool } from "../schema/index.js";
import type { Issuance, ToolLedger } from "./ledger.js";
import { buildLedger, eventsOf, issuances } from "./ledger.js";
import { RevocationSchema, SourceRefSchema, buildRevocations, sealOf } from "./revocations.js";

export const CERTIFICATES_GENERATED_BY = "pnpm notary export --certificates";
export const CERTIFICATES_FIXTURE_GENERATED_BY = "pnpm notary export --certificates --fixture";
export const FIXTURE_CERT_DISCLOSURE = "FIXTURE — simulated APIs and models, not a live run";
export const MATCHES_DOCS = "matches docs";
export const TOOLS: readonly Tool[] = ["crustdata", "dodo"];

// ------------------------------------------------------------------------------------- schemas

export const CertificateEvidenceSchema = z
  .object({
    probeId: z.string(),
    traceId: z.string(),
    spanId: z.string().optional(),
    traceUrl: z.string().optional(),
    /** Absent only when no source bundle carries the probe record. */
    template: ProbeTemplateSchema.optional(),
    verdict: ProbeVerdictSchema.optional(),
    /** FR-10 evidence check result, as recorded on the belief. */
    valid: z.boolean().optional(),
    /** The probe's recorded observation in words. */
    observed: z.string().optional(),
  })
  .strict();

export const CertificateScopeSchema = z
  .object({
    text: z.string(),
    asProbed: z
      .object({
        operations: z.array(z.string()),
        currencies: z.array(z.string()),
        param: z.string(),
        values: z.array(z.string()),
        probes: z.number().int().nonnegative(),
      })
      .strict(),
    narrowed: z
      .object({
        text: z.string(),
        /** Machine-checkable form (guards/compiler parseScope); null = not machine-checkable, guards block. */
        parsed: z.object({ currency: z.array(z.string()) }).strict().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const CertificateSchema = z
  .object({
    id: z.string().regex(/^cert-[0-9a-f]{16}$/),
    status: z.enum(["active", "revoked"]),
    /** Pointer to the revocation when status is "revoked". */
    revocation: z.object({ id: z.string(), revokedAt: z.iso.datetime() }).strict().optional(),
    tool: ToolSchema,
    claimId: z.string(),
    beliefId: z.string(),
    claim: z
      .object({ operation: z.string(), param: z.string(), endpoint: z.string().optional(), expect: ExpectRuleSchema })
      .strict(),
    docText: z.string(),
    docUrl: z.string(),
    side: z.enum(["honored", "violated"]),
    defectClass: DefectClassSchema.optional(),
    verdictKind: z.enum(["matches_docs", "contradicts_docs"]),
    verdict: z.string(),
    docsSay: z.string(),
    observed: z.string(),
    scope: CertificateScopeSchema,
    issuedAt: z.iso.datetime(),
    /** "event": issuedAt is the `→ notarized` belief event; "snapshot": no source carries that event, issuedAt is the belief's updatedAt. */
    issuedFrom: z.enum(["event", "snapshot"]),
    evidence: z.array(CertificateEvidenceSchema),
    adversary: z
      .object({
        verdict: AdversaryVerdictSchema,
        reason: z.string(),
        model: z.string(),
        backend: AdversaryBackendSchema.optional(),
        reviewedAt: z.iso.datetime().optional(),
      })
      .strict()
      .nullable(),
    confidence: z.number().min(0).max(1),
    alpha: z.number().positive(),
    beta: z.number().positive(),
    sourceBundle: SourceRefSchema,
    sample: z.boolean(),
    disclosure: z.array(z.string()),
    sha256: Sha256HexSchema,
  })
  .strict();

export const NoCertificateKindSchema = z.enum([
  "abstained",
  "downgraded",
  "refuted",
  "candidate_unreviewed",
  "undecided",
  "never_probed",
  "revoked",
  "not_tested",
]);

export const NoCertificateSchema = z
  .object({
    tool: ToolSchema,
    claimId: z.string(),
    /** Belief status, or "not_tested" when no source has a belief for the claim. */
    status: z.union([BeliefStatusSchema, z.literal("not_tested")]),
    kind: NoCertificateKindSchema,
    reason: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    alpha: z.number().positive().optional(),
    beta: z.number().positive().optional(),
    sourceBundle: SourceRefSchema.optional(),
    sample: z.boolean(),
  })
  .strict();

export const SourceBundleSchema = z
  .object({
    runId: z.string(),
    contentHash: Sha256HexSchema,
    kind: BundleKindSchema,
    mode: RunModeSchema,
    startedAt: z.iso.datetime(),
    sample: z.boolean(),
  })
  .strict();

export const ToolCertificatesSchema = z
  .object({
    tool: ToolSchema,
    generatedBy: z.string(),
    sample: z.boolean(),
    disclosure: z.array(z.string()),
    /** One line stating where the data came from ("no real runs yet" when there is none). */
    header: z.string(),
    sourceBundles: z.array(SourceBundleSchema),
    ignoredBundles: z.array(z.object({ runId: z.string(), reason: z.string() }).strict()),
    certificates: z.array(CertificateSchema),
    noCertificates: z.array(NoCertificateSchema),
    revocations: z.array(RevocationSchema),
  })
  .strict();

export type Certificate = z.infer<typeof CertificateSchema>;
export type CertificateEvidence = z.infer<typeof CertificateEvidenceSchema>;
export type CertificateScope = z.infer<typeof CertificateScopeSchema>;
export type NoCertificate = z.infer<typeof NoCertificateSchema>;
export type NoCertificateKind = z.infer<typeof NoCertificateKindSchema>;
export type SourceBundle = z.infer<typeof SourceBundleSchema>;
export type ToolCertificates = z.infer<typeof ToolCertificatesSchema>;

// ------------------------------------------------------------------------------- docs in words

function code(s: string): string {
  return `\`${s}\``;
}

/** The documented promise, in words, from the claim's machine-checked expect rule. */
export function docsSayText(claim: Pick<Claim, "param" | "expect">): string {
  const e: ExpectRule = claim.expect;
  switch (e.kind) {
    case "maxItems":
      return claim.param ? `${code(claim.param)} has a maximum of ${e.max}` : `the result lists at most ${e.max} item${e.max === 1 ? "" : "s"}`;
    case "type":
      return `${code(e.field)} is ${/^[aeiou]/i.test(e.type) ? "an" : "a"} ${e.type}`;
    case "unit":
      // The documented promise is about the sent param; `field` is only where it is read back.
      return e.unit === "minor"
        ? `${code(claim.param ? leaf(claim.param) : e.field)} is in the smallest currency unit (minor units)`
        : `${code(claim.param ? leaf(claim.param) : e.field)} is in ${e.unit} units`;
    case "statusOnError":
      return `the error case returns HTTP ${e.status}`;
    case "idempotentOnRetry":
      return "retrying an identical request does not create a duplicate";
    case "errorOnUnknownParam":
      return "an unknown parameter is rejected with an error";
    case "fieldPresent":
      return `${code(e.field)} is present in the response`;
    case "consistentWithin":
      return `a write is readable within ${e.ms} ms`;
  }
}

// --------------------------------------------------------------------------- observed in words

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function short(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  const s = JSON.stringify(v);
  return s && s.length > 40 ? `${s.slice(0, 37)}…` : (s ?? "?");
}

/** Last segment of a dotted param path ("items[].amount" → "amount"). */
function leaf(path: string): string {
  const seg = path.split(".").pop() ?? path;
  return seg.replace(/\[\]$/, "") || path;
}

function ratioWords(ratio: number): string {
  if (ratio === 1) return "echoed unchanged";
  const fmt = (x: number): string => (Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(4))));
  return ratio > 1 ? `echoed ×${fmt(ratio)}` : `echoed ÷${fmt(1 / ratio)}`;
}

/** Treatment values the probe sent at the claim's param (on the claim's op when it calls it). */
function sentValues(claim: Claim, probe: Pick<Probe, "params">): unknown[] {
  if (!claim.param) return [];
  const steps = requestSteps(probe.params);
  const onOp = steps.filter((s) => s.op === claim.operation);
  return (onOp.length ? onOp : steps).flatMap((s) => valuesAtPath(s.params, claim.param));
}

/**
 * One probe's recorded observation as {label, example}: `label` groups probes that saw the same
 * thing ("amount echoed ×100"), `example` is that probe's numbers ("sent 100 → read back 10000").
 */
export function observationWords(claim: Claim, probe: Pick<Probe, "template" | "params" | "observed" | "verdict">): { label: string; example: string } {
  const o = isRecord(probe.observed) ? probe.observed : {};
  const outcome = typeof o.outcome === "string" ? o.outcome : null;
  const param = claim.param ? leaf(claim.param) : "the request";
  if (outcome === null) {
    const note = typeof o.note === "string" ? o.note : typeof o.reason === "string" ? o.reason : "no outcome recorded";
    return { label: `no informative outcome (${probe.verdict ?? "no verdict"})`, example: note };
  }
  switch (probe.template) {
    case "unit_roundtrip": {
      const sent = num(o.sent);
      const echoed = num(o.echoed);
      const ratio = num(o.ratio) ?? (sent && echoed !== null ? echoed / sent : null);
      const field = claim.expect.kind === "unit" ? claim.expect.field : "the read-back";
      const label = ratio !== null ? `${param} ${ratioWords(ratio)}` : `${param}: outcome ${outcome}`;
      return { label, example: sent !== null && echoed !== null ? `sent ${sent} → ${field} ${echoed}` : `outcome ${outcome}` };
    }
    case "boundary_sweep": {
      const over = isRecord(o.over) ? o.over : {};
      const len = num(over.length);
      const status = num(over.status);
      const sent = sentValues(claim, probe).map(short).join("/");
      const ex = `${claim.param ? `${param}=${sent || "?"}` : "over the max"}${status !== null ? ` → HTTP ${status}` : ""}${len !== null ? `, ${len} items` : ""}`;
      const label =
        outcome === "clamped"
          ? `${param} over the documented maximum accepted and silently capped${len !== null ? ` at ${len} items` : ""}`
          : outcome === "rejected"
            ? `${param} over the documented maximum rejected${status !== null ? ` (HTTP ${status})` : ""}`
            : outcome === "over_limit"
              ? `more items than the documented maximum returned`
              : outcome === "reduced"
                ? `fewer items returned than requested`
                : `outcome ${outcome}`;
      return { label, example: ex };
    }
    case "pagination_completeness": {
      const walked = num(o.walked);
      const unique = num(o.unique);
      const ex = `${walked ?? "?"} rows walked, ${unique ?? "?"} unique`;
      const label =
        outcome === "same_set"
          ? "paged walk returned exactly the records of one large page"
          : outcome === "overlap"
            ? "pages overlapped (records repeated across pages)"
            : outcome === "mismatch"
              ? "paged walk did not match one large page"
              : `outcome ${outcome}`;
      return { label, example: ex };
    }
    case "retry_after_timeout": {
      const writes = num(o.writes);
      const statuses = Array.isArray(o.statuses) ? o.statuses.map(short).join(",") : "?";
      const after = num(o.after);
      const ex = `${writes ?? "?"} identical sends → HTTP ${statuses}${after !== null ? `, ${after} records after` : ""}`;
      const label =
        outcome === "duplicate"
          ? "identical retries all succeeded and created duplicates"
          : outcome === "single"
            ? "identical retries were refused or deduplicated (one effect)"
            : outcome === "none"
              ? "no effect was recorded"
              : `outcome ${outcome}`;
      return { label, example: ex };
    }
    case "write_then_read": {
      const ms = Array.isArray(o.afterMs) ? o.afterMs.map(short).join("/") : "?";
      const label =
        outcome === "within"
          ? "the write was visible on read-back right away"
          : outcome === "after"
            ? "the write became visible only on a later read"
            : outcome === "never"
              ? "the write never appeared on read-back"
              : `outcome ${outcome}`;
      return { label, example: `read back after ${ms} ms` };
    }
    case "type_edge": {
      const field = claim.expect.kind === "type" ? claim.expect.field : param;
      const values = Array.isArray(o.values) ? o.values.slice(0, 3).map(short).join(", ") : "?";
      const words: Record<string, string> = {
        doc_type: "returned with the documented type",
        formatted_string: "returned as a formatted string",
        numeric_string: "returned as a numeric string",
        float: "returned as a non-integer number",
        other_type: "returned as a different type",
      };
      return { label: `${field} ${words[outcome] ?? `outcome ${outcome}`}`, example: `values ${values}` };
    }
    case "unknown_param": {
      const label =
        outcome === "ignored"
          ? "an unknown parameter was silently ignored"
          : outcome === "applied"
            ? "an unknown parameter changed the response"
            : outcome === "rejected"
              ? "an unknown parameter was rejected"
              : `outcome ${outcome}`;
      return { label, example: num(o.status) !== null ? `HTTP ${o.status}` : `outcome ${outcome}` };
    }
    case "header_burst": {
      const label = outcome === "limited" ? "a request burst was rate limited" : outcome === "not_limited" ? "a request burst was not rate limited" : `outcome ${outcome}`;
      return { label, example: `outcome ${outcome}` };
    }
  }
}

interface CitedProbe {
  probe: Probe | undefined;
  probeId: string;
  winningClass: DefectClass | null;
}

/** Group probes by label: "label in k of n cited probes (e.g. ex1; ex2)". */
function summarize(claim: Claim, probes: readonly Probe[], total: number): string[] {
  const groups = new Map<string, string[]>();
  for (const p of probes) {
    const w = observationWords(claim, p);
    const g = groups.get(w.label) ?? [];
    g.push(w.example);
    groups.set(w.label, g);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
    .map(([label, ex]) => {
      const n = ex.length === total ? `in all ${total} cited probe${total === 1 ? "" : "s"}` : `in ${ex.length} of ${total} cited probes`;
      const shown = [...new Set(ex)].slice(0, 3);
      return `${label} ${n} (${shown.join("; ")}${new Set(ex).size > 3 ? "; …" : ""})`;
    });
}

/** "observed …" text: the winning-side probes first, then what the other cited probes saw (mixed evidence). */
function observedText(claim: Claim, cited: readonly CitedProbe[], side: "honored" | "violated", cls: DefectClass | undefined): string {
  const known = cited.filter((c): c is CitedProbe & { probe: Probe } => c.probe !== undefined);
  if (known.length === 0) return `${cited.length} cited probe(s); no probe records in the source bundles`;
  const onSide = (c: CitedProbe): boolean => (side === "honored" ? c.winningClass === "honored" : c.winningClass !== null && c.winningClass !== "honored" && (!cls || c.winningClass === cls));
  const win = known.filter(onSide);
  const rest = known.filter((c) => !onSide(c));
  const parts = summarize(claim, (win.length ? win : known).map((c) => c.probe), cited.length);
  if (win.length && rest.length) parts.push(`other cited probes: ${summarize(claim, rest.map((c) => c.probe), cited.length).join("; ")}`);
  return parts.join("; ");
}

// --------------------------------------------------------------------------------------- scope

function scopeOf(claim: Claim, cited: readonly CitedProbe[], belief: Belief): CertificateScope {
  const ops = new Set<string>();
  const currencies = new Set<string>();
  const values = new Set<string>();
  for (const c of cited) {
    if (!c.probe) continue;
    for (const variant of [c.probe.params, c.probe.control?.params]) {
      for (const s of requestSteps(variant)) {
        ops.add(s.op);
        for (const cur of [s.params.currency, ...valuesAtPath(s.params, "items[].currency")]) if (typeof cur === "string") currencies.add(cur);
      }
    }
    // Count templates vary how often the op is sent, not the param's value: their values are just record ids.
    if (!COUNT_TEMPLATES.has(c.probe.template)) for (const v of sentValues(claim, c.probe)) values.add(short(v));
  }
  const operations = [...ops].sort();
  const cur = [...currencies].sort();
  const vals = [...values].sort((a, b) => (Number(a) - Number(b)) || (a < b ? -1 : a > b ? 1 : 0));
  const probed =
    operations.length === 0
      ? `as probed: ${cited.length} cited probe(s), request details not in the source bundles`
      : `as probed: ${operations.join(", ")}${cur.length ? ` in ${cur.join("/")}` : ""}${claim.param && vals.length ? `; ${leaf(claim.param)} ∈ {${vals.slice(0, 8).join(", ")}${vals.length > 8 ? ", …" : ""}}` : ""} (${cited.length} cited probe${cited.length === 1 ? "" : "s"})`;
  const narrowText = narrowedScopeText(belief);
  const parsed = narrowText ? parseScope(narrowText) : null;
  const narrowed = narrowText ? { text: narrowText, parsed } : null;
  const text = narrowed
    ? `${probed}; narrowed by the adversary: "${narrowText}" (${parsed ? `machine-checkable: currency ${parsed.currency.join("/")}` : "not machine-checkable: guards refuse outside the probed scope"})`
    : probed;
  return { text, asProbed: { operations, currencies: cur, param: claim.param, values: vals, probes: cited.length }, narrowed };
}

// ---------------------------------------------------------------------------------- builders

export interface BuildOptions {
  /** Claims the export covers (default: every contract claim). */
  claims?: readonly Claim[];
  /** Tools to build (default: crustdata, dodo). */
  tools?: readonly Tool[];
  /** Fixture mode: every record carries sample: true and FIXTURE_CERT_DISCLOSURE. */
  fixture?: boolean;
}

export interface CertificateSet {
  sample: boolean;
  disclosure: string[];
  generatedBy: string;
  tools: ToolCertificates[];
}

function evidenceAt(ledger: ToolLedger, iss: Issuance): Belief["evidence"] {
  if (iss.issuedFrom === "snapshot") return iss.snapshot.evidence;
  const evs = eventsOf(ledger, iss.beliefId);
  const appliedAt = new Map<string, number>();
  evs.forEach((e, i) => {
    if (e.event.probeId && !appliedAt.has(e.event.probeId)) appliedAt.set(e.event.probeId, i);
  });
  return iss.snapshot.evidence.filter((ev) => {
    const at = appliedAt.get(ev.probeId);
    return at === undefined || at <= iss.eventIndex;
  });
}

function buildCertificate(ledger: ToolLedger, iss: Issuance, claim: Claim, sample: boolean, disclosure: readonly string[]): Omit<Certificate, "sha256" | "status" | "revocation"> {
  const evidence = evidenceAt(ledger, iss);
  const cited: CitedProbe[] = evidence.map((e) => {
    const probe = ledger.probes.get(e.probeId)?.probe;
    const h = probe?.verdict === "confirmed" && probe.winningHypothesisId ? ledger.hypotheses.get(probe.winningHypothesisId) : undefined;
    return { probe, probeId: e.probeId, winningClass: h?.class ?? null };
  });
  let cls: DefectClass | undefined;
  if (iss.side === "violated") {
    const counts = new Map<DefectClass, number>();
    for (const c of cited) if (c.winningClass && c.winningClass !== "honored") counts.set(c.winningClass, (counts.get(c.winningClass) ?? 0) + 1);
    cls = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? (iss.snapshot.class !== "honored" ? iss.snapshot.class : undefined);
  }
  const docsSay = docsSayText(claim);
  const observed = observedText(claim, cited, iss.side, cls);
  const verdict = iss.side === "honored" ? MATCHES_DOCS : `contradicts docs: docs say ${docsSay}, observed ${observed}`;
  const traceLinks = new Map<string, string>();
  for (const s of ledger.sources) for (const [k, v] of Object.entries(s.traceLinks)) traceLinks.set(k, v);
  const a = iss.snapshot.adversary;
  return {
    id: iss.certificateId,
    tool: iss.tool,
    claimId: iss.claimId,
    beliefId: iss.beliefId,
    claim: { operation: claim.operation, param: claim.param, ...(claim.endpoint ? { endpoint: claim.endpoint } : {}), expect: claim.expect },
    docText: claim.docText,
    docUrl: claim.docUrl,
    side: iss.side,
    ...(cls ? { defectClass: cls } : {}),
    verdictKind: iss.side === "honored" ? "matches_docs" : "contradicts_docs",
    verdict,
    docsSay,
    observed,
    scope: scopeOf(claim, cited, iss.snapshot),
    issuedAt: iss.issuedAt,
    issuedFrom: iss.issuedFrom,
    evidence: evidence.map((e, i) => {
      const p = cited[i]!.probe;
      const url = traceLinks.get(e.traceId);
      return {
        probeId: e.probeId,
        traceId: e.traceId,
        ...(e.spanId ? { spanId: e.spanId } : {}),
        ...(url ? { traceUrl: url } : {}),
        ...(p ? { template: p.template } : {}),
        ...(p?.verdict ? { verdict: p.verdict } : {}),
        ...(e.valid === undefined ? {} : { valid: e.valid }),
        ...(p ? { observed: (({ label, example }) => `${label} (${example})`)(observationWords(claim, p)) } : {}),
      };
    }),
    adversary: a
      ? { verdict: a.verdict, reason: a.reason, model: a.model, ...(a.backend ? { backend: a.backend } : {}), ...(a.reviewedAt ? { reviewedAt: a.reviewedAt } : {}) }
      : null,
    confidence: iss.confidence,
    alpha: iss.alpha,
    beta: iss.beta,
    sourceBundle: { runId: iss.bundle.runId, contentHash: iss.bundle.contentHash },
    sample,
    disclosure: [...disclosure],
  };
}

function stripPrefix(reason: string, prefix: string): string {
  return reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
}

function noCertificateFor(ledger: ToolLedger, b: Belief, bundle: RunBundle, hadCertificate: boolean, sample: boolean): NoCertificate {
  const evs = eventsOf(ledger, b.id);
  const lastTo = (s: string) => [...evs].reverse().find((e) => e.event.to === s)?.event;
  const probed = b.evidence.length > 0 || evs.some((e) => e.event.probeId) || (b.probesToCandidate ?? 0) > 0;
  const base = { tool: b.tool, claimId: b.claimId, status: b.status, confidence: b.confidence, alpha: b.alpha, beta: b.beta, sourceBundle: { runId: bundle.runId, contentHash: bundle.contentHash }, sample };
  const downgraded = b.adversary?.verdict === "downgrade" ? `adversary downgraded (${b.adversary.backend ?? "bedrock"}, ${b.adversary.model}): ${b.adversary.reason}` : null;
  if (b.status === "unlearned" && hadCertificate) {
    const e = lastTo("unlearned");
    return { ...base, kind: "revoked", reason: `certificate revoked: ${e?.reason ?? "belief unlearned"}` };
  }
  if (b.status === "abstained") {
    const e = lastTo("abstained");
    const why = e ? stripPrefix(e.reason, "abstain: ") : "abstained";
    return { ...base, kind: downgraded ? "downgraded" : "abstained", reason: downgraded ? `${downgraded}; then abstained: ${why}` : `abstained: ${why}` };
  }
  if (downgraded && (b.status === "hypothesis" || b.status === "candidate")) return { ...base, kind: "downgraded", reason: downgraded };
  if (b.status === "refuted") return { ...base, kind: "refuted", reason: `refuted: ${lastTo("refuted")?.reason ?? "refuted"}` };
  if (b.status === "candidate") {
    const last = evs[evs.length - 1]?.event;
    return { ...base, kind: "candidate_unreviewed", reason: `candidate without an adversary verdict${last ? `: ${last.reason}` : ""}` };
  }
  if (!probed) return { ...base, kind: "never_probed", reason: "never probed" };
  const n = evs.filter((e) => e.event.probeId).length;
  return {
    ...base,
    kind: "undecided",
    reason: `undecided: P(holds)=${b.confidence.toFixed(4)} under Beta(${b.alpha}, ${b.beta}) after ${n || b.evidence.length} probe(s)${b.status === "unlearned" ? " (unlearned)" : ""}`,
  };
}

function sourceBundle(b: RunBundle): SourceBundle {
  return { runId: b.runId, contentHash: b.contentHash, kind: b.kind, mode: b.mode, startedAt: b.startedAt, sample: b.sample };
}

/** Certificates, revocations and no-certificate entries for one tool. */
export function buildToolCertificates(bundles: readonly RunBundle[], tool: Tool, opts: BuildOptions = {}): ToolCertificates {
  const sample = opts.fixture === true;
  const disclosure = sample ? [FIXTURE_CERT_DISCLOSURE] : [];
  const contractClaims = opts.claims ?? allContracts.map((e) => e.claim);
  const ledger = buildLedger(bundles, tool, contractClaims);
  const issued = issuances(ledger).filter((i) => ledger.claims.has(i.claimId));
  const revocations = buildRevocations(ledger, issued, { sample, disclosure });
  const revByCert = new Map(revocations.map((r) => [r.certificateId, r]));

  const certificates: Certificate[] = issued.map((iss) => {
    const body = buildCertificate(ledger, iss, ledger.claims.get(iss.claimId)!, sample, disclosure);
    const rev = revByCert.get(iss.certificateId);
    const full = { ...body, status: rev ? ("revoked" as const) : ("active" as const), ...(rev ? { revocation: { id: rev.id, revokedAt: rev.revokedAt } } : {}) };
    return CertificateSchema.parse({ ...full, sha256: sealOf(full) });
  });

  const active = new Set(certificates.filter((c) => c.status === "active").map((c) => c.claimId));
  const everCertified = new Set(certificates.map((c) => c.claimId));
  const beliefByClaim = new Map<string, { belief: Belief; bundle: RunBundle }>();
  for (const v of ledger.latest.values()) beliefByClaim.set(v.belief.claimId, v);
  const noCertificates: NoCertificate[] = [];
  for (const claimId of [...ledger.claims.keys()]) {
    if (active.has(claimId)) continue;
    const hit = beliefByClaim.get(claimId);
    if (!hit) {
      noCertificates.push({ tool, claimId, status: "not_tested", kind: "not_tested", reason: ledger.sources.length ? "not tested: no belief for this claim in any source bundle" : "not tested: no runs yet", sample });
      continue;
    }
    noCertificates.push(NoCertificateSchema.parse(noCertificateFor(ledger, hit.belief, hit.bundle, everCertified.has(claimId), sample)));
  }

  const header = ledger.sources.length
    ? `${sample ? "FIXTURE — " : ""}generated by \`${sample ? CERTIFICATES_FIXTURE_GENERATED_BY : CERTIFICATES_GENERATED_BY}\` from ${ledger.sources.length} hash-verified ${sample ? "fixture" : "real"} bundle(s): ${ledger.sources.map((s) => s.runId).join(", ")}`
    : `${sample ? "FIXTURE — no fixture bundles found" : "no real runs yet"}: every ${tool} claim is not tested; generated by \`${sample ? CERTIFICATES_FIXTURE_GENERATED_BY : CERTIFICATES_GENERATED_BY}\``;
  return ToolCertificatesSchema.parse({
    tool,
    generatedBy: sample ? CERTIFICATES_FIXTURE_GENERATED_BY : CERTIFICATES_GENERATED_BY,
    sample,
    disclosure,
    header,
    sourceBundles: ledger.sources.map(sourceBundle),
    ignoredBundles: ledger.ignored,
    certificates,
    noCertificates,
    revocations,
  });
}

/** Certificates for every tool from verified bundles. Pure: same bundles in, byte-identical output. */
export function buildCertificates(bundles: readonly RunBundle[], opts: BuildOptions = {}): CertificateSet {
  const sample = opts.fixture === true;
  if (!sample && bundles.some((b) => b.sample)) throw new Error("buildCertificates: a sample/fixture bundle was passed to a real certificate build; use { fixture: true }");
  if (sample && bundles.some((b) => !b.sample)) throw new Error("buildCertificates: a real bundle was passed to a fixture certificate build");
  const tools = opts.tools ?? TOOLS;
  return {
    sample,
    disclosure: sample ? [FIXTURE_CERT_DISCLOSURE] : [],
    generatedBy: sample ? CERTIFICATES_FIXTURE_GENERATED_BY : CERTIFICATES_GENERATED_BY,
    tools: tools.map((t) => buildToolCertificates(bundles, t, opts)),
  };
}

export type VerifyCertificateResult = { ok: true; certificate: Certificate } | { ok: false; reason: "schema" | "sha256"; error: string };

/** Schema-check an untrusted certificate and recompute its sha256 (pure JS; runs in a browser). */
export function verifyCertificate(raw: unknown): VerifyCertificateResult {
  const parsed = CertificateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema", error: `certificate failed schema validation:\n${z.prettifyError(parsed.error)}` };
  const actual = sealOf(parsed.data);
  if (actual !== parsed.data.sha256) {
    return { ok: false, reason: "sha256", error: `sha256 mismatch for ${parsed.data.id}: recorded ${parsed.data.sha256}, computed ${actual}` };
  }
  return { ok: true, certificate: parsed.data };
}
