// public/economics.json: Notary's unit economics, computed deterministically from REAL run bundles,
// next to the business plan imported from cfo.ai exactly as exported. New file; the bundle schema
// stays frozen. Imports only zod (and common.ts) so packages/web can validate it in the browser.
//
// Rules the shape encodes:
//   - nothing here is typed by hand: `computed` comes from bundles, `plan` from the cfo.ai export
//   - fixture / sample bundles are never a source (`sample` is the literal false)
//   - a figure that cannot be computed is null with a reason, never 0 as a stand-in
//   - contentHash = sha256 hex of canonicalJson(file without contentHash), like run bundles
import { z } from "zod";
import { Sha256HexSchema } from "./common.js";

export const ECONOMICS_GENERATED_BY = "pnpm notary economics" as const;

const Usd = z.number().nonnegative();
const Count = z.number().int().nonnegative();
const Slug = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "expected a lowercase slug (a-z, 0-9, _ . -)");

export const EconomicsRoleUsdSchema = z
  .object({ executor: Usd, reflector: Usd, adversary: Usd })
  .strict();

/** One real bundle as the economics see it (every value read from the bundle). */
export const EconomicsRunSchema = z
  .object({
    runId: z.string(),
    contentHash: Sha256HexSchema,
    kind: z.enum(["run", "notarize"]),
    variant: z.enum(["naive", "guarded", "notarize"]),
    mode: z.enum(["live", "replay"]),
    tool: z.enum(["crustdata", "dodo"]).nullable(),
    seed: z.number().int(),
    startedAt: z.iso.datetime(),
    status: z.enum(["completed", "stopped_budget", "blocked", "failed"]),
    modelUsd: Usd,
    usdByRole: EconomicsRoleUsdSchema,
    tokens: Count,
    credits: z.number().nonnegative(),
    creditsByEndpoint: z.record(z.string(), z.number().nonnegative()),
    unsafeActions: z.number().nullable(),
    holds: z.number().nullable(),
    beliefsNotarized: z.number().nullable(),
  })
  .strict();

/** A computed ratio: value (or null) plus the exact rule it came from, in words. */
export const EconomicsRatioSchema = z
  .object({
    usd: Usd.nullable(),
    credits: z.number().nonnegative().nullable(),
    basis: z.string().min(1),
    /** Why the value is null; null when it is computed. */
    reason: z.string().nullable(),
  })
  .strict();

/** Naive vs guarded live queue runs of one world (same seed): what the guard prevented. */
export const EconomicsPairSchema = z
  .object({
    seed: z.number().int(),
    naiveRunId: z.string(),
    guardedRunId: z.string(),
    naiveUnsafe: z.number().nullable(),
    guardedUnsafe: z.number().nullable(),
    prevented: z.number().nullable(),
    held: z.number().nullable(),
  })
  .strict();

/** Live notarize spend per tool, and what it bought. */
export const EconomicsToolSchema = z
  .object({
    tool: z.enum(["crustdata", "dodo"]),
    runs: Count,
    modelUsd: Usd,
    credits: z.number().nonnegative(),
    /** Distinct notarized beliefs in the tool's newest full notarize bundle; null when none exists. */
    notarizedBeliefs: Count.nullable(),
    /** Certified claims from public/certificates/report.json; null when it is absent or stale. */
    certified: Count.nullable(),
    costPerCertificateUsd: Usd.nullable(),
  })
  .strict();

export const EconomicsComputedSchema = z
  .object({
    runs: z.array(EconomicsRunSchema),
    totals: z
      .object({
        runs: Count,
        liveRuns: Count,
        replayRuns: Count,
        modelUsd: Usd,
        credits: z.number().nonnegative(),
        tokens: Count,
      })
      .strict(),
    usdByRole: EconomicsRoleUsdSchema,
    creditsByEndpoint: z.record(z.string(), z.number().nonnegative()),
    costPerRun: EconomicsRatioSchema,
    costPerNotarizedBelief: EconomicsRatioSchema,
    costPerCertificate: EconomicsRatioSchema,
    tools: z.array(EconomicsToolSchema),
    pairs: z.array(EconomicsPairSchema),
    unsafeActionsPrevented: z.object({ value: z.number().nullable(), basis: z.string(), reason: z.string().nullable() }).strict(),
    heldActions: z.object({ value: z.number().nullable(), basis: z.string(), reason: z.string().nullable() }).strict(),
  })
  .strict();

// --- the cfo.ai plan, as exported ------------------------------------------------------------

export const CfoPlanTierSchema = z
  .object({
    key: Slug,
    name: z.string().min(1),
    price: z.number().finite().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** What the price is per, as exported (e.g. "contract/month"). */
    period: z.string().min(1),
    description: z.string().nullable(),
    features: z.array(z.string().min(1)),
  })
  .strict();

