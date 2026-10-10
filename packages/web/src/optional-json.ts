/** Raw optional public data. Callers must validate with the committed core schema. */
export async function readOptionalJSON(
  path: string,
  signal?: AbortSignal,
): Promise<unknown | undefined> {
  const response = await fetch(`${import.meta.env.BASE_URL}${path}`, {
    signal,
    cache: "no-store",
  });
  if (response.headers.get("x-notary-hash-mismatch") === "1")
    throw new Error(
      "The server reported a content hash mismatch. Data withheld.",
    );
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Unable to load ${path}. Data withheld.`);
  // Vite/static SPA hosts can answer an absent public file with index.html.
  if (!response.headers.get("content-type")?.includes("json")) return;
  try {
    return await response.json();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(`${path} is not valid JSON. Data withheld.`);
  }
}
