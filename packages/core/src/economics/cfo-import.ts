/**
 * Importer for the cfo.ai business plan.
 *
 * What cfo.ai offers (checked 2026-10-12, docs.cfo.ai/llms.txt, cfo.ai/skill.md,
 * docs.cfo.ai/integrations/mcp-server.md): no REST API and no API key. Programmatic access is a
 * remote MCP server (https://api.cfo.ai/mcp, Streamable HTTP) authorized by browser OAuth for an
 * approved account; its tools read the Model (`inspect_table_blocks` `read`, `inspect_pages`,
 * `inspect_scenarios`, …). The docs describe no file export (CSV/XLSX/PDF/JSON) of a Model; Pages
 * are shared as read-only links. So Notary never calls cfo.ai itself: the user reads the plan out
 * of cfo.ai (over MCP from their own agent, or from Ari) into the small, documented CSV below, and
 * this module parses it. Only the parsed values, the file's base name and its sha256 are kept, so
 * anyone holding the file can check the import.
 *
 * Format "notary-cfo-plan-csv/1" (header row required, RFC 4180 quoting, `#` lines are comments):
 *
 *   section,key,label,period,value,unit,detail
 *   meta,workspace,,,Notary,,              workspace | page | scenario | exported_at | share_url | currency
 *   tier,team,Team,,49,USD/contract/month,Up to 5 monitored contracts
 *   tier_feature,team,Certificates and revocations,,,,
 *   series,revenue,Revenue,2026-11,1200,USD,
 *   figure,runway_months,Runway,,14,months,At current burn
 *
 * Values are taken exactly as exported; nothing is rounded, scaled or filled in.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sha256Hex } from "../bundle/hash.js";
import { CfoPlanSchema, type CfoPlan, type CfoPlanFigure, type CfoPlanSeries, type CfoPlanTier } from "../schema/economics.js";

export const CFO_PLAN_FORMAT = "notary-cfo-plan-csv/1" as const;
export const CFO_PLAN_HEADER = ["section", "key", "label", "period", "value", "unit", "detail"] as const;
const META_KEYS = ["workspace", "page", "scenario", "exported_at", "share_url", "currency"] as const;
type MetaKey = (typeof META_KEYS)[number];

export class CfoImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfoImportError";
  }
}

/** RFC 4180 rows: commas, double-quoted fields with "" escapes, CRLF or LF line ends. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.replace(/^﻿/, "");
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new CfoImportError("unterminated quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function num(raw: string, where: string): number {
  const t = raw.trim();
  // Plain decimal numbers only: no thousands separators, currency signs or percent, so a value is
  // never reinterpreted on the way in.
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) throw new CfoImportError(`${where}: value ${JSON.stringify(raw)} is not a plain number`);
  return Number(t);
}

const opt = (s: string): string | null => (s.trim() === "" ? null : s.trim());

/** "USD/contract/month" -> currency USD, period "contract/month". */
function priceUnit(unit: string, where: string): { currency: string; period: string } {
  const m = /^([A-Z]{3})\/(.+)$/.exec(unit.trim());
  if (!m) throw new CfoImportError(`${where}: tier unit must look like CUR/period (e.g. USD/contract/month), got ${JSON.stringify(unit)}`);
  return { currency: m[1]!, period: m[2]!.trim() };
}

export interface CfoImportInput {
  text: string;
  /** Base name recorded in the plan (never the full path). */
  file: string;
  importedAt: string;
  /** sha256 of the file's bytes; defaults to sha256 of `text`. */
  fileSha256?: string;
}

