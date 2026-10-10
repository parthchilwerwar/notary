// Transport for the local `notary serve` (moved from src/state/local-api.ts). Write endpoints and
// GET /api/approvals need the per-session token `notary serve` prints at startup; the user pastes
// it once and it lives in sessionStorage for this tab only (never localStorage, never in a URL).
// The hosted site has no local API, so none of this runs there.
import { useCallback, useEffect, useState } from "react";
import { globalFetch, type FetchImpl } from "./http";
import { resolveApiBase } from "./env";

const TOKEN_KEY = "notary.session-token";

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token.trim());
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token only lasts for this page view.
  }
  window.dispatchEvent(new Event("notary-token"));
}

export class LocalApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LocalApiError";
  }
}

export const TOKEN_REQUIRED = "Paste the session token that `notary serve` printed at startup.";

export type ApiRequestOptions = {
  /** "required": throw 401 without calling when there is no token. "optional": send it if present. */
  auth?: "required" | "optional";
  token?: string | null;
  fetchImpl?: FetchImpl;
};

/** A JSON request against the local API. Throws LocalApiError (server's `{error}` text) on non-2xx. */
export async function apiRequest(
  base: string,
  path: string,
  init: RequestInit = {},
  opts: ApiRequestOptions = {},
): Promise<{ status: number; body: unknown }> {
  const token = opts.token === undefined ? readToken() : opts.token;
  if (opts.auth === "required" && !token) throw new LocalApiError(401, TOKEN_REQUIRED);
  const response = await (opts.fetchImpl ?? globalFetch)(`${base}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.headers.get("x-notary-hash-mismatch") === "1")
    throw new LocalApiError(response.status, "The local API reported a content hash mismatch. Data withheld.");
  const type = response.headers.get("content-type") ?? "";
  let body: unknown;
  try {
    body = type.includes("json") ? await response.json() : await response.text();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new LocalApiError(response.status, `The local API answered ${path} with invalid JSON. Data withheld.`);
  }
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : response.status === 401
          ? "The session token was rejected. Paste the token from the current `notary serve`."
          : response.status === 403
            ? "The local API only accepts requests from this machine."
            : `Request failed (${response.status}).`;
    throw new LocalApiError(response.status, message);
  }
  return { status: response.status, body };
}

/** Compatibility wrapper (old src/state/local-api.ts API): token required, body only. */
export async function localFetch(
  path: string,
  init: RequestInit = {},
  token: string | null = readToken(),
  base = resolveApiBase(),
): Promise<unknown> {
  return (await apiRequest(base, path, init, { auth: "required", token })).body;
}

/** The current token, kept in sync across components in this tab. */
export function useSessionToken(): [string | null, (token: string | null) => void] {
  const [token, setToken] = useState<string | null>(() => readToken());
  useEffect(() => {
    const sync = () => setToken(readToken());
    window.addEventListener("notary-token", sync);
    return () => window.removeEventListener("notary-token", sync);
  }, []);
  const update = useCallback((next: string | null) => writeToken(next), []);
  return [token, update];
}
