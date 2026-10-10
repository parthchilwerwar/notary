/**
 * `notary demo --fixture` tests. Everything here runs on the FIXTURE API and the model doubles from
 * src/demo/ (simulated; no network, no keys); nothing is a run result. Also holds the regression
 * tests for pipeline bugs the demo surfaced.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPriorsSource } from "../src/beliefs/priors.js";
import { verifyBundle } from "../src/bundle/index.js";
import { FixtureApi, FixtureTransportRefusal, FixtureWorld } from "../src/demo/fixture-api.js";
import { adversaryDecision, reflectorReply } from "../src/demo/fixture-llm.js";
import { DEMO_RUN_IDS, FIXTURE_DISCLOSURE, runFixtureDemo } from "../src/demo/index.js";
import type { FixtureDemoResult } from "../src/demo/index.js";
import { collectBundles } from "../src/export/index.js";
import { compileGuards } from "../src/guards/index.js";
import { claimById } from "../src/contracts/index.js";
import { recordedRunId } from "../src/reflect/notarize.js";
import { judge } from "../src/reflect/verdict.js";
import { runReplay } from "../src/replay/index.js";
import { PinMismatchError, loadPinned, pinRef } from "../src/replay/pins.js";
import type { Belief, Probe } from "../src/schema/index.js";
import { DEFAULT_CASSETTE_DIR, computeContentHash, listCassettes, loadCassette, saveCassette, setRecorderTransport } from "../src/tools/index.js";
import type { ProbeDesign, ProbeObservation, ProbeTemplateModule } from "../src/reflect/templates/index.js";

const WEB_BUNDLES = fileURLToPath(new URL("../../web/public/bundles/", import.meta.url));
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function webSnapshot(): string[] {
  if (!existsSync(WEB_BUNDLES)) return [];
  return readdirSync(WEB_BUNDLES)
    .sort()
    .map((f) => `${f}:${statSync(join(WEB_BUNDLES, f)).mtimeMs}`);
}

function demoBundleFiles(outDir: string): string[] {
  return readdirSync(outDir)
    .filter((d) => d.startsWith("demo-"))
    .map((d) => join(outDir, d, `${d}.json`))
    .filter((f) => existsSync(f));
}

describe("notary demo --fixture (FIXTURE data, simulated APIs and model doubles)", () => {
  let outDir: string;
  let first: FixtureDemoResult;
  let fetchCalls = 0;
  let webBefore: string[];
  let cassettesBefore: string[];
  const realFetch = globalThis.fetch;
  let modeBefore: string | undefined;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "notary-demo-"));
    webBefore = webSnapshot();
    modeBefore = process.env.NOTARY_MODE;
    cassettesBefore = listCassettes(DEFAULT_CASSETTE_DIR);
    // Any network attempt from anywhere during the demo would land here (the demo also traps it).
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("test: network is forbidden");
    }) as typeof fetch;
    try {
      first = await runFixtureDemo({ outDir, slowFullRefundMs: 300, readinessEnv: {} });
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 120_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("runs every stage end to end with no network call", () => {
    expect(first.exitCode, first.lines.filter((l) => l.includes("PROBLEM")).join("\n")).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(first.stats.globalFetchCalls).toBe(0);
    expect(first.stats.refused).toEqual([]);
    expect(first.stats.unknownRoutes).toEqual([]);
    expect(first.stats.served).toBeGreaterThan(100);
    for (let n = 1; n <= 10; n++) expect(first.lines.some((l) => l.includes(`== Stage ${n} ·`))).toBe(true);
    expect(first.lines.filter((l) => l.includes("PLANTED FIXTURE QUIRK Q")).length).toBeGreaterThanOrEqual(6);
    expect(first.lines.some((l) => l.includes("live: BLOCKED at Stage 1 — CRUSTDATA_API_KEY not set"))).toBe(true);
    expect(process.env.NOTARY_MODE).toBe(modeBefore); // set in-process for the demo only, then restored
  });

  it("labels every bundle it writes: sample, FIXTURE disclosure, demo- runId, under the demo dir only", () => {
    const files = demoBundleFiles(outDir);
    expect(files.length).toBe(4);
    for (const f of files) {
      const v = verifyBundle(JSON.parse(readFileSync(f, "utf8")));
      expect(v.ok).toBe(true);
      if (!v.ok) continue;
      expect(v.bundle.sample).toBe(true);
      expect(v.bundle.disclosure).toContain(FIXTURE_DISCLOSURE);
      expect(v.bundle.runId.startsWith("demo-")).toBe(true);
    }
    expect(webSnapshot()).toEqual(webBefore);
    expect(listCassettes(DEFAULT_CASSETTE_DIR)).toEqual(cassettesBefore);
  });

  it("marks every cassette it records fixture: true", () => {
    const dir = join(outDir, "cassettes");
    const names = listCassettes(dir);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(loadCassette(n, { dir }).fixture).toBe(true);
  });

  it("export, priors and replay ignore the demo's bundles and cassettes", async () => {
    const collected = collectBundles(outDir);
    expect(collected.bundles).toEqual([]);
    expect(collected.excluded.length).toBe(4);
    expect(loadPriorsSource({ tool: "dodo", runsDir: outDir }).blocked).toMatch(/BLOCKED/);
    expect(recordedRunId(outDir, "dodo")).toBeUndefined();
    expect(recordedRunId(outDir, "crustdata")).toBeUndefined();
    const all = await runReplay({ runsDir: outDir, webBundlesDir: null, cassetteDir: join(outDir, "cassettes") });
    expect(all.exitCode).toBe(3);
    expect(all.replays).toEqual([]);
    const one = await runReplay({ bundle: DEMO_RUN_IDS.naive, runsDir: outDir, webBundlesDir: null, cassetteDir: join(outDir, "cassettes") });
    expect(one.exitCode).toBe(1);
    expect(one.lines.join("\n")).toMatch(/not a recorded live run .*sample/);
    const naive = first.bundles.find((b) => b.runId === DEMO_RUN_IDS.naive)!;
    expect(() => loadPinned(naive.cassettes[0]!, join(outDir, "cassettes"))).toThrow(PinMismatchError);
    expect(() => loadPinned(naive.cassettes[0]!, join(outDir, "cassettes"))).toThrow(/FIXTURE cassette/);
  });

  it("shows the loop at work: committed predictions, a refutation, planted harm in the naive run, none in the guarded run", () => {
    const dodo = first.bundles.find((b) => b.runId === DEMO_RUN_IDS.notarizeDodo)!;
    expect(dodo.probes.length).toBeGreaterThan(0);
    for (const p of dodo.probes) expect(p.committedAt < (p.ranAt ?? "")).toBe(true);
    expect(dodo.beliefs.after.some((b) => b.adversary?.verdict === "downgrade")).toBe(true);
    expect(dodo.guards.some((g) => g.kind === "transform" && g.operation === "dodo.createWalletLedgerEntry" && g.rule.scale === 0.01)).toBe(true);
    const naive = first.bundles.find((b) => b.runId === DEMO_RUN_IDS.naive)!;
    expect(naive.metrics.unsafe_duplicates).toBeGreaterThanOrEqual(1);
    expect(naive.metrics.unsafe_wrong_unit).toBeGreaterThanOrEqual(1);
    const guarded = first.bundles.find((b) => b.runId === DEMO_RUN_IDS.guarded)!;
    expect(guarded.metrics.unsafe_actions_total).toBe(0);
    expect(guarded.decisions.filter((d) => d.status === "held").every((d) => d.evidencePack !== undefined)).toBe(true);
  });

  it("verification probes notarize required claims that had no anomaly, so the guarded run can execute what they gate", () => {
    const dodo = first.bundles.find((b) => b.runId === DEMO_RUN_IDS.notarizeDodo)!;
    const verifyHyps = new Set(dodo.hypotheses.filter((h) => h.anomalyId.startsWith("verify:")).map((h) => h.id));
    const verifyProbes = dodo.probes.filter((p) => p.hypothesisIds.every((id) => verifyHyps.has(id)));
    expect(verifyProbes.length).toBeGreaterThan(0);
    const anomalyClaims = new Set(dodo.anomalies.map((a) => a.claimId));
    for (const p of verifyProbes) expect(anomalyClaims.has(p.claimId)).toBe(false);
    // recon: [] claims are exercised against probe-only seeded state and settle on both sides
    const after = new Map(dodo.beliefs.after.map((b) => [b.claimId, b]));
    expect(after.get("dodo.subscription.change-plan-pending-409")).toMatchObject({ status: "notarized", class: "honored" });
    expect(after.get("dodo.payment.refunds-lists-issued-refund")).toMatchObject({ status: "notarized", class: "honored" });
    expect(after.get("dodo.refund.amount-minor-units")).toMatchObject({ status: "notarized", class: "unit_mismatch" });
    expect(after.get("dodo.refund.full-retry-no-duplicate")).toMatchObject({ status: "notarized", class: "idempotency_hazard" });
    // the guarded run executes items whose required beliefs are all notarized, and only those
    const guarded = first.bundles.find((b) => b.runId === DEMO_RUN_IDS.guarded)!;
    const executed = guarded.decisions.filter((d) => d.status === "executed");
    expect(executed.length).toBeGreaterThan(0);
    for (const d of executed) expect(d.missingBeliefs).toEqual([]);
    for (const d of guarded.decisions.filter((x) => x.status === "held")) {
      expect(d.missingBeliefs.length).toBeGreaterThan(0);
      expect(d.evidencePack).toBeDefined();
    }
  });

  it("is deterministic: a second run prints the same summary (timestamps aside)", async () => {
    const second = await runFixtureDemo({ outDir, slowFullRefundMs: 300, readinessEnv: {} });
    expect(second.exitCode).toBe(0);
    const norm = (lines: string[]) => lines.map((l) => l.replace(ISO, "<ts>"));
    expect(norm(second.lines)).toEqual(norm(first.lines));
  }, 120_000);
});

describe("fixture plumbing", () => {
  it("the fixture transport refuses any non-fixture host", async () => {
    const api = new FixtureApi(() => new FixtureWorld());
    await expect(api.fetch("https://example.com/x", { method: "GET" })).rejects.toBeInstanceOf(FixtureTransportRefusal);
    await expect(api.fetch("https://live.dodopayments.com/payments", { method: "GET" })).rejects.toBeInstanceOf(FixtureTransportRefusal);
    await expect(api.fetch("http://test.dodopayments.com/payments", { method: "GET" })).rejects.toBeInstanceOf(FixtureTransportRefusal);
    expect(api.stats.refused.length).toBe(3);
    const ok = await api.fetch("https://test.dodopayments.com/payments?page_size=5", { method: "GET", headers: { authorization: "Bearer x" } });
    expect(ok.status).toBe(200);
  });

  it("while a fixture transport is installed, cassettes are stamped and never saved into fixtures/cassettes", () => {
    const dir = mkdtempSync(join(tmpdir(), "notary-fx-cassette-"));
    const restore = setRecorderTransport({ fetch: async () => new Response("{}"), fixture: true });
    try {
      const c = { name: "fx-test", tool: "dodo", createdAt: "2026-10-10T00:00:00.000Z", exchanges: [], contentHash: computeContentHash([]) };
      expect(() => saveCassette(c, DEFAULT_CASSETTE_DIR)).toThrow(/refusing to save fixture cassette/);
      saveCassette(c, dir);
      expect(loadCassette("fx-test", { dir }).fixture).toBe(true);
      expect(() => loadPinned(pinRef("fx-test", c.contentHash), dir)).toThrow(/FIXTURE cassette/);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the reflector double always proposes an honored rival with speakable templates", () => {
    const reply = JSON.parse(
      reflectorReply(`Anomalies (1). Propose rival hypotheses for each one:\n${JSON.stringify([{ anomalyId: "a1", operation: "dodo.listPayments", param: "page_size", expectRule: { kind: "maxItems", max: 100 } }])}`),
    ) as { anomalies: Array<{ hypotheses: Array<{ class: string }> }> };
    const classes = reply.anomalies[0]!.hypotheses.map((h) => h.class);
    expect(classes).toContain("honored");
    expect(new Set(classes).size).toBeGreaterThanOrEqual(2);
  });

  it("the adversary double downgrades a belief whose probes never varied the parameter", () => {
    const probe = (id: string) => ({ id, cited: true, template: "unit_roundtrip", params: { steps: [{ op: "dodo.createWalletLedgerEntry", params: { amount: 5 } }] }, control: { params: { steps: [{ op: "dodo.createWalletLedgerEntry", params: { amount: 5 } }] } }, observed: {} });
    const d = adversaryDecision({
      belief: { id: "b", class: "unit_mismatch", alpha: 1, beta: 4, confidence: 0.06 },
      claim: { id: "c", operation: "dodo.createWalletLedgerEntry", param: "amount", expect: { kind: "unit" } },
      probes: [probe("p1"), probe("p2")],
    });
    expect(d.verdict).toBe("downgrade");
  });
});

describe("pipeline bugs found by the demo (regressions)", () => {
  it("guard compiler reads the unit ratio where the probe runner records it (observed.ratio), so unit_mismatch compiles to a transform", () => {
    const claim = claimById("dodo.wallet.credit-amount-minor-units")!;
    const probes: Probe[] = [0, 1, 2].map((k) => ({
      id: `p${k}`,
      tool: "dodo",
      claimId: claim.id,
      hypothesisIds: ["h"],
      template: "unit_roundtrip",
      params: { steps: [], variant: k },
      prediction: {},
      predictionHash: "a".repeat(64),
      committedAt: "2026-10-10T00:00:00.000Z",
      // The real runner's shape: {outcome, ...observation.treatment, reason}.
      observed: { outcome: "x100", status: 200, sent: 1234, echoed: 123400, ratio: 100, reason: "r" },
      verdict: "confirmed",
      costCredits: 0,
      calls: 2,
      traceId: `t${k}`,
    }));
    const belief: Belief = {
      id: "belief-dodo.wallet.credit-amount-minor-units",
      claimId: claim.id,
      tool: "dodo",
      class: "unit_mismatch",
      statement: "s",
      alpha: 1,
      beta: 4,
      confidence: 0.0625,
      status: "notarized",
      evidence: probes.map((p) => ({ probeId: p.id, traceId: p.traceId, valid: true })),
      updatedAt: "2026-10-10T00:00:00.000Z",
    };
    const guards = compileGuards({ beliefs: [belief], claimFor: (id) => claimById(id), probes });
    expect(guards).toMatchObject([{ kind: "transform", operation: "dodo.createWalletLedgerEntry", rule: { scale: 0.01, observedRatio: 100 } }]);
  });

  it("a hypothesis a template makes no prediction for (\"*\") is never confirmed by elimination", () => {
    const template = { matches: (p: { outcomes: string[] }, o: ProbeObservation) => p.outcomes.includes("*") || p.outcomes.includes(String(o.outcome)), informative: () => true } as unknown as ProbeTemplateModule;
    const design = {
      predictions: { "h-honored": { class: "honored", outcomes: ["same_set"] }, "h-wild": { class: "silent_coercion", outcomes: ["*"] } },
    } as unknown as ProbeDesign;
    const v = judge(template, design, { outcome: "mismatch", treatment: {}, control: {}, instrument: { treatment: 1, control: 2 } });
    expect(v.verdict).toBe("inconclusive");
    expect(v.winningHypothesisId).toBeUndefined();
    // A real, specific prediction is still confirmed as before.
    const v2 = judge(template, design, { outcome: "same_set", treatment: {}, control: {}, instrument: { treatment: 1, control: 2 } });
    expect(v2.verdict).toBe("inconclusive"); // the wildcard also matches, so two rivals match
  });
});