/** Parse a notary-cfo-plan-csv/1 export into a validated plan. Throws CfoImportError on any problem. */
export function parseCfoPlanCsv(input: CfoImportInput): CfoPlan {
  const rows = parseCsv(input.text)
    .map((cells, i) => ({ cells, line: i + 1 }))
    .filter(({ cells }) => !(cells.length === 1 && cells[0]!.trim() === "") && !cells[0]!.trimStart().startsWith("#"));
  if (!rows.length) throw new CfoImportError("the file is empty");
  const header = rows[0]!.cells.map((h) => h.trim().toLowerCase());
  if (header.join(",") !== CFO_PLAN_HEADER.join(","))
    throw new CfoImportError(`line ${rows[0]!.line}: header must be exactly "${CFO_PLAN_HEADER.join(",")}" (got "${header.join(",")}")`);

  const meta: Partial<Record<MetaKey, string>> = {};
  const tiers: CfoPlanTier[] = [];
  const features: { key: string; label: string; where: string }[] = [];
  const series = new Map<string, CfoPlanSeries>();
  const figures: CfoPlanFigure[] = [];

  for (const { cells, line } of rows.slice(1)) {
    const where = `line ${line}`;
    if (cells.length !== CFO_PLAN_HEADER.length)
      throw new CfoImportError(`${where}: expected ${CFO_PLAN_HEADER.length} columns, got ${cells.length}`);
    const [section, key, label, period, value, unit, detail] = cells.map((c) => c.trim()) as [string, string, string, string, string, string, string];
    const s = section.toLowerCase();
    if (!key) throw new CfoImportError(`${where}: key is empty`);
    switch (s) {
      case "meta": {
        if (!(META_KEYS as readonly string[]).includes(key)) throw new CfoImportError(`${where}: unknown meta key ${JSON.stringify(key)} (expected ${META_KEYS.join(", ")})`);
        if (meta[key as MetaKey] !== undefined) throw new CfoImportError(`${where}: meta ${key} is given twice`);
        meta[key as MetaKey] = value;
        break;
      }
      case "tier": {
        if (tiers.some((t) => t.key === key)) throw new CfoImportError(`${where}: tier ${key} is given twice`);
        const { currency, period: per } = priceUnit(unit, where);
        tiers.push({ key, name: label || key, price: num(value, where), currency, period: per, description: opt(detail), features: [] });
        break;
      }
      case "tier_feature":
        if (!label) throw new CfoImportError(`${where}: tier_feature needs the feature text in label`);
        features.push({ key, label, where });
        break;
      case "series": {
        if (!period) throw new CfoImportError(`${where}: series ${key} row has no period`);
        const existing = series.get(key);
        const point = { period, value: num(value, where) };
        if (!existing) series.set(key, { key, label: label || key, unit, points: [point] });
        else {
          if (existing.unit !== unit) throw new CfoImportError(`${where}: series ${key} changes unit (${existing.unit} -> ${unit})`);
          if (existing.points.some((p) => p.period === period)) throw new CfoImportError(`${where}: series ${key} repeats period ${period}`);
          existing.points.push(point);
        }
        break;
      }
      case "figure":
        if (figures.some((f) => f.key === key)) throw new CfoImportError(`${where}: figure ${key} is given twice`);
        figures.push({ key, label: label || key, value: num(value, where), unit, detail: opt(detail) });
        break;
      default:
        throw new CfoImportError(`${where}: unknown section ${JSON.stringify(section)} (expected meta, tier, tier_feature, series, figure)`);
    }
  }
  for (const f of features) {
    const tier = tiers.find((t) => t.key === f.key);
    if (!tier) throw new CfoImportError(`${f.where}: tier_feature names tier ${f.key}, which has no tier row`);
    tier.features.push(f.label);
  }
  if (!tiers.length && !series.size && !figures.length) throw new CfoImportError("the file has no tier, series or figure rows");

  const currency = opt(meta.currency ?? "");
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new CfoImportError(`meta currency must be a 3-letter code, got ${JSON.stringify(currency)}`);
  const shareUrl = opt(meta.share_url ?? "");
  if (shareUrl !== null && !/^https:\/\/[^\s]+$/.test(shareUrl)) throw new CfoImportError("meta share_url must be an https URL");

  const plan = {
    source: {
      tool: "cfo.ai" as const,
      format: CFO_PLAN_FORMAT,
      file: basename(input.file),
      fileSha256: input.fileSha256 ?? sha256Hex(input.text),
      importedAt: input.importedAt,
      workspace: opt(meta.workspace ?? ""),
      page: opt(meta.page ?? ""),
      scenario: opt(meta.scenario ?? ""),
      exportedAt: opt(meta.exported_at ?? ""),
      shareUrl,
    },
    currency,
    tiers,
    series: [...series.values()],
    figures,
  };
  const parsed = CfoPlanSchema.safeParse(plan);
  if (!parsed.success) throw new CfoImportError(`the plan does not fit the economics schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** Read and parse an export file from disk (bytes hashed as read). */
export function importCfoPlanFile(path: string, importedAt: string): CfoPlan {
  const bytes = readFileSync(path);
  return parseCfoPlanCsv({ text: bytes.toString("utf8"), file: path, importedAt, fileSha256: sha256Hex(new Uint8Array(bytes)) });
}
