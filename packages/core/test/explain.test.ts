// Explain engine (src/explain/): deterministic answers from records only, every citation resolving,
// one data world per answer. Uses the published fixture bundles (read-only).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeBundle } from "../src/bundle/hash.js";
import { AnswerWriter } from "../src/explain/text.js";
import {
  RecordIndex,
  indexApprovals,
  indexBundles,
  indexCertificates,
  indexTimelines,
  indexWorld,
  makeWorld,
  revocations,
  runDiff,
  timelineEventId,
  toolKnowledge,
  validateCitations,
  whyHeld,
  worldKeyOf,
} from "../src/explain/index.js";
import type { World } from "../src/explain/index.js";
import { EXPLAIN_PATHS, loadPublishedWorlds, worldAnswers } from "../src/explain/export.js";
import { demoScenarioOf } from "../src/demo/index.js";
import type { RunBundle } from "../src/schema/index.js";

const FIXTURE_DIR = join(EXPLAIN_PATHS.webBundlesDir, "fixture");
const fixtureBundles: RunBundle[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json") && f !== "index.json" && !f.endsWith(".timeline.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as RunBundle);

const { worlds } = loadPublishedWorlds();
const world = (key: string): World => {
  const w = worlds.find((x) => x.key === key);
  if (!w) throw new Error(`no world ${key}`);
  return w;
};
const bundle = (w: World, variant: string): RunBundle => w.bundles.find((b) => b.kind === "run" && b.variant === variant)!;

describe("worlds", () => {
  it("worldKeyOf agrees with the demo's scenario of every published fixture bundle", () => {
    expect(fixtureBundles.length).toBeGreaterThan(0);
    for (const b of fixtureBundles) expect(worldKeyOf(b)).toBe(`fixture:${demoScenarioOf(b.runId)}`);
  });

  it("published worlds: real first (no live runs today), then one world per fixture scenario", () => {
    expect(worlds.map((w) => w.key)).toEqual(["real", "fixture:change-api", "fixture:default"]);
    const real = world("real");
    expect(real.sample).toBe(false);
    for (const w of worlds.slice(1)) {
      expect(w.sample).toBe(true);
      for (const b of w.bundles) expect(worldKeyOf(b)).toBe(w.key);
    }
  });

  it("refuses to build a world that mixes scenarios, or fixture with real", () => {
    const a = bundle(world("fixture:default"), "guarded");
    const b = bundle(world("fixture:change-api"), "guarded");
    expect(() => makeWorld([a, b])).toThrow(/different worlds/);
    const real = finalizeBundle({ ...a, runId: "real-run", sample: false, disclosure: [] });
    expect(worldKeyOf(real)).toBe("real");
    expect(() => makeWorld([a, real])).toThrow(/different worlds/);
  });

  it("refuses certificates that do not come from the world's own bundles", () => {
    const def = world("fixture:default");
    const other = world("fixture:change-api");
    expect(() => makeWorld(def.bundles, other.certificates)).toThrow(/not a bundle of world/);
  });
});

