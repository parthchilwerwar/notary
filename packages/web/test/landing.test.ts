import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateBundle } from "../src/data";
import { landingResults, loadEvidence } from "../src/landing-data";
const read = (id: string) =>
  validateBundle(
    JSON.parse(
      readFileSync(
        new URL(`../public/bundles/fixture/${id}.json`, import.meta.url),
        "utf8",
      ),
    ),
  );
const naive = read("demo-run-naive"),
  guarded = read("demo-run-guarded");
afterEach(() => vi.unstubAllGlobals());
describe("landing result provenance", () => {
  it("uses a fixture pair when no live bundle exists", () => {
    const result = landingResults([naive, guarded]);
    expect(result.sample).toBe(true);
    expect(result.naive?.runId).toBe(naive.runId);
    expect(result.guarded?.runId).toBe(guarded.runId);
  });
  it("prefers live runs and never fills a missing live side with fixtures", () => {
    const live = { ...guarded, sample: false, runId: "live-guarded" };
    const result = landingResults([naive, guarded, live]);
    expect(result.sample).toBe(false);
    expect(result.guarded).toBe(live);
    expect(result.naive).toBeUndefined();
  });
  it("does not label fixture queue outcomes live when only live notarization exists", () => {
    const live = { ...guarded, sample: false, kind: "notarize" as const };
    const result = landingResults([naive, guarded, live]);
    expect(result.sample).toBe(false);
    expect(result.guarded).toBeUndefined();
    expect(result.naive).toBeUndefined();
  });
  it("uses the most recent run on each side", () => {
    const earlier = { ...guarded, startedAt: "2020-01-01T00:00:00.000Z" };
    expect(landingResults([earlier, guarded, naive]).guarded).toBe(guarded);
  });
  it("leaves missing tool evidence pending instead of inventing status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    expect(await loadEvidence()).toEqual([]);
  });
  it("rejects an invented tool status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify([
              {
                name: "Entire",
                purpose: "Coverage",
                status: "complete",
                links: [],
              },
            ]),
            { headers: { "content-type": "application/json" } },
          ),
        ),
    );
    await expect(loadEvidence()).rejects.toThrow();
  });
});

import {
  REQUIRED_TOOLS,
  findIncident,
  fixturePair,
  money,
  realRuns,
  replayEvents,
  replayRunIds,
  stageCounts,
  typeCounts,
  unsafeBreakdown,
  verifyTimeline,
} from "../src/landing-data";

const readAll = () =>
  (
    JSON.parse(
      readFileSync(
        new URL("../public/bundles/fixture/index.json", import.meta.url),
        "utf8",
      ),
    ) as { runId: string }[]
  ).map((e) => read(e.runId));
