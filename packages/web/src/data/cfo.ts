// The cfo.ai connection on a LOCAL `notary serve` (GET /api/cfo/status, POST /api/cfo/sync). Both
// need the per-session token, like the approvals desk; the hosted site never calls them (its API
// does not mount them). Responses are validated with the shared schemas; nothing here carries a
// cfo.ai token (the server never returns one).
import { CFO_CONNECT_COMMAND, CFO_SYNC_COMMAND, CfoStatusSchema, CfoSyncResponseSchema, type CfoStatus, type CfoSyncResponse } from "../../../core/src/schema";
import { apiRequest, type ApiRequestOptions } from "./local-api";

export { CFO_CONNECT_COMMAND, CFO_SYNC_COMMAND };

const invalid = (what: string) => new Error(`The local API returned ${what} that does not match the shared schema. Data withheld.`);

export async function fetchCfoStatus(base: string, opts: Omit<ApiRequestOptions, "auth"> & { signal?: AbortSignal } = {}): Promise<CfoStatus> {
  const { signal, ...rest } = opts;
  const { body } = await apiRequest(base, "/api/cfo/status", signal ? { signal } : {}, { ...rest, auth: "required" });
  const parsed = CfoStatusSchema.safeParse(body);
  if (!parsed.success) throw invalid("a cfo.ai status");
  return parsed.data;
}

/** Runs `notary cfo sync` in the local server; the server regenerates the published economics. */
export async function syncFromCfo(base: string, opts: Omit<ApiRequestOptions, "auth"> = {}): Promise<CfoSyncResponse> {
  const { body } = await apiRequest(base, "/api/cfo/sync", { method: "POST" }, { ...opts, auth: "required" });
  const parsed = CfoSyncResponseSchema.safeParse(body);
  if (!parsed.success) throw invalid("a cfo.ai sync result");
  return parsed.data;
}
