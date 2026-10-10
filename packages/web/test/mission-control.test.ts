// Mission control's pure logic against the real published fixture timelines and bundles.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BundleIndexSchema } from "../../core/src/schema/bundle";
import type { RunBundle, TimelineEvent } from "../../core/src/schema";
import { validateBundle } from "../src/data";
import {
  REPLAY_MAX_STEP_MS,
  REPLAY_MIN_STEP_MS,
  STAGES,
  STAGE_EDGES,
  advance,
  checkTimeline,
  cursorAt,
  displayGap,
  edgesForNewEvents,
  elapsedAtCursor,
  failureOf,
  filterFeed,
  finishedStatus,
  firstBudgetSeq,
  latestBudget,
  meterView,
  mergeEvents,
  nodeStates,
  parseStreamData,
  recordLinkFor,
  replayDuration,
  shortRecordId,
  replayOffsets,
  stageLines,
  stageStats,
  toastFor,
  traceRefs,
  transitionEdges,
  unsafeDecisionIds,
  usdView,
} from "../src/pages/mission-control/model";
import { stageLayout } from "../src/pages/mission-control/StageGraph";
import { timelineUrls } from "../src/pages/mission-control/hooks";

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8"));
const index = BundleIndexSchema.parse(read("bundles/fixture/index.json"));
const bundles = new Map<string, RunBundle>(
  index.map((e) => [e.runId, validateBundle(read(`bundles/fixture/${e.runId}.json`), e)]),
);
const timelineRaw = (runId: string) => read(`bundles/fixture/${runId}.timeline.json`);
const timeline = (runId: string) => {
  const checked = checkTimeline(timelineRaw(runId), bundles.get(runId)!);
  if (!checked.ok) throw new Error(checked.error);
  return checked.file.events;
};
const guarded = bundles.get("demo-run-guarded")!;
const changeApi = bundles.get("demo-change-api-run-guarded")!;
const naive = bundles.get("demo-run-naive")!;
const dodo = bundles.get("demo-notarize-dodo")!;

describe("timeline validation", () => {
  it("accepts every published fixture timeline for its verified bundle", () => {
    expect(index.length).toBe(8);
    for (const e of index) {
      const checked = checkTimeline(timelineRaw(e.runId), bundles.get(e.runId)!);
      expect(checked.ok, e.runId).toBe(true);
    }
  });

  it("withholds a timeline whose bundleHash is not the selected bundle's contentHash", () => {
    const checked = checkTimeline(timelineRaw("demo-run-guarded"), {
      ...guarded,
      contentHash: "0".repeat(64),
    });
    expect(checked).toMatchObject({ ok: false });
    expect(!checked.ok && checked.error).toMatch(/hash mismatch.*data withheld/);
  });

  it("withholds another run's timeline, a sample-flag mismatch, bad schema and disordered seq", () => {
    expect(checkTimeline(timelineRaw("demo-run-naive"), guarded).ok).toBe(false);
    expect(checkTimeline(timelineRaw("demo-run-guarded"), { ...guarded, sample: false }).ok).toBe(false);
    expect(checkTimeline({ runId: guarded.runId }, guarded).ok).toBe(false);
    const raw = timelineRaw("demo-run-guarded");
    [raw.events[0], raw.events[1]] = [raw.events[1], raw.events[0]];
    expect(checkTimeline(raw, guarded)).toMatchObject({ ok: false });
  });
});

