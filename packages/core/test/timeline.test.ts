// v2 run timeline (src/timeline): derivation, the runs/<runId>/timeline.jsonl writer, publishing and
// GET /api/bundles/:id/timeline. Derivation tests read the COMMITTED fixture bundles in
// packages/web/public/bundles/fixture/ (read-only, sample: true); everything written goes to temp dirs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bus, NOTARY_EVENT_TYPES } from "../src/api/bus.js";
import { createApp } from "../src/api/server.js";
import { finalizeBundle, verifyBundle, writeBundle } from "../src/bundle/index.js";
import { buildCertificates } from "../src/certify/certificates.js";
import { demoScenarioOf } from "../src/demo/index.js";
import { runExport } from "../src/export/index.js";
import type { RunBundle } from "../src/schema/index.js";
import { TimelineFileSchema } from "../src/schema/timeline.js";
import type { TimelineEvent } from "../src/schema/timeline.js";
import { STAGE_OF_TYPE, TYPE_RANK, budgetSnapshot, deriveTimeline, finalStageOf } from "../src/timeline/derive.js";
import { appendTimelineEvents, readTimeline, timelinePath } from "../src/timeline/store.js";
import {
  TIMELINE_FILE_SUFFIX,
  buildTimelineFile,
  liveDecisionEmitter,
  needsCertificateContext,
  publishTimeline,
  recordRunTimeline,
  timelineEvents,
} from "../src/timeline/write.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../web/public/bundles/fixture/", import.meta.url));
const TEST = "TEST bundle built in test/timeline.test.ts — not a Notary result";
const ZERO = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "notary-timeline-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixtureBundles(): RunBundle[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json") && f !== "index.json" && !f.endsWith(TIMELINE_FILE_SUFFIX))
    .sort()
    .map((f) => {
      const v = verifyBundle(JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")));
      if (!v.ok) throw new Error(`${f}: ${v.error}`);
      return v.bundle;
    });
}
const ALL = fixtureBundles();
const scenario = (name: string): RunBundle[] => ALL.filter((b) => demoScenarioOf(b.runId) === name);
const byId = (id: string): RunBundle => {
  const b = ALL.find((x) => x.runId === id);
  if (!b) throw new Error(`no committed fixture bundle ${id}`);
  return b;
};
const ctxFor = (b: RunBundle): RunBundle[] => scenario(demoScenarioOf(b.runId));

function realBundle(runId: string, extra: Partial<RunBundle> = {}): RunBundle {
  const at = "2026-10-11T10:00:00.000Z";
  return finalizeBundle({
    runId,
    kind: "run",
    variant: "guarded",
    mode: "live",
    sample: false,
    disclosure: [TEST],
    startedAt: at,
    finishedAt: "2026-10-11T10:00:05.000Z",
    status: "completed",
    seed: 0,
    queue: [{ id: "q01", customerId: "c1", companyDomain: "x.test", type: "refund", plan: "starter", paymentId: "p1", amount: 2500, currency: "USD", reason: "test" }],
    decisions: [
      {
        id: `${runId}:q01`,
        requestId: "q01",
        customerId: "c1",
        tier: "smb",
        requestType: "refund",
        policyOutcome: "approve",
        action: "dodo.createRefund",
        requiredBeliefs: ["belief-x"],
        missingBeliefs: ["belief-x"],
        status: "held",
        guardsApplied: [],
        effects: [{ op: "dodo.getPayment", params: {}, status: 200, at: "2026-10-11T10:00:01.000Z" }],
        traceId: "",
      },
    ],
    claims: [],
    anomalies: [],
    hypotheses: [],
    probes: [],
    beliefs: { before: [], after: [] },
    beliefEvents: [],
    guards: [],
    usageByRole: { executor: { ...ZERO, usd: 0.25 }, reflector: ZERO, adversary: ZERO },
    credits: { byEndpoint: { "crustdata.enrichCompany": 2 }, total: 2, budget: 200 },
    metrics: { holds: 1 },
    traceLinks: {},
    cassettes: [],
    ...extra,
  });
}

function approvalEvent(runId: string): Omit<TimelineEvent, "seq"> {
  return {
    runId,
    at: "2026-10-11T11:00:00.000Z",
    stage: "enforce",
    type: "approval.decided",
    recordIds: ["appr-0123456789abcdef", `${runId}:q01`],
    traceIds: [],
    summary: "TEST approval appended by the approval desk.",
    data: { decision: "rejected" },
  };
}

