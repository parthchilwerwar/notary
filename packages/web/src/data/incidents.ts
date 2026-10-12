// Published incidents (public/incidents/index.json for real runs and public/incidents/fixture/index.json
// for fixture runs, IncidentsIndex files written by `notary export` / `publish:incidents`) and the bundle
// indexes they are tied to. Incidents never live inside public/bundles. Like published.ts, this module is the only place that
// knows the file paths; it only reads and validates. What the page shows is derived in
// pages/incidents/model.ts.
import { IncidentsIndexSchema } from "../../../core/src/schema";
import type { BundleIndexEntry, IncidentsIndex } from "../../../core/src/schema";
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
    };

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
  const parse = (raw: unknown, label: string): IncidentsIndex["runs"] => {
    if (raw === undefined) return [];
    const parsed = IncidentsIndexSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${label} does not match the shared Notary schema. Incidents withheld.`);
    // Each run keeps its own sample flag; a fixture index marks all of its runs as fixture.
    return parsed.data.runs.map((r) => (parsed.data.sample ? { ...r, sample: true } : r));
  };
  const runs = [...parse(rawReal, "incidents/index.json"), ...parse(rawFixture, "incidents/fixture/index.json")];
  const parsed = { data: { sample: false, runs } as IncidentsIndex };
  const [primary, fixture] = await Promise.all([
    readIndex(`${base}bundles/index.json`, "Bundle index", opts.signal, fetchImpl),
    readIndex(`${base}bundles/fixture/index.json`, "Fixture index", opts.signal, fetchImpl),
  ]);
  return { status: "ready", index: parsed.data, primary, fixture };
}