describe("stage counts and node states", () => {
  it("counts every event once, by stage, matching the file", () => {
    for (const e of index) {
      const events = timeline(e.runId);
      const stats = stageStats(events);
      expect(STAGES.reduce((n, s) => n + stats[s].count, 0)).toBe(events.length);
      for (const s of STAGES)
        expect(stats[s].count).toBe(events.filter((x) => x.stage === s).length);
    }
  });

  it("a finished guarded queue run: Enforce done, the stages it never reached idle", () => {
    const events = timeline(guarded.runId);
    const stats = stageStats(events, unsafeDecisionIds(guarded));
    const states = nodeStates(events, stats);
    expect(states).toEqual({ read: "idle", test: "idle", challenge: "idle", certify: "idle", enforce: "done" });
    expect(stats.enforce.byType.decision).toBe(guarded.decisions.length);
    expect(stats.enforce.byStatus.held).toBe(guarded.decisions.filter((d) => d.status === "held").length);
    expect(stageLines(stats.enforce)[0]).toBe(`${guarded.decisions.length} decisions`);
  });

  it("mid-replay the latest event's stage is active and earlier stages are done", () => {
    const events = timeline(changeApi.runId);
    const firstProbe = events.findIndex((e) => e.type === "probe.committed");
    const shown = events.slice(0, firstProbe + 1);
    const states = nodeStates(shown, stageStats(shown));
    expect(states.test).toBe("active");
    expect(states.enforce).toBe("done");
    expect(states.certify).toBe("idle");
  });

  it("the change-api run fails Certify once the revocation is replayed, not before", () => {
    const events = timeline(changeApi.runId);
    const revoked = events.findIndex((e) => e.type === "certificate.revoked");
    expect(revoked).toBeGreaterThan(0);
    const before = events.slice(0, revoked - 1);
    expect(nodeStates(before, stageStats(before)).certify).not.toBe("failed");
    const after = events.slice(0, revoked + 1);
    const stats = stageStats(after);
    expect(nodeStates(after, stats).certify).toBe("failed");
    expect(stats.certify.failures).toEqual({ "belief unlearned": 1, "certificate revoked": 1 });
  });

  it("the naive run fails Enforce through graded unsafe decisions", () => {
    const unsafe = unsafeDecisionIds(naive);
    expect(unsafe.size).toBeGreaterThan(0);
    const events = timeline(naive.runId);
    const stats = stageStats(events, unsafe);
    expect(stats.enforce.failures["unsafe action"]).toBe(unsafe.size);
    expect(nodeStates(events, stats).enforce).toBe("failed");
    // Without the bundle's grades nothing is invented.
    expect(stageStats(events).enforce.failures).toEqual({});
  });

  it("run.finished with a failing status fails its stage", () => {
    const finished = timeline(guarded.runId).at(-1)!;
    expect(failureOf({ ...finished, data: { ...finished.data, status: "stopped_budget" } })).toBe("run stopped budget");
    expect(failureOf(finished)).toBeNull();
  });
});

describe("edges", () => {
  it("chains the five stages", () => {
    expect(STAGE_EDGES.map((e) => e.id)).toEqual([
      "read->test",
      "test->challenge",
      "challenge->certify",
      "certify->enforce",
    ]);
    expect(transitionEdges("test", "certify")).toEqual(["test->challenge", "challenge->certify"]);
    expect(transitionEdges("enforce", "test")).toEqual(["test->challenge", "challenge->certify", "certify->enforce"]);
    expect(transitionEdges("test", "test")).toEqual([]);
  });

  it("lights edges only for hand-offs among new events", () => {
    const events = timeline(changeApi.runId);
    const probe = events.findIndex((e) => e.type === "probe.committed");
    expect(edgesForNewEvents(events.slice(0, probe), probe - 1)).toEqual([]);
    expect(edgesForNewEvents(events.slice(0, probe + 1), probe)).toEqual(
      transitionEdges("enforce", "test"),
    );
  });
});

describe("replay clock", () => {
  it("uses real gaps clamped to the floor and cap", () => {
    expect(displayGap(0)).toBe(REPLAY_MIN_STEP_MS);
    expect(displayGap(-5)).toBe(REPLAY_MIN_STEP_MS);
    expect(displayGap(500)).toBe(500);
    expect(displayGap(60_000)).toBe(REPLAY_MAX_STEP_MS);
    const events = timeline(dodo.runId);
    const offsets = replayOffsets(events);
    expect(offsets).toHaveLength(events.length);
    expect(offsets[0]).toBe(REPLAY_MIN_STEP_MS);
    for (let i = 1; i < events.length; i++) {
      const real = Date.parse(events[i]!.at) - Date.parse(events[i - 1]!.at);
      expect(offsets[i]! - offsets[i - 1]!).toBe(displayGap(real));
    }
  });

  it("cursor counts the events whose time has come; seeking round-trips", () => {
    const offsets = replayOffsets(timeline(guarded.runId));
    expect(cursorAt(offsets, 0)).toBe(0);
    expect(cursorAt(offsets, offsets[0]! - 1)).toBe(0);
    expect(cursorAt(offsets, offsets[0]!)).toBe(1);
    expect(cursorAt(offsets, replayDuration(offsets))).toBe(offsets.length);
    for (let c = 0; c <= offsets.length; c++) expect(cursorAt(offsets, elapsedAtCursor(offsets, c))).toBe(c);
  });

  it("speed scales wall time and never runs past the end", () => {
    expect(advance(0, 100, 8, 10_000)).toBe(800);
    expect(advance(9_900, 100, 4, 10_000)).toBe(10_000);
    const offsets = replayOffsets(timeline(guarded.runId));
    const d = replayDuration(offsets);
    // At 8× the whole guarded run replays in duration / 8 of wall time.
    expect(cursorAt(offsets, advance(0, d / 8, 8, d))).toBe(offsets.length);
  });
});

