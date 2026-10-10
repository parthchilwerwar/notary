/**
 * Security layer for the token-protected local endpoints (src/api/session.ts): per-session token,
 * constant-time check, loopback socket / Host / Origin, CORS for loopback origins only.
 */
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/api/bus.js";
import { createApp, startServer } from "../src/api/server.js";
import type { StartedServer } from "../src/api/server.js";
import {
  SESSION_TOKEN_BYTES,
  checkLocalRequest,
  createSession,
  isLoopbackAddress,
  isLoopbackHost,
  sessionBanner,
} from "../src/api/session.js";

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

describe("session token", () => {
  it("is 32 crypto-random bytes (base64url), different per session, and hidden from serialization", () => {
    const a = createSession();
    const b = createSession();
    expect(Buffer.from(a.token, "base64url")).toHaveLength(SESSION_TOKEN_BYTES);
    expect(a.token).not.toBe(b.token);
    expect(JSON.stringify(a)).not.toContain(a.token);
    expect(Object.keys(a)).not.toContain("token");
  });

  it("verifies only the exact token (wrong, prefix, empty, missing refused)", () => {
    const s = createSession();
    expect(s.verify(s.token)).toBe(true);
    expect(s.verify(`${s.token}x`)).toBe(false);
    expect(s.verify(s.token.slice(0, -1))).toBe(false);
    expect(s.verify("")).toBe(false);
    expect(s.verify(undefined)).toBe(false);
    expect(s.verify(createSession().token)).toBe(false);
  });

  it("the startup banner is the only place the token is shown", () => {
    const s = createSession();
    const lines = sessionBanner("http://127.0.0.1:8787", s.token);
    expect(lines.filter((l) => l.includes(s.token))).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/never stored/);
  });
});