describe("whyHeld", () => {
  const def = world("fixture:default");
  const guarded = bundle(def, "guarded");

  it("matches each held decision's actual missing beliefs, and cites them", () => {
    for (const w of worlds) {
      for (const b of w.bundles.filter((x) => x.kind === "run" && x.variant === "guarded")) {
        for (const d of b.decisions.filter((x) => x.status === "held")) {
          const a = whyHeld(b, d.id, w);
          const heldBecause = [...a.answer.matchAll(/It was held because required belief (\S+) was not notarized/g)].map((m) => m[1]);
          expect(heldBecause.sort()).toEqual(d.missingBeliefs.map((id) => id.replace(/^belief-/, "")).sort());
          for (const id of d.missingBeliefs) expect(a.citations).toContainEqual({ kind: "belief", id, runId: b.runId });
          expect(a.citations).toContainEqual(expect.objectContaining({ kind: "decision", id: d.id, runId: b.runId }));
          const required = a.answer.match(/requires (\d+) notarized belief/);
          if (d.requiredBeliefs.length) expect(Number(required?.[1])).toBe(d.requiredBeliefs.length);
          // Every evidence-pack probe resolves and is cited with its own run.
          for (const pid of d.evidencePack?.relatedProbeIds ?? []) expect(a.citations.some((c) => c.kind === "probe" && c.id === pid)).toBe(true);
          if (!d.missingBeliefs.length) expect(a.answer).toMatch(/guard grd-[0-9a-f]+|neither a missing belief nor a guard/);
        }
      }
    }
  });

  it("names the refusing guard when no belief was missing (default q08: block guard on wallet credits)", () => {
    const d = guarded.decisions.find((x) => x.requestId === "q08")!;
    expect(d.missingBeliefs).toEqual([]);
    const a = whyHeld(guarded, d.id, def);
    const g = guarded.guards.find((x) => d.guardsApplied.includes(x.id))!;
    expect(a.answer).toContain(`It was held because the recorded reason names guard ${g.id} (${g.kind} on ${g.operation}`);
    expect(a.citations).toContainEqual({ kind: "guard", id: g.id, runId: guarded.runId });
  });

  it("change-api q10: the sentinel's un-learn event, the revoked certificate and the retired guard", () => {
    const w = world("fixture:change-api");
    const b = bundle(w, "guarded");
    const d = b.decisions.find((x) => x.requestId === "q10")!;
    const a = whyHeld(b, d.id, w);
    const rev = w.certificates.flatMap((t) => t.revocations).find((r) => r.beliefId === d.missingBeliefs[0])!;
    expect(rev).toBeDefined();
    expect(a.citations).toContainEqual(expect.objectContaining({ kind: "revocation", id: rev.id }));
    expect(a.answer).toContain(`notarized → unlearned at ${rev.revokedAt}`);
    expect(a.citations.some((c) => c.kind === "belief_event")).toBe(true);
  });

  it("refuses a decision that was not held, and a bundle outside the world", () => {
    const executed = guarded.decisions.find((x) => x.status !== "held")!;
    expect(() => whyHeld(guarded, executed.id, def)).toThrow(/not held/);
    const other = bundle(world("fixture:change-api"), "guarded");
    expect(() => whyHeld(other, other.decisions[0]!.id, def)).toThrow(/not a bundle of world/);
  });

  it("states missing records plainly instead of inventing them (evidence-pack probes from runs not loaded)", () => {
    const d = guarded.decisions.find((x) => x.missingBeliefs.length && x.evidencePack?.relatedProbeIds.length)!;
    const alone = whyHeld(guarded, d.id); // this bundle only: the notarize run's probes are absent
    expect(alone.answer).toMatch(/not in any published run of this world/);
    expect(alone.answer).toMatch(/No certificates were supplied|No dodo certificates were supplied/);
    expect(alone.citations.every((c) => c.runId === guarded.runId)).toBe(true);
  });
});

describe("toolKnowledge", () => {
  it("counts match the certificates and the latest belief snapshots", () => {
    for (const w of worlds.filter((x) => x.bundles.length)) {
      for (const t of w.certificates) {
        const a = toolKnowledge(t.tool, w)!;
        const active = t.certificates.filter((c) => c.status === "active");
        if (active.length) {
          const m = a.answer.match(/Certified: (\d+) \S+ claims? \((\d+) match(?:es)? the docs, (\d+) contradicts? them\)/);
          expect(m?.slice(1).map(Number)).toEqual([active.length, active.filter((c) => c.side === "honored").length, active.filter((c) => c.side === "violated").length]);
        }
        expect(a.answer).toContain(`Unproven: ${t.noCertificates.length} ${t.tool} claim`);
        for (const c of t.certificates) expect(a.citations).toContainEqual({ kind: "certificate", id: c.id, runId: c.sourceBundle.runId });
      }
    }
  });

  it("accepts bundles + certificates directly, and returns null when no run speaks about the tool", () => {
    const w = world("fixture:default");
    const crust = w.bundles.filter((b) => b.tool === "crustdata");
    expect(toolKnowledge("crustdata", crust)).not.toBeNull();
    expect(toolKnowledge("dodo", crust)).toBeNull();
  });
});