describe("feed", () => {
  it("filters by stage, newest first", () => {
    const events = timeline(changeApi.runId);
    const all = filterFeed(events, null);
    expect(all[0]!.seq).toBe(events.at(-1)!.seq);
    const test = filterFeed(events, "test");
    expect(test.every((e) => e.stage === "test")).toBe(true);
    expect(test.length).toBe(events.filter((e) => e.stage === "test").length);
    expect(test[0]!.seq).toBeGreaterThan(test.at(-1)!.seq);
  });

  it("links every event to an existing record, keeping ?run=", () => {
    for (const b of [guarded, changeApi, dodo]) {
      const beliefIds = new Set([...b.beliefs.before, ...b.beliefs.after].map((x) => x.id));
      for (const e of timeline(b.runId)) {
        const link = recordLinkFor(e, b);
        if (e.type === "anomaly.detected" && !link) continue;
        expect(link, `${b.runId}#${e.seq} ${e.type}`).toBeDefined();
        expect(link!.path).toContain(`?run=${encodeURIComponent(b.runId)}`);
        if (link!.kind === "decision") {
          expect(b.decisions.some((d) => d.id === link!.id)).toBe(true);
          expect(link!.path.startsWith("/app/queue/")).toBe(true);
        }
        if (link!.kind === "probe") expect(b.probes.some((p) => p.id === link!.id)).toBe(true);
        if (link!.kind === "belief") expect(beliefIds.has(link!.id)).toBe(true);
        if (link!.kind === "certificate") expect(link!.path.startsWith("/app/certificates/cert-")).toBe(true);
      }
    }
  });

  it("shortens record ids for display only", () => {
    const events = timeline(changeApi.runId);
    const decision = recordLinkFor(events[0]!, changeApi)!;
    expect(shortRecordId(decision, changeApi.runId)).toBe("q01");
    const probe = recordLinkFor(events.find((e) => e.type === "probe.verdict")!, changeApi)!;
    expect(shortRecordId(probe, changeApi.runId)).toBe("s001");
    const belief = recordLinkFor(events.find((e) => e.type === "belief.changed")!, changeApi)!;
    expect(shortRecordId(belief, changeApi.runId)).toBe("dodo.refund.amount-minor-units");
  });

  it("certificate events link to ids published in the fixture certificate files", () => {
    const published = new Set<string>();
    for (const scenario of ["default", "change-api"])
      for (const tool of ["dodo", "crustdata"]) {
        try {
          const file = read(`certificates/fixture/${scenario}/${tool}.json`);
          for (const c of file.certificates ?? []) published.add(c.id);
        } catch {
          // Not every scenario publishes every tool.
        }
      }
    const revoked = timeline(changeApi.runId).find((e) => e.type === "certificate.revoked")!;
    expect(published.has(recordLinkFor(revoked, changeApi)!.id)).toBe(true);
  });

  it("links traces only when the bundle recorded a link, else shows the id", () => {
    const e = timeline(guarded.runId)[0]!;
    expect(e.traceIds.length).toBeGreaterThan(0);
    const refs = traceRefs(e, { traceLinks: {} });
    expect(refs).toEqual(e.traceIds.map((id) => ({ id, href: undefined })));
    const id = e.traceIds[0]!;
    const linked = traceRefs(e, { traceLinks: { [id]: `runs/${guarded.runId}/spans.jsonl#trace=${id}` } });
    expect(linked[0]!.href).toBe(`runs/${guarded.runId}/spans.jsonl#trace=${id}`);
    expect(traceRefs(e, { traceLinks: { [id]: "javascript:alert(1)" } })[0]!.href).toBeUndefined();
  });
});

