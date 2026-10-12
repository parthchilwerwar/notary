// `notary economics`. Every bundle here is TEST DATA built in this file with finalizeBundle and
// written to temp dirs; the cfo.ai plan is test/fixtures/cfo-plan.test-fixture.csv (synthetic,
// clearly marked, never published). None of it is a Notary result.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildSampleBundle, finalizeBundle } from "../src/bundle/index.js";
import { dodoContract } from "../src/contracts/index.js";
import {
  CfoImportError,
  computeEconomics,
  economicsHash,
  finalizeEconomics,
  buildEconomicsBody,
  parseCfoPlanCsv,
  parseCsv,
  verifyEconomics,
  writeEconomics,
} from "../src/economics/index.js";
import { EconomicsFileSchema } from "../src/schema/economics.js";
import type { Belief, RunBundle } from "../src/schema/index.js";

const ZERO = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
const TEST = "TEST bundle built in test/economics.test.ts — not a Notary result";
const FIXTURE_CSV = fileURLToPath(new URL("./fixtures/cfo-plan.test-fixture.csv", import.meta.url));

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "notary-economics-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Over = Partial<Omit<RunBundle, "contentHash">>;
function testBundle(runId: string, over: Over): RunBundle {
  return finalizeBundle({
    runId,
    kind: "run",
    variant: "guarded",
    mode: "live",
    sample: false,
    disclosure: [TEST],
    startedAt: "2026-10-11T10:00:00.000Z",
    status: "completed",
    seed: 7,
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

const claim = dodoContract[0]!.claim;
const belief: Belief = {
  id: `belief-${claim.id}`,
  claimId: claim.id,
  tool: "dodo",
  class: "silent_truncation",
  statement: "test statement",
  alpha: 1,
  beta: 4,
  confidence: 0.0625,
  status: "notarized",
  evidence: [],
  updatedAt: "2026-10-11T09:00:00.000Z",
};

function world() {
  const naive = testBundle("test-naive", {
    variant: "naive",
    startedAt: "2026-10-11T10:00:00.000Z",
    metrics: { unsafe_actions_total: 3, holds: 0 },
    credits: { byEndpoint: { "crustdata.enrichCompany": 20 }, total: 20, budget: 100 },
    usageByRole: { executor: { inputTokens: 100, outputTokens: 50, usd: 0.25, calls: 2 }, reflector: ZERO, adversary: ZERO },
  });
  const guarded = testBundle("test-guarded", {
    startedAt: "2026-10-11T11:00:00.000Z",
    metrics: { unsafe_actions_total: 0, holds: 4 },
    credits: { byEndpoint: { "crustdata.enrichCompany": 10 }, total: 10, budget: 100 },
    usageByRole: { executor: { inputTokens: 10, outputTokens: 5, usd: 0.5, calls: 1 }, reflector: { inputTokens: 1, outputTokens: 1, usd: 0.25, calls: 1 }, adversary: ZERO },
  });
  const notarize = testBundle("notarize-dodo-test", {
    kind: "notarize",
    variant: "notarize",
    tool: "dodo",
    startedAt: "2026-10-11T09:00:00.000Z",
    beliefs: { before: [], after: [belief] },
    usageByRole: { executor: ZERO, reflector: { inputTokens: 1, outputTokens: 1, usd: 1, calls: 1 }, adversary: { inputTokens: 1, outputTokens: 1, usd: 1, calls: 1 } },
  });
  const replay = testBundle("test-guarded-replay", {
    mode: "replay",
    replayOf: "test-guarded",
    startedAt: "2026-10-11T12:00:00.000Z",
    metrics: { unsafe_actions_total: 0, holds: 4 },
    usageByRole: { executor: { inputTokens: 10, outputTokens: 5, usd: 9, calls: 1 }, reflector: ZERO, adversary: ZERO },
  });
  return { naive, guarded, notarize, replay };
}

function put(runsDir: string, b: unknown, runId: string): void {
  mkdirSync(join(runsDir, runId), { recursive: true });
  writeFileSync(join(runsDir, runId, `${runId}.json`), JSON.stringify(b, null, 2));
}

function paths(root: string) {
  return {
    runsDir: join(root, "runs"),
    webBundlesDir: join(root, "web", "bundles"),
    certificatesReport: join(root, "web", "certificates", "report.json"),
    economicsJson: join(root, "web", "economics.json"),
    businessMd: join(root, "docs", "BUSINESS.md"),
    cfoInputsCsv: join(root, "export", "cfo-inputs.csv"),
  };
}

const NOW = () => new Date("2026-10-12T08:00:00.000Z");

describe("economics schema", () => {
  it("round-trips a finalized file and detects tampering", () => {
    const { naive, guarded } = world();
    const body = buildEconomicsBody({
      bundles: [naive, guarded].map((b) => ({ bundle: b, file: `core/runs/${b.runId}/${b.runId}.json` })),
      skipped: [],
      certificates: null,
      certificatesRef: null,
      plan: null,
      planReason: null,
    });
    const file = finalizeEconomics(body);
    const again = EconomicsFileSchema.parse(JSON.parse(JSON.stringify(file)));
    expect(again).toEqual(file);
    expect(economicsHash(again)).toBe(file.contentHash);
    expect(verifyEconomics(again).ok).toBe(true);
    const tampered = structuredClone(file);
    tampered.computed!.totals.modelUsd += 1;
    const v = verifyEconomics(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/hash mismatch/);
    // A section is either present or says why not.
    expect(EconomicsFileSchema.safeParse({ ...file, planReason: null }).success).toBe(false);
    expect(EconomicsFileSchema.safeParse({ ...file, sample: true }).success).toBe(false);
  });
});

describe("computeEconomics", () => {
  it("computes every figure from the bundles, live only for costs", () => {
    const { naive, guarded, notarize, replay } = world();
    const { computed, computedReason } = computeEconomics({ bundles: [replay, guarded, notarize, naive], certificates: null });
    expect(computedReason).toBeNull();
    const c = computed!;
    expect(c.runs.map((r) => r.runId)).toEqual(["notarize-dodo-test", "test-naive", "test-guarded", "test-guarded-replay"]);
    expect(c.totals).toEqual({ runs: 4, liveRuns: 3, replayRuns: 1, modelUsd: 3, credits: 30, tokens: 100 + 50 + 10 + 5 + 1 + 1 + 1 + 1 + 1 + 1 });
    expect(c.usdByRole).toEqual({ executor: 0.75, reflector: 1.25, adversary: 1 });
    expect(c.creditsByEndpoint).toEqual({ "crustdata.enrichCompany": 30 });
    expect(c.costPerRun.usd).toBe(1);
    expect(c.costPerRun.credits).toBe(10);
    expect(c.pairs).toEqual([{ seed: 7, naiveRunId: "test-naive", guardedRunId: "test-guarded", naiveUnsafe: 3, guardedUnsafe: 0, prevented: 3, held: 4 }]);
    expect(c.unsafeActionsPrevented.value).toBe(3);
    expect(c.heldActions.value).toBe(4);
    expect(c.tools).toEqual([{ tool: "dodo", runs: 1, modelUsd: 2, credits: 0, notarizedBeliefs: 1, certified: null, costPerCertificateUsd: null }]);
    expect(c.costPerNotarizedBelief.usd).toBe(2);
    expect(c.costPerCertificate.usd).toBeNull();
    expect(c.costPerCertificate.reason).toMatch(/export --certificates/);
  });

  it("is deterministic: same input, identical JSON (order of input does not matter)", () => {
    const { naive, guarded, notarize, replay } = world();
    const a = finalizeEconomics(buildEconomicsBody({ bundles: [naive, guarded, notarize, replay].map((b) => ({ bundle: b, file: b.runId })), skipped: [], certificates: null, certificatesRef: null, plan: null, planReason: null }));
    const b = finalizeEconomics(buildEconomicsBody({ bundles: [naive, guarded, notarize, replay].map((b) => ({ bundle: b, file: b.runId })), skipped: [], certificates: null, certificatesRef: null, plan: null, planReason: null }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const reordered = computeEconomics({ bundles: [replay, notarize, guarded, naive], certificates: null });
    expect(JSON.stringify(reordered.computed)).toBe(JSON.stringify(a.computed));
  });

  it("cost per certificate only from a certificates report that counted the newest notarize bundle", () => {
    const { notarize } = world();
    const src = { runId: notarize.runId, contentHash: notarize.contentHash, kind: notarize.kind, mode: notarize.mode, startedAt: notarize.startedAt, sample: false };
    const counts = (certified: number) => ({ claimsTotal: 2, certified, matchesDocs: 0, contradictsDocs: 0, unproven: 2 - certified, revoked: 0 });
    const report = (sourceBundles: (typeof src)[]) => ({
      generatedBy: "test",
      sample: false,
      disclosure: [],
      header: "TEST report",
      sourceBundles,
      tools: [{ tool: "dodo" as const, header: "test", counts: counts(2), file: "dodo.json" }],
      overall: counts(2),
      toolFileHashes: {},
    });
    const fresh = computeEconomics({ bundles: [notarize], certificates: report([src]) }).computed!;
    expect(fresh.costPerCertificate.usd).toBe(1); // 2 USD of notarize spend / 2 certified
    expect(fresh.tools[0]!.costPerCertificateUsd).toBe(1);
    const stale = computeEconomics({ bundles: [notarize], certificates: report([]) }).computed!;
    expect(stale.costPerCertificate.usd).toBeNull();
    expect(stale.costPerCertificate.reason).toMatch(/predates notarize-dodo-test/);
  });

  it("zero real bundles: computed is null with a reason, never zeros", () => {
    const { computed, computedReason } = computeEconomics({ bundles: [], certificates: null });
    expect(computed).toBeNull();
    expect(computedReason).toMatch(/No real run bundles/);
  });

  it("refuses sample bundles outright", () => {
    expect(() => computeEconomics({ bundles: [buildSampleBundle(42)], certificates: null })).toThrow(/sample/);
  });
});

describe("cfo.ai import (notary-cfo-plan-csv/1)", () => {
  const text = readFileSync(FIXTURE_CSV, "utf8");
  it("parses the synthetic test export exactly as written", () => {
    const plan = parseCfoPlanCsv({ text, file: "C:/somewhere/cfo-plan.test-fixture.csv", importedAt: "2026-10-12T08:00:00.000Z" });
    expect(plan.source).toMatchObject({ tool: "cfo.ai", format: "notary-cfo-plan-csv/1", file: "cfo-plan.test-fixture.csv", workspace: "Test workspace", page: "Test page", scenario: "Main", shareUrl: "https://example.test/share/fixture" });
    expect(plan.currency).toBe("USD");
    expect(plan.tiers.map((t) => [t.key, t.name, t.price, t.currency, t.period])).toEqual([
      ["starter", "Starter", 10, "USD", "contract/month"],
      ["team", "Team", 20, "USD", "contract/month"],
      ["scale", "Scale", 30, "USD", "contract/month"],
    ]);
    expect(plan.tiers[0]!.description).toBe("Test tier, with a comma");
    expect(plan.tiers[1]!.features).toEqual(["Feature A", 'Feature "B"']);
    expect(plan.series.map((s) => [s.key, s.points.map((p) => p.value)])).toEqual([
      ["revenue", [100, 150]],
      ["cogs", [40, 50]],
      ["cash", [1000, 950]],
    ]);
    expect(plan.figures.find((f) => f.key === "runway_months")?.value).toBe(19);
  });

  it("rejects anything it would have to guess at", () => {
    const head = "section,key,label,period,value,unit,detail\n";
    const bad = (body: string) => () => parseCfoPlanCsv({ text: head + body, file: "x.csv", importedAt: "2026-10-12T08:00:00.000Z" });
    expect(() => parseCfoPlanCsv({ text: "a,b\n1,2\n", file: "x.csv", importedAt: "2026-10-12T08:00:00.000Z" })).toThrow(CfoImportError);
    expect(bad("figure,runway,Runway,,\"1,200\",months,\n")).toThrow(/plain number/);
    expect(bad("figure,runway,Runway,,$12,months,\n")).toThrow(/plain number/);
    expect(bad("tier,team,Team,,49,per month,\n")).toThrow(/CUR\/period/);
    expect(bad("series,revenue,Revenue,,10,USD,\n")).toThrow(/no period/);
    expect(bad("series,revenue,Revenue,2027-01,10,USD,\nseries,revenue,Revenue,2027-01,11,USD,\n")).toThrow(/repeats period/);
    expect(bad("tier_feature,ghost,Feature,,,,\nfigure,a,A,,1,x,\n")).toThrow(/no tier row/);
    expect(bad("bogus,a,A,,1,x,\n")).toThrow(/unknown section/);
    expect(bad("meta,share_url,,,http://insecure.test,,\nfigure,a,A,,1,x,\n")).toThrow(/https/);
    expect(bad("meta,workspace,,,w,,\n")).toThrow(/no tier, series or figure/);
  });

  it("parses RFC 4180 quoting and CRLF", () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3')).toEqual([["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
  });
});

describe("writeEconomics", () => {
  it("uses real bundles only, never fixtures, samples or drift; merges the plan; writes BUSINESS.md", () => {
    const root = tempDir();
    const p = paths(root);
    const { naive, guarded, notarize } = world();
    put(p.runsDir, naive, naive.runId);
    put(p.runsDir, notarize, notarize.runId);
    put(p.runsDir, buildSampleBundle(7), "sample-7");
    const drift = testBundle("test-drift", { mode: "replay", disclosure: [TEST, "DRIFT FIXTURE: altered recording"] });
    put(p.runsDir, drift, drift.runId);
    // The published dir: one real bundle (also in runs? no — only here), a fixture, a timeline.
    mkdirSync(join(p.webBundlesDir, "fixture"), { recursive: true });
    writeFileSync(join(p.webBundlesDir, `${guarded.runId}.json`), JSON.stringify(guarded));
    writeFileSync(join(p.webBundlesDir, `${guarded.runId}.timeline.json`), "{}");
    writeFileSync(join(p.webBundlesDir, "index.json"), "[]");
    const fixture = finalizeBundle({ ...naive, runId: "demo-run-naive", sample: true, disclosure: ["FIXTURE"] });
    writeFileSync(join(p.webBundlesDir, "fixture", "demo-run-naive.json"), JSON.stringify(fixture));
    writeFileSync(join(p.webBundlesDir, "sample-42.json"), JSON.stringify(buildSampleBundle(42)));

    const { file } = writeEconomics({ ...p, cfoImport: FIXTURE_CSV, now: NOW });
    expect(file.sources.bundles.map((b) => b.runId).sort()).toEqual(["notarize-dodo-test", "test-guarded", "test-naive"]);
    const skipped = file.sources.skipped.map((s) => s.file);
    expect(skipped).toEqual(expect.arrayContaining(["core/runs/sample-7/sample-7.json", "core/runs/test-drift/test-drift.json", "web/public/bundles/sample-42.json"]));
    expect(JSON.stringify(file)).not.toContain("demo-run-naive");
    expect(file.computed!.unsafeActionsPrevented.value).toBe(3);
    expect(file.plan!.source.importedAt).toBe("2026-10-12T08:00:00.000Z");
    expect(file.combined.incidentsPreventedValue).toEqual({ value: 750, unit: "USD", basis: expect.stringContaining("cfo.ai plan") });
    expect(verifyEconomics(JSON.parse(readFileSync(p.economicsJson, "utf8"))).ok).toBe(true);
    const md = readFileSync(p.businessMd, "utf8");
    expect(md).toContain("## The plan, modeled in cfo.ai");
    expect(md).toContain("| Starter | 10 USD / contract/month |");
    expect(md).toContain(file.contentHash);
    // The inputs sheet for cfo.ai: one row per real bundle, values from the bundles.
    const inputs = readFileSync(p.cfoInputsCsv, "utf8").trim().split("\n");
    expect(inputs[0]).toBe("run_id,started_at,month,kind,variant,tool,mode,status,model_usd,usd_executor,usd_reflector,usd_adversary,tokens,crustdata_credits,unsafe_actions,held_actions,notarized_beliefs");
    expect(inputs.slice(1)).toEqual([
      "notarize-dodo-test,2026-10-11T09:00:00.000Z,2026-10,notarize,notarize,dodo,live,completed,2,0,1,1,4,0,,,1",
      "test-naive,2026-10-11T10:00:00.000Z,2026-10,run,naive,,live,completed,0.25,0.25,0,0,150,20,3,0,",
      "test-guarded,2026-10-11T11:00:00.000Z,2026-10,run,guarded,,live,completed,0.75,0.5,0.25,0,17,10,0,4,",
    ]);

    // Re-running without --cfo-import keeps the verified plan and produces the identical file.
    const again = writeEconomics({ ...p, now: () => new Date("2030-01-01T00:00:00.000Z") });
    expect(JSON.stringify(again.file)).toBe(JSON.stringify(file));
    expect(readFileSync(p.businessMd, "utf8")).toBe(md);
  });

  it("missing plan and zero real bundles: both sections null with reasons, file still written", () => {
    const root = tempDir();
    const p = paths(root);
    put(p.runsDir, buildSampleBundle(3), "sample-3");
    const { file } = writeEconomics({ ...p, now: NOW });
    expect(existsSync(p.economicsJson)).toBe(true);
    expect(file.computed).toBeNull();
    expect(file.computedReason).toMatch(/No real run bundles/);
    expect(file.plan).toBeNull();
    expect(file.planReason).toBe("No cfo.ai plan imported yet. Import your cfo.ai plan: pnpm notary economics --cfo-import <file>");
    expect(file.combined.incidentsPreventedValue).toBeNull();
    expect(readFileSync(p.businessMd, "utf8")).toContain("Not imported:");
    // No real runs: the inputs sheet is the header only, never placeholder rows.
    expect(readFileSync(p.cfoInputsCsv, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("drops a plan whose economics.json no longer verifies", () => {
    const root = tempDir();
    const p = paths(root);
    writeEconomics({ ...p, cfoImport: FIXTURE_CSV, now: NOW });
    const raw = JSON.parse(readFileSync(p.economicsJson, "utf8"));
    raw.plan.tiers[0].price = 1;
    writeFileSync(p.economicsJson, JSON.stringify(raw));
    const { file } = writeEconomics({ ...p, now: NOW });
    expect(file.plan).toBeNull();
    expect(file.planReason).toMatch(/did not verify/);
  });
});
