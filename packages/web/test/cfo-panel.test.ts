// The cfo.ai connection panel on the Business page and its data functions. The plan here is the
// synthetic core test fixture (packages/core/test/fixtures/cfo-plan.test-fixture.csv) relabeled as
// an MCP sync for rendering; ids, hashes and responses are TEST DATA, not cfo.ai output.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildEconomicsBody, finalizeEconomics, parseCfoPlanCsv } from "../../core/src/economics/index";
import type { CfoPlan, CfoStatus, CfoSyncResponse } from "../../core/src/schema";
import { verifyEconomicsFile } from "../src/data/economics";
import { fetchCfoStatus, syncFromCfo } from "../src/data/cfo";
import { BusinessView } from "../src/pages/business/BusinessPage";

const csv = readFileSync(new URL("../../core/test/fixtures/cfo-plan.test-fixture.csv", import.meta.url), "utf8");
const csvPlan = parseCfoPlanCsv({ text: csv, file: "cfo-plan.test-fixture.csv", importedAt: "2026-10-12T08:00:00.000Z" });
const SHA = "a".repeat(64);
const mcpPlan: CfoPlan = {
  ...csvPlan,
  source: {
    ...csvPlan.source,
    format: "cfo.ai-mcp/1",
    file: "cfo-last-sync.json",
    fileSha256: SHA,
    importedAt: "2026-10-12T09:30:00.000Z",
    shareUrl: null,
    mcp: { server: "https://api.cfo.ai/mcp", tool: "inspect_table_blocks", orgId: "org_test_1", orgName: "Test workspace", tables: ["Notary Plan"], scenarioId: null, pageId: null, syncedAt: "2026-10-12T09:30:00.000Z" },
  },
};
const fileWith = (plan: CfoPlan | null) => finalizeEconomics(buildEconomicsBody({ bundles: [], skipped: [], certificates: null, certificatesRef: null, plan, planReason: null }));
const ready = (plan: CfoPlan | null) => verifyEconomicsFile(JSON.parse(JSON.stringify(fileWith(plan))));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const render = (props: Parameters<typeof BusinessView>[0]) => text(renderToStaticMarkup(createElement(BusinessView, props)));

describe("cfo.ai panel (replay / hosted: no API)", () => {
  it("an MCP-synced plan says when and from which workspace, with the payload hash; the plan section labels the sync", () => {
    const state = ready(mcpPlan);
    expect(state.status).toBe("ready");
    const t = render({ state });
    expect(t).toContain("cfo.ai connection");
    expect(t).toContain("Synced from cfo.ai 2026-10-12 09:30 UTC");
    expect(t).toContain("Test workspace");
    expect(t).toContain(SHA);
    expect(t).toContain("As read from cfo.ai over its MCP server");
    expect(t).toContain("Raw MCP payload (local)");
    expect(t).not.toContain("Sync from cfo.ai "); // no live button without a local server
    // The two sources stay labeled.
    expect(t).toContain("Modeled in cfo.ai");
    expect(t).toContain("Computed from runs");
  });

  it("a CSV import or no plan shows the exact connect and sync commands", () => {
    expect(render({ state: ready(csvPlan) })).toMatch(/imported from a cfo.ai export file.*pnpm notary cfo connect.*pnpm notary cfo sync/);
    expect(render({ state: ready(null) })).toMatch(/Connect cfo.ai once.*pnpm notary cfo connect/);
  });

  it("live mode without a session token asks for it (nothing is fetched during render)", () => {
    const t = render({ state: ready(null), cfo: { apiBase: "http://localhost:8787" } });
    expect(t).toMatch(/Session token \(printed once by pnpm notary serve ?\) to see the cfo.ai connection and sync/);
  });
});

describe("data/cfo.ts", () => {
  const status: CfoStatus = {
    connected: true,
    server: "https://api.cfo.ai/mcp",
    org: { id: "org_test_1", name: "Test workspace" },
    tokenExpiresAt: "2026-10-12T10:30:00.000Z",
    expired: false,
    refreshable: true,
    tables: ["Notary Plan"],
    scenario: "Main",
    lastSync: null,
    reason: null,
    connectCommand: "pnpm notary cfo connect",
  };
  const fake = (body: unknown, status = 200) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it("GET /api/cfo/status with the session token, validated", async () => {
    const { f, calls } = fake(status);
    expect(await fetchCfoStatus("http://localhost:8787", { token: "t".repeat(43), fetchImpl: f })).toEqual(status);
    expect(calls[0]!.url).toBe("http://localhost:8787/api/cfo/status");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${"t".repeat(43)}`);
    await expect(fetchCfoStatus("", { token: "t".repeat(43), fetchImpl: fake({ connected: "yes" }).f })).rejects.toThrow(/does not match the shared schema/);
    await expect(fetchCfoStatus("", { token: null, fetchImpl: f })).rejects.toThrow(/session token/);
  });

  it("POST /api/cfo/sync returns the validated result; a server refusal surfaces its error text", async () => {
    const result: CfoSyncResponse = { ok: true, syncedAt: "2026-10-12T09:30:00.000Z", payloadSha256: SHA, org: { id: "org_test_1", name: null }, tables: ["Notary Plan"], tiers: 3, series: 3, figures: 2, economicsContentHash: "b".repeat(64), lines: [] };
    const { f, calls } = fake(result);
    expect(await syncFromCfo("", { token: "t".repeat(43), fetchImpl: f })).toEqual(result);
    expect(calls[0]!.init.method).toBe("POST");
    await expect(syncFromCfo("", { token: "t".repeat(43), fetchImpl: fake({ error: "cfo.ai plan rejected, nothing written: row \"Revenue\" has no unit" }, 422).f })).rejects.toThrow(/nothing written/);
  });
});

describe("cfo.ai sync errors read as sentences", () => {
  it("a missing table names the table and what to do; other errors show cfo.ai's message, not JSON", async () => {
    const { readableSyncError } = await import("../src/pages/business/CfoPanel");
    const live = 'cfo.ai inspect_table_blocks returned an error: {"error":{"code":"not_found","message":"No table_block named \\"Notary Plan\\" was found.","transient":false},"state_changed":"no"}';
    expect(readableSyncError(live)).toBe('Your cfo.ai workspace has no "Notary Plan" table yet. Create it in cfo.ai (steps below), then press Sync from cfo.ai.');
    expect(readableSyncError('cfo.ai x returned an error: {"error":{"code":"forbidden","message":"Not allowed here."}}')).toBe("Last sync did not complete: Not allowed here.");
    expect(readableSyncError("socket hang up")).toBe("Last sync did not complete: socket hang up");
  });
});
