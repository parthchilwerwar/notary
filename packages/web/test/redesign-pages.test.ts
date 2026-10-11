// R2: Report (comparison within one world, cost per run, traces) and Certificates helpers,
// against the published fixture data.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RunBundle } from "../../core/src/schema";
import { BundleIndexSchema } from "../../core/src/schema/bundle";
import { toCertificateView, validateBundle, verifyToolFile, type CertificateView } from "../src/data";
import {
  comparisonPairs,
  comparisonRows,
  pickPair,
  roleCosts,
  runCost,
  runTraces,
  byCohort,
  worldOf,
} from "../src/pages/report/model";
import {
  certificateTraces,
  filterWorld,
  heldAfterRevocation,
  reasonText,
  resolveBelief,
  runWithProbe,
} from "../src/pages/certificates/model";

const pub = (p: string) => JSON.parse(readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8"));
const index = BundleIndexSchema.parse(pub("bundles/fixture/index.json"));
const fixtures: RunBundle[] = index.map((e) => validateBundle(pub(`bundles/fixture/${e.runId}.json`), e));
const byId = (id: string) => fixtures.find((b) => b.runId === id)!;

function world(scenario: string): CertificateView {
  const report = pub(`certificates/fixture/${scenario}/report.json`);
  const tools = report.tools.map((t: { file: string }) =>
    verifyToolFile(pub(`certificates/fixture/${scenario}/${t.file}`), report.toolFileHashes[t.file], true, t.file),
  );
  return toCertificateView({ world: `fixture:${scenario}`, sample: true, tools, report })!;
}

describe("report: naive vs guarded", () => {
  it("pairs only runs of the same world", () => {
    const pairs = comparisonPairs(fixtures);
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) {
      expect(p.naive.variant).toBe("naive");
      expect(p.guarded.variant).toBe("guarded");
      expect(worldOf(p.naive)).toBe(worldOf(p.guarded));
      expect(p.naive.sample).toBe(p.guarded.sample);
    }
    expect(pairs.map((p) => [p.guarded.runId, p.naive.runId])).toContainEqual(["demo-run-guarded", "demo-run-naive"]);
    expect(pairs.map((p) => [p.guarded.runId, p.naive.runId])).toContainEqual([
      "demo-change-api-run-guarded",
      "demo-change-api-run-naive",
    ]);
  });
  it("never pairs a real run with a fixture run", () => {
    const realGuarded = { ...byId("demo-run-guarded"), runId: "real-guarded", sample: false };
    const pairs = comparisonPairs([realGuarded, ...fixtures]);
    expect(pairs.some((p) => p.guarded.runId === "real-guarded")).toBe(false);
    const realNaive = { ...byId("demo-run-naive"), runId: "real-naive", sample: false };
    const withReal = comparisonPairs([realGuarded, realNaive, ...fixtures]);
    expect(withReal[0]).toMatchObject({ sample: false, guarded: { runId: "real-guarded" }, naive: { runId: "real-naive" } });
    // Real runs with a different seed are a different world.
    const otherSeed = { ...realNaive, seed: realGuarded.seed + 1 };
    expect(comparisonPairs([realGuarded, otherSeed]).length).toBe(0);
  });
  it("prefers the selected run's own world", () => {
    const pairs = comparisonPairs(fixtures);
    expect(pickPair(pairs, byId("demo-change-api-notarize-dodo"))?.guarded.runId).toBe("demo-change-api-run-guarded");
    expect(pickPair(pairs, byId("demo-run-naive"))?.guarded.runId).toBe("demo-run-guarded");
    expect(pickPair([], byId("demo-run-naive"))).toBeUndefined();
  });
  it("reads every value from the bundles and never invents a missing one", () => {
    const pair = { naive: byId("demo-run-naive"), guarded: byId("demo-run-guarded") };
    const rows = comparisonRows(pair);
    const unsafe = rows.find((r) => r.key === "unsafe_actions_total")!;
    expect(unsafe.naive).toBe(pair.naive.metrics.unsafe_actions_total);
    expect(unsafe.guarded).toBe(pair.guarded.metrics.unsafe_actions_total);
    expect(unsafe.delta).toBe(unsafe.guarded! - unsafe.naive!);
    const accuracy = rows.find((r) => r.key === "decision_accuracy")!;
    expect(accuracy.delta).toBe(
      Math.round((pair.guarded.metrics.decision_accuracy! - pair.naive.metrics.decision_accuracy!) * 1000) / 10,
    );
    expect(rows.find((r) => r.key === "credits")?.guarded).toBe(pair.guarded.credits.total);
    const missing = comparisonRows({
      naive: { ...pair.naive, metrics: { ...pair.naive.metrics, decision_accuracy: null } },
      guarded: pair.guarded,
    }).find((r) => r.key === "decision_accuracy")!;
    expect(missing.naive).toBeNull();
    expect(missing.delta).toBeNull();
  });
});

