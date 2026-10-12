/**
 * cfo.ai over MCP (src/cfo/, src/api/cfo.ts) against the in-process FAKE cfo.ai in cfo-fake.ts:
 * OAuth sign-in with a real loopback callback (tokens stored, never printed), workspace choice,
 * strict plan mapping and its rejections, the economics regeneration, the localhost + token guard on
 * the local endpoints and their absence from the hosted API. Everything is synthetic and lives in a
 * temp directory; nothing is written to packages/web/public or packages/core/config.
 */
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/bundle/hash.js";
import { createApp } from "../src/api/server.js";
import { createHostedApp } from "../src/api/hosted.js";
import { createSession } from "../src/api/session.js";
import { buildProgram } from "../src/cli.js";
import {
  CFO_PUSH_BLOCKED,
  CfoMappingError,
  CfoNotConnectedError,
  cfoConnect,
  cfoPathsIn,
  cfoPushLines,
  cfoStatus,
  cfoSync,
  extractIdNameList,
  extractTable,
  formatStatus,
  mapRows,
  readSettings,
} from "../src/cfo/index.js";
import { resultJson } from "../src/cfo/client.js";
import { verifyEconomics, parseCfoPlanCsv } from "../src/economics/index.js";
import { CfoPlanSchema, CfoStatusSchema, CfoSyncResponseSchema } from "../src/schema/index.js";
import { FAKE_MCP, datedTable, fakeCfo, timelessTable, type FakeCfo } from "./cfo-fake.js";

let dir: string;
let paths: ReturnType<typeof cfoPathsIn>;
let econ: { runsDir: string; webBundlesDir: string; certificatesReport: string; economicsJson: string; businessMd: string; cfoInputsCsv: string };
const T0 = new Date("2027-01-15T10:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notary-cfo-"));
  paths = cfoPathsIn(join(dir, "config"));
  econ = {
    runsDir: join(dir, "runs"),
    webBundlesDir: join(dir, "bundles"),
    certificatesReport: join(dir, "certificates", "report.json"),
    economicsJson: join(dir, "public", "economics.json"),
    businessMd: join(dir, "BUSINESS.md"),
    cfoInputsCsv: join(dir, "cfo-inputs.csv"),
  };
});

const tables = { "Notary Plan": datedTable, "Notary Pricing": timelessTable };

async function connect(fake: FakeCfo, extra: Parameters<typeof cfoConnect>[0] = {}) {
  const logged: string[] = [];
  const result = await cfoConnect({ paths, server: FAKE_MCP, fetch: fake.fetch, now: () => T0, onAuthorize: fake.browser, log: (l) => logged.push(l), timeoutMs: 10_000, ...extra });
  return { ...result, logged };
}

describe("notary cfo connect (fake cfo.ai)", () => {
  it("signs in with PKCE over a loopback redirect, stores the tokens user-only, picks the only workspace and prints no token", async () => {
    const fake = fakeCfo({ tables });
    const { org, logged } = await connect(fake);
    expect(org).toEqual({ id: "org_test_1", name: "Test workspace" });
    expect(fake.registrations).toBe(1);
    expect(fake.tokenGrants).toEqual(["authorization_code"]);

    const stored = readFileSync(paths.oauth, "utf8");
    expect(stored).toContain(fake.issued[0]); // the access token is stored ...
    if (process.platform !== "win32") expect(statSync(paths.oauth).mode & 0o777).toBe(0o600);
    const status = cfoStatus({ paths, server: FAKE_MCP, now: () => T0 });
    const shown = [...logged, JSON.stringify(status), ...formatStatus(status)].join("\n");
    for (const token of fake.issued) expect(shown).not.toContain(token); // ... and never shown
    expect(readFileSync(paths.settings, "utf8")).not.toMatch(/fake-(access|refresh)/);

    expect(CfoStatusSchema.parse(status)).toMatchObject({ connected: true, org: { id: "org_test_1" }, expired: false, refreshable: true, tokenExpiresAt: "2027-01-15T11:00:00.000Z" });
    expect(logged.join("\n")).toContain("authorization endpoint host: auth.cfo.test");
  });

  it("several workspaces: --org picks by id; otherwise the picker is asked; an unknown --org is refused", async () => {
    const orgs = [
      { id: "org_a", name: "Alpha" },
      { id: "org_b", name: "Beta" },
    ];
    expect((await connect(fakeCfo({ orgs }), { org: "org_b" })).org).toEqual({ id: "org_b", name: "Beta" });
    let offered: unknown;
    const picked = await connect(fakeCfo({ orgs }), { pickOrg: async (list) => ((offered = list), list[0]!) });
    expect(offered).toEqual(orgs);
    expect(picked.org?.id).toBe("org_a");
    await expect(connect(fakeCfo({ orgs }), { org: "org_zzz" })).rejects.toThrow(/no cfo.ai workspace "org_zzz"/);
  });

  it("--discover-only registers nothing and opens no browser", async () => {
    const fake = fakeCfo();
    let opened = false;
    const r = await connect(fake, { discoverOnly: true, onAuthorize: () => void (opened = true) });
    expect(r.org).toBeNull();
    expect(opened).toBe(false);
    expect(fake.registrations).toBe(0);
    expect(existsSync(paths.oauth)).toBe(false);
  });

  it("status before any connect: not connected, with the connect command", () => {
    const s = cfoStatus({ paths, server: FAKE_MCP });
    expect(s).toMatchObject({ connected: false, org: null, reason: "No cfo.ai sign-in stored.", connectCommand: "pnpm notary cfo connect", tables: ["Notary Plan"], scenario: "Main" });
  });
});

