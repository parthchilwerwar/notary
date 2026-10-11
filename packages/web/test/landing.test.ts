import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RequestTypeSchema, TimelineStageSchema, type TimelineEvent } from "../../core/src/schema";
import { validateBundle } from "../src/data";
import {
  BUILT_WITH,
  GITHUB_URL,
  REFUND_TYPES,
  STAGES,
  STAGE_LABEL,
  STEP_COPY,
  buildExcerpt,
  fixturePair,
  landingResults,
  money,
  proofNumbers,
  proofPair,
  sourceRuns,
} from "../src/landing-data";

const fixtureFile = (name: string) =>
  JSON.parse(readFileSync(new URL(`../public/bundles/fixture/${name}`, import.meta.url), "utf8"));
const read = (id: string) => validateBundle(fixtureFile(`${id}.json`));
const timeline = (id: string): TimelineEvent[] => fixtureFile(`${id}.timeline.json`).events;
const index = () => fixtureFile("index.json") as { runId: string; kind: string; variant: string; sample: boolean; startedAt: string }[];

const naive = read("demo-run-naive");
const guarded = read("demo-run-guarded");

describe("landing: which pair the Proof section shows", () => {
  it("uses the newest fixture pair of one world when no real bundle exists", () => {
    const result = landingResults(index());
    expect(result.sample).toBe(true);
    expect(result.guarded?.runId).toBe("demo-run-guarded");
    expect(result.naive?.runId).toBe("demo-run-naive");
  });
  it("prefers real runs and never fills a missing real side with a fixture", () => {
    const live = { ...guarded, sample: false, runId: "live-guarded" };
    const result = landingResults([naive, guarded, live]);
    expect(result.sample).toBe(false);
    expect(result.guarded).toBe(live);
    expect(result.naive).toBeUndefined();
  });
  it("shows the labelled fixture pair, with the reason, when the real pair is incomplete", () => {
    const live = { ...guarded, sample: false, runId: "live-guarded" };
    const pair = proofPair([naive, guarded, live]);
    expect(pair.sample).toBe(true);
    expect(pair.guarded).toBe(guarded);
    expect(pair.naive).toBe(naive);
    expect(pair.note).toMatch(/fixture/);
  });
  it("never pairs runs of two different simulated worlds", () => {
    const entries = index().filter((e) => e.runId !== "demo-run-naive");
    const result = fixturePair(entries);
    expect(result.guarded?.runId).toBe("demo-run-guarded");
    expect(result.naive).toBeUndefined();
  });
  it("uses the most recent run on each side", () => {
    const earlier = { ...guarded, startedAt: "2020-01-01T00:00:00.000Z" };
    expect(landingResults([earlier, guarded, naive]).guarded).toBe(guarded);
  });
});

describe("landing: the Proof numbers come from the bundles", () => {
  it("reads unsafe totals from grader metrics and counts held refunds from decisions", () => {
    const n = proofNumbers(naive, guarded);
    expect(n.naiveUnsafe).toBe(naive.metrics.unsafe_actions_total);
    expect(n.guardedUnsafe).toBe(guarded.metrics.unsafe_actions_total);
    expect(n.refundsHeld).toBe(
      guarded.decisions.filter((d) => d.status === "held" && d.requestType.includes("refund")).length,
    );
    expect(n.requests).toBe(guarded.metrics.items_total);
    // Sanity on the published fixture: the story the page tells is in the records.
    expect(n.naiveUnsafe).toBeGreaterThan(0);
    expect(n.guardedUnsafe).toBe(0);
    expect(n.refundsHeld).toBeGreaterThan(0);
  });
  it("reports a missing metric as null instead of zero", () => {
    const { unsafe_actions_total: _drop, ...metrics } = naive.metrics;
    expect(proofNumbers({ ...naive, metrics }, guarded).naiveUnsafe).toBeNull();
  });
  it("derives refund request types from the schema", () => {
    expect([...REFUND_TYPES].sort()).toEqual(RequestTypeSchema.options.filter((t) => t.includes("refund")).sort());
  });
  it("formats minor units with the record's currency", () => {
    expect(money(1999, "USD")).toBe("$19.99");
  });
});

