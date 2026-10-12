/**
 * Strict mapping from cfo.ai MCP payloads to Notary's plan (schema/economics.ts CfoPlan).
 *
 * Two layers, both refusing rather than guessing:
 *
 * 1. Reading a table (`inspect_table_blocks` `read`). cfo.ai documents the request
 *    (`{"scenario":"Main","read":{"target":"<table>"}}`) and names `rows` / `columns` in the
 *    response (column entries like {"ref":"Date#10b","axis":true,"dimension":"Date","grain":"MONTH"},
 *    row refs like `Revenue#a4d`), but not the key that holds cell values
 *    (docs.cfo.ai/formulas/agent-docs/read-and-explain.md). Notary accepts exactly these forms and
 *    rejects anything else, naming the keys it found (never the values), so the first real sync
 *    either confirms the reading or says precisely what to adapt:
 *      - the grid is the payload itself, or the one property of it that holds a `rows` array;
 *      - a row's name is its `name` / `label` / `variable` (all that are present must agree), else
 *        its `ref` without the `#hex` suffix; dimensioned rows (`Revenue[West]`, `members`) are refused;
 *      - a dated row has `values` (or `cells`): an object keyed by period, or an array aligned with
 *        the period columns (a column's `period`, else its `label`/`name`/`ref`, when it reads as a
 *        period: 2026-11, 2026, 2026-Q1, FY2026);
 *      - a timeless row has `value`;
 *      - a cell is a finite number, a plain decimal string, {"value": <that>}, or null (empty: left out).
 *        Anything else (`#NO_ROLLUP`, "12%", "$1,200", an error) is refused.
 *
 * 2. Naming. Each row name carries its unit in parentheses (the "Notary Plan" convention, documented
 *    in docs/BUSINESS.md); a name without one is refused:
 *      - `Tier <Name> price (USD/contract/month)`  timeless -> a pricing tier (key = slug of <Name>)
 *      - `<Label> (<unit>)` dated                  -> a series  (key = slug of <Label>; Revenue, COGS, Cash)
 *      - `<Label> (<unit>)` timeless               -> a figure  (key = slug of <Label>; Runway months, …)
 *    Values are kept exactly as read: never rounded, scaled or filled in.
 */
import type { CfoPlanFigure, CfoPlanSeries, CfoPlanTier } from "../schema/economics.js";

export class CfoMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfoMappingError";
  }
}

export const PERIOD_RE = /^(\d{4}-(0[1-9]|1[0-2])|\d{4}|\d{4}-Q[1-4]|FY\d{4})$/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const NAME_WITH_UNIT = /^(.+?)\s*\(([^()]+)\)$/;
const TIER = /^Tier\s+(.+?)\s+price$/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysOf = (v: unknown): string => (isObj(v) ? Object.keys(v).sort().join(", ") || "none" : Array.isArray(v) ? "an array" : typeof v);

export interface GridRow {
  table: string;
  name: string;
  /** Dated rows: points in the order read. */
  points: { period: string; value: number }[] | null;
  /** Timeless rows. */
  value: number | null;
}

export interface GridMeta {
  page: { id: string | null; name: string | null } | null;
}

function cellValue(cell: unknown, where: string): number | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) throw new CfoMappingError(`${where}: value is not a finite number`);
    return cell;
  }
  if (typeof cell === "string") {
    const t = cell.trim();
    if (t === "") return null;
    if (!PLAIN_NUMBER.test(t)) throw new CfoMappingError(`${where}: cell ${JSON.stringify(t.slice(0, 40))} is not a plain number (refused, not interpreted)`);
    return Number(t);
  }
  if (isObj(cell) && "value" in cell && Object.keys(cell).every((k) => ["value", "formatted", "format", "display"].includes(k))) return cellValue(cell.value, where);
  throw new CfoMappingError(`${where}: unrecognized cell (keys: ${keysOf(cell)})`);
}

