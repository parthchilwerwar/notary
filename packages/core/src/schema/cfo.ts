// The local cfo.ai connection, as `notary cfo status` and the local API (GET /api/cfo/status,
// POST /api/cfo/sync on `notary serve`, token + localhost) report it. New file: shared with
// packages/web, so it imports only zod (and common.ts). Never carries a token, a client secret or
// a code verifier: only whether a sign-in exists, when it expires, and the chosen workspace.
import { z } from "zod";
import { Sha256HexSchema } from "./common.js";

export const CFO_CONNECT_COMMAND = "pnpm notary cfo connect" as const;
export const CFO_SYNC_COMMAND = "pnpm notary cfo sync" as const;

export const CfoOrgSchema = z.object({ id: z.string().min(1), name: z.string().nullable() }).strict();

export const CfoLastSyncSchema = z
  .object({
    at: z.iso.datetime(),
    ok: z.boolean(),
    /** sha256 of the raw MCP payload (canonical JSON); null when the sync failed before reading it. */
    payloadSha256: Sha256HexSchema.nullable(),
    tables: z.array(z.string()),
    /** Why the sync failed (a rejection names the row or field); null on success. */
    error: z.string().nullable(),
  })
  .strict();

export const CfoStatusSchema = z
  .object({
    /** A stored sign-in exists and is not known to be expired beyond refresh. */
    connected: z.boolean(),
    server: z.url(),
    org: CfoOrgSchema.nullable(),
    /** Access-token expiry as reported by cfo.ai at sign-in (expires_in); null when unknown. */
    tokenExpiresAt: z.iso.datetime().nullable(),
    expired: z.boolean().nullable(),
    /** A refresh token is stored, so an expired access token can be renewed without the browser. */
    refreshable: z.boolean(),
    /** The table blocks and scenario `notary cfo sync` reads. */
    tables: z.array(z.string().min(1)),
    scenario: z.string().min(1),
    lastSync: CfoLastSyncSchema.nullable(),
    /** Why it is not connected; null when connected. */
    reason: z.string().nullable(),
    connectCommand: z.literal(CFO_CONNECT_COMMAND),
  })
  .strict();

export const CfoSyncResponseSchema = z
  .object({
    ok: z.literal(true),
    syncedAt: z.iso.datetime(),
    payloadSha256: Sha256HexSchema,
    org: CfoOrgSchema,
    tables: z.array(z.string().min(1)).min(1),
    tiers: z.number().int().nonnegative(),
    series: z.number().int().nonnegative(),
    figures: z.number().int().nonnegative(),
    /** contentHash of the economics file the sync wrote. */
    economicsContentHash: Sha256HexSchema,
    lines: z.array(z.string()),
  })
  .strict();

export type CfoOrg = z.infer<typeof CfoOrgSchema>;
export type CfoLastSync = z.infer<typeof CfoLastSyncSchema>;
export type CfoStatus = z.infer<typeof CfoStatusSchema>;
export type CfoSyncResponse = z.infer<typeof CfoSyncResponseSchema>;
