// Business page: pure helpers (no React, no fetching). Every value comes from a verified
// public/economics.json; these only pick, order and format.
import type { CfoPlan, CfoPlanFigure, CfoPlanSeries, EconomicsComputed, EconomicsFile } from "../../../../core/src/schema";

/** "$0.0632", "$12.40", "$1,200": short, honest USD for small model costs. */
export function money(value: number, currency = "USD"): string {
  const abs = Math.abs(value);
  const opts: Intl.NumberFormatOptions =
    abs === 0 ? { maximumFractionDigits: 0 } : abs < 1 ? { maximumSignificantDigits: 3 } : abs < 1000 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 };
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, ...opts }).format(value);
  } catch {
    return `${new Intl.NumberFormat("en-US", opts).format(value)} ${currency}`;
  }
}

/** Compact axis ticks: 1.2K, 3.4M. */
export const compact = (value: number): string => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export const count = (value: number): string => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);

/** A plan value in its exported unit: currency units as money, anything else as "14 months". */
export function planValue(value: number, unit: string): string {
  if (/^[A-Z]{3}$/.test(unit)) return money(value, unit);
  return unit ? `${count(value)} ${unit}` : count(value);
}

export type Datum = { key: string; label: string; value: number; display: string; sub?: string };

/** Live runs, oldest first: model USD per run (replays spend nothing and are left out). */
export function costPerRunSeries(c: EconomicsComputed): { usd: Datum[]; credits: Datum[] } {
  const live = c.runs.filter((r) => r.mode === "live");
  const label = (r: (typeof live)[number]) => `${r.tool ?? r.variant} ${r.kind === "notarize" ? "notarize" : "run"}`;
  const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
  return {
    usd: live.map((r) => ({ key: r.runId, label: label(r), value: r.modelUsd, display: money(r.modelUsd), sub: when(r.startedAt) })),
    credits: live.map((r) => ({ key: r.runId, label: label(r), value: r.credits, display: `${count(r.credits)} credits`, sub: when(r.startedAt) })),
  };
}

export const ROLE_LABEL = { executor: "Executor", reflector: "Reflector", adversary: "Adversary" } as const;

export function roleBars(c: EconomicsComputed): Datum[] {
  return (["executor", "reflector", "adversary"] as const).map((r) => ({ key: r, label: ROLE_LABEL[r], value: c.usdByRole[r], display: money(c.usdByRole[r]) }));
}

export function endpointBars(c: EconomicsComputed): Datum[] {
  return Object.entries(c.creditsByEndpoint)
    .map(([e, n]) => ({ key: e, label: e, value: n, display: `${count(n)} credits` }))
    .sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : 1));
}

export function certificateBars(c: EconomicsComputed): Datum[] {
  return c.tools.flatMap((t) =>
    t.costPerCertificateUsd === null ? [] : [{ key: t.tool, label: t.tool === "dodo" ? "Dodo Payments" : "Crustdata", value: t.costPerCertificateUsd, display: money(t.costPerCertificateUsd), sub: `${t.certified} certified` }],
  );
}

/** Well-known plan keys the charts read; everything else is listed as exported. */
export const PLAN_SERIES = { revenue: "revenue", cogs: "cogs", cash: "cash" } as const;
export const PLAN_FIGURES = ["runway_months", "cogs_per_contract", "cost_per_incident", "gross_margin"] as const;

export const seriesOf = (plan: CfoPlan, key: string): CfoPlanSeries | undefined => plan.series.find((s) => s.key === key);
export const figureOf = (plan: CfoPlan, key: string): CfoPlanFigure | undefined => plan.figures.find((f) => f.key === key);

/** Plan series not drawn by a named chart, shown in the "as exported" table. */
export const otherSeries = (plan: CfoPlan): CfoPlanSeries[] => plan.series.filter((s) => !Object.values(PLAN_SERIES).includes(s.key as never));

/** A point-aligned two-series view (revenue vs COGS): periods in revenue order, then any extra COGS periods. */
export function alignSeries(a: CfoPlanSeries, b: CfoPlanSeries): { periods: string[]; a: (number | null)[]; b: (number | null)[] } {
  const periods = [...a.points.map((p) => p.period), ...b.points.map((p) => p.period).filter((p) => !a.points.some((q) => q.period === p))];
  const at = (s: CfoPlanSeries, p: string) => s.points.find((x) => x.period === p)?.value ?? null;
  return { periods, a: periods.map((p) => at(a, p)), b: periods.map((p) => at(b, p)) };
}

// --- the inputs sheet for cfo.ai (same bytes as core/src/economics/cfo-inputs.ts; a test pins it)

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

export function cfoInputsCsv(file: Pick<EconomicsFile, "computed">): string {
  const rows = (file.computed?.runs ?? []).map((r) =>
    [r.runId, r.startedAt, r.startedAt.slice(0, 7), r.kind, r.variant, r.tool, r.mode, r.status, r.modelUsd, r.usdByRole.executor, r.usdByRole.reflector, r.usdByRole.adversary, r.tokens, r.credits, r.unsafeActions, r.holds, r.beliefsNotarized]
      .map(field)
      .join(","),
  );
  return [CFO_INPUTS_COLUMNS.join(","), ...rows].join("\n") + "\n";
}

/** The round trip, as on docs/BUSINESS.md (copy, not data). */
export const CFO_STEPS: readonly { title: string; body: string; command?: string }[] = [
  { title: "Sign up", body: "Create a cfo.ai workspace at cfo.ai/neathacks (then cancel the subscription in Settings → Billing, per the hackathon rules)." },
  { title: "Export Notary's real costs", body: "One row per real run: model USD by role, tokens, Crustdata credits, unsafe and held actions, straight from the bundles. Download it here or find it at export/cfo-inputs.csv.", command: "pnpm notary economics" },
  { title: "Upload it to cfo.ai", body: "Connections → Add → Integrations → Upload, choose cfo-inputs.csv (or attach it to an Ari message and pick “Data source”). Ask Ari to confirm the import finished." },
  { title: "Have Ari build the plan", body: "Ask Ari for pricing per monitored API contract, COGS per contract from the live rows, the cost of incidents prevented, a monthly revenue and COGS projection, cash and runway. The prompt is in docs/BUSINESS.md; the assumptions are yours." },
  { title: "Download the plan", body: "Ask Ari for the plan as a CSV in Notary's import format (prompt in docs/BUSINESS.md) and download the file card. Optionally share the Page and add its link as a meta share_url row." },
  { title: "Import it", body: "The plan is published with the file's sha256 and import time, here and in docs/BUSINESS.md.", command: "pnpm notary economics --cfo-import <file.csv>" },
];
