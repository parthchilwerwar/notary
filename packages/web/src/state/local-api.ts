// Client for the local-only `notary serve` write endpoints (POST /api/ask, GET/POST /api/approvals).
// They need the per-session token `notary serve` prints at startup; the user pastes it once and it
// lives in sessionStorage for this tab only (never localStorage, never in a URL). The hosted site
// has no local API, so these endpoints are simply unavailable there.
import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../data";

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
  }
}

/** fetch against the local API with the session token; throws LocalApiError on non-2xx. */
export async function localFetch(path: string, init: RequestInit = {}, token = readToken()): Promise<unknown> {
  if (!token) throw new LocalApiError(401, "Paste the session token that `notary serve` printed at startup.");
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
  const type = response.headers.get("content-type") ?? "";
  const body: unknown = type.includes("json") ? await response.json() : await response.text();
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
  return body;
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
