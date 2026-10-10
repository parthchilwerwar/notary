// Security layer for the local API's write-capable endpoints (POST /api/ask, GET/POST /api/approvals).
//
// - A per-session token: 32 crypto-random bytes (base64url), created when `notary serve` starts and
//   printed once to the terminal. It lives only in this process's memory: never written to a file,
//   the event journal, a span or a log. Compared in constant time (sha256 digests + timingSafeEqual,
//   so the token length leaks nothing either). Sent as `Authorization: Bearer <token>`.
// - Localhost only: the socket's remote address must be loopback, the Host header must name
//   localhost / 127.0.0.1 / [::1] (any port; DNS-rebinding defence), and an Origin, when sent, must be
//   a loopback origin. A request with no socket (no remote address) is refused.
//
// Order: localhost checks first (403), then the token (401). Error bodies never echo request headers.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

export const SESSION_TOKEN_BYTES = 32;

/** Dashboard dev servers on loopback only (Vite, preview, any port). Same rule as the CORS policy. */
export const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export interface ApiSession {
  /** Constant-time check of a presented token. */
  verify(presented: string | undefined | null): boolean;
}

export interface CreatedSession extends ApiSession {
  /** The token, for the one startup line. Do not log, persist or trace it anywhere else. */
  readonly token: string;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

export function createSession(token: string = randomBytes(SESSION_TOKEN_BYTES).toString("base64url")): CreatedSession {
  if (token.length < 32) throw new RangeError("session token too short");
  const expected = digest(token);
  const session = {
    verify(presented: string | undefined | null): boolean {
      if (typeof presented !== "string" || presented.length === 0) return false;
      return timingSafeEqual(digest(presented), expected);
    },
  } as CreatedSession;
  // Non-enumerable: JSON.stringify / console.log of the session object never shows the token.
  Object.defineProperty(session, "token", { value: token, enumerable: false });
  return session;
}

/** The startup hint printed once by `notary serve`. The only place the token is ever shown. */
export function sessionBanner(baseUrl: string, token: string): string[] {
  return [
    `  session token (this run only; never stored): ${token}`,
    `  POST ${baseUrl}/api/ask  GET|POST ${baseUrl}/api/approvals  need: Authorization: Bearer <token>`,
  ];
}

export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

export function isLoopbackHost(host: string | undefined | null): boolean {
  return typeof host === "string" && LOOPBACK_HOST.test(host.trim());
}

export function isLoopbackOrigin(origin: string): boolean {
  return LOOPBACK_ORIGIN.test(origin);
}

/** Remote address of the socket (@hono/node-server bindings), undefined when there is no socket. */
export function remoteAddressOf(c: Context): string | undefined {
  const env = c.env as { server?: { incoming?: unknown }; incoming?: unknown } | undefined;
  const incoming = (env?.server?.incoming ?? env?.incoming) as { socket?: { remoteAddress?: string } } | undefined;
  return incoming?.socket?.remoteAddress;
}

export type LocalCheck = { ok: true } | { ok: false; status: 401 | 403; error: string };

/** Pure check of one request (exported for tests). */
export function checkLocalRequest(
  session: ApiSession,
  req: { remoteAddress: string | undefined; host: string | undefined; origin: string | undefined; authorization: string | undefined },
): LocalCheck {
  if (!isLoopbackAddress(req.remoteAddress)) return { ok: false, status: 403, error: "forbidden: local API accepts loopback connections only" };
  if (!isLoopbackHost(req.host)) return { ok: false, status: 403, error: "forbidden: Host must be localhost, 127.0.0.1 or [::1]" };
  if (req.origin !== undefined && !isLoopbackOrigin(req.origin)) return { ok: false, status: 403, error: "forbidden: cross-origin request from a non-loopback origin" };
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.authorization ?? "");
  if (!m || !session.verify(m[1])) return { ok: false, status: 401, error: "unauthorized: send Authorization: Bearer <session token printed by notary serve>" };
  return { ok: true };
}

/** Hono middleware: token + localhost. */
export function requireLocalSession(session: ApiSession): MiddlewareHandler {
  return async (c, next) => {
    const verdict = checkLocalRequest(session, {
      remoteAddress: remoteAddressOf(c),
      host: c.req.header("Host"),
      origin: c.req.header("Origin"),
      authorization: c.req.header("Authorization"),
    });
    if (!verdict.ok) {
      if (verdict.status === 401) c.header("WWW-Authenticate", 'Bearer realm="notary"');
      return c.json({ error: verdict.error }, verdict.status);
    }
    await next();
  };
}