describe("deriveTimeline (committed fixture bundles)", () => {
  it("has fixture bundles of both scenarios to work with", () => {
    expect(scenario("default").length).toBe(4);
    expect(scenario("change-api").length).toBe(4);
  });

  it("is deterministic: the same bundle gives byte-identical events (also after a JSON round trip)", () => {
    for (const b of ALL) {
      const a = JSON.stringify(deriveTimeline(b, { context: ctxFor(b) }));
      const again = JSON.stringify(deriveTimeline(JSON.parse(JSON.stringify(b)) as RunBundle, { context: ctxFor(b) }));
      expect(again).toBe(a);
    }
  });

  it("orders events by time, then type rank, then primary record id; budget and run.finished close the run", () => {
    for (const b of ALL) {
      const ev = deriveTimeline(b, { context: ctxFor(b) });
      const body = ev.slice(0, -2);
      for (let i = 1; i < body.length; i++) {
        const [x, y] = [body[i - 1]!, body[i]!];
        const dt = Date.parse(y.at) - Date.parse(x.at);
        expect(dt).toBeGreaterThanOrEqual(0);
        if (dt === 0) {
          expect(TYPE_RANK[y.type]).toBeGreaterThanOrEqual(TYPE_RANK[x.type]);
          if (TYPE_RANK[y.type] === TYPE_RANK[x.type]) expect((y.recordIds[0] ?? "") >= (x.recordIds[0] ?? "")).toBe(true);
        }
      }
      expect(ev.at(-2)!.type).toBe("budget");
      expect(ev.at(-1)!.type).toBe("run.finished");
      for (const e of body) expect(Date.parse(e.at)).toBeLessThanOrEqual(Date.parse(ev.at(-1)!.at));
    }
  });

  it("maps every type to its stage; budget and run.finished take the bundle kind's last stage", () => {
    for (const b of ALL) {
      for (const e of deriveTimeline(b, { context: ctxFor(b) })) {
        expect(e.runId).toBe(b.runId);
        if (e.type === "budget" || e.type === "run.finished") expect(e.stage).toBe(finalStageOf(b.kind));
        else expect(e.stage).toBe(STAGE_OF_TYPE[e.type]);
        expect(e.traceIds).not.toContain("");
        expect(e.summary.length).toBeGreaterThan(10);
      }
    }
    expect(finalStageOf("notarize")).toBe("certify");
    expect(finalStageOf("run")).toBe("enforce");
  });

  it("emits one event per record: anomalies, probes (committed + verdict), belief events, decisions", () => {
    for (const b of ALL) {
      const ev = deriveTimeline(b, { context: ctxFor(b) });
      const n = (t: string): number => ev.filter((e) => e.type === t).length;
      expect(n("anomaly.detected")).toBe(b.anomalies.length);
      expect(n("probe.committed")).toBe(b.probes.length);
      expect(n("probe.verdict")).toBe(b.probes.filter((p) => p.verdict).length);
      expect(n("belief.changed")).toBe(b.beliefEvents.length);
      expect(n("decision")).toBe(b.decisions.length);
      expect(n("adversary.verdict")).toBe(b.beliefEvents.filter((e) => e.from === "candidate" && e.reason.startsWith("adversary ")).length);
      expect(n("certificate.issued")).toBe(b.beliefEvents.filter((e) => e.to === "notarized" && e.from !== "notarized").length);
      expect(n("certificate.revoked")).toBe(b.beliefEvents.filter((e) => e.from === "notarized" && e.to !== "notarized").length);
    }
    // The fixture notarize-dodo run has adversary reviews in its Challenge stage.
    const adv = deriveTimeline(byId("demo-notarize-dodo")).filter((e) => e.type === "adversary.verdict");
    expect(adv.length).toBeGreaterThan(0);
    expect(adv.every((e) => e.stage === "challenge" && ["uphold", "narrow", "downgrade"].includes(e.data!.verdict as string))).toBe(true);
  });

  it("carries the decision facts the UI needs", () => {
    const b = byId("demo-change-api-run-guarded");
    const ev = deriveTimeline(b, { context: ctxFor(b) }).filter((e) => e.type === "decision");
    for (const [i, d] of b.decisions.entries()) {
      const e = ev.find((x) => x.recordIds[0] === d.id)!;
      expect(e).toBeDefined();
      expect(e.data).toMatchObject({ status: d.status, action: d.action, guardsApplied: d.guardsApplied, missingBeliefs: d.missingBeliefs, requestId: d.requestId });
      expect(e.traceIds).toEqual(d.traceId ? [d.traceId] : []);
      void i;
    }
    // Every decision is placed no earlier than its own last effect.
    for (const d of b.decisions) {
      const e = ev.find((x) => x.recordIds[0] === d.id)!;
      for (const eff of d.effects) expect(Date.parse(e.at)).toBeGreaterThanOrEqual(Date.parse(eff.at));
    }
  });

  it("change-api: the revocation comes before the held decision it causes, with certify's exact ids", () => {
    const b = byId("demo-change-api-run-guarded");
    const ev = deriveTimeline(b, { context: ctxFor(b) });
    const rev = ev.find((e) => e.type === "certificate.revoked")!;
    expect(rev).toBeDefined();
    const held = ev.find((e) => e.type === "decision" && (e.data!.missingBeliefs as string[]).includes(rev.data!.beliefId as string))!;
    expect(held).toBeDefined();
    expect(ev.indexOf(rev)).toBeLessThan(ev.indexOf(held));
    // Same ids `notary export --certificates --fixture` computes for this scenario.
    const set = buildCertificates(ctxFor(b), { fixture: true, scenario: "change-api" });
    const revocations = set.tools.flatMap((t) => t.revocations);
    expect(revocations.map((r) => r.id)).toContain(rev.data!.revocationId);
    expect(rev.recordIds[0]).toBe(rev.data!.revocationId);
    expect(rev.recordIds[1]).toBe(rev.data!.certificateId);
  });

  it("certificate.issued ids across a scenario are exactly the certificates certify issues", () => {
    for (const name of ["default", "change-api"]) {
      const bundles = scenario(name);
      const fromTimeline = new Set(bundles.flatMap((b) => deriveTimeline(b, { context: bundles }).filter((e) => e.type === "certificate.issued").map((e) => e.data!.certificateId as string)));
      const set = buildCertificates(bundles, { fixture: true, scenario: name });
      const fromCertify = new Set(set.tools.flatMap((t) => t.certificates.filter((c) => c.issuedFrom === "event").map((c) => c.id)));
      expect([...fromTimeline].sort()).toEqual([...fromCertify].sort());
      expect(fromTimeline.size).toBeGreaterThan(0);
    }
  });

  it("without the issuing bundle, a revocation has no computed certificate id and says so", () => {
    const b = byId("demo-change-api-run-guarded");
    expect(needsCertificateContext(b)).toBe(true);
    const rev = deriveTimeline(b).find((e) => e.type === "certificate.revoked")!;
    expect(rev.data!.certificateId).toBeNull();
    expect(rev.data!.revocationId).toBeNull();
    expect(rev.recordIds[0]).toBe(rev.data!.beliefId);
    expect(rev.summary).toMatch(/not in this bundle/);
  });

  it("budget snapshot is exact: credits, Σ probe calls + Σ decision effects, usd by role, no invented caps", () => {
    for (const b of ALL) {
      const ev = deriveTimeline(b, { context: ctxFor(b) });
      const snap = ev.at(-2)!.data!.budget as ReturnType<typeof budgetSnapshot>;
      expect(snap.credits).toEqual({ used: b.credits.total, cap: b.credits.budget });
      expect(snap.toolCalls.used).toBe(b.probes.reduce((n, p) => n + p.calls, 0) + b.decisions.reduce((n, d) => n + d.effects.length, 0));
      expect(snap.toolCalls.cap).toBeNull();
      expect(snap.usdCap).toBeNull();
      expect(snap.usdByRole).toEqual({ executor: b.usageByRole.executor.usd, reflector: b.usageByRole.reflector.usd, adversary: b.usageByRole.adversary.usd });
      expect(snap.stopReason).toBe(b.stopReason);
      const fin = ev.at(-1)!.data!;
      expect(fin.budget).toEqual(snap);
      expect(fin.status).toBe(b.status);
      expect(fin.metrics).toEqual(b.metrics);
    }
    const stopped = realBundle("test-stopped", { status: "stopped_budget", stopReason: "credit budget 200 reached" });
    expect(budgetSnapshot(stopped)).toEqual({
      credits: { used: 2, cap: 200 },
      toolCalls: { used: 1, cap: null },
      usdByRole: { executor: 0.25, reflector: 0, adversary: 0 },
      usdCap: null,
      stopReason: "credit budget 200 reached",
    });
    expect(deriveTimeline(stopped).at(-1)!.data).toMatchObject({ status: "stopped_budget", stopReason: "credit budget 200 reached" });
  });
});

