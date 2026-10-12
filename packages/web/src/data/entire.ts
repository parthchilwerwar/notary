// public/evidence/entire.json: Entire checkpoints for this repo and the entire-graph guard-coverage
// result, written by `pnpm notary export --entire` from the real Entire CLI. Validated with the
// shared core schema; anything that does not match is withheld, never shown.
import { EntireFileSchema, type EntireFile } from "../../../core/src/schema/entire";
import { globalFetch, readOptionalJson, type FetchImpl } from "./http";

/** Human-readable name of the file, for copy that says where the data comes from. */
export const ENTIRE_FILE = "public/evidence/entire.json";

const baseUrl = (): string => String(import.meta.env.BASE_URL ?? "/");

/** The validated file; undefined when it is not published. Throws on invalid JSON or a schema mismatch. */
export async function loadEntireFile(signal?: AbortSignal, fetchImpl: FetchImpl = globalFetch): Promise<EntireFile | undefined> {
  const raw = await readOptionalJson(`${baseUrl()}evidence/entire.json`, "evidence/entire.json", signal, fetchImpl);
  if (raw === undefined) return undefined;
  const parsed = EntireFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error("evidence/entire.json does not match the Entire schema. Data withheld.");
  return parsed.data;
}