export const CfoPlanPointSchema = z.object({ period: z.string().min(1), value: z.number().finite() }).strict();

export const CfoPlanSeriesSchema = z
  .object({
    key: Slug,
    label: z.string().min(1),
    unit: z.string(),
    points: z.array(CfoPlanPointSchema).min(1),
  })
  .strict();

export const CfoPlanFigureSchema = z
  .object({
    key: Slug,
    label: z.string().min(1),
    value: z.number().finite(),
    unit: z.string(),
    detail: z.string().nullable(),
  })
  .strict();

export const CfoPlanSourceSchema = z
  .object({
    tool: z.literal("cfo.ai"),
    /** The import format Notary read (docs/BUSINESS.md documents it). */
    format: z.literal("notary-cfo-plan-csv/1"),
    /** Base name of the imported file (the path is not recorded). */
    file: z.string().min(1),
    fileSha256: Sha256HexSchema,
    importedAt: z.iso.datetime(),
    workspace: z.string().nullable(),
    page: z.string().nullable(),
    scenario: z.string().nullable(),
    exportedAt: z.string().nullable(),
    /** A cfo.ai read-only share link to the Page the figures came from (https only). */
    shareUrl: z.url({ protocol: /^https$/ }).nullable(),
  })
  .strict();

export const CfoPlanSchema = z
  .object({
    source: CfoPlanSourceSchema,
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    tiers: z.array(CfoPlanTierSchema),
    series: z.array(CfoPlanSeriesSchema),
    figures: z.array(CfoPlanFigureSchema),
  })
  .strict();

/** A figure that needs both sources (computed × plan); null unless both exist. */
export const EconomicsCombinedSchema = z
  .object({
    incidentsPreventedValue: z
      .object({ value: z.number().finite(), unit: z.string(), basis: z.string() })
      .strict()
      .nullable(),
  })
  .strict();

export const EconomicsSourceBundleSchema = z
  .object({ runId: z.string(), contentHash: Sha256HexSchema, file: z.string() })
  .strict();

/** The file without its contentHash (what the hash is taken over), unrefined. */
export const EconomicsBodySchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedBy: z.literal(ECONOMICS_GENERATED_BY),
    sample: z.literal(false),
    sources: z
      .object({
        bundles: z.array(EconomicsSourceBundleSchema),
        /** Files looked at and not used, with the reason (fixtures, samples, tampered, drift). */
        skipped: z.array(z.object({ file: z.string(), reason: z.string() }).strict()),
        certificatesReport: z.object({ file: z.string(), sha256: Sha256HexSchema }).strict().nullable(),
      })
      .strict(),
    computed: EconomicsComputedSchema.nullable(),
    computedReason: z.string().nullable(),
    plan: CfoPlanSchema.nullable(),
    planReason: z.string().nullable(),
    combined: EconomicsCombinedSchema,
  })
  .strict();

type Body = z.infer<typeof EconomicsBodySchema>;
const oneOf = (f: Body) => (f.computed === null) !== (f.computedReason === null) && (f.plan === null) !== (f.planReason === null);
const ONE_OF = { message: "exactly one of computed / computedReason and one of plan / planReason is set" };

/** Body checks shared by both schemas: a section is either present or carries the reason it is not. */
export const EconomicsBodyCheckedSchema = EconomicsBodySchema.refine(oneOf, ONE_OF);

export const EconomicsFileSchema = EconomicsBodySchema.extend({ contentHash: Sha256HexSchema }).strict().refine(oneOf, ONE_OF);

export type EconomicsRun = z.infer<typeof EconomicsRunSchema>;
export type EconomicsRatio = z.infer<typeof EconomicsRatioSchema>;
export type EconomicsPair = z.infer<typeof EconomicsPairSchema>;
export type EconomicsTool = z.infer<typeof EconomicsToolSchema>;
export type EconomicsComputed = z.infer<typeof EconomicsComputedSchema>;
export type CfoPlanTier = z.infer<typeof CfoPlanTierSchema>;
export type CfoPlanSeries = z.infer<typeof CfoPlanSeriesSchema>;
export type CfoPlanFigure = z.infer<typeof CfoPlanFigureSchema>;
export type CfoPlanSource = z.infer<typeof CfoPlanSourceSchema>;
export type CfoPlan = z.infer<typeof CfoPlanSchema>;
export type EconomicsCombined = z.infer<typeof EconomicsCombinedSchema>;
export type EconomicsBody = z.infer<typeof EconomicsBodySchema>;
export type EconomicsFile = z.infer<typeof EconomicsFileSchema>;
