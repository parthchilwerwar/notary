// Build/runtime environment for mode selection (see select.ts). No I/O.

export const DEFAULT_API_BASE = "http://localhost:8787";
export type SelectEnv = {
  PROD?: boolean;
  VITE_NOTARY_API?: string;
  VITE_NOTARY_LIVE?: string;
};

const buildEnv = (): SelectEnv => import.meta.env as unknown as SelectEnv;

/** Base URL of the local API: VITE_NOTARY_API, else the serve default. "" = same origin. */
export function resolveApiBase(env: SelectEnv = buildEnv()): string {
  const set = env.VITE_NOTARY_API;
  if (set === undefined) return DEFAULT_API_BASE;
  return String(set).trim().replace(/\/+$/, "");
}

/** The hosted/production build: replay only, never probes. */
export function isHostedBuild(env: SelectEnv = buildEnv()): boolean {
  return env.PROD === true && env.VITE_NOTARY_LIVE !== "1";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Whether this page may probe the local API at all. Never on the hosted build. Otherwise only
 * from a loopback page (or a hostless context such as tests), unless VITE_NOTARY_API names the
 * API explicitly.
 */
export function shouldProbe(
  env: SelectEnv = buildEnv(),
  hostname: string | undefined = globalThis.location?.hostname,
): boolean {
  if (isHostedBuild(env)) return false;
  if (env.VITE_NOTARY_API !== undefined && env.VITE_NOTARY_API !== "") return true;
  if (!hostname) return true;
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}
