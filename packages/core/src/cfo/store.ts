/**
 * Local state of the cfo.ai MCP connection. Two gitignored files under packages/core/config/:
 *
 *   cfo-oauth.json  SECRET: the OAuth client registration (dynamic client registration result),
 *                   the access/refresh tokens and when they were saved. Written with mode 0600
 *                   (user-only; on Windows the file inherits the user profile's ACL). Never printed,
 *                   logged, traced or sent anywhere but cfo.ai's own token/MCP endpoints.
 *   cfo.json        not secret: the chosen workspace (org id + name), the tables and scenario
 *                   `notary cfo sync` reads, and the last sync's outcome.
 *   cfo-last-sync.json  the raw MCP payload of the last sync (real workspace data, local only);
 *                   its sha256 is what economics.json records.
 *
 * Every write is atomic (temp file + rename).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CfoLastSyncSchema, CfoOrgSchema } from "../schema/cfo.js";

/** cfo.ai's remote MCP server (docs.cfo.ai/integrations/mcp-server.md; Streamable HTTP, browser OAuth). */
export const CFO_MCP_URL = "https://api.cfo.ai/mcp";
export const DEFAULT_CFO_TABLES = ["Notary Plan"] as const;
export const DEFAULT_CFO_SCENARIO = "Main";

export interface CfoPaths {
  oauth: string;
  settings: string;
  lastPayload: string;
}

const CONFIG_DIR = fileURLToPath(new URL("../../config/", import.meta.url));
export const DEFAULT_CFO_PATHS: CfoPaths = {
  oauth: join(CONFIG_DIR, "cfo-oauth.json"),
  settings: join(CONFIG_DIR, "cfo.json"),
  lastPayload: join(CONFIG_DIR, "cfo-last-sync.json"),
};

/** Paths rooted in another directory (tests). */
export function cfoPathsIn(dir: string): CfoPaths {
  return { oauth: join(dir, "cfo-oauth.json"), settings: join(dir, "cfo.json"), lastPayload: join(dir, "cfo-last-sync.json") };
}

// The OAuth file mirrors the SDK's shapes loosely (passthrough): cfo.ai's authorization server
// decides the fields, Notary only needs these few.
const TokensSchema = z
  .object({ access_token: z.string().min(1), token_type: z.string(), expires_in: z.number().optional(), refresh_token: z.string().optional(), scope: z.string().optional() })
  .passthrough();
const ClientInfoSchema = z.object({ client_id: z.string().min(1), redirect_uris: z.array(z.string()).optional() }).passthrough();

export const CfoOAuthFileSchema = z
  .object({
    server: z.string(),
    client: ClientInfoSchema.nullable(),
    tokens: TokensSchema.nullable(),
    tokensSavedAt: z.iso.datetime().nullable(),
    discovery: z.unknown().optional(),
  })
  .strict();
export type CfoOAuthFile = z.infer<typeof CfoOAuthFileSchema>;

export const CfoSettingsSchema = z
  .object({
    server: z.string(),
    org: CfoOrgSchema.nullable(),
    tables: z.array(z.string().min(1)).min(1),
    scenario: z.string().min(1),
    lastSync: CfoLastSyncSchema.nullable(),
  })
  .strict();
export type CfoSettings = z.infer<typeof CfoSettingsSchema>;

function atomicWrite(path: string, text: string, secret: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, secret ? { mode: 0o600 } : {});
  renameSync(tmp, path);
  if (secret) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows: POSIX modes do not apply; the file keeps the user profile's ACL.
    }
  }
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function readOAuth(paths: CfoPaths, server: string): CfoOAuthFile {
  const parsed = CfoOAuthFileSchema.safeParse(readJson(paths.oauth));
  // A sign-in for another server is not this server's sign-in.
  if (!parsed.success || parsed.data.server !== server) return { server, client: null, tokens: null, tokensSavedAt: null };
  return parsed.data;
}

export function writeOAuth(paths: CfoPaths, file: CfoOAuthFile): void {
  atomicWrite(paths.oauth, `${JSON.stringify(CfoOAuthFileSchema.parse(file), null, 2)}\n`, true);
}

/** Forget the sign-in (tokens and client registration). */
export function clearOAuth(paths: CfoPaths): void {
  rmSync(paths.oauth, { force: true });
}

export function readSettings(paths: CfoPaths, server: string): CfoSettings {
  const parsed = CfoSettingsSchema.safeParse(readJson(paths.settings));
  if (!parsed.success || parsed.data.server !== server)
    return { server, org: null, tables: [...DEFAULT_CFO_TABLES], scenario: DEFAULT_CFO_SCENARIO, lastSync: null };
  return parsed.data;
}

export function writeSettings(paths: CfoPaths, settings: CfoSettings): void {
  atomicWrite(paths.settings, `${JSON.stringify(CfoSettingsSchema.parse(settings), null, 2)}\n`, false);
}

/** The raw payload of the last sync (local only; real workspace data). */
export function writeLastPayload(paths: CfoPaths, text: string): void {
  atomicWrite(paths.lastPayload, text, true);
}
