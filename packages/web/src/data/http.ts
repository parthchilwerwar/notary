// Low-level JSON reads for the data layer. Every caller validates what comes back with the shared
// core schema; these helpers only turn transport problems into plain-language errors.

export type FetchImpl = typeof fetch;

/** The global fetch, looked up at call time (so tests can stub it). */
export const globalFetch: FetchImpl = (input, init) => fetch(input, init);

const HASH_MISMATCH = "The server reported a content hash mismatch. Data withheld.";

/**
 * A required JSON file. Throws on HTTP errors (including 404), on the server's hash-mismatch
 * header and on invalid JSON. `label` names the file in errors.
 */
export async function readJson(
  url: string,
  label: string,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = globalFetch,
): Promise<unknown> {
  const response = await fetchImpl(url, { signal, cache: "no-store" });
  if (response.headers.get("x-notary-hash-mismatch") === "1") throw new Error(HASH_MISMATCH);
  if (!response.ok)
    throw new Error(`Unable to load ${label}: ${response.statusText || "request failed"}.`);
  try {
    return await response.json();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(`${label} is not valid JSON. Data withheld.`);
  }
}

/**
 * An optional published file: `undefined` when it is absent (404, or a static host's HTML SPA
 * fallback). Any other failure is an error, never disguised as "missing".
 */
export async function readOptionalJson(
  url: string,
  label: string,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = globalFetch,
): Promise<unknown | undefined> {
  const response = await fetchImpl(url, { signal, cache: "no-store" });
  if (response.headers.get("x-notary-hash-mismatch") === "1") throw new Error(HASH_MISMATCH);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Unable to load ${label}. Data withheld.`);
  // Vite/static SPA hosts can answer an absent public file with index.html.
  if (!response.headers.get("content-type")?.includes("json")) return undefined;
  try {
    return await response.json();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(`${label} is not valid JSON. Data withheld.`);
  }
}
