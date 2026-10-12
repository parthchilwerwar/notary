/**
 * export/cfo-inputs.csv: Notary's REAL per-run cost inputs, ready to upload into cfo.ai as a CSV
 * data source (Connections → Add → Integrations → Upload, or attach to an Ari chat and choose
 * "Data source"; docs.cfo.ai/integrations/connect-and-sync-data, /workspace-settings/file-attachments-in-chat).
 * cfo.ai's Ari then models COGS per monitored contract from these rows instead of from typed
 * guesses. One row per real bundle (live and replay, labeled); values are the bundle's own.
 * No real bundles → the header only (never placeholder rows).
 *
 * packages/web/src/pages/business/model.ts renders the same CSV in the browser for the download
 * button; packages/web/test/business-page.test.ts checks the two stay byte-identical.
 */
import type { EconomicsFile } from "../schema/economics.js";

export const CFO_INPUTS_COLUMNS = [
  "run_id",
  "started_at",
  "month",
  "kind",
  "variant",
  "tool",
  "mode",
  "status",
  "model_usd",
  "usd_executor",
  "usd_reflector",
  "usd_adversary",
  "tokens",
  "crustdata_credits",
  "unsafe_actions",
  "held_actions",
  "notarized_beliefs",
] as const;

const field = (v: string | number | null): string => {
  if (v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function renderCfoInputsCsv(file: Pick<EconomicsFile, "computed">): string {
  const rows = (file.computed?.runs ?? []).map((r) =>
    [
      r.runId,
      r.startedAt,
      r.startedAt.slice(0, 7),
      r.kind,
      r.variant,
      r.tool,
      r.mode,
      r.status,
      r.modelUsd,
      r.usdByRole.executor,
      r.usdByRole.reflector,
      r.usdByRole.adversary,
      r.tokens,
      r.credits,
      r.unsafeActions,
      r.holds,
      r.beliefsNotarized,
    ]
      .map(field)
      .join(","),
  );
  return [CFO_INPUTS_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