describe("notary cfo sync (fake cfo.ai)", () => {
  it("reads the tables, maps them strictly, records ids + payload sha256, and regenerates economics like `notary economics`", async () => {
    const fake = fakeCfo({ tables, scenarios: [{ id: "scn_main", name: "Main" }, { id: "scn_up", name: "Upside" }] });
    await connect(fake);
    const res = await cfoSync({ paths, server: FAKE_MCP, fetch: fake.fetch, now: () => T0, tables: ["Notary Plan", "Notary Pricing"], economics: econ });
    expect(CfoSyncResponseSchema.parse(res)).toMatchObject({ tiers: 2, series: 3, figures: 2, tables: ["Notary Plan", "Notary Pricing"] });
    // org_id is sent because the fake's tools declare it; the documented read shape is used.
    expect(fake.calls.filter((c) => c.tool === "inspect_table_blocks").map((c) => c.args)).toEqual([
      { org_id: "org_test_1", scenario: "Main", read: { target: "Notary Plan" } },
      { org_id: "org_test_1", scenario: "Main", read: { target: "Notary Pricing" } },
    ]);
    expect(fake.calls.some((c) => c.tool === "edit_table_blocks")).toBe(false); // sync never writes

    const v = verifyEconomics(JSON.parse(readFileSync(econ.economicsJson, "utf8")));
    expect(v.ok).toBe(true);
    const plan = v.ok ? v.file.plan! : null!;
    expect(plan.source).toMatchObject({
      tool: "cfo.ai",
      format: "cfo.ai-mcp/1",
      file: "cfo-last-sync.json",
      workspace: "Test workspace",
      page: "Test page",
      scenario: "Main",
      importedAt: T0.toISOString(),
      mcp: { server: FAKE_MCP, tool: "inspect_table_blocks", orgId: "org_test_1", tables: ["Notary Plan", "Notary Pricing"], scenarioId: "scn_main", pageId: "page_test_1", syncedAt: T0.toISOString() },
    });
    // The recorded sha256 is the canonical JSON of the local raw payload file.
    expect(plan.source.fileSha256).toBe(sha256Hex(canonicalJson(JSON.parse(readFileSync(paths.lastPayload, "utf8")))));
    expect(res.payloadSha256).toBe(plan.source.fileSha256);
    expect(plan.currency).toBe("USD");
    expect(plan.series.map((s) => [s.key, s.unit, s.points])).toEqual([
      ["revenue", "USD", [{ period: "2027-01", value: 100 }, { period: "2027-02", value: 150 }]],
      ["cogs", "USD", [{ period: "2027-01", value: 40 }, { period: "2027-02", value: 50 }]],
      ["cash", "USD", [{ period: "2027-01", value: 1000 }, { period: "2027-02", value: 950 }]],
    ]);
    expect(plan.tiers.map((t) => [t.key, t.name, t.price, t.currency, t.period])).toEqual([
      ["starter", "Starter", 10, "USD", "contract/month"],
      ["team", "Team", 20, "USD", "contract/month"],
    ]);
    expect(plan.figures.map((f) => [f.key, f.value, f.unit])).toEqual([
      ["runway_months", 19, "months"],
      ["cost_per_incident", 250, "USD"],
    ]);
    const md = readFileSync(econ.businessMd, "utf8");
    expect(md).toContain("Synced 2027-01-15T10:00:00.000Z from cfo.ai over MCP");
    expect(md).toContain(plan.source.fileSha256);
    expect(readSettings(paths, FAKE_MCP)).toMatchObject({ tables: ["Notary Plan", "Notary Pricing"], lastSync: { ok: true, payloadSha256: plan.source.fileSha256 } });
    for (const token of fake.issued) expect(readFileSync(paths.lastPayload, "utf8") + md + readFileSync(econ.economicsJson, "utf8")).not.toContain(token);
  });

  it("an access token cfo.ai no longer accepts is refreshed without the browser", async () => {
    const fake = fakeCfo({ tables });
    await connect(fake);
    fake.revokeAccess();
    await cfoSync({ paths, server: FAKE_MCP, fetch: fake.fetch, now: () => T0, tables: ["Notary Plan"], economics: econ });
    expect(fake.tokenGrants).toEqual(["authorization_code", "refresh_token"]);
  });

  it("scenario id stays null when inspect_scenarios offers no list action or the name is not unique", async () => {
    const fake = fakeCfo({ tables, scenarioList: false });
    await connect(fake);
    await cfoSync({ paths, server: FAKE_MCP, fetch: fake.fetch, now: () => T0, tables: ["Notary Plan"], economics: econ });
    const v = verifyEconomics(JSON.parse(readFileSync(econ.economicsJson, "utf8")));
    expect(v.ok && v.file.plan!.source.mcp!.scenarioId).toBeNull();
    expect(fake.calls.some((c) => c.tool === "inspect_scenarios")).toBe(false);
  });

  it("not connected: BLOCKED before any network call, recorded in cfo.json", async () => {
    let called = false;
    await expect(cfoSync({ paths, server: FAKE_MCP, fetch: async () => ((called = true), new Response("", { status: 500 })), economics: econ })).rejects.toBeInstanceOf(CfoNotConnectedError);
    expect(called).toBe(false);
    expect(existsSync(econ.economicsJson)).toBe(false);
    expect(readSettings(paths, FAKE_MCP).lastSync).toMatchObject({ ok: false, payloadSha256: null });
  });

  it("an ambiguous plan is rejected and nothing is written; the failure is recorded", async () => {
    const bad = { rows: [{ name: "Revenue", values: { "2027-01": 100 } }] }; // no unit
    const fake = fakeCfo({ tables: { "Notary Plan": bad } });
    await connect(fake);
    await expect(cfoSync({ paths, server: FAKE_MCP, fetch: fake.fetch, now: () => T0, economics: econ })).rejects.toThrow(/the name has no unit/);
    expect(existsSync(econ.economicsJson)).toBe(false);
    expect(readSettings(paths, FAKE_MCP).lastSync).toMatchObject({ ok: false, error: expect.stringMatching(/no unit/) });
  });

  it("a cfo.ai tool error is surfaced, not mapped", async () => {
    const fake = fakeCfo({ tables: {} });
    await connect(fake);
    await expect(cfoSync({ paths, server: FAKE_MCP, fetch: fake.fetch, now: () => T0, economics: econ })).rejects.toThrow(/inspect_table_blocks returned an error: no table named Notary Plan/);
  });
});

