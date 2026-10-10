import {
  BundleIndexSchema,
  RunBundleSchema,
} from "../../core/src/schema/bundle";
import type { BundleIndexEntry, RunBundle } from "../../core/src/schema";
import { computeContentHash } from "../../core/src/bundle/hash";

export function validateBundle(
  raw: unknown,
  entry?: BundleIndexEntry,
): RunBundle {
  const parsed = RunBundleSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "Bundle does not match the shared Notary schema. Data withheld.",
    );
  const bundle = parsed.data;
  if (computeContentHash(bundle) !== bundle.contentHash) {
    throw new Error(
      `Content hash mismatch for ${bundle.runId}. Data withheld.`,
    );
  }
  if (
    entry &&
    (entry.runId !== bundle.runId ||
      entry.contentHash !== bundle.contentHash ||
      entry.sample !== bundle.sample ||
      entry.kind !== bundle.kind ||
      entry.variant !== bundle.variant ||
      entry.mode !== bundle.mode ||
      entry.status !== bundle.status ||
      entry.startedAt !== bundle.startedAt)
  ) {
    throw new Error("Bundle disagrees with its index entry. Data withheld.");
  }
  return bundle;
}

async function readJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, cache: "no-store" });
  if (response.headers.get("x-notary-hash-mismatch") === "1") {
    throw new Error(
      "The server reported a content hash mismatch. Data withheld.",
    );
  }
  if (!response.ok)
    throw new Error(
      `Unable to load ${path}: ${response.statusText || "request failed"}.`,
    );
  return response.json();
}

export async function loadIndex(
  signal?: AbortSignal,
  path = "bundles/index.json",
): Promise<BundleIndexEntry[]> {
  const parsed = BundleIndexSchema.safeParse(
    await readJson(`${import.meta.env.BASE_URL}${path}`, signal),
  );
  if (!parsed.success)
    throw new Error("Bundle index does not match the shared Notary schema.");
  if (
    new Set(parsed.data.map((entry) => entry.runId)).size !== parsed.data.length
  )
    throw new Error("Duplicate run identifiers in bundle index.");
  return [...parsed.data].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}

export async function loadBundle(
  entry: BundleIndexEntry,
  signal?: AbortSignal,
  directory = "bundles",
): Promise<RunBundle> {
  return validateBundle(
    await readJson(
      `${import.meta.env.BASE_URL}${directory}/${encodeURIComponent(entry.runId)}.json`,
      signal,
    ),
    entry,
  );
}

export function safeLink(value?: string): string | undefined {
  if (!value) return;
  if (/^https?:\/\//i.test(value)) return value;
  // Local receipts are links exactly as recorded, never invented neatlogs URLs.
  if (/^(?:\.?\/?runs\/|\/runs\/)/.test(value) && !value.includes(".."))
    return value;
}

export const label = (value: string) => value.replaceAll("_", " ");
export const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
export const percent = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
export const date = (value: string) =>
  new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(value));

export const usd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(value);

/** Optional fixture index (public/bundles/fixture/index.json); every entry must be `sample: true`. */
export async function loadFixtureEntries(
  signal?: AbortSignal,
): Promise<BundleIndexEntry[]> {
  const response = await fetch(
    `${import.meta.env.BASE_URL}bundles/fixture/index.json`,
    { signal, cache: "no-store" },
  );
  if (response.headers.get("x-notary-hash-mismatch") === "1")
    throw new Error("Fixture index hash mismatch. Data withheld.");
  if (response.ok && response.headers.get("content-type")?.includes("json")) {
    const fixtures = BundleIndexSchema.parse(await response.json());
    if (fixtures.some((entry) => !entry.sample))
      throw new Error(
        "Fixture directory contains a live bundle. Data withheld.",
      );
    return fixtures;
  }
  if (!response.ok && response.status !== 404)
    throw new Error("Unable to load the fixture index.");
  return [];
}

function finishCatalog(all: RunBundle[]): RunBundle[] {
  if (new Set(all.map((bundle) => bundle.runId)).size !== all.length)
    throw new Error("Duplicate run identifiers across bundle sources.");
  return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function loadCatalog(signal?: AbortSignal): Promise<RunBundle[]> {
  const primary = await loadIndex(signal);
  const fixtures = await loadFixtureEntries(signal);
  return finishCatalog(
    await Promise.all([
      ...primary.map((entry) => loadBundle(entry, signal)),
      ...fixtures.map((entry) => loadBundle(entry, signal, "bundles/fixture")),
    ]),
  );
}

/**
 * Base URL of a local `notary serve` (read-only API). Empty = same origin; the Vite dev server
 * proxies /api to http://127.0.0.1:8787. Set VITE_NOTARY_API to point elsewhere.
 */
export const API_BASE: string = String(
  import.meta.env.VITE_NOTARY_API ?? "",
).replace(/\/$/, "");

/**
 * Index from a local `notary serve` at /api/bundles, or null when no API answers with JSON
 * (static hosting, server not running, timeout). A JSON answer that fails the shared schema is
 * an error, not a silent fallback.
 */
export async function probeLocalApi(
  signal?: AbortSignal,
  timeoutMs = 1500,
): Promise<BundleIndexEntry[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  signal?.addEventListener("abort", forward, { once: true });
  let raw: unknown;
  try {
    const response = await fetch(`${API_BASE}/api/bundles`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("json"))
      return null;
    raw = await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
  const parsed = BundleIndexSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "The local Notary API returned an index that does not match the shared schema. Data withheld.",
    );
  return parsed.data;
}

export type DataSource = "api" | "static";
export type Catalog = {
  source: DataSource;
  entries: BundleIndexEntry[];
  bundles: RunBundle[];
};

/**
 * Everything the app can show: a local API first (its bundles plus the static fixture index),
 * else the static published index plus the fixture index. Every bundle is schema-checked and
 * hash-verified against its index entry before it is returned.
 */
export async function loadDataWorld(signal?: AbortSignal): Promise<Catalog> {
  const api = await probeLocalApi(signal);
  if (api) {
    const fixtures = (await loadFixtureEntries(signal)).filter(
      (entry) => !api.some((a) => a.runId === entry.runId),
    );
    const bundles = finishCatalog(
      await Promise.all([
        ...api.map(async (entry) =>
          validateBundle(
            await readJson(
              `${API_BASE}/api/bundles/${encodeURIComponent(entry.runId)}`,
              signal,
            ),
            entry,
          ),
        ),
        ...fixtures.map((entry) =>
          loadBundle(entry, signal, "bundles/fixture"),
        ),
      ]),
    );
    return { source: "api", entries: sortEntries([...api, ...fixtures]), bundles };
  }
  const primary = await loadIndex(signal);
  const fixtures = await loadFixtureEntries(signal);
  const bundles = finishCatalog(
    await Promise.all([
      ...primary.map((entry) => loadBundle(entry, signal)),
      ...fixtures.map((entry) => loadBundle(entry, signal, "bundles/fixture")),
    ]),
  );
  return {
    source: "static",
    entries: sortEntries([...primary, ...fixtures]),
    bundles,
  };
}

const sortEntries = (entries: BundleIndexEntry[]) =>
  [...entries].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
