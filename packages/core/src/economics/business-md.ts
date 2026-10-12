/**
 * docs/BUSINESS.md, generated from economics.json by `notary economics`. Every number below is a
 * value from the file (computed from real bundles, or the cfo.ai plan as exported); the prose
 * around them is fixed text. Deterministic: same file, same Markdown.
 */
import type { EconomicsFile, EconomicsRatio } from "../schema/economics.js";
import { CFO_PLAN_HEADER } from "./cfo-import.js";

/** The round trip, step by step (also shown on the Business page). */
export const CFO_STEPS: readonly string[] = [
  "Sign up at https://cfo.ai/neathacks (then cancel the subscription in Settings → Billing, per the hackathon rules).",
  "Run `pnpm notary economics`. It writes `export/cfo-inputs.csv`: one row per real run with model USD by role, tokens, Crustdata credits, unsafe actions and held actions, straight from the bundles. Replay rows (`new_spend` = no) re-serve a recorded run and carry 0 spend, so the sheet never counts a live run twice; `stage` tells recon sweeps (`notarize-recon`) from full notarize runs; a model with no known price leaves `model_usd` empty (unknown, not 0).",
  "In cfo.ai, open Connections → Add → Integrations → Upload and choose `export/cfo-inputs.csv` (or attach it to an Ari message and pick \"Data source\"). Ask Ari to confirm the import finished.",
  "Ask Ari to build the plan from that data source (prompt below): pricing per monitored API contract, COGS per contract, cost of incidents prevented, a monthly revenue and COGS projection, cash and runway. Review and adjust the assumptions on the Page.",
  `Ask Ari for the plan as a downloadable CSV in Notary's import format (prompt below; header \`${CFO_PLAN_HEADER.join(",")}\`). Download the file card. Optionally Share the Page (Share → Create link) and put the link in a \`meta,share_url\` row.`,
  "Run `pnpm notary economics --cfo-import <downloaded.csv>`. The plan lands in `packages/web/public/economics.json` (hash-pinned, with the file's sha256 and the import time), on the dashboard's Business page and in this file.",
];

/** The direct route: `notary cfo connect` / `sync` over cfo.ai's MCP server (src/cfo/). */
export const CFO_MCP_STEPS: readonly string[] = [
  "Run `pnpm notary cfo connect`. It discovers cfo.ai's OAuth server from `https://api.cfo.ai/mcp`, registers Notary as a native client, and opens your browser on cfo.ai's sign-in page; you sign in there (Notary never sees your password). Tokens stay in the gitignored `packages/core/config/cfo-oauth.json`. With several workspaces, pick one (or pass `--org <id>`).",
  "In cfo.ai, keep the plan in a table block named \"Notary Plan\" (or pass `--table` to `sync`, repeatable). Each row name carries its unit in parentheses: dated rows such as `Revenue (USD)`, `COGS (USD)` and `Cash (USD)` become series; timeless rows such as `Runway months (months)` and `Cost per incident (USD)` become figures; `Tier <Name> price (USD/contract/month)` rows become pricing tiers. Rows without a unit, rows split by a Dimension, and cells that are not plain numbers are rejected, never guessed.",
  "Run `pnpm notary cfo sync` (or press \"Sync from cfo.ai\" on the Business tab while `pnpm notary serve` runs). It reads the tables with `inspect_table_blocks` (Main scenario unless `--scenario`), records the workspace and scenario ids, the sync time and the sha256 of the raw MCP payload, and regenerates economics.json and this file. The raw payload stays local in the gitignored `packages/core/config/cfo-last-sync.json`. A response shape Notary does not recognize is rejected with the keys it found, and nothing is written.",
  "Notary's per-run costs still go into cfo.ai as the `export/cfo-inputs.csv` upload: cfo.ai's MCP server documents no write of literal data rows (`notary cfo push` explains and exits BLOCKED).",
];

export const ARI_MODEL_PROMPT = [
  "Use the uploaded data source cfo-inputs.csv (one row per Notary run; model_usd, tokens and crustdata_credits are real costs; new_spend=yes rows are billable work; new_spend=no rows are replays with 0 spend; an empty model_usd is an unknown price, not 0).",
  "Build a business plan for Notary, a certification layer that monitors API contracts for AI agents, on a Page named \"Notary plan\":",
  "1. Three pricing tiers, priced per monitored API contract per month.",
  "2. COGS per monitored contract per month from the live rows (model_usd plus crustdata_credits at our Crustdata credit price).",
  "3. Cost of incidents prevented: unsafe_actions avoided times a cost per incident.",
  "4. A 12-month projection of revenue and COGS, and cash balance with runway in months.",
  "Ask me for any assumption you need (contracts per tier, growth, credit price, cost per incident, starting cash, monthly burn).",
].join("\n");