describe("strict mapping", () => {
  const rows = (rs: unknown[], extra: Record<string, unknown> = {}) => extractTable("T", { rows: rs, ...extra }).rows;
  it("refuses cells that are not plain numbers", () => {
    for (const cell of ["#NO_ROLLUP", "12%", "$1,200", "1,200", true, { error: "x" }])
      expect(() => rows([{ name: "Revenue (USD)", values: { "2027-01": cell } }]), JSON.stringify(cell)).toThrow(CfoMappingError);
  });
  it("refuses dimensioned rows, disagreeing names, both values and value, and unknown shapes", () => {
    expect(() => rows([{ ref: "Revenue[West]#a1", values: { "2027-01": 1 } }])).toThrow(/split by a Dimension/);
    expect(() => rows([{ name: "A (USD)", members: ["x"], value: 1 }])).toThrow(/split by a Dimension/);
    expect(() => rows([{ name: "A (USD)", label: "B (USD)", value: 1 }])).toThrow(/disagree/);
    expect(() => rows([{ name: "A (USD)", value: 1, values: { "2027-01": 1 } }])).toThrow(/both/);
    expect(() => rows([{ name: "A (USD)" }])).toThrow(/no values, cells or value/);
    expect(() => extractTable("T", { data: [] })).toThrow(/top-level keys: data/);
    expect(() => rows([{ name: "A (USD)", values: { "Jan 2027": 1 } }])).toThrow(/is not a period/);
  });
  it("aligns value arrays to period columns only when the counts match", () => {
    const cols = { columns: [{ ref: "Date#1", axis: true }, { label: "2027-01" }, { label: "2027-02" }] };
    expect(rows([{ name: "Revenue (USD)", values: [1, 2] }], cols)[0]!.points).toEqual([{ period: "2027-01", value: 1 }, { period: "2027-02", value: 2 }]);
    expect(() => rows([{ name: "Revenue (USD)", values: [1] }], cols)).toThrow(/cannot be matched/);
  });
  it("refuses names without a unit, duplicate keys, bad tier units and per-period tier prices", () => {
    const g = (name: string, value: number | null = 1, points: { period: string; value: number }[] | null = null) => ({ table: "T", name, value: points ? null : value, points });
    expect(() => mapRows([g("Revenue")])).toThrow(/no unit/);
    expect(() => mapRows([g("Gross margin (%)"), g("Gross-margin (%)")])).toThrow(/both map to figure gross_margin/);
    expect(() => mapRows([g("Tier Team price (USD)")])).toThrow(/CUR\/period/);
    expect(() => mapRows([g("Tier Team price (USD/contract/month)", null, [{ period: "2027-01", value: 1 }])])).toThrow(/single value/);
    expect(() => mapRows([])).toThrow(/no rows/);
    expect(mapRows([g("Revenue (USD)"), g("Margin (EUR)")]).currency).toBeNull(); // two currencies: not guessed
  });
  it("tool results must be JSON; prose is refused", () => {
    expect(() => resultJson("x", { content: [{ type: "text", text: "Revenue is about 1.2k" }] })).toThrow(/not JSON/);
    expect(() => resultJson("x", { content: [] })).toThrow(/0 text blocks/);
    expect(resultJson("x", { structuredContent: { a: 1 }, content: [] })).toEqual({ a: 1 });
    expect(() => extractIdNameList("list_orgs", { orgs: [{ name: "no id" }] })).toThrow(/no string id/);
  });
});

