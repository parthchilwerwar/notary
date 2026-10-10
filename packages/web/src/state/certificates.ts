// Certificate "world" for the selected run: real certificates (public/certificates/) for a real
// run, one fixture scenario (public/certificates/fixture/<scenario>/) for a fixture run. Never
// both. Every file is validated with the shared core schema, and every seal is recomputed in the
// browser (sha256 of canonical JSON, the same functions core uses) before anything renders.
import {
  CertificateReportSchema,
  FixtureIndexSchema,
  ToolCertificatesSchema,
} from "../../../core/src/schema";
import type {
  Certificate,
  CertificateReport,
  FixtureIndex,
  NoCertificate,
  Revocation,
  ToolCertificates,
} from "../../../core/src/schema";
import { canonicalJson, sha256Hex } from "../../../core/src/bundle/hash";
import { readOptionalJSON } from "../optional-json";

export type CertificateWorld = {
  sample: boolean;
  /** Fixture scenario name; undefined for real data. */
  scenario?: string;
  /** Why this scenario was chosen for the selected run. */
  scenarioReason?: string;
  report: CertificateReport;
  tools: ToolCertificates[];
  certificates: Certificate[];
  revocations: Revocation[];
  noCertificates: NoCertificate[];
};

const sealOf = (record: { sha256: string }) => {
  const { sha256: _ignored, ...rest } = record;
  return sha256Hex(canonicalJson(rest));
};

/**
 * Pick the fixture scenario for a run: the scenario that lists the run as a source bundle, else
 * the first scenario in the index (its order is the exporter's). Returns the reason shown on screen.
 */
export function chooseScenario(
  index: FixtureIndex,
  runId: string | undefined,
): { scenario: FixtureIndex["scenarios"][number]; reason: string } | undefined {
  const listed = index.scenarios.find((s) =>
    runId ? s.sourceBundles.includes(runId) : false,
  );
  if (listed)
    return {
      scenario: listed,
      reason: `${runId} is a source bundle of fixture scenario "${listed.scenario}".`,
    };
  const first = index.scenarios[0];
  return first
    ? {
        scenario: first,
        reason: `${runId ?? "The selected run"} is not a certificate source; showing the first fixture scenario, "${first.scenario}".`,
      }
    : undefined;
}

/** Throws (data withheld) when a tool file or any record inside it fails its seal. */
export function verifyToolFile(
  raw: unknown,
  expectedHash: string | undefined,
  sample: boolean,
  file: string,
): ToolCertificates {
  const parsed = ToolCertificatesSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `${file} does not match the shared certificate schema. Data withheld.`,
    );
  if (expectedHash === undefined || sha256Hex(canonicalJson(raw)) !== expectedHash)
    throw new Error(
      `${file} does not match the hash pinned in its report. Data withheld.`,
    );
  const tool = parsed.data;
  if (tool.sample !== sample)
    throw new Error(
      `${file} mixes fixture and real certificate data. Data withheld.`,
    );
  for (const record of [...tool.certificates, ...tool.revocations]) {
    if (sealOf(record) !== record.sha256)
      throw new Error(`Seal mismatch for ${record.id}. Data withheld.`);
    if (record.sample !== sample)
      throw new Error(
        `${record.id} mixes fixture and real data. Data withheld.`,
      );
  }
  return tool;
}

export async function loadCertificateWorld(
  sample: boolean,
  runId: string | undefined,
  signal?: AbortSignal,
): Promise<CertificateWorld | null> {
  let base = "certificates/";
  let scenario: string | undefined;
  let scenarioReason: string | undefined;
  if (sample) {
    const rawIndex = await readOptionalJSON("certificates/fixture/index.json", signal);
    if (rawIndex === undefined) return null;
    const index = FixtureIndexSchema.safeParse(rawIndex);
    if (!index.success)
      throw new Error(
        "The fixture certificate index does not match the shared schema. Data withheld.",
      );
    const chosen = chooseScenario(index.data, runId);
    if (!chosen) return null;
    scenario = chosen.scenario.scenario;
    scenarioReason = chosen.reason;
    const reportPath = chosen.scenario.report;
    base = `certificates/fixture/${reportPath.slice(0, reportPath.lastIndexOf("/") + 1)}`;
  }
  const rawReport = await readOptionalJSON(`${base}report.json`, signal);
  if (rawReport === undefined) return null;
  const parsed = CertificateReportSchema.safeParse(rawReport);
  if (!parsed.success)
    throw new Error(
      "The certificate report does not match the shared schema. Data withheld.",
    );
  const report = parsed.data;
  if (report.sample !== sample || report.scenario !== scenario)
    throw new Error(
      "The certificate report belongs to a different data world. Data withheld.",
    );
  const tools = await Promise.all(
    report.tools.map(async (entry) => {
      const raw = await readOptionalJSON(`${base}${entry.file}`, signal);
      if (raw === undefined)
        throw new Error(`${entry.file} is listed in the report but missing.`);
      return verifyToolFile(
        raw,
        report.toolFileHashes[entry.file],
        sample,
        entry.file,
      );
    }),
  );
  return {
    sample,
    scenario,
    scenarioReason,
    report,
    tools,
    certificates: tools.flatMap((t) => t.certificates),
    revocations: tools.flatMap((t) => t.revocations),
    noCertificates: tools.flatMap((t) => t.noCertificates),
  };
}
