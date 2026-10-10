/**
 * Certificate contracts: the JSON files `notary export --certificates [--fixture]` writes under
 * packages/web/public/certificates/ (see src/certify/index.ts for how they are derived).
 *
 *   <tool>.json                       ToolCertificatesSchema (certificates, noCertificates, revocations)
 *   report.json                       CertificateReportSchema (counts; pins each <tool>.json by sha256)
 *   fixture/index.json                FixtureIndexSchema (the fixture scenarios)
 *   fixture/<scenario>/<tool>.json    ToolCertificatesSchema
 *   fixture/<scenario>/report.json    CertificateReportSchema
 *
 * Browser-safe: zod and other src/schema files only (test/browser-safe.test.ts), so packages/web can
 * parse these files. A record's `sha256` (Certificate, Revocation) is
 * sha256Hex(canonicalJson(record without its sha256 field)) from src/bundle/hash.ts; a report's
 * toolFileHashes[file] is sha256Hex(canonicalJson(<tool>.json contents)). The derivation logic stays in
 * src/certify; this file is structure only.
 */
import { z } from "zod";
import { AdversaryBackendSchema, AdversaryVerdictSchema, BeliefStatusSchema } from "./belief.js";
import { BundleKindSchema, RunModeSchema } from "./bundle.js";
import { DefectClassSchema, ExpectRuleSchema, ProbeTemplateSchema, Sha256HexSchema, ToolSchema } from "./common.js";
import { GuardKindSchema } from "./guard.js";
import { ProbeVerdictSchema } from "./probe.js";

// ----------------------------------------------------------------------------------- revocations

export const SourceRefSchema = z.object({ runId: z.string(), contentHash: Sha256HexSchema }).strict();

export const RetiredGuardSchema = z
  .object({ id: z.string(), kind: GuardKindSchema, operation: z.string(), retiredAt: z.iso.datetime() })
  .strict();

export const RevocationSchema = z
  .object({
    id: z.string().regex(/^rev-[0-9a-f]{16}$/),
    certificateId: z.string().regex(/^cert-[0-9a-f]{16}$/),
    tool: ToolSchema,
    claimId: z.string(),
    beliefId: z.string(),
    revokedAt: z.iso.datetime(),
    from: z.literal("notarized"),
    to: BeliefStatusSchema,
    reason: z.string(),
    alpha: z.number().positive(),
    beta: z.number().positive(),
    confidence: z.number().min(0).max(1),
    triggerProbeIds: z.array(z.string()),
    triggerTraceIds: z.array(z.string()),
    guardsRetired: z.array(RetiredGuardSchema),
    sourceBundle: SourceRefSchema,
    sample: z.boolean(),
    disclosure: z.array(z.string()),
    sha256: Sha256HexSchema,
  })
  .strict();

// ---------------------------------------------------------------------------------- certificates

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

/** packages/web/public/certificates/<tool>.json (and fixture/<scenario>/<tool>.json). */
export const ToolCertificatesSchema = z
  .object({
    tool: ToolSchema,
    generatedBy: z.string(),
    sample: z.boolean(),
    /** Fixture scenario (one simulated world), absent for real data. */
    scenario: z.string().optional(),
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

// ------------------------------------------------------------------------------------- reports

export const ReportCountsSchema = z
  .object({
    claimsTotal: z.number().int().nonnegative(),
    certified: z.number().int().nonnegative(),
    matchesDocs: z.number().int().nonnegative(),
    contradictsDocs: z.number().int().nonnegative(),
    unproven: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
  })
  .strict();

/** packages/web/public/certificates/report.json (and fixture/<scenario>/report.json). */
export const CertificateReportSchema = z
  .object({
    generatedBy: z.string(),
    sample: z.boolean(),
    /** Fixture scenario (one simulated world), absent for real data. */
    scenario: z.string().optional(),
    disclosure: z.array(z.string()),
    header: z.string(),
    sourceBundles: z.array(SourceBundleSchema),
    tools: z.array(z.object({ tool: ToolSchema, header: z.string(), counts: ReportCountsSchema, file: z.string() }).strict()),
    overall: ReportCountsSchema,
    /** sha256 of each per-tool file's canonical JSON, so the report pins exactly what it counted. */
    toolFileHashes: z.record(z.string(), Sha256HexSchema),
  })
  .strict();

/** packages/web/public/certificates/fixture/index.json: the fixture scenarios (separate simulated worlds). */
export const FixtureIndexSchema = z
  .object({
    generatedBy: z.string(),
    sample: z.literal(true),
    disclosure: z.array(z.string()),
    note: z.string(),
    scenarios: z.array(
      z
        .object({
          scenario: z.string(),
          report: z.string(),
          files: z.array(z.string()),
          sourceBundles: z.array(z.string()),
          overall: ReportCountsSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type RetiredGuard = z.infer<typeof RetiredGuardSchema>;
export type Revocation = z.infer<typeof RevocationSchema>;
export type Certificate = z.infer<typeof CertificateSchema>;
export type CertificateEvidence = z.infer<typeof CertificateEvidenceSchema>;
export type CertificateScope = z.infer<typeof CertificateScopeSchema>;
export type NoCertificate = z.infer<typeof NoCertificateSchema>;
export type NoCertificateKind = z.infer<typeof NoCertificateKindSchema>;
export type SourceBundle = z.infer<typeof SourceBundleSchema>;
export type ToolCertificates = z.infer<typeof ToolCertificatesSchema>;
export type ReportCounts = z.infer<typeof ReportCountsSchema>;
export type CertificateReport = z.infer<typeof CertificateReportSchema>;
export type FixtureIndex = z.infer<typeof FixtureIndexSchema>;
