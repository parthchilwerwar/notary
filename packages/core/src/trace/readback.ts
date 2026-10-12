/**
 * Read a trace back from neatlogs with the SDK's project key (FR-10 evidence without neatlogs-cli).
 *
 * Endpoint (docs vs reality, DECISIONS proposal): the SDK's own `neatlogs doctor --probe` (dist/cli.mjs
 * in neatlogs 1.1.26) polls `GET <NEATLOGS_ENDPOINT origin>/api/traces/v3/<traceId>` with header
 * `x-api-key: <NEATLOGS_API_KEY>`. The README documents the probe but not the route; verified against
 * the live service on Oct 12: 200 with the persisted trace (name, spanCount, llmCalls, toolCalls,
 * status, detections, spans[] with node_name / node_type / span_metadata; log() records come back as
 * node_type "log" children of the span that was active), 404 while a trace is not persisted yet.
 *
 * Returns counts only — never the payload, never the key. Never throws.
 */
export type TraceReadBack =
  | { status: "ok"; traceId: string; name: string; spanCount: number; llmCalls: number; toolCalls: number; logs: number; incidentLogs: number; traceStatus: string; detections: number }
  | { status: "not_found" | "auth_failed" | "error" | "skipped"; traceId: string; detail: string };

const TRACE_ID_RE = /^[0-9a-f]{32}$/;

export async function readBackTrace(
  traceId: string,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<TraceReadBack> {
  const env = opts.env ?? process.env;
  const key = (env.NEATLOGS_API_KEY ?? "").trim();
  if (!TRACE_ID_RE.test(traceId)) return { status: "skipped", traceId, detail: "not a 32-hex trace id" };
  if (!key) return { status: "skipped", traceId, detail: "NEATLOGS_API_KEY not set" };
  let origin: string;
  try {
    const u = new URL((env.NEATLOGS_ENDPOINT ?? "").trim() || "https://ingest.neatlogs.com");
    if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return { status: "skipped", traceId, detail: "NEATLOGS_ENDPOINT is not https" };
    origin = u.origin;
  } catch {
    return { status: "skipped", traceId, detail: "NEATLOGS_ENDPOINT is not a URL" };
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${origin}/api/traces/v3/${traceId}`, {
      headers: { "x-api-key": key },
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (res.status === 401 || res.status === 403) return { status: "auth_failed", traceId, detail: `HTTP ${res.status}: the project key may not read traces` };
    if (res.status === 404 || res.status === 202) return { status: "not_found", traceId, detail: `HTTP ${res.status}: not persisted (yet)` };
    if (!res.ok) return { status: "error", traceId, detail: `HTTP ${res.status}` };
    const j = (await res.json()) as {
      name?: unknown; spanCount?: unknown; llmCalls?: unknown; toolCalls?: unknown; status?: unknown; detections?: unknown;
      spans?: { node_type?: unknown; node_name?: unknown }[];
    };
    const spans = Array.isArray(j.spans) ? j.spans : [];
    const logs = spans.filter((s) => s.node_type === "log");
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    return {
      status: "ok",
      traceId,
      name: typeof j.name === "string" ? j.name : "",
      spanCount: n(j.spanCount) || spans.length,
      llmCalls: n(j.llmCalls),
      toolCalls: n(j.toolCalls),
      logs: logs.length,
      incidentLogs: logs.filter((s) => typeof s.node_name === "string" && s.node_name.startsWith("incident ")).length,
      traceStatus: typeof j.status === "string" ? j.status : "",
      detections: Array.isArray(j.detections) ? j.detections.length : 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { status: "error", traceId, detail: msg.split(key).join("[REDACTED]").slice(0, 200) };
  }
}