describe("budget meters", () => {
  it("appear only once the snapshot event is replayed", () => {
    const events = timeline(guarded.runId);
    const seq = firstBudgetSeq(events)!;
    expect(events[seq]!.type).toBe("budget");
    expect(latestBudget(events.slice(0, seq))).toBeUndefined();
    const b = latestBudget(events.slice(0, seq + 1))!;
    expect(b.seq).toBe(seq);
    expect(b.snapshot.credits.used).toBe(guarded.credits.total);
    expect(b.snapshot.credits.cap).toBe(guarded.credits.budget);
  });

  it("show the cap when recorded and 'no cap configured' when null", () => {
    const b = latestBudget(timeline(changeApi.runId))!.snapshot;
    const credits = meterView(b.credits);
    expect(credits).toEqual({ used: "22", capText: "of 200", ratio: 22 / 200, over: false });
    expect(meterView(b.toolCalls)).toMatchObject({ used: "119", capText: "no cap configured", ratio: null });
    const usd = usdView(b);
    expect(usd.roles.map((r) => r.role)).toEqual(["executor", "reflector", "adversary"]);
    expect(usd.total.capText).toBe("no cap configured");
    expect(meterView({ used: 250, cap: 200 })).toMatchObject({ ratio: 1, over: true });
  });

  it("run status comes from run.finished", () => {
    const events = timeline(guarded.runId);
    expect(finishedStatus(events.slice(0, -1))).toBeUndefined();
    expect(finishedStatus(events)).toBe(guarded.status);
  });
});

describe("live stream", () => {
  const base = timeline(changeApi.runId);
  const last = base.at(-1)!;
  const liveEvent = (seq: number, summary = "live"): TimelineEvent => ({
    ...last,
    seq,
    summary,
    data: { ...(last.data ?? {}), live: true },
  });

  it("parses SSE data into schema-valid events only", () => {
    expect(parseStreamData(JSON.stringify({ at: last.at, payload: last }))).toEqual(last);
    expect(parseStreamData(JSON.stringify({ at: last.at, payload: { seq: 1 } }))).toBeNull();
    expect(parseStreamData("not json")).toBeNull();
  });

  it("appends live events, never lets them replace recorded ones, and ignores other runs", () => {
    const appended = mergeEvents(base, [liveEvent(last.seq + 1)], changeApi.runId);
    expect(appended).toHaveLength(base.length + 1);
    const clash = mergeEvents(base, [liveEvent(last.seq, "provisional")], changeApi.runId);
    expect(clash.at(-1)!.summary).toBe(last.summary);
    const recorded = mergeEvents(appended, [{ ...last, seq: last.seq + 1, summary: "recorded" }], changeApi.runId);
    expect(recorded.at(-1)!.summary).toBe("recorded");
    expect(mergeEvents(base, [{ ...liveEvent(last.seq + 1), runId: "other" }], changeApi.runId)).toHaveLength(base.length);
  });

  it("toasts held decisions, revocations and finished runs — once per record", () => {
    const events = timeline(changeApi.runId);
    const held = events.find((e) => e.type === "decision" && e.data?.status === "held")!;
    expect(toastFor(held)?.title).toBe("Decision held");
    expect(toastFor(events.find((e) => e.type === "certificate.revoked")!)?.tone).toBe("error");
    expect(toastFor(last)?.title).toBe("Run finished: completed");
    expect(toastFor(events.find((e) => e.type === "probe.verdict")!)).toBeNull();
    expect(toastFor({ ...held, seq: 999, data: { ...held.data, live: true } })?.id).toBe(toastFor(held)?.id);
  });
});

describe("layout and sources", () => {
  it("stacks the graph vertically on a phone and lays it out horizontally on desktop", () => {
    const phone = stageLayout(390 - 2 * 16 - 2 * 16);
    expect(phone.vertical).toBe(true);
    expect(phone.nodeW).toBeLessThanOrEqual(390);
    const desk = stageLayout(1100);
    expect(desk.vertical).toBe(false);
    expect(desk.position(4).x + desk.nodeW).toBeCloseTo(1100);
  });

  it("reads fixture timelines from bundles/fixture/ and real ones from bundles/ or the local API", () => {
    expect(timelineUrls(guarded, false)[0]).toMatch(/bundles\/fixture\/demo-run-guarded\.timeline\.json$/);
    expect(timelineUrls({ runId: "r1", sample: false }, false)).toEqual([
      expect.stringMatching(/bundles\/r1\.timeline\.json$/),
    ]);
    expect(timelineUrls({ runId: "r1", sample: false }, true)).toEqual(["/api/bundles/r1/timeline"]);
  });
});