function rowName(row: Record<string, unknown>, where: string): string {
  const named = (["name", "label", "variable"] as const).map((k) => row[k]).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  const distinct = [...new Set(named)];
  if (distinct.length > 1) throw new CfoMappingError(`${where}: the row's name fields disagree (${distinct.map((d) => JSON.stringify(d)).join(" vs ")})`);
  const ref = typeof row.ref === "string" ? row.ref.trim() : "";
  if (/\[.*\]/.test(ref) || (Array.isArray(row.members) && row.members.length > 0))
    throw new CfoMappingError(`${where}: row ${JSON.stringify(ref || distinct[0] || "?")} is split by a Dimension; the Notary Plan table must have one row per Variable`);
  const name = distinct[0] ?? ref.replace(/#[0-9a-f]+$/i, "").trim();
  if (!name) throw new CfoMappingError(`${where}: row has no name, label, variable or ref (keys: ${keysOf(row)})`);
  return name;
}

function periodOf(col: unknown): string | null {
  if (!isObj(col)) return typeof col === "string" && PERIOD_RE.test(col.trim()) ? col.trim() : null;
  if (typeof col.period === "string") return PERIOD_RE.test(col.period.trim()) ? col.period.trim() : null;
  for (const k of ["label", "name", "ref"] as const) {
    const v = col[k];
    if (typeof v === "string" && PERIOD_RE.test(v.trim())) return v.trim();
  }
  return null;
}

/** The rows of one table read (layer 1). */
export function extractTable(table: string, json: unknown): { rows: GridRow[]; meta: GridMeta } {
  let grid: Record<string, unknown> | undefined;
  if (isObj(json) && Array.isArray(json.rows)) grid = json;
  else if (isObj(json)) {
    const holders = Object.values(json).filter((v): v is Record<string, unknown> => isObj(v) && Array.isArray(v.rows));
    if (holders.length === 1) grid = holders[0];
  }
  if (!grid) throw new CfoMappingError(`table ${JSON.stringify(table)}: the read result has no rows array Notary recognizes (top-level keys: ${keysOf(json)})`);

  const periods = Array.isArray(grid.columns) ? grid.columns.map(periodOf).filter((p): p is string => p !== null) : [];
  const page = isObj(grid.page)
    ? { id: typeof grid.page.id === "string" ? grid.page.id : null, name: typeof grid.page.name === "string" ? grid.page.name : null }
    : typeof grid.page === "string"
      ? { id: null, name: grid.page }
      : null;

  const rows = (grid.rows as unknown[]).map((r, i): GridRow => {
    const where = `table ${JSON.stringify(table)} row ${i + 1}`;
    if (!isObj(r)) throw new CfoMappingError(`${where}: not an object`);
    const name = rowName(r, where);
    const at = `${where} (${JSON.stringify(name)})`;
    const holders = (["values", "cells"] as const).filter((k) => r[k] !== undefined && r[k] !== null);
    if (holders.length > 1) throw new CfoMappingError(`${at}: has both values and cells`);
    const dated = holders[0] ? r[holders[0]] : undefined;
    const hasValue = "value" in r && r.value !== undefined;
    if (dated !== undefined && hasValue) throw new CfoMappingError(`${at}: has both per-period values and a single value`);
    if (dated === undefined && !hasValue) throw new CfoMappingError(`${at}: has no values, cells or value (keys: ${keysOf(r)})`);
    if (hasValue) {
      const v = cellValue(r.value, at);
      if (v === null) throw new CfoMappingError(`${at}: value is empty`);
      return { table, name, points: null, value: v };
    }
    const points: { period: string; value: number }[] = [];
    const push = (period: string, cell: unknown) => {
      if (!PERIOD_RE.test(period)) throw new CfoMappingError(`${at}: ${JSON.stringify(period.slice(0, 30))} is not a period (YYYY-MM, YYYY, YYYY-Qn, FYYYYY)`);
      if (points.some((p) => p.period === period)) throw new CfoMappingError(`${at}: period ${period} appears twice`);
      const v = cellValue(cell, `${at} ${period}`);
      if (v !== null) points.push({ period, value: v });
    };
    if (Array.isArray(dated)) {
      if (dated.length !== periods.length)
        throw new CfoMappingError(`${at}: ${dated.length} values but ${periods.length} period columns, so values cannot be matched to periods`);
      dated.forEach((cell, j) => push(periods[j]!, cell));
    } else if (isObj(dated)) {
      for (const [period, cell] of Object.entries(dated)) push(period.trim(), cell);
    } else throw new CfoMappingError(`${at}: values is neither a list nor an object keyed by period`);
    if (!points.length) throw new CfoMappingError(`${at}: every period is empty`);
    return { table, name, points, value: null };
  });
  return { rows, meta: { page } };
}

export function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface MappedPlan {
  currency: string | null;
  tiers: CfoPlanTier[];
  series: CfoPlanSeries[];
  figures: CfoPlanFigure[];
}

/** Rows -> plan (layer 2). Throws CfoMappingError on the first row that does not fit. */
export function mapRows(rows: readonly GridRow[]): MappedPlan {
  const tiers: CfoPlanTier[] = [];
  const series: CfoPlanSeries[] = [];
  const figures: CfoPlanFigure[] = [];
  const currencies = new Set<string>();
  const taken = new Map<string, string>();
  const claim = (kind: string, key: string, name: string) => {
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(key)) throw new CfoMappingError(`row ${JSON.stringify(name)}: gives no usable key (letters or digits needed)`);
    const prior = taken.get(`${kind}:${key}`);
    if (prior) throw new CfoMappingError(`rows ${JSON.stringify(prior)} and ${JSON.stringify(name)} both map to ${kind} ${key}`);
    taken.set(`${kind}:${key}`, name);
  };

  for (const row of rows) {
    const m = NAME_WITH_UNIT.exec(row.name);
    if (!m) throw new CfoMappingError(`row ${JSON.stringify(row.name)} (table ${JSON.stringify(row.table)}): the name has no unit; rename it like "${row.name} (USD)" or "${row.name} (months)"`);
    const label = m[1]!.trim();
    const unit = m[2]!.trim();
    const tier = TIER.exec(label);
    if (tier) {
      if (row.value === null) throw new CfoMappingError(`row ${JSON.stringify(row.name)}: a tier price must be a single value (a timeless table), not per period`);
      const pu = /^([A-Z]{3})\/(.+)$/.exec(unit);
      if (!pu) throw new CfoMappingError(`row ${JSON.stringify(row.name)}: a tier unit must look like CUR/period (e.g. USD/contract/month), got ${JSON.stringify(unit)}`);
      if (row.value < 0) throw new CfoMappingError(`row ${JSON.stringify(row.name)}: a price cannot be negative`);
      const name = tier[1]!.trim();
      const key = slug(name);
      claim("tier", key, row.name);
      currencies.add(pu[1]!);
      tiers.push({ key, name, price: row.value, currency: pu[1]!, period: pu[2]!.trim(), description: null, features: [] });
      continue;
    }
    const key = slug(label);
    if (/^[A-Z]{3}$/.test(unit)) currencies.add(unit);
    if (row.points) {
      claim("series", key, row.name);
      series.push({ key, label, unit, points: row.points.map((p) => ({ ...p })) });
    } else {
      claim("figure", key, row.name);
      figures.push({ key, label, value: row.value!, unit, detail: null });
    }
  }
  if (!tiers.length && !series.length && !figures.length) throw new CfoMappingError("the tables have no rows");
  return { currency: currencies.size === 1 ? [...currencies][0]! : null, tiers, series, figures };
}

/** list_orgs (and similar list results): [{id, name}], strictly. */
export function extractIdNameList(what: string, json: unknown): { id: string; name: string | null }[] {
  let list: unknown;
  if (Array.isArray(json)) list = json;
  else if (isObj(json)) {
    const arrays = Object.values(json).filter(Array.isArray);
    if (arrays.length === 1) list = arrays[0];
  }
  if (!Array.isArray(list)) throw new CfoMappingError(`${what}: no list Notary recognizes (top-level keys: ${keysOf(json)})`);
  return list.map((item, i) => {
    if (!isObj(item) || typeof item.id !== "string" || !item.id.trim()) throw new CfoMappingError(`${what} item ${i + 1}: has no string id (keys: ${keysOf(item)})`);
    const name = typeof item.name === "string" ? item.name : typeof item.slug === "string" ? item.slug : null;
    return { id: item.id, name };
  });
}