describe("runDiff", () => {
  it("decision status changes, unsafe counts and metric deltas are computed from the two bundles", () => {
    for (const w of worlds.filter((x) => x.bundles.length)) {
      const naive = bundle(w, "naive");
      const guarded = bundle(w, "guarded");
      const a = runDiff(naive, guarded, w)!;
      const changed = guarded.decisions.filter((d) => naive.decisions.find((n) => n.requestId === d.requestId)?.status !== d.status);
      expect(a.answer).toContain(`${changed.length} of ${guarded.decisions.length} queue items changed status`);
      const ua = naive.metrics.unsafe_actions_total;
      const ub = guarded.metrics.unsafe_actions_total;
      if (typeof ua === "number" && typeof ub === "number" && ua !== ub) expect(a.answer).toContain(`unsafe_actions_total ${ua} → ${ub}`);
      expect(a.answer).toContain("records no belief snapshot");
    }
  });

  it("is null-safe: a metric null in one run is listed as not comparable, never as a delta", () => {
    const w = world("fixture:default");
    const naive = bundle(w, "naive");
    const guarded = bundle(w, "guarded");
    const a = runDiff(naive, guarded, w)!;
    const nullInNaive = Object.keys(guarded.metrics).filter((k) => naive.metrics[k] === null && typeof guarded.metrics[k] === "number");
    expect(nullInNaive.length).toBeGreaterThan(0);
    for (const k of nullInNaive) {
      expect(a.answer).not.toMatch(new RegExp(`\\b${k.replace(/[.]/g, "\\.")} [-0-9.]+ →`));
      expect(a.answer).toContain(k);
    }
  });

  it("never compares fixture with real, or two fixture scenarios", () => {
    const a = bundle(world("fixture:default"), "naive");
    const b = bundle(world("fixture:change-api"), "guarded");
    expect(() => runDiff(a, b)).toThrow(/different worlds/);
    const real = finalizeBundle({ ...a, runId: "real-naive", sample: false, disclosure: [] });
    expect(() => runDiff(real, a)).toThrow(/different worlds/);
  });
});

describe("revocations", () => {
  it("change-api: the revocation with its trigger probes, traces and retired guards", () => {
    const w = world("fixture:change-api");
    const a = revocations(w)!;
    const revs = w.certificates.flatMap((t) => t.revocations);
    expect(revs.length).toBeGreaterThan(0);
    for (const r of revs) {
      expect(a.citations).toContainEqual(expect.objectContaining({ kind: "revocation", id: r.id }));
      for (const p of r.triggerProbeIds) expect(a.citations.some((c) => c.kind === "probe" && c.id === p)).toBe(true);
      for (const t of r.triggerTraceIds) expect(a.answer).toContain(t);
      for (const g of r.guardsRetired) expect(a.citations).toContainEqual({ kind: "guard", id: g.id, runId: r.sourceBundle.runId });
    }
  });

  it("default: says plainly that nothing was revoked; the real world (no certificates issued) gives no answer", () => {
    const a = revocations(world("fixture:default"))!;
    expect(a.answer).toMatch(/No certificate in fixture scenario default was revoked/);
    expect(revocations(world("real"))).toBeNull();
  });
});

describe("citations", () => {
  it("every answer's citations resolve in its own world, and in no other world's index", () => {
    for (const w of worlds) {
      const own = indexWorld(w);
      for (const a of worldAnswers(w)) {
        expect(validateCitations(a.citations, own)).toEqual({ ok: true, invalid: [] });
        expect(a.sample).toBe(w.sample);
      }
    }
  });

  it("an empty citation list or an unknown record is invalid", () => {
    const index = indexBundles(world("fixture:default").bundles);
    expect(validateCitations([], index).ok).toBe(false);
    const r = validateCitations([{ kind: "probe", id: "no-such-probe" }], index);
    expect(r.ok).toBe(false);
    expect(r.invalid).toHaveLength(1);
    // A citation naming the wrong run is invalid even if the id exists elsewhere.
    const p = world("fixture:default").bundles.find((b) => b.probes.length)!.probes[0]!;
    expect(validateCitations([{ kind: "probe", id: p.id, runId: "demo-run-naive" }], index).ok).toBe(false);
  });

  it("indexes certificates by source run, timelines as <runId>#<seq>, approvals by id", () => {
    const w = world("fixture:change-api");
    const index = indexCertificates(w.certificates, new RecordIndex());
    const c = w.certificates[0]!.certificates[0]!;
    expect(index.has({ kind: "certificate", id: c.id, runId: c.sourceBundle.runId })).toBe(true);
    expect(index.has({ kind: "certificate", id: c.id, runId: "elsewhere" })).toBe(false);
    indexTimelines([{ runId: "r1", sample: true, events: [{ seq: 0, traceIds: [] }] }], index);
    expect(index.has({ kind: "timeline_event", id: timelineEventId("r1", 0), runId: "r1" })).toBe(true);
    indexApprovals([{ runId: "r1", sample: true, approvals: [{ id: "appr-1" }] }], index);
    expect(index.has({ kind: "approval", id: "appr-1" })).toBe(true);
  });

  it("the writer refuses an uncited sentence", () => {
    const w = new AnswerWriter();
    expect(() => w.say("A fact with no record", [])).toThrow(/uncited/);
  });
});