const rawTimeline = (id: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../public/bundles/fixture/${id}.timeline.json`, import.meta.url),
      "utf8",
    ),
  );

describe("landing: the double-refund problem comes from bundle records", () => {
  it("finds the duplicate refund: a timed-out write retried, held in the guarded run", () => {
    const incident = findIncident("duplicate", naive, guarded)!;
    const decision = naive.decisions.find((d) => d.id === incident.naive.decisionId)!;
    expect(decision.grade?.unsafe).toContain("duplicate");
    expect(incident.naive.writes).toBeGreaterThan(1);
    expect(incident.naive.attempts[0]!.status).toBeNull();
    expect(incident.requestId).toBe(decision.requestId);
    const counterpart = guarded.decisions.find((d) => d.requestId === decision.requestId)!;
    expect(incident.guarded?.status).toBe(counterpart.status);
    expect(incident.guarded?.writes).toBe(
      counterpart.effects.filter((e) => e.op === counterpart.action && (e.status === null || (e.status >= 200 && e.status < 300))).length,
    );
  });
  it("finds a wrong-unit refund with the amount sent and the amount refunded", () => {
    const incident = findIncident("wrong_unit", naive, guarded)!;
    const decision = naive.decisions.find((d) => d.id === incident.naive.decisionId)!;
    expect(decision.grade?.unsafe).toContain("wrong_unit");
    expect(incident.naive.requestedAmount).toBeTypeOf("number");
    expect(incident.naive.attempts.some((a) => a.amount !== undefined)).toBe(true);
  });
  it("returns nothing without a naive run", () => {
    expect(findIncident("duplicate", undefined, guarded)).toBeUndefined();
  });
  it("reads unsafe totals from bundle metrics, never computing new ones", () => {
    expect(unsafeBreakdown(naive)).toMatchObject({
      total: naive.metrics.unsafe_actions_total,
      duplicates: naive.metrics.unsafe_duplicates,
      wrongUnit: naive.metrics.unsafe_wrong_unit,
    });
    expect(unsafeBreakdown(guarded)?.held).toBe(guarded.metrics.holds);
  });
  it("formats minor units with the effect currency", () => {
    expect(money(9900, "USD")).toBe("$99.00");
  });
});

describe("landing: real results stay separate", () => {
  it("counts only non-sample bundles as real", () => {
    expect(realRuns([naive, guarded])).toEqual({ total: 0, queueRuns: 0, notarizeRuns: 0 });
    const live = { ...guarded, sample: false, runId: "live-guarded" };
    expect(realRuns([naive, live]).queueRuns).toBe(1);
    expect(fixturePair([naive, live]).guarded).toBeUndefined();
  });
});

describe("landing: mission control replay", () => {
  const all = readAll();
  it("replays one fixture world: its notarize runs, then the guarded run", () => {
    const ids = replayRunIds(all);
    const guardedId = fixturePair(all).guarded!.runId;
    expect(ids.at(-1)).toBe(guardedId);
    const world = guardedId.replace(/-run-guarded$/, "");
    for (const id of ids.slice(0, -1))
      expect(id.replace(/-notarize-[a-z]+$/, "")).toBe(world);
    expect(ids.length).toBeGreaterThan(1);
  });
  it("ties every replayed timeline to its verified bundle", () => {
    for (const id of replayRunIds(all)) {
      const bundle = all.find((b) => b.runId === id)!;
      expect(verifyTimeline(rawTimeline(id), bundle).bundleHash).toBe(bundle.contentHash);
    }
  });
  it("withholds a timeline whose bundleHash does not match", () => {
    const raw = rawTimeline("demo-run-guarded");
    raw.bundleHash = "0".repeat(64);
    expect(() => verifyTimeline(raw, guarded)).toThrow(/content hash/);
  });
  it("withholds a timeline for another run or a non-fixture timeline", () => {
    expect(() => verifyTimeline(rawTimeline("demo-run-naive"), guarded)).toThrow();
    const raw = rawTimeline("demo-run-guarded");
    expect(() => verifyTimeline({ ...raw, sample: false }, guarded)).toThrow();
  });
  it("counts replayed events per stage", () => {
    const files = replayRunIds(all).map((id) =>
      verifyTimeline(rawTimeline(id), all.find((b) => b.runId === id)!),
    );
    const events = replayEvents(files);
    const full = stageCounts(events);
    expect(Object.values(full).reduce((a, b) => a + b, 0)).toBe(events.length);
    for (const stage of ["read", "test", "challenge", "certify", "enforce"] as const)
      expect(full[stage]).toBe(events.filter((e) => e.stage === stage).length);
    expect(Object.values(stageCounts(events, 0)).every((n) => n === 0)).toBe(true);
    const t = typeCounts(events, events.length);
    expect(t.certificatesIssued).toBe(events.filter((e) => e.type === "certificate.issued").length);
    expect(t.held).toBe(events.filter((e) => e.type === "decision" && e.data?.status === "held").length);
  });
});

describe("landing: required tools", () => {
  it("names exactly the sponsors in the published evidence file", () => {
    const evidence = JSON.parse(
      readFileSync(new URL("../public/evidence/evidence.json", import.meta.url), "utf8"),
    ) as { name: string }[];
    expect(evidence.map((e) => e.name).sort()).toEqual([...REQUIRED_TOOLS].sort());
  });
});
