/**
 * `notary demo --fixture --scenario change-api` (DECISIONS #105). Everything here runs on the FIXTURE
 * API and the model doubles (simulated; no network, no keys); nothing is a run result.
 *
 * The simulated Dodo switches the refund amount unit right after q09 is decided. The guarded run's
 * re-verification sentinel must notice it only by probing, un-learn the notarized refund-unit belief
 * through BeliefStore's real rules, retire its transform guard, and hold the refund that the stale
 * transform would have made 100x too small. A counterfactual run with the sentinel off shows that
 * refund really would have been wrong.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BeliefStore, beliefIdFor } from "../src/beliefs/store.js";
import { FIXTURE_BUNDLES_SUBDIR, buildSampleBundle, finalizeBundle, verifyBundle } from "../src/bundle/index.js";
import { FixtureWorld } from "../src/demo/fixture-api.js";
import {
  CHANGE_API_CLAIM_ID,
  CHANGE_API_DISCLOSURE,
  CHANGE_API_RUN_IDS,
  CHANGE_API_SWITCH_AFTER,
  DEMO_RUN_IDS,
  FIXTURE_DISCLOSURE,
  demoScenarioOf,
  runFixtureDemo,
} from "../src/demo/index.js";
import type { FixtureDemoResult } from "../src/demo/index.js";
import { publishFixtureBundles } from "../src/demo/publish.js";
import { GuardRegistry } from "../src/guards/registry.js";
import { DEFAULT_MAX_PROBES_PER_CLAIM, MAX_PROBES_PER_RUN } from "../src/reflect/loop.js";
import { DEFAULT_SENTINEL_MODE, sentinelModeFromEnv, transformRewrites } from "../src/queue/sentinel.js";
import { BundleIndexSchema } from "../src/schema/bundle.js";
import type { Guard, RunBundle } from "../src/schema/index.js";
import { NotaryDb } from "../src/store/db.js";
import { readFileSync, readdirSync } from "node:fs";

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const BELIEF = beliefIdFor(CHANGE_API_CLAIM_ID);

function guardedOf(r: FixtureDemoResult): RunBundle {
  const b = r.bundles.find((x) => x.runId === CHANGE_API_RUN_IDS.guarded);
  if (!b) throw new Error("no guarded bundle");
  return b;
}

describe("notary demo --fixture --scenario change-api (FIXTURE: mid-run API change)", () => {
  let outDir: string;
  let counterDir: string;
  let first: FixtureDemoResult;
  let counter: FixtureDemoResult;
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "notary-change-api-"));
    counterDir = mkdtempSync(join(tmpdir(), "notary-change-api-off-"));
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("test: network is forbidden");
    }) as typeof fetch;
    try {
      first = await runFixtureDemo({ scenario: "change-api", outDir, slowFullRefundMs: 300, readinessEnv: {} });
      counter = await runFixtureDemo({ scenario: "change-api", outDir: counterDir, slowFullRefundMs: 300, readinessEnv: {}, guardedSentinel: "off" });
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 240_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(counterDir, { recursive: true, force: true });
  });

  it("runs end to end on fixtures with no network call and labels its bundles demo-change-api-*", () => {
    expect(first.exitCode, first.lines.filter((l) => l.includes("PROBLEM")).join("\n")).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(first.stats.globalFetchCalls).toBe(0);
    expect(first.stats.refused).toEqual([]);
    expect(first.stats.unknownRoutes).toEqual([]);
    expect(first.scenario).toBe("change-api");
    expect(first.bundles.map((b) => b.runId).sort()).toEqual(Object.values(CHANGE_API_RUN_IDS).sort());
    for (const b of first.bundles) {
      expect(verifyBundle(b).ok).toBe(true);
      expect(b.sample).toBe(true);
      expect(b.runId.startsWith("demo-change-api-")).toBe(true);
      expect(b.disclosure).toContain(FIXTURE_DISCLOSURE);
      expect(b.disclosure).toContain(CHANGE_API_DISCLOSURE);
      expect(demoScenarioOf(b.runId)).toBe("change-api");
    }
    for (const id of Object.values(DEMO_RUN_IDS)) expect(demoScenarioOf(id)).toBe("default");
    expect(first.lines.some((l) => l.includes("== Stage 11 · Change the API"))).toBe(true);
  });

  it("switches the refund unit once, right after the switch item, consistently for every later exchange", () => {
    for (const variant of ["naive", "guarded"] as const) {
      const run = first.apiChange?.[variant];
      expect(run?.change, variant).toBeDefined();
      const cut = run!.change!.afterSeq;
      const before = run!.bookings.filter((b) => b.seq <= cut);
      const after = run!.bookings.filter((b) => b.seq > cut);
      expect(after.length, variant).toBeGreaterThan(0);
      for (const b of before) {
        expect(b.unit).toBe("major");
        expect(b.booked).toBe(Math.min(b.sent * 100, b.linePrice));
      }
      for (const b of after) {
        expect(b.unit).toBe("minor");
        expect(b.booked).toBe(b.sent);
      }
    }
    // The recorded probes agree: the sentinel probe before the change saw x100, every one after it saw the sent amount.
    const g = guardedOf(first);
    const sentinel = g.probes.filter((p) => p.claimId === CHANGE_API_CLAIM_ID);
    expect(sentinel.length).toBeGreaterThanOrEqual(2);
    const ratios = sentinel.map((p) => (p.observed as { ratio?: unknown }).ratio);
    expect(ratios[0]).toBe(100);
    expect(ratios.slice(1).every((r) => r === 1)).toBe(true);
    // The switch item itself executed with the (then still correct) transform.
    const q09 = g.decisions.find((d) => d.requestId === CHANGE_API_SWITCH_AFTER)!;
    expect(q09.status).toBe("executed");
    expect(q09.grade?.unsafe ?? []).toEqual([]);
  });

  it("sentinel probes are committed before they run and recorded in the bundle like other probes", () => {
    const g = guardedOf(first);
    expect(g.probes.length).toBeGreaterThan(0);
    for (const p of g.probes) {
      expect(p.id.startsWith(`${CHANGE_API_RUN_IDS.guarded}-s`)).toBe(true);
      expect(p.committedAt < (p.ranAt ?? "")).toBe(true);
      expect(p.predictionHash).toMatch(/^[0-9a-f]{64}$/);
      for (const h of p.hypothesisIds) expect(g.hypotheses.some((x) => x.id === h)).toBe(true);
    }
    expect(g.cassettes.some((c) => c.startsWith(`${CHANGE_API_RUN_IDS.guarded}-sentinel@`))).toBe(true);
    expect(g.disclosure.some((d) => d.startsWith("Re-verification sentinel (DECISIONS #105"))).toBe(true);
  });

  it("the notarized refund-unit belief un-learns through BeliefStore's real transitions, triggered by sentinel probe ids", () => {
    const g = guardedOf(first);
    const before = g.beliefs.before.find((b) => b.id === BELIEF)!;
    expect(before.status).toBe("notarized");
    expect(before.class).toBe("unit_mismatch");
    const events = g.beliefEvents.filter((e) => e.beliefId === BELIEF);
    const sentinelIds = new Set(g.probes.map((p) => p.id));
    expect(events.length).toBe(g.probes.filter((p) => p.claimId === CHANGE_API_CLAIM_ID).length);
    // One confirmed probe per event, each moving exactly one of α/β by 1 from the belief's prior state.
    let prev = { alpha: before.alpha, beta: before.beta };
    for (const e of events) {
      expect(sentinelIds.has(e.probeId ?? "")).toBe(true);
      expect(e.alpha + e.beta).toBe(prev.alpha + prev.beta + 1);
      prev = { alpha: e.alpha, beta: e.beta };
    }
    const unlearn = events.find((e) => e.from === "notarized" && e.to === "unlearned");
    expect(unlearn).toBeDefined();
    expect(unlearn!.probeId).toBe(events[events.length - 1]!.probeId);
    expect(unlearn!.confidence).toBeGreaterThan(0.5);
    expect(events.slice(0, -1).every((e) => e.to === "notarized")).toBe(true);
    // Crossing needs α > β: from the state at the first contrary probe, exactly β-α+1 contrary probes.
    const contraryFrom = events.findIndex((e, i) => e.alpha > (i === 0 ? before.alpha : events[i - 1]!.alpha));
    const start = contraryFrom === 0 ? before : events[contraryFrom - 1]!;
    expect(events.length - contraryFrom).toBe(start.beta - start.alpha + 1);
    expect(g.beliefs.after.find((b) => b.id === BELIEF)!.status).toBe("unlearned");
    // The append-only store agrees with the bundle.
    const db = new NotaryDb(join(outDir, "notary.sqlite"));
    try {
      const store = new BeliefStore(db);
      expect(store.get(BELIEF)!.status).toBe("unlearned");
      const stored = store.events(BELIEF).filter((e) => e.from === "notarized" && e.to === "unlearned");
      expect(stored.map((e) => e.probeId)).toEqual([unlearn!.probeId]);
    } finally {
      db.close();
    }
  });

  it("retires the refund transform guard of the revoked belief", () => {
    const g = guardedOf(first);
    const own = g.guards.filter((x) => x.beliefId === BELIEF);
    const transform = own.find((x) => x.kind === "transform" && x.operation === "dodo.createRefund");
    expect(transform).toBeDefined();
    expect(transform!.active).toBe(false);
    expect(transform!.retiredAt).toBeDefined();
    expect(g.disclosure.some((d) => d.includes("Guards retired during the run") && d.includes(transform!.id))).toBe(true);
    const db = new NotaryDb(join(outDir, "notary.sqlite"));
    try {
      expect(new GuardRegistry(db).get(transform!.id)?.active).toBe(false);
    } finally {
      db.close();
    }
  });

  it("holds the refund the stale transform would have made wrong, with an evidence pack naming the revoked belief", () => {
    const g = guardedOf(first);
    const q10 = g.decisions.find((d) => d.requestId === "q10")!;
    expect(q10.status).toBe("held");
    expect(q10.evidencePack).toBeDefined();
    expect(q10.evidencePack!.missingBeliefs).toContain(BELIEF);
    expect(q10.evidencePack!.reason.startsWith("re-verification sentinel")).toBe(true);
    expect(q10.evidencePack!.reason).toContain(BELIEF);
    const sentinelIds = g.probes.map((p) => p.id);
    expect(sentinelIds.filter((id) => q10.evidencePack!.relatedProbeIds.includes(id)).length).toBe(sentinelIds.length);
    // No refund was sent for q10.
    expect(q10.effects.some((e) => e.op === "dodo.createRefund")).toBe(false);
    expect(g.metrics.unsafe_actions_total).toBe(0);
    expect(first.lines.some((l) => l.startsWith(`  CERTIFICATE REVOKED: ${BELIEF}`))).toBe(true);
    expect(first.lines.some((l) => l.startsWith("  HELD q10"))).toBe(true);
  });

  it("counterfactual: with the sentinel off, the same world executes that refund 100x short (wrong_unit)", () => {
    const g = counter.bundles.find((b) => b.runId === CHANGE_API_RUN_IDS.guarded)!;
    expect(g.probes).toEqual([]);
    expect(g.disclosure.some((d) => d.startsWith("Re-verification sentinel: off"))).toBe(true);
    const q10 = g.decisions.find((d) => d.requestId === "q10")!;
    expect(q10.status).toBe("executed");
    expect(q10.grade?.unsafe).toContain("wrong_unit");
    const booked = counter.apiChange!.guarded!.bookings.filter((b) => b.unit === "minor");
    expect(booked.map((b) => [b.sent, b.booked])).toEqual([[25, 25]]);
    expect(g.beliefs.after.find((b) => b.id === BELIEF)!.status).toBe("notarized");
  });

  it("is deterministic: a second run prints the same summary (timestamps aside)", async () => {
    const second = await runFixtureDemo({ scenario: "change-api", outDir, slowFullRefundMs: 300, readinessEnv: {} });
    expect(second.exitCode).toBe(0);
    const norm = (ls: string[]) => ls.map((l) => l.replace(ISO, "<ts>"));
    expect(norm(second.lines)).toEqual(norm(first.lines));
  }, 120_000);
});

describe("re-verification sentinel defaults and pieces (no demo)", () => {
  it("live defaults: sentinel on (transform) in guarded runs, NOTARY_SENTINEL=off turns it off; probe caps unchanged", () => {
    expect(DEFAULT_SENTINEL_MODE).toBe("transform");
    expect(sentinelModeFromEnv({})).toBe("transform");
    expect(sentinelModeFromEnv({ NOTARY_SENTINEL: "off" })).toBe("off");
    expect(sentinelModeFromEnv({ NOTARY_SENTINEL: "transform" })).toBe("transform");
    expect(() => sentinelModeFromEnv({ NOTARY_SENTINEL: "sometimes" })).toThrow(/NOTARY_SENTINEL/);
    expect(DEFAULT_MAX_PROBES_PER_CLAIM).toBe(5);
    expect(MAX_PROBES_PER_RUN).toBe(30);
    // The default fixture world is the default demo's world (Q1 on payments, Q4 major units).
    const w = new FixtureWorld();
    expect(w.paymentsPageClamp).toBe(true);
    expect(w.refundAmountUnit).toBe("major");
    expect(w.apiChanges).toEqual([]);
  });

  it("transformRewrites: only when the transform would rewrite (not refuse) the write", () => {
    const g: Guard = {
      id: "grd-test",
      beliefId: BELIEF,
      operation: "dodo.createRefund",
      kind: "transform",
      class: "unit_mismatch",
      rule: { param: "items[].amount", scale: 0.01, observedRatio: 100, requireInteger: true },
      reason: "test",
      active: true,
      compiledAt: "2026-10-10T00:00:00.000Z",
    };
    expect(transformRewrites(g, { payment_id: "p", items: [{ item_id: "i", amount: 2500 }] })).toBe(true);
    expect(transformRewrites(g, { payment_id: "p", items: [{ item_id: "i", amount: 24950 }] })).toBe(false); // refused: not an integer
    expect(transformRewrites(g, { payment_id: "p", reason: "full refund" })).toBe(false); // untouched
    expect(transformRewrites({ ...g, kind: "block" }, { items: [{ amount: 2500 }] })).toBe(false);
  });
});

describe("fixture publish is per scenario", () => {
  const TEST = "TEST bundle built in test/change-api.test.ts — not a Notary result";
  const fixtureBundle = (runId: string, seed = 7): RunBundle => finalizeBundle({ ...buildSampleBundle(seed), runId, sample: true, disclosure: [FIXTURE_DISCLOSURE, TEST] });

  it("publishing one scenario never deletes the other's bundles; index.json lists both", async () => {
    const web = mkdtempSync(join(tmpdir(), "notary-publish-scenario-"));
    try {
      const dir = join(web, FIXTURE_BUNDLES_SUBDIR);
      await publishFixtureBundles([fixtureBundle("demo-run-guarded"), fixtureBundle("demo-notarize-dodo")], { webBundlesDir: web });
      const ca = await publishFixtureBundles([fixtureBundle("demo-change-api-run-guarded", 9)], { webBundlesDir: web });
      expect(ca.removed).toEqual(["index.json"]);
      const idx = () => BundleIndexSchema.parse(JSON.parse(readFileSync(join(dir, "index.json"), "utf8"))).map((e) => e.runId).sort();
      expect(idx()).toEqual(["demo-change-api-run-guarded", "demo-notarize-dodo", "demo-run-guarded"]);
      // Default again, with one bundle fewer: its stale file goes, the change-api bundle stays.
      writeFileSync(join(dir, "README.txt"), "not ours");
      const d = await publishFixtureBundles([fixtureBundle("demo-run-guarded", 11)], { webBundlesDir: web });
      expect(d.removed.sort()).toEqual(["demo-notarize-dodo.json", "demo-run-guarded.json", "index.json"]);
      expect(idx()).toEqual(["demo-change-api-run-guarded", "demo-run-guarded"]);
      expect(readdirSync(dir).sort()).toEqual(["README.txt", "demo-change-api-run-guarded.json", "demo-run-guarded.json", "index.json"]);
      for (const f of ["demo-change-api-run-guarded.json", "demo-run-guarded.json"]) expect(verifyBundle(JSON.parse(readFileSync(join(dir, f), "utf8"))).ok).toBe(true);
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
  });
});
