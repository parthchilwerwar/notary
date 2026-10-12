/**
 * MCP client for cfo.ai (Streamable HTTP + the OAuth provider in oauth.ts). Tool calls are shaped
 * from the server's own tools/list: `org_id` is sent only when the tool declares it, and a tool the
 * server does not list is never called. Results are JSON (structuredContent, or exactly one text
 * block that parses as JSON); prose is refused rather than interpreted.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CfoNotConnectedError, type CfoOAuthProvider } from "./oauth.js";

export const NOTARY_CLIENT_INFO = { name: "notary", version: "0.0.0" } as const;

export class CfoMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfoMcpError";
  }
}

export interface ToolInfo {
  name: string;
  properties: string[];
}

export interface CfoSession {
  tools: Map<string, ToolInfo>;
  /** Call a listed tool; returns the raw result and its JSON payload. */
  call(name: string, args: Record<string, unknown>, orgId?: string | null): Promise<{ raw: unknown; json: unknown }>;
  close(): Promise<void>;
}

export interface OpenOptions {
  server: string;
  provider: CfoOAuthProvider;
  fetch?: FetchLike;
  /** Interactive sign-in: resolves with the authorization code from the loopback redirect. */
  waitForCode?: () => Promise<string>;
}

function transportFor(opts: OpenOptions): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(opts.server), { authProvider: opts.provider, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}

/** The JSON payload of a tools/call result, or a CfoMcpError. */
export function resultJson(tool: string, result: unknown): unknown {
  const r = result as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
  const texts = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "");
  if (r.isError) throw new CfoMcpError(`cfo.ai ${tool} returned an error: ${(texts.join(" ") || "no message").slice(0, 400)}`);
  if (r.structuredContent !== undefined && r.structuredContent !== null && typeof r.structuredContent === "object") return r.structuredContent;
  if (texts.length !== 1) throw new CfoMcpError(`cfo.ai ${tool} returned ${texts.length} text blocks and no structured content; Notary reads exactly one JSON block`);
  try {
    return JSON.parse(texts[0]!);
  } catch {
    throw new CfoMcpError(`cfo.ai ${tool} returned text that is not JSON (${JSON.stringify(texts[0]!.slice(0, 80))}…); Notary does not interpret prose`);
  }
}

/** Connect (signing in first when `waitForCode` is given), list tools, and return a session. */
export async function openCfoSession(opts: OpenOptions): Promise<CfoSession> {
  let client = new Client(NOTARY_CLIENT_INFO);
  let transport = transportFor(opts);
  try {
    await client.connect(transport);
  } catch (err) {
    if (!(err instanceof UnauthorizedError) && !(err instanceof CfoNotConnectedError)) throw err;
    if (!opts.waitForCode) throw new CfoNotConnectedError();
    const code = await opts.waitForCode();
    await transport.finishAuth(code);
    await client.close().catch(() => undefined);
    client = new Client(NOTARY_CLIENT_INFO);
    transport = transportFor(opts);
    await client.connect(transport);
  }
  const listed = await client.listTools();
  const tools = new Map<string, ToolInfo>(
    listed.tools.map((t) => [t.name, { name: t.name, properties: Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}) }]),
  );
  return {
    tools,
    async call(name, args, orgId) {
      const info = tools.get(name);
      if (!info) throw new CfoMcpError(`cfo.ai's MCP server does not list a ${name} tool (it lists: ${[...tools.keys()].sort().join(", ") || "none"})`);
      const withOrg = orgId && info.properties.includes("org_id") ? { org_id: orgId, ...args } : args;
      let raw: unknown;
      try {
        raw = await client.callTool({ name, arguments: withOrg });
      } catch (err) {
        if (err instanceof UnauthorizedError || err instanceof CfoNotConnectedError) throw new CfoNotConnectedError();
        throw err;
      }
      return { raw, json: resultJson(name, raw) };
    },
    close: () => client.close(),
  };
}
