/**
 * An in-process FAKE cfo.ai for test/cfo.test.ts: an OAuth authorization server (RFC 9728 resource
 * metadata, RFC 8414 metadata, dynamic client registration, authorization code + PKCE S256,
 * refresh tokens) and a Streamable HTTP MCP server (the SDK's own server) behind a bearer check.
 * Reached only through the `fetch` it returns: no network. Every value here is SYNTHETIC test data,
 * not cfo.ai output and not Notary's plan. Tokens are random per test run and never written outside
 * the test's temp directory.
 */
import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export const FAKE_MCP = "https://cfo.test/mcp";
const RESOURCE_META = "https://cfo.test/.well-known/oauth-protected-resource/mcp";
const AS = "https://auth.cfo.test";

export interface FakeOptions {
  orgs?: Record<string, string>[];
  /** Table name -> the JSON the fake returns for inspect_table_blocks read (or a raw text block). */
  tables?: Record<string, unknown>;
  scenarios?: { id: string; name: string }[];
  /** Advertise a `list` action on inspect_scenarios (default true). */
  scenarioList?: boolean;
  /**
   * Scenario refs the workspace has. When set, a table read naming any other scenario gets the live
   * cfo.ai not_found error (seen Oct 12, 2026) with these refs as candidates.
   */
  scenarioRefs?: string[];
}

export interface FakeCfo {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** Plays the user's browser: follow the authorize URL and hit the loopback redirect. */
  browser: (url: URL) => Promise<void>;
  /** Every access/refresh token issued (to assert they are never printed). */
  issued: string[];
  calls: { tool: string; args: Record<string, unknown> }[];
  /** Revoke the current access token (the next MCP call gets 401; a refresh must follow). */
  revokeAccess(): void;
  registrations: number;
  tokenGrants: string[];
}

