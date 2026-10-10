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

export async function loadCatalog(signal?: AbortSignal): Promise<RunBundle[]> {
  const primary = await loadIndex(signal);
  let fixtures: BundleIndexEntry[] = [];
  const response = await fetch(
    `${import.meta.env.BASE_URL}bundles/fixture/index.json`,
    { signal, cache: "no-store" },
  );
  if (response.headers.get("x-notary-hash-mismatch") === "1")
    throw new Error("Fixture index hash mismatch. Data withheld.");
  if (response.ok && response.headers.get("content-type")?.includes("json")) {
    fixtures = BundleIndexSchema.parse(await response.json());
    if (fixtures.some((entry) => !entry.sample))
      throw new Error(
        "Fixture directory contains a live bundle. Data withheld.",
      );
  } else if (!response.ok && response.status !== 404)
    throw new Error("Unable to load the fixture index.");
  const all = await Promise.all([
    ...primary.map((entry) => loadBundle(entry, signal)),
    ...fixtures.map((entry) => loadBundle(entry, signal, "bundles/fixture")),
  ]);
  if (new Set(all.map((bundle) => bundle.runId)).size !== all.length)
    throw new Error("Duplicate run identifiers across bundle sources.");
  return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