export const ARI_EXPORT_PROMPT = [
  "Produce a CSV file I can download, nothing else in it, with exactly this header:",
  CFO_PLAN_HEADER.join(","),
  "Rows:",
  "- meta rows: key = workspace, page, scenario, exported_at, currency (3-letter); put the text in the value column.",
  "- one tier row per pricing tier: key = short lowercase id, label = tier name, value = price as a plain number, unit = CUR/contract/month, detail = one-line description; plus tier_feature rows (key = tier id, label = feature).",
  "- series rows for the monthly projection: key = revenue, cogs and cash, period = YYYY-MM, value = plain number, unit = the currency.",
  "- figure rows: runway_months, cost_per_incident, cogs_per_contract, gross_margin and any other headline figure; value = plain number, unit as appropriate.",
  "Plain numbers only (no thousands separators or currency signs). Values exactly as in the model, Main scenario.",
].join("\n");

const usd = (n: number | null): string => (n === null ? "not computable" : n === 0 ? "$0" : `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 6 : 4)}`);
const num = (n: number | null): string => (n === null ? "not computable" : String(n));
const cell = (s: string): string => s.replaceAll("|", "\\|").replaceAll("\n", " ");

function ratioRow(label: string, r: EconomicsRatio): string {
  const value = r.usd === null ? `not computable — ${r.reason ?? ""}` : `${usd(r.usd)} model USD + ${num(r.credits)} Crustdata credits`;
  return `| ${label} | ${cell(value)} | ${cell(r.basis)} |`;
}

