// Published incidents (public/incidents/index.json for real runs and public/incidents/fixture/index.json
// for fixture runs, IncidentsIndex files written by `notary export` / `publish:incidents`) and the bundle
// indexes they are tied to. Incidents never live inside public/bundles. Like published.ts, this module is the only place that
// knows the file paths; it only reads and validates. What the page shows is derived in
// pages/incidents/model.ts.
import { IncidentsIndexSchema } from "../../../core/src/schema";
import type { BundleIndexEntry, IncidentsIndex } from "../../../core/src/schema";
import { canonicalJson, sha256Hex } from "../../../core/src/bundle/hash";
import { globalFetch, readOptionalJson, type FetchImpl } from "./http";
import { parseBundleIndex } from "./verify";

export const INCIDENTS_FILE = "public/incidents/index.json";
export const FIXTURE_INCIDENTS_FILE = "public/incidents/fixture/index.json";

/** A bundle index as read for the hash tie-in: entries, or why they could not be read. */
export type IndexRead = { entries: BundleIndexEntry[] } | { entries: null; error?: string };

export type IncidentsLoad =
  /** No incidents file is published (404 / SPA fallback). */
  | { status: "missing" }
  | {
      status: "ready";
      index: IncidentsIndex;
      /** bundles/index.json (real runs; may also list sample runs). */
      primary: IndexRead;
      /** bundles/fixture/index.json (fixture runs). */
      fixture: IndexRead;
      /**
       * Why a cohort's incidents index was withheld (content hash missing or wrong). Its runs are not
       * in `index`; the page shows this message instead of them.
       */
      withheld?: { real?: string; fixture?: string };
    };

/**
 * The incidents index's own content hash, recomputed in the browser like economics.json and run
 * bundles: sha256 of canonicalJson(the file without its contentHash). Real data must carry one
 * (missing = withheld); a fixture index is checked when it carries one. Returns why the file is
 * withheld, or undefined when it verifies.
 */
export function incidentsHashProblem(raw: unknown, label: string, required: boolean): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { contentHash, ...rest } = raw as Record<string, unknown>;
  if (contentHash === undefined)
    return required
      ? `${label} carries no contentHash, so this browser cannot verify it. Incidents withheld — re-export with pnpm notary export.`
      : undefined;
  if (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/.test(contentHash))
    return `${label} has a malformed contentHash. Incidents withheld.`;
  const actual = sha256Hex(canonicalJson(rest));
  return actual === contentHash
    ? undefined
    : `${label} content hash mismatch: recorded ${contentHash.slice(0, 12)}…, computed ${actual.slice(0, 12)}…. Incidents withheld.`;
}

const baseUrl = (): string => String(import.meta.env.BASE_URL ?? "/");

async function readIndex(url: string, label: string, signal: AbortSignal | undefined, fetchImpl: FetchImpl): Promise<IndexRead> {
  let raw: unknown;
  try {
    raw = await readOptionalJson(url, label, signal, fetchImpl);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return { entries: null, error: (e as Error).message };
  }
  if (raw === undefined) return { entries: null };
  try {
    return { entries: parseBundleIndex(raw, label) };
  } catch (e) {
    return { entries: null, error: (e as Error).message };
  }
}

/**
 * Read and validate the published incidents. `missing` when nothing is published; throws (with a
 * plain-language message) when the file is unreadable or does not match IncidentsIndexSchema.
 * The bundle indexes are read alongside so each run can be checked against its published bundle.
 */
export async function loadIncidents(
  opts: { signal?: AbortSignal; fetchImpl?: FetchImpl; base?: string } = {},
): Promise<IncidentsLoad> {
  const base = opts.base ?? baseUrl();
  const fetchImpl = opts.fetchImpl ?? globalFetch;
  const [rawReal, rawFixture] = await Promise.all([
    readOptionalJson(`${base}incidents/index.json`, "incidents/index.json", opts.signal, fetchImpl),
    readOptionalJson(`${base}incidents/fixture/index.json`, "incidents/fixture/index.json", opts.signal, fetchImpl),
  ]);
  if (rawReal === undefined && rawFixture === undefined) return { status: "missing" };
  const withheld: { real?: string; fixture?: string } = {};
  const parse = (raw: unknown, label: string, cohort: "real" | "fixture"): IncidentsIndex["runs"] => {
    if (raw === undefined) return [];
    const parsed = IncidentsIndexSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${label} does not match the shared Notary schema. Incidents withheld.`);
    // The hash is required for real data (sample false); the schema strips unknown keys, so the raw file is hashed.
    const problem = incidentsHashProblem(raw, label, !parsed.data.sample && cohort === "real");
    if (problem) {
      withheld[cohort] = problem;
      return [];
    }
    // Each run keeps its own sample flag; a fixture index marks all of its runs as fixture.
    return parsed.data.runs.map((r) => (parsed.data.sample ? { ...r, sample: true } : r));
  };
  const runs = [...parse(rawReal, "incidents/index.json", "real"), ...parse(rawFixture, "incidents/fixture/index.json", "fixture")];
  const parsed = { data: { sample: false, runs } as IncidentsIndex };
  const [primary, fixture] = await Promise.all([
    readIndex(`${base}bundles/index.json`, "Bundle index", opts.signal, fetchImpl),
    readIndex(`${base}bundles/fixture/index.json`, "Fixture index", opts.signal, fetchImpl),
  ]);
  return {
    status: "ready",
    index: parsed.data,
    primary,
    fixture,
    ...(withheld.real || withheld.fixture ? { withheld } : {}),
  };
}