describe("runs/<runId>/timeline.jsonl", () => {
  it("is rewritten from the bundle and keeps later approval.decided events after it, re-sequenced", () => {
    const runDir = join(tempDir(), "test-run");
    const b = realBundle("test-run");
    const first = recordRunTimeline(b, runDir, { emit: false });
    expect(first.map((e) => e.seq)).toEqual(first.map((_, i) => i));
    const appended = appendTimelineEvents(runDir, [approvalEvent(b.runId)]);
    expect(appended[0]!.seq).toBe(first.length);
    // A later rewrite (e.g. noise floor re-hash, resume) keeps the approval after the derived events.
    const b2 = finalizeBundle({ ...b, metrics: { holds: 1, extra: 2 } });
    const second = recordRunTimeline(b2, runDir, { emit: false });
    expect(second.length).toBe(first.length + 1);
    expect(second.at(-1)!.type).toBe("approval.decided");
    expect(second.at(-1)!.seq).toBe(second.length - 1);
    expect(second.slice(0, -1).map(({ seq: _s, ...e }) => e)).toEqual(deriveTimeline(b2));
    expect(readTimeline(runDir)).toEqual(second);
    expect(readFileSync(timelinePath(runDir), "utf8").endsWith("\n")).toBe(true);
    expect(existsSync(`${timelinePath(runDir)}.tmp-${process.pid}`)).toBe(false);
  });

  it("emits the written events on the bus as `timeline` events (and the bus knows the type)", () => {
    expect(NOTARY_EVENT_TYPES).toContain("timeline");
    const before = bus.lastId;
    const b = realBundle("test-bus");
    const written = recordRunTimeline(b, join(tempDir(), b.runId));
    const got = bus.since(before).filter((e) => e.type === "timeline").map((e) => e.payload as TimelineEvent);
    expect(got).toEqual(written);
  });

  it("live decision events are marked live and carry the decision facts", () => {
    const before = bus.lastId;
    const b = realBundle("test-live");
    const emit = liveDecisionEmitter(b.runId, b.queue, () => new Date("2026-10-11T10:00:02.000Z"));
    emit(b.decisions[0]!);
    const got = bus.since(before).filter((e) => e.type === "timeline").map((e) => e.payload as TimelineEvent);
    expect(got.length).toBe(1);
    expect(got[0]).toMatchObject({ runId: b.runId, type: "decision", stage: "enforce", seq: 0, at: "2026-10-11T10:00:01.000Z" });
    expect(got[0]!.data).toMatchObject({ live: true, status: "held", amount: 2500, currency: "USD", missingBeliefs: ["belief-x"] });
  });
});