export function renderBusinessMd(f: EconomicsFile): string {
  const out: string[] = [];
  out.push("# Business plan and unit economics");
  out.push("");
  out.push(`Generated by \`${f.generatedBy}\` from \`packages/web/public/economics.json\` (contentHash \`${f.contentHash}\`). Do not edit by hand; re-run the command.`);
  out.push("");
  out.push("Two sources, never mixed: **computed** figures come from real run bundles (`sample: false`; fixture runs are never counted), and the **plan** is the business model built in [cfo.ai](https://cfo.ai), imported exactly as exported.");
  out.push("");

  // --- plan
  out.push("## The plan, modeled in cfo.ai");
  out.push("");
  if (!f.plan) {
    out.push(`Not imported: ${f.planReason}`);
  } else {
    const s = f.plan.source;
    if (s.mcp)
      out.push(
        `Synced ${s.importedAt} from cfo.ai over MCP (\`${s.mcp.server}\`, tool \`${s.mcp.tool}\`, table${s.mcp.tables.length === 1 ? "" : "s"} ${s.mcp.tables.map((t) => `"${t}"`).join(", ")}; workspace id \`${s.mcp.orgId}\`${s.mcp.scenarioId ? `, scenario id \`${s.mcp.scenarioId}\`` : ""}${s.mcp.pageId ? `, page id \`${s.mcp.pageId}\`` : ""}). Raw MCP payload sha256 \`${s.fileSha256}\` (canonical JSON of the local \`${s.file}\`), format \`${s.format}\`.`,
      );
    else out.push(`Imported ${s.importedAt} from \`${s.file}\` (sha256 \`${s.fileSha256}\`, format \`${s.format}\`).`);
    const where = [s.workspace && `workspace "${s.workspace}"`, s.page && `page "${s.page}"`, s.scenario && `scenario "${s.scenario}"`, s.exportedAt && `exported ${s.exportedAt}`].filter(Boolean);
    if (where.length) out.push(`cfo.ai ${where.join(", ")}.`);
    if (s.shareUrl) out.push(`Read-only cfo.ai page: ${s.shareUrl}`);
    out.push("");
    if (f.plan.tiers.length) {
      out.push("### Pricing per monitored API contract");
      out.push("");
      out.push("| Tier | Price | Description | Includes |");
      out.push("| --- | --- | --- | --- |");
      for (const t of f.plan.tiers) out.push(`| ${cell(t.name)} | ${t.price} ${t.currency} / ${cell(t.period)} | ${cell(t.description ?? "")} | ${cell(t.features.join("; "))} |`);
      out.push("");
    }
    if (f.plan.figures.length) {
      out.push("### Key figures");
      out.push("");
      out.push("| Figure | Value | Note |");
      out.push("| --- | --- | --- |");
      for (const x of f.plan.figures) out.push(`| ${cell(x.label)} | ${x.value} ${cell(x.unit)} | ${cell(x.detail ?? "")} |`);
      out.push("");
    }
    for (const sr of f.plan.series) {
      out.push(`### ${sr.label}${sr.unit ? ` (${sr.unit})` : ""}`);
      out.push("");
      out.push(`| ${sr.points.map((p) => cell(p.period)).join(" | ")} |`);
      out.push(`| ${sr.points.map(() => "---").join(" | ")} |`);
      out.push(`| ${sr.points.map((p) => String(p.value)).join(" | ")} |`);
      out.push("");
    }
  }
  out.push("");

  // --- computed
  out.push("## Unit economics from real runs");
  out.push("");
  const c = f.computed;
  if (!c) {
    out.push(`Not computed: ${f.computedReason}`);
  } else {
    out.push(`${c.totals.runs} real bundles (${c.totals.liveRuns} live, ${c.totals.replayRuns} replay). Live spend: ${c.totals.usdUnknownRuns ? `at least ${usd(c.totals.modelUsd)} model USD (${c.totals.usdUnknownRuns} live run${c.totals.usdUnknownRuns === 1 ? "" : "s"} used a model with no known price)` : `${usd(c.totals.modelUsd)} model USD`}, ${c.totals.credits} Crustdata credits, ${c.totals.tokens} tokens. Crustdata credits have no USD price, so they are reported next to model USD, never converted.`);
    out.push("");
    out.push("| Figure | Value | How it is computed |");
    out.push("| --- | --- | --- |");
    out.push(ratioRow("Cost per run", c.costPerRun));
    out.push(ratioRow("Cost per notarized belief", c.costPerNotarizedBelief));
    out.push(ratioRow("Cost per certificate", c.costPerCertificate));
    out.push(`| Unsafe actions prevented | ${cell(c.unsafeActionsPrevented.value === null ? `not computable — ${c.unsafeActionsPrevented.reason ?? ""}` : String(c.unsafeActionsPrevented.value))} | ${cell(c.unsafeActionsPrevented.basis)} |`);
    out.push(`| Money actions held for a person | ${cell(c.heldActions.value === null ? `not computable — ${c.heldActions.reason ?? ""}` : String(c.heldActions.value))} | ${cell(c.heldActions.basis)} |`);
    out.push("");
    out.push("Model USD by role (live): " + (["executor", "reflector", "adversary"] as const).map((r) => `${r} ${usd(c.usdByRole[r])}`).join(", ") + ".");
    const eps = Object.entries(c.creditsByEndpoint);
    out.push("");
    out.push(`Crustdata credits by endpoint (live): ${eps.length ? eps.map(([e, n]) => `\`${e}\` ${n}`).join(", ") : "none charged"}.`);
  }
  out.push("");
  if (f.combined.incidentsPreventedValue) {
    out.push("## Both sources together");
    out.push("");
    out.push(`Value of unsafe actions prevented: ${f.combined.incidentsPreventedValue.value} ${f.combined.incidentsPreventedValue.unit}. ${f.combined.incidentsPreventedValue.basis}`);
    out.push("");
  }

  // --- how to refresh
  out.push("## How the plan is built in cfo.ai and comes back");
  out.push("");
  out.push("cfo.ai has no REST API and no API key. Data goes in as a CSV upload (a documented data source) and comes back as a file Ari produces for download, or over its MCP server (`https://api.cfo.ai/mcp`, browser OAuth, approved account). The round trip:");
  out.push("");
  CFO_STEPS.forEach((step, i) => out.push(`${i + 1}. ${step}`));
  out.push("");
  out.push("Prompt for step 4 (the assumptions in it are yours to set in cfo.ai; Notary supplies only the per-run costs):");
  out.push("");
  out.push("```text");
  out.push(ARI_MODEL_PROMPT);
  out.push("```");
  out.push("");
  out.push("Prompt for step 5:");
  out.push("");
  out.push("```text");
  out.push(ARI_EXPORT_PROMPT);
  out.push("```");
  out.push("");
  out.push("Or read the plan straight from cfo.ai over its MCP server, with no file to download:");
  out.push("");
  CFO_MCP_STEPS.forEach((step, i) => out.push(`${i + 1}. ${step}`));
  out.push("");
  out.push(`Sources: ${f.sources.bundles.length} real bundles used, ${f.sources.skipped.length} files skipped (fixtures, samples, drift fixtures, failed checks)${f.sources.certificatesReport ? `, certificates report sha256 \`${f.sources.certificatesReport.sha256}\`` : ", no real certificates report"}.`);
  out.push("");
  return out.join("\n");
}
