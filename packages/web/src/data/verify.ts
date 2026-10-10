// Trust checks run in the browser before anything renders: shared-schema validation, bundle
// content hashes, timeline ↔ bundle hash ties, certificate seals and report pins. Pure functions
// (no I/O), shared by LiveSource and ReplaySource. Moved from src/data.ts and state/certificates.ts.
import { BundleIndexSchema, RunBundleSchema } from "../../../core/src/schema/bundle";
import { ToolCertificatesSchema, TimelineFileSchema } from "../../../core/src/schema";
import type {
  BundleIndexEntry,
  FixtureIndex,
  RunBundle,
  TimelineFile,
  ToolCertificates,
} from "../../../core/src/schema";
import { canonicalJson, computeContentHash, sha256Hex } from "../../../core/src/bundle/hash";

/** Schema + content hash (+ agreement with its index entry). Throws, data withheld, otherwise. */
export function validateBundle(raw: unknown, entry?: BundleIndexEntry): RunBundle {
  const parsed = RunBundleSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error("Bundle does not match the shared Notary schema. Data withheld.");
  const bundle = parsed.data;
  if (computeContentHash(bundle) !== bundle.contentHash)
    throw new Error(`Content hash mismatch for ${bundle.runId}. Data withheld.`);
  if (
    entry &&
    (entry.runId !== bundle.runId ||
      entry.contentHash !== bundle.contentHash ||
      entry.sample !== bundle.sample ||
      entry.kind !== bundle.kind ||
      entry.variant !== bundle.variant ||
      entry.mode !== bundle.mode ||
      entry.status !== bundle.status ||
      entry.startedAt !== bundle.startedAt)
  )
    throw new Error("Bundle disagrees with its index entry. Data withheld.");
  return bundle;
}

/** A bundle index (array of entries), schema-checked, run ids unique. */
export function parseBundleIndex(raw: unknown, what = "Bundle index"): BundleIndexEntry[] {
  const parsed = BundleIndexSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${what} does not match the shared Notary schema.`);
  if (new Set(parsed.data.map((e) => e.runId)).size !== parsed.data.length)
    throw new Error(`Duplicate run identifiers in ${what.toLowerCase()}.`);
  return parsed.data;
}

export const byNewest = <T extends { startedAt: string }>(a: T, b: T) =>
  b.startedAt.localeCompare(a.startedAt);

/**
 * Parse a timeline file and tie it to its verified bundle: same run, same sample flag, the
 * bundle's content hash, events of this run with strictly increasing seq. Throws otherwise.
 */
export function verifyTimelineFile(raw: unknown, bundle: RunBundle): TimelineFile {
  const parsed = TimelineFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `The timeline for ${bundle.runId} does not match the shared timeline schema. Data withheld.`,
    );
  const file = parsed.data;
  if (file.runId !== bundle.runId)
    throw new Error(`The timeline is for run ${file.runId}, not ${bundle.runId}. Data withheld.`);
  if (file.sample !== bundle.sample)
    throw new Error(
      `The timeline's sample flag (${file.sample}) disagrees with the bundle (${bundle.sample}). Data withheld.`,
    );
  if (file.bundleHash !== bundle.contentHash)
    throw new Error(
      `Timeline hash mismatch for ${bundle.runId}: it belongs to bundle ${file.bundleHash.slice(0, 12)}…, not the verified bundle ${bundle.contentHash.slice(0, 12)}…. Data withheld.`,
    );
  file.events.forEach((e, i) => {
    if (e.runId !== bundle.runId || (i > 0 && e.seq <= file.events[i - 1]!.seq))
      throw new Error(`The timeline for ${bundle.runId} is out of order. Data withheld.`);
  });
  return file;
}

// ---------------------------------------------------------------------------- certificates

/** sha256 of a certificate/revocation record without its own sha256 field. */
export const sealOf = (record: { sha256: string }) => {
  const { sha256: _ignored, ...rest } = record;
  return sha256Hex(canonicalJson(rest));
};

/** Every record's seal and sample flag. Throws (data withheld) on the first failure. */
export function verifyToolRecords(tool: ToolCertificates, sample: boolean, file: string): ToolCertificates {
  if (tool.sample !== sample)
    throw new Error(`${file} mixes fixture and real certificate data. Data withheld.`);
  for (const record of [...tool.certificates, ...tool.revocations]) {
    if (sealOf(record) !== record.sha256)
      throw new Error(`Seal mismatch for ${record.id}. Data withheld.`);
    if (record.sample !== sample)
      throw new Error(`${record.id} mixes fixture and real data. Data withheld.`);
  }
  return tool;
}

/** Throws (data withheld) when a tool file, its report pin, or any record inside it fails. */
export function verifyToolFile(
  raw: unknown,
  expectedHash: string | undefined,
  sample: boolean,
  file: string,
): ToolCertificates {
  const parsed = ToolCertificatesSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`${file} does not match the shared certificate schema. Data withheld.`);
  if (expectedHash === undefined || sha256Hex(canonicalJson(raw)) !== expectedHash)
    throw new Error(`${file} does not match the hash pinned in its report. Data withheld.`);
  return verifyToolRecords(parsed.data, sample, file);
}

/** Runs whose ids differ only in their trailing kind/variant share a key ("demo-change-api"). */
export const scenarioKey = (runId: string) => runId.replace(/-(run|notarize)-[a-z]+$/, "");

/**
 * Pick the fixture scenario for a run: the scenario that lists the run as a source bundle, else
 * the scenario whose source bundles belong to the same simulated world (same scenarioKey, e.g.
 * a queue run next to its notarize runs). Never another world: no match → undefined (the UI says
 * no certificates were published for this run's world). Returns the reason shown on screen.
 */
export function chooseScenario(
  index: FixtureIndex,
  runId: string | undefined,
): { scenario: FixtureIndex["scenarios"][number]; reason: string } | undefined {
  if (!runId) return undefined;
  const listed = index.scenarios.find((s) => s.sourceBundles.includes(runId));
  if (listed)
    return {
      scenario: listed,
      reason: `${runId} is a source bundle of fixture scenario "${listed.scenario}".`,
    };
  const key = scenarioKey(runId);
  const sameWorld = index.scenarios.find((s) => s.sourceBundles.some((b) => scenarioKey(b) === key));
  return sameWorld
    ? {
        scenario: sameWorld,
        reason: `${runId} belongs to the same simulated world as fixture scenario "${sameWorld.scenario}" (its notarize runs are the certificate sources).`,
      }
    : undefined;
}

// ------------------------------------------------------------------------------- approvals

/** The id `notary serve` gives a held decision: "appr-" + sha256(runId \n decisionId)[:16]. */
export const approvalId = (runId: string, decisionId: string) =>
  `appr-${sha256Hex(`${runId}\n${decisionId}`).slice(0, 16)}`;
