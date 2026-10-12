/**
 * `notary cfo connect | status | sync | push`: cfo.ai's MCP server wired directly into Notary.
 *
 * cfo.ai has no REST API and no API key (checked 2026-10-12). Its one programmatic door is the
 * remote MCP server https://api.cfo.ai/mcp (Streamable HTTP) with browser OAuth. So:
 *   connect  OAuth sign-in in the user's own browser (oauth.ts), then list_orgs and pick a workspace
 *   status   connected or not, workspace, token expiry; never a token
 *   sync     inspect_table_blocks `read` of the plan table(s) -> strict mapping (map.ts) -> the
 *            economics `plan` (format cfo.ai-mcp/1, payload sha256), then the same regeneration as
 *            `notary economics` (economics.json, docs/BUSINESS.md, export/cfo-inputs.csv)
 *   push     BLOCKED: no documented MCP write of literal data rows; the CSV upload stays manual
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { canonicalJson, sha256Hex } from "../bundle/hash.js";
import { writeEconomics, type WriteEconomicsOptions } from "../economics/index.js";
import { CfoPlanSchema, type CfoPlan } from "../schema/economics.js";
import { CFO_CONNECT_COMMAND, CfoStatusSchema, type CfoOrg, type CfoStatus, type CfoSyncResponse } from "../schema/cfo.js";
import { CfoMcpError, openCfoSession, resultJson, scenarioCandidates, soleScenarioCandidate, type CfoSession } from "./client.js";
import { CfoMappingError, extractIdNameList, extractTable, mapRows, type GridRow } from "./map.js";
import { CfoNotConnectedError, CfoOAuthProvider, newState, startCallbackServer } from "./oauth.js";
import { CFO_MCP_URL, DEFAULT_CFO_PATHS, clearOAuth, readOAuth, readSettings, writeLastPayload, writeSettings, type CfoPaths } from "./store.js";

export { CfoMcpError, CfoMappingError, CfoNotConnectedError, CFO_MCP_URL, DEFAULT_CFO_PATHS };
export { extractTable, mapRows, extractIdNameList } from "./map.js";
export { cfoPathsIn, readOAuth, readSettings } from "./store.js";

export const CFO_PUSH_BLOCKED =
  "BLOCKED: cfo.ai's MCP server documents no write of literal data rows. edit_table_blocks creates and updates tables, Variables and formulas (docs.cfo.ai/formulas/agent-docs/create-and-update.md), not per-run records, so Notary does not write its costs into your workspace over MCP.";

export interface CfoContext {
  paths?: CfoPaths;
  server?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

const ctx = (c: CfoContext) => ({ paths: c.paths ?? DEFAULT_CFO_PATHS, server: c.server ?? CFO_MCP_URL, now: c.now ?? (() => new Date()) });

// ------------------------------------------------------------------------------------- status

export function cfoStatus(c: CfoContext = {}): CfoStatus {
  const { paths, server, now } = ctx(c);
  const oauth = readOAuth(paths, server);
  const settings = readSettings(paths, server);
  const t = oauth.tokens;
  const expiresAt = t?.expires_in !== undefined && oauth.tokensSavedAt ? new Date(Date.parse(oauth.tokensSavedAt) + t.expires_in * 1000).toISOString() : null;
  const expired = expiresAt === null ? null : Date.parse(expiresAt) <= now().getTime();
  const refreshable = Boolean(t?.refresh_token);
  const connected = Boolean(t) && settings.org !== null && !(expired === true && !refreshable);
  const reason = connected
    ? null
    : !t
      ? "No cfo.ai sign-in stored."
      : expired && !refreshable
        ? "The cfo.ai sign-in expired and cannot be refreshed."
        : "Signed in, but no cfo.ai workspace is chosen yet.";
  return CfoStatusSchema.parse({
    connected,
    server,
    org: settings.org,
    tokenExpiresAt: expiresAt,
    expired,
    refreshable,
    tables: settings.tables,
    scenario: settings.scenario,
    lastSync: settings.lastSync,
    reason,
    connectCommand: CFO_CONNECT_COMMAND,
  });
}

export function formatStatus(s: CfoStatus): string[] {
  const lines = [`cfo.ai MCP server: ${s.server}`];
  if (!s.connected) lines.push(`not connected: ${s.reason}`, `  connect with: ${s.connectCommand}`);
  else lines.push(`connected: workspace ${s.org!.name ? `"${s.org!.name}" ` : ""}(${s.org!.id})`);
  if (s.tokenExpiresAt) lines.push(`  access token ${s.expired ? "expired" : "expires"} ${s.tokenExpiresAt}${s.refreshable ? " (refreshable without the browser)" : ""}`);
  lines.push(`  sync reads: table${s.tables.length === 1 ? "" : "s"} ${s.tables.map((t) => `"${t}"`).join(", ")}, scenario "${s.scenario}"`);
  if (s.lastSync)
    lines.push(
      s.lastSync.ok
        ? `  last sync: ${s.lastSync.at} ok (payload sha256 ${s.lastSync.payloadSha256!.slice(0, 12)})`
        : `  last sync: ${s.lastSync.at} FAILED — ${s.lastSync.error}`,
    );
  return lines;
}

// ----------------------------------------------------------------------------------- discover

export interface Discovery {
  resource: string | null;
  authorizationServer: string;
  authorizationEndpoint: string | null;
  registration: boolean;
  pkceS256: boolean;
  publicClients: boolean;
  refreshTokens: boolean;
}

/** RFC 9728 + RFC 8414 discovery only: no registration, no browser, no secrets. */
export async function discoverCfo(c: CfoContext = {}): Promise<Discovery> {
  const { server } = ctx(c);
  const info = await discoverOAuthServerInfo(server, c.fetch ? { fetchFn: c.fetch } : {});
  const m = info.authorizationServerMetadata;
  return {
    resource: info.resourceMetadata?.resource ?? null,
    authorizationServer: info.authorizationServerUrl,
    authorizationEndpoint: m?.authorization_endpoint ?? null,
    registration: Boolean(m?.registration_endpoint),
    pkceS256: (m?.code_challenge_methods_supported ?? []).includes("S256"),
    publicClients: (m?.token_endpoint_auth_methods_supported ?? []).includes("none"),
    refreshTokens: (m?.grant_types_supported ?? []).includes("refresh_token"),
  };
}