const b64url = (b: Buffer) => b.toString("base64url");
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function fakeCfo(opts: FakeOptions = {}): FakeCfo {
  // The live cfo.ai list_orgs shape (Oct 12, 2026): {name, org_id, role, slug}.
  const orgs = opts.orgs ?? [{ name: "Test workspace", org_id: "org_test_1", role: "owner", slug: "test-workspace" }];
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  let access: string | null = null;
  let refresh: string | null = null;
  const fake: FakeCfo = {
    issued: [],
    calls: [],
    registrations: 0,
    tokenGrants: [],
    revokeAccess: () => {
      access = null;
    },
    browser: async (url: URL) => {
      // The "user" approves: the fake authorization server redirects to the loopback callback.
      const res = await fake.fetch(url, { redirect: "manual" });
      const location = res.headers.get("location");
      if (!location) throw new Error(`fake authorize did not redirect (${res.status})`);
      await globalThis.fetch(location);
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? String(init.body) : "";
      if (url.href === RESOURCE_META) return json({ resource: FAKE_MCP, authorization_servers: [AS], bearer_methods_supported: ["header"] });
      if (url.origin === AS && url.pathname === "/.well-known/oauth-authorization-server")
        return json({
          issuer: AS,
          authorization_endpoint: `${AS}/oauth2/authorize`,
          token_endpoint: `${AS}/oauth2/token`,
          registration_endpoint: `${AS}/oauth2/register`,
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["email", "offline_access", "openid", "profile"],
        });
      if (url.origin === AS && url.pathname === "/oauth2/register" && method === "POST") {
        const meta = JSON.parse(body) as { redirect_uris: string[] };
        const id = `client_${randomBytes(6).toString("hex")}`;
        clients.set(id, meta.redirect_uris);
        fake.registrations++;
        return json({ ...meta, client_id: id, client_id_issued_at: 1 }, 201);
      }
      if (url.origin === AS && url.pathname === "/oauth2/authorize") {
        const q = url.searchParams;
        const client = q.get("client_id") ?? "";
        const redirect = q.get("redirect_uri") ?? "";
        if (!clients.get(client)?.includes(redirect)) return new Response("bad redirect", { status: 400 });
        if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return new Response("PKCE required", { status: 400 });
        const code = b64url(randomBytes(12));
        codes.set(code, { challenge: q.get("code_challenge")!, redirect, client });
        return new Response(null, { status: 302, headers: { location: `${redirect}?code=${code}&state=${encodeURIComponent(q.get("state") ?? "")}` } });
      }
      if (url.origin === AS && url.pathname === "/oauth2/token" && method === "POST") {
        const p = new URLSearchParams(body);
        fake.tokenGrants.push(p.get("grant_type") ?? "");
        if (p.get("grant_type") === "authorization_code") {
          const c = codes.get(p.get("code") ?? "");
          const verifier = p.get("code_verifier") ?? "";
          if (!c || c.redirect !== p.get("redirect_uri") || b64url(createHash("sha256").update(verifier).digest()) !== c.challenge)
            return json({ error: "invalid_grant" }, 400);
          codes.delete(p.get("code")!);
        } else if (p.get("grant_type") === "refresh_token") {
          if (!refresh || p.get("refresh_token") !== refresh) return json({ error: "invalid_grant" }, 400);
        } else return json({ error: "unsupported_grant_type" }, 400);
        access = `fake-access-${b64url(randomBytes(18))}`;
        refresh = `fake-refresh-${b64url(randomBytes(18))}`;
        fake.issued.push(access, refresh);
        return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: p.get("scope") ?? "" });
      }
      if (url.href === FAKE_MCP) {
        const auth = new Headers(init?.headers).get("authorization");
        if (!access || auth !== `Bearer ${access}`)
          return new Response("no bearer token", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${RESOURCE_META}"` } });
        return mcp(new Request(url, { method, headers: init?.headers, ...(body ? { body } : {}) }));
      }
      return new Response("not found", { status: 404 });
    },
  };

  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
  async function mcp(req: Request): Promise<Response> {
    const server = new McpServer({ name: "fake-cfo", version: "0.0.0" });
    server.registerTool("list_orgs", { description: "fake", inputSchema: {} }, async () => {
      fake.calls.push({ tool: "list_orgs", args: {} });
      return text({ orgs });
    });
    server.registerTool(
      "inspect_table_blocks",
      { description: "fake", inputSchema: { org_id: z.string().optional(), scenario: z.string().optional(), read: z.object({ target: z.string() }).optional() } },
      async (args) => {
        fake.calls.push({ tool: "inspect_table_blocks", args: args as Record<string, unknown> });
        const t = args.read?.target ?? "";
        if (opts.scenarioRefs && !opts.scenarioRefs.includes(String(args.scenario))) {
          return {
            ...text({
              error: {
                code: "not_found",
                message: `No available scenario named "${String(args.scenario)}" was found.`,
                transient: false,
                candidates: opts.scenarioRefs.map((ref) => ({ display_name: ref, ref, kind: "scenario", score: 0.95 })),
                hint: "inspect_scenarios lists the visible scenarios.",
              },
              state_changed: "no",
            }),
            isError: true,
          };
        }
        if (!opts.tables || !(t in opts.tables)) return { ...text(`no table named ${t}`), isError: true };
        return text(opts.tables[t]);
      },
    );
    server.registerTool(
      "inspect_scenarios",
      { description: "fake", inputSchema: (opts.scenarioList === false ? { org_id: z.string().optional() } : { org_id: z.string().optional(), list: z.object({}).optional() }) as { org_id: z.ZodOptional<z.ZodString> } },
      async (args: { org_id?: string | undefined }) => {
        fake.calls.push({ tool: "inspect_scenarios", args: args as Record<string, unknown> });
        return text({ scenarios: opts.scenarios ?? [] });
      },
    );
    server.registerTool("edit_table_blocks", { description: "fake write tool", inputSchema: {} }, async () => {
      fake.calls.push({ tool: "edit_table_blocks", args: {} });
      return text({ ok: true });
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  }
  return fake;
}

/** A SYNTHETIC "Notary Plan" table read in the shape map.ts accepts (not cfo.ai output). */
export const datedTable = {
  page: { id: "page_test_1", name: "Test page" },
  columns: [{ ref: "Date#10b", axis: true, dimension: "Date", grain: "MONTH", writable: true }],
  rows: [
    { ref: "Revenue (USD)#a4d", name: "Revenue (USD)", values: { "2027-01": 100, "2027-02": 150 } },
    { ref: "COGS (USD)#b11", name: "COGS (USD)", values: { "2027-01": 40, "2027-02": "50" } },
    { ref: "Cash (USD)#c22", name: "Cash (USD)", values: { "2027-01": 1000, "2027-02": { value: 950 } } },
  ],
};

export const timelessTable = {
  page: { id: "page_test_1", name: "Test page" },
  columns: [],
  rows: [
    { ref: "Tier Starter price (USD/contract/month)#d01", value: 10 },
    { ref: "Tier Team price (USD/contract/month)#d02", value: 20 },
    { ref: "Runway months (months)#e01", value: 19 },
    { ref: "Cost per incident (USD)#e02", value: 250 },
  ],
};
