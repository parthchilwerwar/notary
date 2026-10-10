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
): Promise<BundleIndexEntry[]> {
  const parsed = BundleIndexSchema.safeParse(
    await readJson(`${import.meta.env.BASE_URL}bundles/index.json`, signal),
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
): Promise<RunBundle> {
  return validateBundle(
    await readJson(
      `${import.meta.env.BASE_URL}bundles/${encodeURIComponent(entry.runId)}.json`,
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