describe("report: cost per run", () => {
  it("marks model usage with no recorded price as unknown, never $0", () => {
    const dodo = byId("demo-notarize-dodo");
    const roles = roleCosts(dodo);
    for (const r of roles) {
      const u = dodo.usageByRole[r.role];
      if (u.calls === 0 && u.inputTokens + u.outputTokens === 0) expect(r.price).toBe("none");
      else if (u.usd === 0) expect(r.price).toBe("unknown");
      else expect(r.price).toBe("recorded");
    }
    const cost = runCost(dodo);
    expect(cost.unknownRoles.length).toBeGreaterThan(0);
    expect(cost.recordedUsd).toBe(0);
    expect(cost.creditsUsed).toBe(dodo.credits.total);
  });
  it("sums recorded prices only, and knows when a role made no calls", () => {
    const priced = { ...byId("demo-notarize-dodo") };
    priced.usageByRole = {
      executor: { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 },
      reflector: { inputTokens: 10, outputTokens: 5, usd: 0.25, calls: 1 },
      adversary: { inputTokens: 10, outputTokens: 5, usd: 0, calls: 1 },
    };
    const cost = runCost(priced);
    expect(cost.recordedUsd).toBe(0.25);
    expect(cost.unknownRoles).toEqual(["adversary"]);
    expect(roleCosts(priced).find((r) => r.role === "executor")?.price).toBe("none");
  });
  it("splits runs by cohort", () => {
    const realRun = { ...byId("demo-run-guarded"), runId: "real", sample: false };
    const cohorts = byCohort([realRun, ...fixtures]);
    expect(cohorts.map((c) => c.sample)).toEqual([false, true]);
    expect(cohorts[0]!.runs.every((b) => !b.sample)).toBe(true);
    expect(cohorts[1]!.runs.every((b) => b.sample)).toBe(true);
    // The synthetic SAMPLE bundle is neither real nor fixture: its own cohort, never in the fixture list.
    const synthetic = { ...byId("demo-run-guarded"), runId: "sample-x", kind: "sample" as const, variant: "sample" as const };
    const three = byCohort([realRun, ...fixtures, synthetic]);
    expect(three.map((c) => c.cohort)).toEqual(["real", "fixture", "synthetic"]);
    expect(three[1]!.runs.some((b) => b.kind === "sample")).toBe(false);
  });
  it("lists trace receipts as recorded, else the records' trace ids", () => {
    const guarded = byId("demo-run-guarded");
    expect(runTraces(guarded).map((t) => t.traceId).sort()).toEqual(Object.keys(guarded.traceLinks).sort());
    expect(runTraces(guarded).every((t) => t.recorded === guarded.traceLinks[t.traceId])).toBe(true);
    const bare = { ...guarded, traceLinks: {} };
    const ids = runTraces(bare);
    expect(ids.every((t) => t.source === "records" && t.recorded === undefined)).toBe(true);
    expect(new Set(ids.map((t) => t.traceId)).size).toBe(ids.length);
  });
});

describe("certificates", () => {
  it("drops a reason that only repeats the status word", () => {
    expect(reasonText({ kind: "never_probed", reason: "never probed" })).toBe("");
    expect(reasonText({ kind: "abstained", reason: "abstained: no further probe design" })).toBe("no further probe design");
    expect(reasonText({ kind: "revoked", reason: "certificate revoked: crossed back over 0.5" })).toBe(
      "certificate revoked: crossed back over 0.5",
    );
  });
  it("filters one provider without mixing in another", () => {
    const w = world("default");
    for (const tool of w.report.tools.map((t) => t.tool)) {
      const view = filterWorld(w, tool);
      expect([...view.certificates, ...view.revocations, ...view.noCertificates].every((r) => r.tool === tool)).toBe(true);
      expect(view.counts).toEqual(w.report.tools.find((t) => t.tool === tool)?.counts);
    }
    expect(filterWorld(w, null).certificates).toHaveLength(w.certificates.length);
  });
  it("sends an old belief link to its certificate, or to its claim", () => {
    const w = world("default");
    const cert = w.certificates[0]!;
    expect(resolveBelief(w, fixtures, cert.beliefId).certificate?.id).toBe(cert.id);
    expect(resolveBelief(w, fixtures, "belief-that-does-not-exist")).toEqual({});
  });
  it("links each probe to the fixture run that recorded it, and its trace as recorded", () => {
    const w = world("default");
    for (const c of w.certificates) {
      const traces = certificateTraces(c, fixtures);
      expect(traces.map((t) => t.probeId)).toEqual(c.evidence.map((e) => e.probeId));
      for (const t of traces) {
        const run = runWithProbe(fixtures, t.probeId, true);
        expect(t.runId).toBe(run?.runId);
        if (run) expect(run.sample).toBe(true);
      }
    }
  });
  it("finds the decisions held after a revocation in its source run", () => {
    const w = world("change-api");
    for (const r of w.revocations) {
      const held = heldAfterRevocation(r, fixtures)!;
      expect(held.run.runId).toBe(r.sourceBundle.runId);
      for (const id of held.decisionIds) {
        const d = held.run.decisions.find((x) => x.id === id)!;
        expect(d.status).toBe("held");
        expect(d.missingBeliefs).toContain(r.beliefId);
      }
    }
  });
});