describe("localhost checks", () => {
  const s = createSession();
  const ok = { remoteAddress: "127.0.0.1", host: "localhost:8787", origin: undefined, authorization: `Bearer ${s.token}` };

  it("accepts loopback socket + Host + (absent or loopback) Origin + token", () => {
    expect(checkLocalRequest(s, ok)).toEqual({ ok: true });
    expect(checkLocalRequest(s, { ...ok, origin: "http://127.0.0.1:5173", host: "127.0.0.1:8787" })).toEqual({ ok: true });
    expect(checkLocalRequest(s, { ...ok, remoteAddress: "::1", host: "[::1]:8787" })).toEqual({ ok: true });
    expect(checkLocalRequest(s, { ...ok, remoteAddress: "::ffff:127.0.0.1" })).toEqual({ ok: true });
  });

  it("refuses non-loopback remotes, Hosts (DNS rebinding) and Origins with 403", () => {
    for (const bad of [
      { ...ok, remoteAddress: "10.0.0.5" },
      { ...ok, remoteAddress: undefined },
      { ...ok, remoteAddress: "::ffff:192.168.1.2" },
      { ...ok, host: "evil.example" },
      { ...ok, host: "localhost.evil.example:8787" },
      { ...ok, host: undefined },
      { ...ok, origin: "https://evil.example" },
      { ...ok, origin: "http://localhost.evil.example" },
      { ...ok, origin: "null" },
    ]) {
      const v = checkLocalRequest(s, bad);
      expect(v.ok, JSON.stringify({ ...bad, authorization: "[token]" })).toBe(false);
      if (!v.ok) expect(v.status).toBe(403);
    }
  });

  it("refuses a missing or wrong token with 401", () => {
    for (const authorization of [undefined, "", "Bearer", `Basic ${s.token}`, `Bearer ${createSession().token}`, s.token]) {
      const v = checkLocalRequest(s, { ...ok, authorization });
      expect(v).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("classifies addresses and hosts", () => {
    expect(isLoopbackAddress("127.0.0.53")).toBe(true);
    expect(isLoopbackAddress("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("localhost:99999999")).toBe(false);
  });
});

describe("protected endpoints over createApp", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "notary-session-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const make = () => {
    const session = createSession();
    const app = createApp({ bundleDirs: [root], runsDir: null, bus: new EventBus(), session, ask: { env: {} }, approvals: { env: {} } });
    return { app, session };
  };

  it("401 without / with a wrong token, 403 from a non-loopback socket, Host or Origin", async () => {
    const { app, session } = make();
    const auth = { Authorization: `Bearer ${session.token}`, Host: "localhost:8787" };
    for (const path of ["/api/approvals"]) {
      expect((await app.request(path, { headers: { Host: "localhost:8787" } }, LOOPBACK_ENV)).status).toBe(401);
      expect((await app.request(path, { headers: { ...auth, Authorization: `Bearer ${createSession().token}` } }, LOOPBACK_ENV)).status).toBe(401);
      expect((await app.request(path, { headers: auth }, { incoming: { socket: { remoteAddress: "192.168.1.9" } } })).status).toBe(403);
      expect((await app.request(path, { headers: auth })).status).toBe(403); // no socket at all
      expect((await app.request(path, { headers: { ...auth, Host: "attacker.example" } }, LOOPBACK_ENV)).status).toBe(403);
      expect((await app.request(path, { headers: { ...auth, Origin: "https://attacker.example" } }, LOOPBACK_ENV)).status).toBe(403);
      expect((await app.request(path, { headers: auth }, LOOPBACK_ENV)).status).toBe(200);
    }
    const ask = (headers: Record<string, string>) =>
      app.request("/api/ask", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ question: "why?" }) }, LOOPBACK_ENV);
    expect((await ask({ Host: "localhost:8787" })).status).toBe(401);
    expect((await ask({ ...auth, Host: "evil.example" })).status).toBe(403);
    expect((await ask(auth)).status).toBe(200);
  });

  it("without a configured session nobody knows the token: 401", async () => {
    const app = createApp({ bundleDirs: [root], runsDir: null, bus: new EventBus() });
    const res = await app.request("/api/approvals", { headers: { Host: "localhost", Authorization: "Bearer guess" } }, LOOPBACK_ENV);
    expect(res.status).toBe(401);
  });

  it("CORS preflight allows POST + Authorization + Content-Type for loopback origins only", async () => {
    const { app } = make();
    const pre = (origin: string) =>
      app.request("/api/ask", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
      });
    const good = await pre("http://localhost:5173");
    expect(good.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(good.headers.get("Access-Control-Allow-Methods")).toMatch(/POST/);
    expect(good.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toMatch(/authorization/);
    expect(good.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toMatch(/content-type/);
    const evil = await pre("https://evil.example");
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("other writes stay refused (405) and GET endpoints need no token", async () => {
    const { app } = make();
    expect((await app.request("/api/bundles", { method: "POST" })).status).toBe(405);
    expect((await app.request("/api/bundles")).status).toBe(200);
  });
});

describe("startServer (real socket on 127.0.0.1)", () => {
  let server: StartedServer;
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "notary-session-srv-"));
    server = await startServer({ port: 0, bundleDirs: [root], runsDir: null, bus: new EventBus(), eventJournal: null });
  });
  afterAll(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string>): Promise<number> =>
    new Promise((resolve, reject) => {
      const u = new URL(server.url);
      const r = httpRequest({ host: u.hostname, port: Number(u.port), path, method: "GET", headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject);
      r.end();
    });

  it("binds loopback and serves the session's token holder only", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = new URL(server.url).port;
    expect(await get("/api/approvals", { Host: `127.0.0.1:${port}` })).toBe(401);
    expect(await get("/api/approvals", { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${server.session.token}` })).toBe(200);
    // DNS rebinding: a loopback socket but a foreign Host.
    expect(await get("/api/approvals", { Host: "rebind.attacker.example", Authorization: `Bearer ${server.session.token}` })).toBe(403);
  });

  it("source never persists the token: no file write of it in session.ts", () => {
    const src = readFileSync(new URL("../src/api/session.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/writeFile|appendFile|setSpanSink|withSpan|emitEvent|console\./);
  });
});
