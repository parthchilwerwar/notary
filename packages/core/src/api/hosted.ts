// The hosted, read-only Notary API (AWS deployment: deploy/aws/, docs/DEPLOY_AWS.md).
//
// Same app as `notary serve` (createApp) with three differences (ApiOptions.hosted):
//   - POST /api/ask and /api/chat/** require `Authorization: Bearer <NOTARY_HOSTED_TOKEN>` (a token
//     injected from AWS Secrets Manager by ECS; compared in constant time) instead of localhost + the
//     per-process session token. TLS is terminated by the load balancer.
//   - The approvals desk (GET/POST /api/approvals/**) is not mounted (404) and POST /api/runs is
//     refused (405): the hosted site is read-only (CLAUDE.md). Chat's list_approvals/get_approval
//     tools report "unavailable" there.
//   - CORS allows exactly NOTARY_ALLOWED_ORIGINS (comma-separated https origins), nothing else.
// Plus GET /ping for the load balancer's health check (no I/O; /api/health does network checks).
//
// Environment (all read once at start; values are never logged):
//   NOTARY_HOSTED_TOKEN     required, ≥ 32 characters; missing/short -> "BLOCKED: ..." and exit 3
//   PORT                    default 8080; binds 0.0.0.0 (inside the container)
//   NOTARY_RUNS_DIR         default <repo>/packages/core/runs (each subdirectory is a bundle dir)
//   NOTARY_BUNDLES_DIR      default packages/web/public/bundles
//   NOTARY_ALLOWED_ORIGINS  optional
// plus the usual model settings (NOTARY_LLM_PROVIDER, LITELLM_*, NOTARY_MODEL_*, NOTARY_MAX_USD,
// NOTARY_ASK_RPM, NEATLOGS_API_KEY), all from the task definition / Secrets Manager.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { DEFAULT_RUNS_DIR, DEFAULT_WEB_BUNDLES_DIR, createApp } from "./server.js";
import type { ApiOptions } from "./server.js";
import { createSession } from "./session.js";

type Env = Record<string, string | undefined>;

export const HOSTED_TOKEN_ENV = "NOTARY_HOSTED_TOKEN";
export const HOSTED_TOKEN_MIN_CHARS = 32;
export const DEFAULT_HOSTED_PORT = 8080;

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Bearer-token guard for the hosted ask/chat routes (constant-time; error bodies never echo headers). */
export function hostedTokenGuard(token: string): MiddlewareHandler {
  if (token.length < HOSTED_TOKEN_MIN_CHARS) throw new RangeError(`${HOSTED_TOKEN_ENV} must be at least ${HOSTED_TOKEN_MIN_CHARS} characters`);
  const expected = digest(token);
  return async (c, next) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("Authorization") ?? "");
    if (!m || !timingSafeEqual(digest(m[1]!), expected)) {
      c.header("WWW-Authenticate", 'Bearer realm="notary-hosted"');
      return c.json({ error: "unauthorized: send Authorization: Bearer <hosted token>" }, 401);
    }
    await next();
  };
}

/** Parse NOTARY_ALLOWED_ORIGINS: exact https origins only (http only for localhost). */
export function allowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(s) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/i.test(s));
}

export type HostedConfig = { ok: true; token: string; port: number; origins: string[]; runsDir: string; bundlesDir: string } | { ok: false; blocked: string };

/** Read the hosted configuration; a missing or short token is BLOCKED (never printed). */
export function hostedConfig(env: Env = process.env): HostedConfig {
  const token = (env[HOSTED_TOKEN_ENV] ?? "").trim();
  if (!token) return { ok: false, blocked: `BLOCKED: ${HOSTED_TOKEN_ENV} not set — store it in AWS Secrets Manager and map it into the task (docs/DEPLOY_AWS.md)` };
  if (token.length < HOSTED_TOKEN_MIN_CHARS) return { ok: false, blocked: `BLOCKED: ${HOSTED_TOKEN_ENV} is shorter than ${HOSTED_TOKEN_MIN_CHARS} characters — generate one with \`openssl rand -base64 48\`` };
  const rawPort = (env.PORT ?? "").trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_HOSTED_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, blocked: `BLOCKED: PORT must be 1-65535, got ${JSON.stringify(rawPort)}` };
  return {
    ok: true,
    token,
    port,
    origins: allowedOrigins(env.NOTARY_ALLOWED_ORIGINS),
    runsDir: (env.NOTARY_RUNS_DIR ?? "").trim() || DEFAULT_RUNS_DIR,
    bundlesDir: (env.NOTARY_BUNDLES_DIR ?? "").trim() || DEFAULT_WEB_BUNDLES_DIR,
  };
}

/** The hosted app: GET /ping + createApp in hosted (read-only) mode. */
export function createHostedApp(cfg: { token: string; origins: readonly string[]; runsDir: string | null; bundlesDir: string }, extra: Omit<ApiOptions, "hosted" | "session" | "runsDir" | "bundleDirs"> = {}): Hono {
  const outer = new Hono();
  outer.get("/ping", (c) => c.json({ status: "Healthy" }));
  const app = createApp({
    ...extra,
    runsDir: cfg.runsDir,
    bundleDirs: [cfg.bundlesDir],
    // A session nobody knows the token of: every local-only guard that is still mounted answers 401.
    session: createSession(),
    hosted: { guard: hostedTokenGuard(cfg.token), allowedOrigins: cfg.origins },
  });
  outer.route("/", app);
  return outer;
}