describe("published timelines", () => {
  it("the committed fixture timelines are valid TimelineFiles tied to their bundles and equal what code derives", () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(TIMELINE_FILE_SUFFIX)).sort();
    expect(files.length).toBe(ALL.length);
    for (const f of files) {
      const raw = readFileSync(join(FIXTURE_DIR, f), "utf8");
      const tl = TimelineFileSchema.parse(JSON.parse(raw));
      const b = byId(f.slice(0, -TIMELINE_FILE_SUFFIX.length));
      expect(tl.runId).toBe(b.runId);
      expect(tl.sample).toBe(true);
      expect(tl.bundleHash).toBe(b.contentHash);
      expect(tl.events.map((e) => e.seq)).toEqual(tl.events.map((_, i) => i));
      expect(tl.events.every((e) => e.runId === b.runId)).toBe(true);
      expect(raw).toBe(`${JSON.stringify(buildTimelineFile(b, { context: ctxFor(b) }), null, 2)}\n`);
    }
  });

  it("refuses to mix fixture and real data, and refuses tampered bundles", async () => {
    const dir = tempDir();
    const fixture = byId("demo-run-naive");
    const real = realBundle("test-real");
    await expect(publishTimeline(real, dir, { expectSample: true })).rejects.toThrow(/fixture and real data never mix/);
    await expect(publishTimeline(fixture, dir, { expectSample: false })).rejects.toThrow(/fixture and real data never mix/);
    await expect(publishTimeline({ ...real, metrics: { holds: 99 } }, dir, { expectSample: false })).rejects.toThrow(/refusing to publish timeline/);
    expect(readdirSync(dir)).toEqual([]);
    const path = await publishTimeline(real, dir, { expectSample: false });
    expect(path).toBe(join(dir, `test-real${TIMELINE_FILE_SUFFIX}`));
  });

  it("notary export publishes a timeline next to each real bundle it copies (with runs/<id> approvals)", async () => {
    const root = tempDir();
    const runsDir = join(root, "runs");
    const web = join(root, "bundles");
    const b = realBundle("test-export-run");
    mkdirSync(join(runsDir, b.runId), { recursive: true });
    writeFileSync(join(runsDir, b.runId, `${b.runId}.json`), JSON.stringify(b, null, 2));
    recordRunTimeline(b, join(runsDir, b.runId), { emit: false });
    appendTimelineEvents(join(runsDir, b.runId), [approvalEvent(b.runId)]);
    const r = await runExport({ runsDir, exportDir: join(root, "export"), docsDir: join(root, "docs"), driftDir: join(root, "drift"), checks: null, webBundlesDir: web, now: () => new Date("2026-10-11T12:00:00.000Z") });
    expect(r.copied).toEqual([b.runId]);
    const tl = TimelineFileSchema.parse(JSON.parse(readFileSync(join(web, `${b.runId}${TIMELINE_FILE_SUFFIX}`), "utf8")));
    expect(tl).toMatchObject({ runId: b.runId, sample: false, bundleHash: b.contentHash });
    expect(tl.events.at(-1)!.type).toBe("approval.decided");
    expect(tl.events).toEqual(timelineEvents(b, { runDir: join(runsDir, b.runId) }));
  });
});

