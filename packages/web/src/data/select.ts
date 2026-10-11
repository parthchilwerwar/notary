// Mode selection. LiveSource iff the API at VITE_NOTARY_API (default http://localhost:8787, the
// `notary serve` default port) answers GET /api/health with a schema-valid HealthResponse;
// otherwise ReplaySource. No global mode banner (K4): pages say "Start the server…" where a live
// action fails, and fixture runs keep their fixture note.
//
// The hosted (production) build is ALWAYS replay and never probes anything: `notary serve`
// accepts loopback requests only (DECISIONS #115), so a hosted page could never reach it and a
// probe would only log console errors (#133). A production build meant for local use can opt in
// with VITE_NOTARY_LIVE=1 at build time. In dev, a page served from a non-loopback host only
// probes when VITE_NOTARY_API is set explicitly. VITE_NOTARY_API="" (or "/") means same origin,
// i.e. the Vite dev proxy forwarding /api to 127.0.0.1:8787.
import { HealthResponseSchema, type HealthResponse } from "../../../core/src/schema";
import { globalFetch, type FetchImpl } from "./http";
import { LiveSource, type EventSourceCtor } from "./live";
import { PublishedFiles } from "./published";
import { ReplaySource } from "./replay";
import type { DataMode, DataSource } from "./types";
import { isHostedBuild, resolveApiBase, shouldProbe, type SelectEnv } from "./env";

export { DEFAULT_API_BASE, isHostedBuild, resolveApiBase, shouldProbe, type SelectEnv } from "./env";

export const HEALTH_TIMEOUT_MS = 1500;

export type HealthProbe =
  | { ok: true; health: HealthResponse }
  /** Nothing answered (refused, timeout, non-JSON, non-2xx). Quietly replay. */
  | { ok: false; reason: "unreachable" }
  /** Something answered with JSON that is not a HealthResponse: replay, and say why. */
  | { ok: false; reason: "invalid"; error: string };

/** GET <base>/api/health, validated with HealthResponseSchema. Never throws. */
export async function probeHealth(
  base: string,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HealthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? HEALTH_TIMEOUT_MS);
  const forward = () => controller.abort();
  opts.signal?.addEventListener("abort", forward, { once: true });
  let raw: unknown;
  try {
    const response = await (opts.fetchImpl ?? globalFetch)(`${base}/api/health`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("json"))
      return { ok: false, reason: "unreachable" };
    raw = await response.json();
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", forward);
  }
  const parsed = HealthResponseSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, health: parsed.data }
    : {
        ok: false,
        reason: "invalid",
        error: `The API at ${base || "this origin"} answered /api/health with something that is not a Notary health response, so this page is replaying published files.`,
      };
}

export type Selection = {
  source: DataSource;
  mode: DataMode;
  /** Live: the probe's health response. Replay: null. */
  health: HealthResponse | null;
  /** True on the hosted build (always replay, never probed). */
  hosted: boolean;
  apiBase: string;
  /** Why live mode was refused although something answered; null otherwise. */
  error: string | null;
};

export type SelectOptions = {
  env?: SelectEnv;
  hostname?: string;
  fetchImpl?: FetchImpl;
  EventSourceImpl?: EventSourceCtor;
  published?: PublishedFiles;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** The replay selection, known synchronously (used before/without a probe). */
export function replaySelection(opts: SelectOptions = {}): Selection {
  const env = opts.env ?? (import.meta.env as unknown as SelectEnv);
  return {
    source: new ReplaySource({ published: opts.published ?? new PublishedFiles({ fetchImpl: opts.fetchImpl }) }),
    mode: "replay",
    health: null,
    hosted: isHostedBuild(env),
    apiBase: resolveApiBase(env),
    error: null,
  };
}

/** Probe (when allowed) and pick the data source. Never throws. */
export async function selectDataSource(opts: SelectOptions = {}): Promise<Selection> {
  const env = opts.env ?? (import.meta.env as unknown as SelectEnv);
  const replay = replaySelection(opts);
  if (!shouldProbe(env, "hostname" in opts ? opts.hostname : globalThis.location?.hostname)) return replay;
  const base = resolveApiBase(env);
  const probe = await probeHealth(base, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, signal: opts.signal });
  if (!probe.ok) return { ...replay, error: probe.reason === "invalid" ? probe.error : null };
  const published = opts.published ?? new PublishedFiles({ fetchImpl: opts.fetchImpl });
  return {
    source: new LiveSource({ base, fetchImpl: opts.fetchImpl, EventSourceImpl: opts.EventSourceImpl, published }),
    mode: "live",
    health: probe.health,
    hosted: false,
    apiBase: base,
    error: null,
  };
}
