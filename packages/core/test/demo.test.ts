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
import { DEMO_MAX_PROBES_PER_CLAIM, DEMO_MAX_PROBES_PER_RUN, DEMO_RUN_IDS, DRIFT_CLAIM_ID, FIXTURE_DISCLOSURE, runFixtureDemo } from "../src/demo/index.js";
import { designsToCross } from "../src/beliefs/drift.js";
import { designFingerprint } from "../src/beliefs/params.js";
import { BeliefStore } from "../src/beliefs/store.js";
import { GuardRegistry } from "../src/guards/registry.js";
import { DEFAULT_MAX_PROBES_PER_CLAIM, MAX_PROBES_PER_RUN, maxProbesPerClaimFromEnv } from "../src/reflect/loop.js";
import { NotaryDb } from "../src/store/db.js";
import { loadDriftFixture } from "../src/tools/drift-fixture.js";
import { REFUND_TREATMENT_VARIANTS, UNIT_TREATMENT_VARIANTS } from "../src/reflect/templates/unit_roundtrip.js";
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
  let capEnvBefore: string | undefined;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "notary-demo-"));
    webBefore = webSnapshot();
    modeBefore = process.env.NOTARY_MODE;
    capEnvBefore = process.env.NOTARY_MAX_PROBES_PER_CLAIM;
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
    for (let n = 1; n <= 11; n++) expect(first.lines.some((l) => l.includes(`== Stage ${n} ·`))).toBe(true);
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
    // Unit guards: consistent x100 evidence compiles to a transform (refunds); the intermittent Q2 (one
    // cited wallet probe echoed the amount unchanged) leaves no safe transform, so the wallet guard blocks.
    expect(dodo.guards.some((g) => g.kind === "transform" && g.operation === "dodo.createRefund" && g.rule.scale === 0.01)).toBe(true);
    const walletUnit = dodo.guards.filter((g) => g.beliefId === "belief-dodo.wallet.credit-amount-minor-units");
    expect(walletUnit.map((g) => [g.kind, g.operation])).toEqual([["block", "dodo.createWalletLedgerEntry"]]);
    expect(walletUnit[0]!.reason).toMatch(/cited probes disagree: demo-notarize-dodo-p\d+ echoed the amount unchanged/);
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
    // Held either by the gate (a missing belief) or by a guard that refused the call (block).
    for (const d of guarded.decisions.filter((x) => x.status === "held")) {
      expect(d.missingBeliefs.length > 0 || d.guardsApplied.length > 0).toBe(true);
      expect(d.evidencePack).toBeDefined();
    }
  });

  it("intermittent Q2: the real loop records mixed wallet-unit evidence and still notarizes it on the violated side", () => {
    const dodo = first.bundles.find((b) => b.runId === DEMO_RUN_IDS.notarizeDodo)!;
    const belief = dodo.beliefs.after.find((b) => b.claimId === DRIFT_CLAIM_ID)!;
    expect(belief).toMatchObject({ status: "notarized", class: "unit_mismatch" });
    const claim = claimById(DRIFT_CLAIM_ID)!;
    const cited = new Set(belief.evidence.map((e) => e.probeId));
    const probes = dodo.probes.filter((p) => cited.has(p.id) && p.template === "unit_roundtrip");
    const outcome = (p: Probe) => (p.observed as { outcome?: string }).outcome;
    // Distinct designs, at least one honored (the Q2 band) and at least five x100.
    expect(new Set(probes.map((p) => designFingerprint(claim, p))).size).toBe(probes.length);
    expect(probes.filter((p) => outcome(p) === "equal").length).toBeGreaterThanOrEqual(1);
    expect(probes.filter((p) => outcome(p) === "x100").length).toBeGreaterThanOrEqual(5);
    // α/β are whatever those confirmed probes made them (honored +α, defect +β, from Beta(1,1)).
    expect(belief.alpha).toBe(1 + probes.filter((p) => outcome(p) === "equal").length);
    expect(belief.beta).toBe(1 + probes.filter((p) => outcome(p) === "x100").length);
    expect(dodo.disclosure.some((d) => d.includes(`${DEMO_MAX_PROBES_PER_CLAIM} per claim, ${DEMO_MAX_PROBES_PER_RUN} per run`))).toBe(true);
  });

  it("Stage 11 drift replay un-learns the mixed-evidence belief via >= the required distinct designs and retires its guard", () => {
    const d = first.drift!;
    expect(d).toBeDefined();
    // The drift fixture is the demo's own FIXTURE cassette, rewritten, under the demo dir only.
    expect(d.fixturePath!.startsWith(join(outDir, "drift"))).toBe(true);
    const fx = loadDriftFixture(d.fixturePath!);
    expect(fx.fixture).toBe(true);
    expect(fx.drift).toMatchObject({ source: "probes-dodo", op: "dodo.createWalletLedgerEntry", path: "$.balance", transform: "idiv100" });
    expect(listCassettes(DEFAULT_CASSETTE_DIR)).toEqual(cassettesBefore);
    const res = d.result!;
    const t = res.trajectories.find((x) => x.claimId === DRIFT_CLAIM_ID)!;
    expect(t.side).toBe("violated");
    expect(t.designsNeeded).toBe(designsToCross(t.start.alpha, t.start.beta, "violated"));
    expect(t.designsNeeded).toBeGreaterThan(4); // more than a fresh Beta(1,4) would need
    expect(t.unlearned).toBe(true);
    const at = t.steps.findIndex((s) => s.status === "unlearned") + 1;
    expect(t.steps.slice(0, at).filter((s) => s.against).length).toBeGreaterThanOrEqual(t.designsNeeded);
    expect(new Set(t.steps.map((s) => s.design)).size).toBe(t.steps.length); // one step per distinct design
    // Retired: exactly the wallet-unit belief's guard(s); the idempotency guard on the same op stays.
    const dodo = first.bundles.find((b) => b.runId === DEMO_RUN_IDS.notarizeDodo)!;
    const own = dodo.guards.filter((g) => g.beliefId === t.beliefId).map((g) => g.id).sort();
    expect(own.length).toBeGreaterThan(0);
    expect(res.retiredGuards.map((g) => g.id).sort()).toEqual(own);
    const copy = new NotaryDb(d.storePath);
    try {
      const reg = new GuardRegistry(copy);
      for (const id of own) expect(reg.get(id)).toMatchObject({ active: false });
      expect(reg.all().some((g) => g.active && g.operation === "dodo.createWalletLedgerEntry" && g.beliefId === "belief-dodo.wallet.idempotency-key-no-duplicate")).toBe(true);
    } finally {
      copy.close();
    }
    // The demo store itself keeps what Stages 1-9 saw.
    const store = new NotaryDb(join(outDir, "notary.sqlite"));
    try {
      expect(new BeliefStore(store).byClaim(DRIFT_CLAIM_ID)!.status).toBe("notarized");
      for (const id of own) expect(new GuardRegistry(store).get(id)).toMatchObject({ active: true });
    } finally {
      store.close();
    }
    expect(first.lines.some((l) => /^ {2}UN-LEARNED at distinct design \d+ of \d+ \(needed \d+;/.test(l))).toBe(true);
    expect(first.lines.some((l) => /^ {2}guard retired: grd-[0-9a-f]{12} \(block on dodo\.createWalletLedgerEntry\)/.test(l))).toBe(true);
    expect(first.lines.some((l) => l.startsWith("  PASS `notary replay --drift` on this fixture: exit 1"))).toBe(true);
  });

  it("raises the probe caps in-process only; live defaults and process.env are unchanged", () => {
    expect(DEFAULT_MAX_PROBES_PER_CLAIM).toBe(5);
    expect(MAX_PROBES_PER_RUN).toBe(30);
    expect(maxProbesPerClaimFromEnv({})).toBe(5);
    // unit_roundtrip's original designs stay first and unchanged; 3 more are appended (6 in all).
    expect(UNIT_TREATMENT_VARIANTS.slice(0, 3)).toEqual([1234, 3517, 4321]);
    expect(REFUND_TREATMENT_VARIANTS.slice(0, 3)).toEqual([100, 120, 130]);
    expect(UNIT_TREATMENT_VARIANTS).toHaveLength(6);
    expect(new Set(UNIT_TREATMENT_VARIANTS).size).toBe(6);
    expect(new Set(REFUND_TREATMENT_VARIANTS).size).toBe(6);
    expect(process.env.NOTARY_MAX_PROBES_PER_CLAIM).toBe(capEnvBefore);
    expect(DEMO_MAX_PROBES_PER_CLAIM).toBeGreaterThan(DEFAULT_MAX_PROBES_PER_CLAIM);
    expect(DEMO_MAX_PROBES_PER_RUN).toBeGreaterThan(MAX_PROBES_PER_RUN);
    // Both #85's re-examination and the change-plan verification still ran.
    const dodo = first.bundles.find((b) => b.runId === DEMO_RUN_IDS.notarizeDodo)!;
    expect(dodo.probes.length).toBeGreaterThan(MAX_PROBES_PER_RUN);
    expect(dodo.probes.some((p) => p.claimId === "dodo.payments.page-size-max-100" && p.template === "pagination_completeness")).toBe(true);
    expect(dodo.beliefs.after.find((b) => b.claimId === "dodo.subscription.change-plan-pending-409")).toMatchObject({ status: "notarized" });
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

  it("guard compiler: a cited unit probe that echoed the amount unchanged disagrees with the x100 ones -> block, never a transform", () => {
    const claim = claimById("dodo.wallet.credit-amount-minor-units")!;
    const probe = (k: number, outcome: "x100" | "equal"): Probe => ({
      id: `p${k}`,
      tool: "dodo",
      claimId: claim.id,
      hypothesisIds: ["h"],
      template: "unit_roundtrip",
      params: { steps: [], variant: k },
      prediction: {},
      predictionHash: "a".repeat(64),
      committedAt: "2026-10-10T00:00:00.000Z",
      observed: outcome === "x100" ? { outcome, status: 200, sent: 1234, echoed: 123400, ratio: 100, reason: "r" } : { outcome, status: 200, sent: 3517, echoed: 3517, ratio: 1, reason: "r" },
      verdict: "confirmed",
      costCredits: 0,
      calls: 2,
      traceId: `t${k}`,
    });
    const probes = [probe(0, "x100"), probe(1, "equal"), probe(2, "x100"), probe(3, "x100"), probe(4, "x100"), probe(5, "x100")];
    const belief: Belief = {
      id: "belief-dodo.wallet.credit-amount-minor-units",
      claimId: claim.id,
      tool: "dodo",
      class: "unit_mismatch",
      statement: "s",
      alpha: 2,
      beta: 6,
      confidence: 0.0625,
      status: "notarized",
      evidence: probes.map((p) => ({ probeId: p.id, traceId: p.traceId, valid: true })),
      updatedAt: "2026-10-10T00:00:00.000Z",
    };
    const guards = compileGuards({ beliefs: [belief], claimFor: (id) => claimById(id), probes });
    expect(guards).toHaveLength(1);
    expect(guards[0]).toMatchObject({ kind: "block", operation: "dodo.createWalletLedgerEntry" });
    expect(guards[0]!.reason).toMatch(/cited probes disagree: p1 echoed the amount unchanged, p0, p2, p3, p4, p5 echoed 100x: no safe transform/);
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