describe("GET /api/bundles/:id/timeline", () => {
  async function setup(): Promise<{ web: string; runsDir: string; b: RunBundle }> {
    const root = tempDir();
    const web = join(root, "bundles");
    const runsDir = join(root, "runs");
    mkdirSync(runsDir, { recursive: true });
    const b = realBundle("test-api-run");
    await writeBundle(b, web);
    return { web, runsDir, b };
  }

  it("serves the published TimelineFile, 404s when absent, 400s on a bad id", async () => {
    const { web, runsDir, b } = await setup();
    const app = createApp({ bundleDirs: [web], runsDir });
    expect((await app.request(`/api/bundles/${b.runId}/timeline`)).status).toBe(404);
    expect((await app.request("/api/bundles/unknown-run/timeline")).status).toBe(404);
    expect((await app.request("/api/bundles/..%2Fetc/timeline")).status).toBe(400);
    await publishTimeline(b, web, { expectSample: false });
    const res = await app.request(`/api/bundles/${b.runId}/timeline`);
    expect(res.status).toBe(200);
    const tl = TimelineFileSchema.parse(await res.json());
    expect(tl).toEqual(buildTimelineFile(b));
  });

  it("prefers runs/<id>/timeline.jsonl (the source of truth, with approvals)", async () => {
    const { web, runsDir, b } = await setup();
    await publishTimeline(b, web, { expectSample: false });
    const runDir = join(runsDir, b.runId);
    recordRunTimeline(b, runDir, { emit: false });
    appendTimelineEvents(runDir, [approvalEvent(b.runId)]);
    const app = createApp({ bundleDirs: [web], runsDir });
    const tl = TimelineFileSchema.parse(await (await app.request(`/api/bundles/${b.runId}/timeline`)).json());
    expect(tl.bundleHash).toBe(b.contentHash);
    expect(tl.events.at(-1)!.type).toBe("approval.decided");
  });

  it("refuses a published timeline that does not belong to the indexed bundle", async () => {
    const { web, runsDir, b } = await setup();
    const file = buildTimelineFile(b);
    writeFileSync(join(web, `${b.runId}${TIMELINE_FILE_SUFFIX}`), JSON.stringify({ ...file, bundleHash: "0".repeat(64) }));
    const app = createApp({ bundleDirs: [web], runsDir });
    const res = await app.request(`/api/bundles/${b.runId}/timeline`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/does not belong/);
  });
});