export function formatDiscovery(d: Discovery): string[] {
  const host = (u: string | null) => (u ? new URL(u).host : "not advertised");
  return [
    `protected resource: ${d.resource ?? "not advertised"}`,
    `authorization server: ${host(d.authorizationServer)}`,
    `authorization endpoint host: ${host(d.authorizationEndpoint)}`,
    `dynamic client registration: ${d.registration ? "yes" : "no"} · PKCE S256: ${d.pkceS256 ? "yes" : "no"} · public clients: ${d.publicClients ? "yes" : "no"} · refresh tokens: ${d.refreshTokens ? "yes" : "no"}`,
  ];
}

// ------------------------------------------------------------------------------------ connect

/** Open a URL in the user's default browser (never through a shell, so `&` in the URL is safe). */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}

export interface ConnectOptions extends CfoContext {
  org?: string;
  /** Stop after OAuth discovery (prints the authorization endpoint host; no registration, no browser). */
  discoverOnly?: boolean;
  /** How to show the authorize URL (default: open the browser). */
  onAuthorize?: (url: URL) => void | Promise<void>;
  /** Choose among several workspaces (default: a numbered prompt on a TTY, else an error). */
  pickOrg?: (orgs: CfoOrg[]) => Promise<CfoOrg>;
  timeoutMs?: number;
  log?: (line: string) => void;
}