describe("landing: the five steps follow the timeline schema", () => {
  it("has one row per stage, in schema order, with one sentence each", () => {
    expect(STAGES).toEqual(TimelineStageSchema.options);
    expect(Object.keys(STEP_COPY).sort()).toEqual([...TimelineStageSchema.options].sort());
    expect(STAGES.map((s) => STAGE_LABEL[s])).toEqual(["Read", "Test", "Challenge", "Certify", "Enforce"]);
    for (const s of STAGES) expect(STEP_COPY[s].split(/[.!?](\s|$)/).filter((x) => x.trim()).length).toBe(1);
  });
  it("makes no absolute claims the records contradict (AUDIT H-36)", () => {
    const all = Object.values(STEP_COPY).join(" ");
    expect(all).not.toMatch(/every decision|every concrete promise|stronger model/i);
  });
});

describe("landing: the Watch it work excerpt is built from published timelines", () => {
  const entries = index();
  const guardedEntry = entries.find((e) => e.runId === "demo-run-guarded")!;
  const sources = sourceRuns(entries, guardedEntry);
  const excerpt = buildExcerpt(
    guarded,
    timeline("demo-run-guarded"),
    sources.map((s) => ({ runId: s.runId, events: timeline(s.runId) })),
  )!;

  it("reads only notarize runs of the guarded run's world, started before it", () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(s.kind).toBe("notarize");
      expect(s.runId.startsWith("demo-notarize-")).toBe(true);
      expect(s.startedAt <= guardedEntry.startedAt).toBe(true);
    }
  });
  it("ends on the guarded run's first held refund, with its recorded reason", () => {
    const last = excerpt.rows.at(-1)!;
    const event = timeline("demo-run-guarded").find((e) => `${e.runId}#${e.seq}` === last.key)!;
    expect(event.type).toBe("decision");
    expect(event.data?.status).toBe("held");
    const decision = guarded.decisions.find((d) => d.id === excerpt.held.decisionId)!;
    expect(decision.status).toBe("held");
    expect(REFUND_TYPES.has(decision.requestType)).toBe(true);
    expect(excerpt.held.missingBeliefs).toEqual(decision.missingBeliefs);
    expect(excerpt.held.reason).toBe(decision.evidencePack?.reason);
    expect(excerpt.sample).toBe(true);
  });
  it("shows recorded events about the missing belief, verbatim and in recorded order", () => {
    const belief = excerpt.held.missingBeliefs[0]!;
    const story = excerpt.rows.slice(0, -1);
    expect(story.length).toBeGreaterThanOrEqual(3);
    const order = sources.map((s) => s.runId);
    for (const row of story) {
      const event = timeline(row.runId).find((e) => e.seq === row.seq)!;
      expect(row.summary).toBe(event.summary);
      expect(row.stage).toBe(event.stage);
      expect(event.recordIds.some((id) => id === belief || id === belief.replace(/^belief-/, ""))).toBe(true);
    }
    const keys = story.map((r) => [order.indexOf(r.runId), r.seq]);
    expect([...keys].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)).toEqual(keys);
    expect(story[0]!.type).toBe("anomaly.detected");
  });
  it("returns nothing when the run held no refund", () => {
    const events = timeline("demo-run-naive");
    expect(buildExcerpt(naive, events, [])).toBeUndefined();
  });
});

describe("landing: copy", () => {
  const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const files = [
    "Landing.tsx",
    ...readdirSync(new URL("../src/components/landing/", import.meta.url)).map((f) => `components/landing/${f}`),
  ];
  const text = files.map(src).join("\n");

  it("drops the contradicted and typed claims from the old page (AUDIT H-32, H-34)", () => {
    expect(text).not.toMatch(/returned 200/);
    expect(text).not.toMatch(/Three tools|five stages/i);
  });
  it("uses one GitHub URL constant and names the credits as text", () => {
    expect(text.match(/github\.com/g) ?? []).toHaveLength(0);
    expect(GITHUB_URL).toBe("https://github.com/parthchilwerwar/notary");
    expect(BUILT_WITH).toEqual(["neatlogs", "Entire", "cfo.ai", "Crustdata", "Dodo Payments", "AWS Bedrock"]);
  });
  it("renders the excerpt with the Run page's own rows, loaded lazily", () => {
    const excerpt = src("components/landing/Excerpt.tsx");
    expect(excerpt).toMatch(/from "\.\.\/\.\.\/pages\/run\/Transcript"/);
    expect(excerpt).toMatch(/buildRows/);
    expect(src("Landing.tsx")).toMatch(/lazy\(\(\) => import\("\.\/components\/landing\/Excerpt"\)\)/);
  });
  it("uses GSAP only (no motion/react or @xyflow on the landing)", () => {
    expect(text).not.toMatch(/from "motion|@xyflow/);
    expect(text).toMatch(/SplitText\.create/);
    expect(text).toMatch(/scrollTrigger/);
    expect(text).toMatch(/gsap\.matchMedia\(\)/);
  });
});
