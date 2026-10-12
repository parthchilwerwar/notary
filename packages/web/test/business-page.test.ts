// Business page (/app/business). Bundles here are TEST DATA built in this file; the plan is the
// synthetic core test fixture (packages/core/test/fixtures/cfo-plan.test-fixture.csv). Neither is
// a Notary result, and nothing here is written to public/.
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { finalizeBundle } from "../../core/src/bundle/hash";
import { buildEconomicsBody, finalizeEconomics, parseCfoPlanCsv, renderCfoInputsCsv } from "../../core/src/economics/index";
import type { RunBundle } from "../../core/src/schema";
import { verifyEconomicsFile } from "../src/data/economics";
import { BusinessView } from "../src/pages/business/BusinessPage";
import { cfoInputsCsv, money } from "../src/pages/business/model";
import { routeById } from "../src/routes";

const ZERO = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
function bundle(runId: string, over: Partial<Omit<RunBundle, "contentHash">>): RunBundle {
  return finalizeBundle({
    runId,
    kind: "run",
    variant: "guarded",
    mode: "live",
    sample: false,
    disclosure: ["TEST bundle built in test/business-page.test.ts — not a Notary result"],
    startedAt: "2026-10-11T10:00:00.000Z",
    status: "completed",
    seed: 1,
    queue: [],
    decisions: [],
    claims: [],
    anomalies: [],
    hypotheses: [],
    probes: [],
    beliefs: { before: [], after: [] },
    beliefEvents: [],
    guards: [],
    usageByRole: { executor: ZERO, reflector: ZERO, adversary: ZERO },
    credits: { byEndpoint: {}, total: 0, budget: 100 },
    metrics: {},
    traceLinks: {},
    cassettes: [],
    ...over,
  });
}

const naive = bundle("test-naive", {
  variant: "naive",
  metrics: { unsafe_actions_total: 5, holds: 0 },
  credits: { byEndpoint: { "crustdata.enrichCompany": 12 }, total: 12, budget: 100 },
  usageByRole: { executor: { inputTokens: 10, outputTokens: 10, usd: 0.0375, calls: 1 }, reflector: ZERO, adversary: ZERO },
});
const guarded = bundle("test-guarded", {
  startedAt: "2026-10-11T11:00:00.000Z",
  metrics: { unsafe_actions_total: 0, holds: 3 },
  usageByRole: { executor: { inputTokens: 10, outputTokens: 10, usd: 0.0125, calls: 1 }, reflector: ZERO, adversary: { inputTokens: 1, outputTokens: 1, usd: 0.05, calls: 1 } },
});

const csv = readFileSync(new URL("../../core/test/fixtures/cfo-plan.test-fixture.csv", import.meta.url), "utf8");
const plan = parseCfoPlanCsv({ text: csv, file: "cfo-plan.test-fixture.csv", importedAt: "2026-10-12T08:00:00.000Z" });
const src = (bs: RunBundle[]) => bs.map((b) => ({ bundle: b, file: `core/runs/${b.runId}/${b.runId}.json` }));
const full = finalizeEconomics(buildEconomicsBody({ bundles: src([naive, guarded]), skipped: [], certificates: null, certificatesRef: null, plan, planReason: null }));
const empty = finalizeEconomics(buildEconomicsBody({ bundles: [], skipped: [], certificates: null, certificatesRef: null, plan: null, planReason: null }));

const render = (state: Parameters<typeof BusinessView>[0]["state"]) => renderToStaticMarkup(createElement(BusinessView, { state }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("business route", () => {
  it("is a sidebar page that handles its own empty states", () => {
    const r = routeById("business")!;
    expect(r.path).toBe("/app/business");
    expect(r.nav).toBe(true);
    expect(r.ungated).toBe(true);
  });
});

describe("Business page renders from data", () => {
  it("shows the computed figures and the cfo.ai plan, each labeled with its source", () => {
    const state = verifyEconomicsFile(JSON.parse(JSON.stringify(full)));
    expect(state.status).toBe("ready");
    const html = render(state);
    const t = text(html);
    // Computed: (0.0375 + 0.0625) / 2 = 0.05 per run; 5 - 0 prevented; 3 held.
    expect(full.computed!.costPerRun.usd).toBe(0.05);
    expect(t).toContain(money(0.05));
    expect(t).toContain("Unsafe actions prevented");
    expect(full.computed!.unsafeActionsPrevented.value).toBe(5);
    expect(t).toContain("Computed from runs");
    // Plan: tiers, figures and attribution exactly as imported.
    expect(t).toContain("Modeled in cfo.ai");
    expect(html).toContain('href="https://cfo.ai"');
    expect(html).toContain('href="https://example.test/share/fixture"');
    for (const tier of plan.tiers) expect(t).toContain(tier.name);
    expect(t).toContain("Revenue vs COGS");
    expect(t).toContain("19 months");
    expect(t).toContain(plan.source.fileSha256);
    // The one combined figure: 5 prevented × 250 USD.
    expect(full.combined.incidentsPreventedValue?.value).toBe(1250);
    expect(t).toContain(money(1250));
    // The inputs sheet download carries the real rows.
    expect(html).toContain('download="cfo-inputs.csv"');
    expect(decodeURIComponent(html.match(/href="data:text\/csv;charset=utf-8,([^"]+)"/)![1]!.replace(/&amp;/g, "&"))).toBe(cfoInputsCsv(full));
  });

  it("empty states say exactly what is missing and the command to run", () => {
    const t = text(render(verifyEconomicsFile(JSON.parse(JSON.stringify(empty)))));
    expect(t).toContain("No real runs to cost yet");
    expect(t).toContain("No real run bundles yet");
    expect(t).toContain("Import your cfo.ai plan");
    expect(t).toContain("pnpm notary economics --cfo-import <file>");
    expect(t).not.toMatch(/\$\d/); // no money figure without data
    const missing = text(render({ status: "missing" }));
    expect(missing).toContain("No economics published yet");
    expect(missing).toContain("pnpm notary economics");
  });

  it("a tampered file is withheld with a visible error", () => {
    const tampered = JSON.parse(JSON.stringify(full));
    tampered.computed.costPerRun.usd = 0.01;
    const state = verifyEconomicsFile(tampered);
    expect(state.status).toBe("invalid");
    const html = render(state);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("content hash mismatch");
  });

  it("the browser's inputs sheet is byte-identical to the CLI's export/cfo-inputs.csv", () => {
    expect(cfoInputsCsv(full)).toBe(renderCfoInputsCsv(full));
    expect(cfoInputsCsv(empty)).toBe(renderCfoInputsCsv(empty));
  });

  it("the published economics.json, when present, verifies and holds no fixture run", () => {
    const url = new URL("../public/economics.json", import.meta.url);
    if (!existsSync(url)) return;
    const state = verifyEconomicsFile(JSON.parse(readFileSync(url, "utf8")));
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.file.sample).toBe(false);
    for (const b of state.file.sources.bundles) expect(b.file).not.toMatch(/fixture|demo|sample/);
  });
});
