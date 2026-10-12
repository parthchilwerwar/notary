/**
 * export/cfo-inputs.csv: Notary's REAL per-run cost inputs, ready to upload into cfo.ai as a CSV
 * data source (Connections → Add → Integrations → Upload, or attach to an Ari chat and choose
 * "Data source"; docs.cfo.ai/integrations/connect-and-sync-data, /workspace-settings/file-attachments-in-chat).
 * cfo.ai's Ari then models COGS per monitored contract from these rows instead of from typed
 * guesses. One row per real bundle (live and replay, labeled); values are the bundle's own, except:
 *   - a replay re-serves a recorded run, so its spend columns are 0 and new_spend is "no" (summing
 *     the sheet never counts a live run's cost twice)
 *   - stage is export/collect.ts classify(): recon sweeps are "notarize-recon", not full notarize runs
 *   - a live run with a model of unknown price has model_usd and usd_* left empty (unknown, not 0)
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
  "stage",
  "variant",
  "tool",
  "mode",
  "new_spend",
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
  const rows = (file.computed?.runs ?? []).map((r) => {
    const replay = r.mode === "replay";
    const usd = (v: number): number | null => (replay ? 0 : r.usdUnknown ? null : v);
    return [
      r.runId,
      r.startedAt,
      r.startedAt.slice(0, 7),
      r.stage ?? r.kind,
      r.variant,
      r.tool,
      r.mode,
      replay ? "no" : "yes",
      r.status,
      usd(r.modelUsd),
      usd(r.usdByRole.executor),
      usd(r.usdByRole.reflector),
      usd(r.usdByRole.adversary),
      replay ? 0 : r.tokens,
      replay ? 0 : r.credits,
      r.unsafeActions,
      r.holds,
      r.beliefsNotarized,
    ]
      .map(field)
      .join(",");
  });
  return [CFO_INPUTS_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
