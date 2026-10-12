// GET /api/cfo/status, POST /api/cfo/sync: the cfo.ai MCP connection on a LOCAL `notary serve`
// only. Both need the per-session token AND a loopback socket, Host and Origin (session.ts), like
// the approvals desk. The hosted read-only API never mounts them (server.ts answers 404 there).
//
//   GET  -> CfoStatus (schema/cfo.ts): connected or not, workspace, token expiry, last sync. No secret.
//   POST -> runs `notary cfo sync` in this process (src/cfo/index.ts) with the saved tables/scenario
//           and returns CfoSyncResponse; economics.json and docs/BUSINESS.md are regenerated exactly
//           like `notary economics`. One sync at a time (409 while one runs).
//           Not connected -> 409 with the connect command; a rejected mapping -> 422 with the row
//           it refused; cfo.ai/MCP failure -> 502. Error bodies never carry tokens.
import type { Hono } from "hono";
import { CFO_CONNECT_COMMAND, type CfoStatus, type CfoSyncResponse } from "../schema/cfo.js";
import { CfoMappingError, CfoMcpError, CfoNotConnectedError, cfoStatus, cfoSync, type SyncOptions } from "../cfo/index.js";
import { requireLocalSession } from "./session.js";
import type { ApiSession } from "./session.js";

export interface CfoApiOptions {
  /** Test seams: where the cfo state lives, the MCP server URL, fetch, clock, economics paths. */
  sync?: Omit<SyncOptions, "tables" | "scenario" | "log">;
  status?: () => CfoStatus;
  runSync?: () => Promise<CfoSyncResponse>;
}

export function mountCfo(app: Hono, opts: CfoApiOptions & { session: ApiSession }): void {
  const guard = requireLocalSession(opts.session);
  const status = opts.status ?? (() => cfoStatus(opts.sync ?? {}));
  const runSync = opts.runSync ?? (() => cfoSync(opts.sync ?? {}));
  let running = false;

  app.get("/api/cfo/status", guard, (c) => c.json(status()));

  app.post("/api/cfo/sync", guard, async (c) => {
    if (running) return c.json({ error: "a cfo.ai sync is already running" }, 409);
    running = true;
    try {
      return c.json(await runSync());
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof CfoNotConnectedError) return c.json({ error: `${message}`, connectCommand: CFO_CONNECT_COMMAND }, 409);
      if (err instanceof CfoMappingError) return c.json({ error: `cfo.ai plan rejected, nothing written: ${message}` }, 422);
      if (err instanceof CfoMcpError) return c.json({ error: message }, 502);
      return c.json({ error: `cfo.ai sync failed: ${message.slice(0, 300)}` }, 502);
    } finally {
      running = false;
    }
  });
}