describe("schema: the plan source is additive", () => {
  it("a CSV import keeps validating and hashing as before; an MCP source needs its mcp block", () => {
    const csv = readFileSync(new URL("./fixtures/cfo-plan.test-fixture.csv", import.meta.url), "utf8");
    const plan = parseCfoPlanCsv({ text: csv, file: "cfo-plan.test-fixture.csv", importedAt: "2026-10-12T08:00:00.000Z" });
    expect("mcp" in plan.source).toBe(false);
    expect(CfoPlanSchema.safeParse({ ...plan, source: { ...plan.source, format: "cfo.ai-mcp/1" } }).success).toBe(false);
    expect(
      CfoPlanSchema.safeParse({ ...plan, source: { ...plan.source, mcp: { server: FAKE_MCP, tool: "inspect_table_blocks", orgId: "o", orgName: null, tables: ["T"], scenarioId: null, pageId: null, syncedAt: T0.toISOString() } } }).success,
    ).toBe(false);
  });
});

describe("local API: /api/cfo/* (token + localhost; never hosted)", () => {
  const session = createSession();
  const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
  const REMOTE = { incoming: { socket: { remoteAddress: "10.0.0.9" } } };
  const h = (token?: string) => ({ Host: "localhost:8787", ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  let fake: FakeCfo;
  const app = () => createApp({ bundleDirs: [], runsDir: null, session, cfo: { sync: { paths, server: FAKE_MCP, fetch: fake.fetch, now: () => T0, economics: econ } } });

  beforeEach(async () => {
    fake = fakeCfo({ tables });
  });
  afterEach(() => undefined);

  it("refuses without the session token (401) and from a non-loopback socket or Host (403)", async () => {
    expect((await app().request("/api/cfo/status", { headers: h() }, LOOPBACK)).status).toBe(401);
    expect((await app().request("/api/cfo/status", { headers: h("wrong-token-".repeat(4)) }, LOOPBACK)).status).toBe(401);
    expect((await app().request("/api/cfo/status", { headers: h(session.token) }, REMOTE)).status).toBe(403);
    expect((await app().request("/api/cfo/status", { headers: { Host: "evil.example.com", Authorization: `Bearer ${session.token}` } }, LOOPBACK)).status).toBe(403);
    expect((await app().request("/api/cfo/sync", { method: "POST", headers: h() }, LOOPBACK)).status).toBe(401);
    expect((await app().request("/api/cfo/sync", { method: "POST", headers: h(session.token) }, REMOTE)).status).toBe(403);
  });

  it("GET status (no secret) and POST sync: 409 before connect, then a real sync through the fake", async () => {
    const s0 = await app().request("/api/cfo/status", { headers: h(session.token) }, LOOPBACK);
    expect(CfoStatusSchema.parse(await s0.json())).toMatchObject({ connected: false });
    const blocked = await app().request("/api/cfo/sync", { method: "POST", headers: h(session.token) }, LOOPBACK);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ connectCommand: "pnpm notary cfo connect" });

    await connect(fake);
    const s1 = await app().request("/api/cfo/status", { headers: h(session.token) }, LOOPBACK);
    const text = await s1.text();
    for (const token of fake.issued) expect(text).not.toContain(token);
    expect(CfoStatusSchema.parse(JSON.parse(text))).toMatchObject({ connected: true, org: { id: "org_test_1" } });

    const ok = await app().request("/api/cfo/sync", { method: "POST", headers: h(session.token) }, LOOPBACK);
    expect(ok.status).toBe(200);
    expect(CfoSyncResponseSchema.parse(await ok.json())).toMatchObject({ series: 3, tables: ["Notary Plan"] });
    expect(verifyEconomics(JSON.parse(readFileSync(econ.economicsJson, "utf8"))).ok).toBe(true);
  });

  it("a rejected plan is 422 with the reason", async () => {
    fake = fakeCfo({ tables: { "Notary Plan": { rows: [{ name: "Revenue", value: 1 }] } } });
    await connect(fake);
    const res = await app().request("/api/cfo/sync", { method: "POST", headers: h(session.token) }, LOOPBACK);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/nothing written.*no unit/);
  });

  it("the hosted read-only API does not expose them, even with its bearer token", async () => {
    const TOKEN = "hosted-test-token-" + "x".repeat(40);
    const hosted = createHostedApp({ token: TOKEN, origins: [], runsDir: null, bundlesDir: join(dir, "none") });
    const r = (method: string, path: string) => new Request(`https://notary.example.com${path}`, { method, headers: { Host: "notary.example.com", Authorization: `Bearer ${TOKEN}` } });
    expect((await hosted.fetch(r("GET", "/api/cfo/status"), REMOTE)).status).toBe(404);
    expect((await hosted.fetch(r("POST", "/api/cfo/sync"), REMOTE)).status).toBe(404);
  });
});

describe("cli + push", () => {
  it("registers cfo connect, status, sync and push", () => {
    const cfo = buildProgram().commands.find((c) => c.name() === "cfo");
    expect(cfo?.commands.map((c) => c.name())).toEqual(["connect", "status", "sync", "push"]);
    expect(cfo?.commands.find((c) => c.name() === "connect")?.options.map((o) => o.long)).toEqual(["--org", "--discover-only"]);
    expect(cfo?.commands.find((c) => c.name() === "sync")?.options.map((o) => o.long)).toEqual(["--table", "--scenario"]);
  });
  it("push is BLOCKED and points at the manual CSV upload", () => {
    const lines = cfoPushLines("/x/export/cfo-inputs.csv", 7);
    expect(lines[0]).toBe(CFO_PUSH_BLOCKED);
    expect(lines.join("\n")).toMatch(/cfo-inputs\.csv \(7 real runs/);
  });
});
