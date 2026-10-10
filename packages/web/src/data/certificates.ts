// The certificate view the current pages render (moved from src/state/certificates.ts), built
// from a DataSource CertificateWorld. One world only: real, or one fixture scenario.
import type {
  Certificate,
  CertificateReport,
  NoCertificate,
  Revocation,
  RunBundle,
  ToolCertificates,
} from "../../../core/src/schema";
import type { CertificateWorldDetail } from "./published";
import type { CertificateWorld, RunEntry } from "./types";

export type CertificateView = {
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

/** null when the world has no published report (nothing to show — never a stand-in). */
export function toCertificateView(world: CertificateWorld): CertificateView | null {
  if (!world.report) return null;
  const detail = world as CertificateWorldDetail;
  const scenario =
    detail.scenario ?? (world.world.startsWith("fixture:") ? world.world.slice("fixture:".length) : undefined);
  return {
    sample: world.sample,
    scenario,
    scenarioReason: detail.scenarioReason,
    report: world.report,
    tools: world.tools,
    certificates: world.tools.flatMap((t) => t.certificates),
    revocations: world.tools.flatMap((t) => t.revocations),
    noCertificates: world.tools.flatMap((t) => t.noCertificates),
  };
}

/** The RunEntry of a verified bundle (for DataSource.certificates). */
export const entryOfBundle = (b: RunBundle): RunEntry => ({
  runId: b.runId,
  kind: b.kind,
  variant: b.variant,
  mode: b.mode,
  sample: b.sample,
  startedAt: b.startedAt,
  status: b.status,
  contentHash: b.contentHash,
  state: "finished",
});
