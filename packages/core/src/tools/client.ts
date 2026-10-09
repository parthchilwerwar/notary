/** Shared plumbing for the raw tool clients. */
import { MissingCredentialError, ToolHttpError } from "./errors.js";
import type { RecordedResponse, Recorder, RequestSpec } from "./recorder.js";

/** What every client method returns: parsed (redacted) JSON plus the exchange that produced it. */
export interface ToolResult<T> {
  data: T;
  status: number;
  exchangeId: string;
}

export type QueryValue = string | number | boolean | null | undefined;

/** Join base + path + query; drops undefined/null params and sorts keys for stable hashing. */
export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (query) {
    for (const key of Object.keys(query).sort()) {
      const v = query[key];
      if (v !== undefined && v !== null) url.searchParams.set(key, String(v));
    }
  }
  return url.toString();
}

/** Read a credential lazily; blank counts as missing. */
export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new MissingCredentialError(name);
  return value;
}

/** Send through the recorder; non-2xx becomes a ToolHttpError carrying the redacted body. */
export async function send<T>(recorder: Recorder, spec: RequestSpec): Promise<{ result: ToolResult<T>; raw: RecordedResponse }> {
  const raw = await recorder.request(spec);
  if (raw.status < 200 || raw.status >= 300) {
    throw new ToolHttpError(spec.op, raw.status, raw.body, raw.exchange.id);
  }
  return { result: { data: raw.body as T, status: raw.status, exchangeId: raw.exchange.id }, raw };
}

export function encodeId(id: string): string {
  if (!id) throw new Error("Empty id");
  return encodeURIComponent(id);
}