async function promptOrg(orgs: CfoOrg[]): Promise<CfoOrg> {
  if (!process.stdin.isTTY) throw new Error(`cfo.ai lists ${orgs.length} workspaces; pass --org <id>: ${orgs.map((o) => `${o.id}${o.name ? ` (${o.name})` : ""}`).join(", ")}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    orgs.forEach((o, i) => console.log(`  ${i + 1}. ${o.name ?? o.id} (${o.id})`));
    const answer = (await rl.question(`Workspace for Notary [1-${orgs.length}]: `)).trim();
    const n = Number(answer);
    const pick = Number.isInteger(n) && n >= 1 && n <= orgs.length ? orgs[n - 1] : orgs.find((o) => o.id === answer);
    if (!pick) throw new Error(`no workspace ${JSON.stringify(answer)}`);
    return pick;
  } finally {
    rl.close();
  }
}

export async function listOrgs(session: CfoSession): Promise<CfoOrg[]> {
  return extractIdNameList("list_orgs", (await session.call("list_orgs", {})).json);
}

export async function cfoConnect(opts: ConnectOptions = {}): Promise<{ lines: string[]; org: CfoOrg | null }> {
  const { paths, server, now } = ctx(opts);
  const log = opts.log ?? (() => undefined);
  const lines: string[] = [];
  const say = (l: string) => (lines.push(l), log(l));
  const d = await discoverCfo(opts);
  for (const l of formatDiscovery(d)) say(l);
  if (!d.authorizationEndpoint) throw new Error("cfo.ai advertises no OAuth authorization endpoint; connect through Claude Code instead (claude mcp add --transport http cfoai https://api.cfo.ai/mcp, then /mcp → Authenticate)");
  if (!d.registration) throw new Error("cfo.ai's authorization server offers no dynamic client registration, so a CLI cannot register itself; connect through Claude Code instead (claude mcp add --transport http cfoai https://api.cfo.ai/mcp)");
  if (opts.discoverOnly) {
    say("discovery only: stopped before client registration and the browser sign-in");
    return { lines, org: null };
  }

  // A connect is always a fresh sign-in: forget any earlier tokens and client registration.
  clearOAuth(paths);
  const state = newState();
  const callback = await startCallbackServer({ state, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  try {
    const provider = new CfoOAuthProvider({
      paths,
      server,
      now,
      interactive: {
        redirectUrl: callback.redirectUrl,
        state,
        onAuthorize:
          opts.onAuthorize ??
          ((url) => {
            say(`opening cfo.ai sign-in in your browser (listening on ${callback.redirectUrl})`);
            say(`if it does not open, visit: ${url.href}`);
            openBrowser(url.href);
          }),
      },
    });
    const session = await openCfoSession({ server, provider, ...(opts.fetch ? { fetch: opts.fetch } : {}), waitForCode: () => callback.code });
    try {
      say(`signed in; cfo.ai lists ${session.tools.size} MCP tools`);
      const orgs = await listOrgs(session);
      if (!orgs.length) throw new Error("cfo.ai lists no workspace for this account");
      let org: CfoOrg | undefined;
      if (opts.org) {
        org = orgs.find((o) => o.id === opts.org) ?? orgs.find((o) => o.name === opts.org);
        if (!org) throw new Error(`no cfo.ai workspace ${JSON.stringify(opts.org)} (have: ${orgs.map((o) => `${o.id}${o.name ? ` (${o.name})` : ""}`).join(", ")})`);
      } else if (orgs.length === 1) org = orgs[0]!;
      else org = await (opts.pickOrg ?? promptOrg)(orgs);
      const settings = readSettings(paths, server);
      writeSettings(paths, { ...settings, org: { id: org.id, name: org.name } });
      say(`workspace: ${org.name ? `"${org.name}" ` : ""}(${org.id}); saved to ${paths.settings}`);
      say("next: pnpm notary cfo sync");
      return { lines, org };
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    await callback.close();
  }
}

// --------------------------------------------------------------------------------------- sync

export interface SyncOptions extends CfoContext {
  tables?: string[];
  scenario?: string;
  /** Where economics.json / BUSINESS.md / cfo-inputs.csv go (default: the `notary economics` paths). */
  economics?: Omit<WriteEconomicsOptions, "plan" | "cfoImport" | "now">;
  log?: (line: string) => void;
}

/** One table read (the request shape documented by cfo.ai). */
export const tableReadArgs = (table: string, scenario: string) => ({ scenario, read: { target: table } });

/** Read, map and publish the plan. Throws CfoNotConnectedError / CfoMcpError / CfoMappingError; the failure is recorded in cfo.json. */
export async function cfoSync(opts: SyncOptions = {}): Promise<CfoSyncResponse> {
  const { paths, server, now } = ctx(opts);
  const settings = readSettings(paths, server);
  const tables = opts.tables?.length ? [...new Set(opts.tables.map((t) => t.trim()).filter(Boolean))] : settings.tables;
  const explicitScenario = !!opts.scenario?.trim();
  let scenario = opts.scenario?.trim() || settings.scenario;
  const at = now().toISOString();
  const record = (ok: boolean, payloadSha256: string | null, error: string | null) =>
    writeSettings(paths, { ...readSettings(paths, server), tables, scenario, lastSync: { at, ok, payloadSha256, tables, error } });
  if (!settings.org || !readOAuth(paths, server).tokens) {
    const err = new CfoNotConnectedError();
    record(false, null, err.message);
    throw err;
  }
  const org = settings.org;
  let payloadSha256: string | null = null;
  try {
    const provider = new CfoOAuthProvider({ paths, server, now });
    const session = await openCfoSession({ server, provider, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    const reads: { table: string; args: unknown; result: unknown }[] = [];
    let scenarios: { args: unknown; result: unknown; error: string | null } | null = null;
    try {
      for (const table of tables) {
        let args = tableReadArgs(table, scenario);
        let raw: unknown;
        try {
          ({ raw } = await session.call("inspect_table_blocks", args, org.id));
        } catch (e) {
          // The scenario name was not found. Without --scenario, take cfo.ai's own suggestion only
          // when it offers exactly one scenario (it is printed, saved and recorded in the plan source);
          // with --scenario, never substitute: show what cfo.ai suggested instead.
          const sole = reads.length === 0 ? soleScenarioCandidate(e) : null;
          if (sole && !explicitScenario) {
            opts.log?.(`cfo.ai has no scenario "${scenario}"; using its only suggestion "${sole.ref}" (pass --scenario to choose another)`);
            scenario = sole.ref;
            args = tableReadArgs(table, scenario);
            ({ raw } = await session.call("inspect_table_blocks", args, org.id));
          } else {
            const names = scenarioCandidates(e);
            if (names.length) throw new CfoMcpError(`${(e as Error).message}\nRe-run with one of cfo.ai's scenarios: ${names.map((n) => `--scenario "${n}"`).join(" or ")}`, (e as CfoMcpError).details);
            throw e;
          }
        }
        reads.push({ table, args, result: raw });
      }
      // Scenario id: only when the server's own schema offers a `list` action, and only an exact,
      // unique name match is recorded; anything else stays null.
      const scen = session.tools.get("inspect_scenarios");
      if (scen?.properties.includes("list")) {
        try {
          const { raw } = await session.call("inspect_scenarios", { list: {} }, org.id);
          scenarios = { args: { list: {} }, result: raw, error: null };
        } catch (e) {
          if (e instanceof CfoNotConnectedError) throw e;
          scenarios = { args: { list: {} }, result: null, error: (e as Error).message.slice(0, 200) };
        }
      }
    } finally {
      await session.close().catch(() => undefined);
    }

    const payload = { server, orgId: org.id, scenario, syncedAt: at, reads, scenarios };
    payloadSha256 = sha256Hex(canonicalJson(payload));
    writeLastPayload(paths, `${JSON.stringify(payload, null, 2)}\n`);

    const rows: GridRow[] = [];
    const pages = new Map<string, { id: string | null; name: string | null }>();
    for (const r of reads) {
      const { rows: tableRows, meta } = extractTable(r.table, resultJson("inspect_table_blocks", r.result));
      rows.push(...tableRows);
      if (meta.page) pages.set(`${meta.page.id}|${meta.page.name}`, meta.page);
    }
    const mapped = mapRows(rows);
    const page = pages.size === 1 ? [...pages.values()][0]! : null;
    let scenarioId: string | null = null;
    if (scenarios?.result) {
      try {
        const matches = extractIdNameList("inspect_scenarios", resultJson("inspect_scenarios", scenarios.result)).filter((s) => s.name === scenario);
        scenarioId = matches.length === 1 ? matches[0]!.id : null;
      } catch {
        scenarioId = null;
      }
    }

    const plan: CfoPlan = CfoPlanSchema.parse({
      source: {
        tool: "cfo.ai",
        format: "cfo.ai-mcp/1",
        file: paths.lastPayload.split(/[\\/]/).pop()!,
        fileSha256: payloadSha256,
        importedAt: at,
        workspace: org.name ?? org.id,
        page: page?.name ?? null,
        scenario,
        exportedAt: null,
        shareUrl: null,
        mcp: { server, tool: "inspect_table_blocks", orgId: org.id, orgName: org.name, tables, scenarioId, pageId: page?.id ?? null, syncedAt: at },
      },
      ...mapped,
    });
    const written = writeEconomics({ ...(opts.economics ?? {}), plan, now });
    record(true, payloadSha256, null);
    const lines = [
      `read ${tables.length} table${tables.length === 1 ? "" : "s"} from cfo.ai workspace ${org.name ? `"${org.name}" ` : ""}(${org.id}), scenario "${scenario}"${scenarioId ? ` (${scenarioId})` : ""}`,
      `raw MCP payload: ${paths.lastPayload} (sha256 ${payloadSha256})`,
      ...written.lines,
    ];
    for (const l of lines) opts.log?.(l);
    return {
      ok: true,
      syncedAt: at,
      payloadSha256,
      org,
      tables,
      tiers: plan.tiers.length,
      series: plan.series.length,
      figures: plan.figures.length,
      economicsContentHash: written.file.contentHash,
      lines,
    };
  } catch (err) {
    record(false, payloadSha256, (err as Error).message.slice(0, 500));
    throw err;
  }
}

// --------------------------------------------------------------------------------------- push

export function cfoPushLines(inputsCsv: string, rows: number): string[] {
  return [
    CFO_PUSH_BLOCKED,
    `Upload the inputs sheet by hand instead: ${inputsCsv} (${rows} real run${rows === 1 ? "" : "s"}; regenerate it with pnpm notary economics).`,
    "In cfo.ai: Connections → Add → Integrations → Upload, choose cfo-inputs.csv (or attach it to an Ari message and pick \"Data source\").",
  ];
}
