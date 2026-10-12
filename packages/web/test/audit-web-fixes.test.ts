// Audit fixes (web): replays labelled and never shown first or as new spend, the default run, the
// fixture view without the synthetic sample, timeline contents tied to the bundle, approvals per
// world, consistent Run page counts, UTC dates, hosted wording and the start-run confirmation.
// Reads the published files in public/ (no network) where real data is needed.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { ApprovalsList, BundleIndexEntry, RunBundle, TimelineFile } from "../../core/src/schema";
import { validateBundle, verifyTimelineFile, type RunEntry } from "../src/data";
import { timelineContentProblem } from "../src/data/verify";
import { worldKeyOf } from "../src/data/world";
import { date } from "../src/data/format";
import { dateTime } from "../src/lib/time";
import {
  REPLAY_SPEND_TEXT,
  defaultRunId,
  groupRuns as pickerGroups,
  isReplayRun,
  liveFirst,
  replayBadge,
  replayOfRun,
  visibleRuns,
} from "../src/app/links";
import {
  buildRows,
  groupRuns,
  HOSTED_START_NOTE,
  pickRun,
  replaySpeed,
  runControls,
  runDefaultState,
  runLabel,
  stageProgress,
} from "../src/pages/run/model";
import { Costs } from "../src/pages/report/ReportPage";
import { certificatesSummary } from "../src/pages/certificates/model";
import { isTypingTarget } from "../src/pages/run/Transcript";
import { startRunFacts } from "../src/pages/run/StartRunDialog";
import { byWorld as costTables } from "../src/pages/report/model";
import { buildDesk, byWorld as approvalWorlds, worldRuns } from "../src/pages/approvals/model";

const pub = (path: string) => new URL(`../public/${path}`, import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(pub(path), "utf8")) as unknown;
const primary = readJson("bundles/index.json") as BundleIndexEntry[];
const fixtureIndex = readJson("bundles/fixture/index.json") as BundleIndexEntry[];
const bundleOf = (dir: string, e: BundleIndexEntry): RunBundle => validateBundle(readJson(`${dir}/${e.runId}.json`), e);
const realBundles = primary.filter((e) => !e.sample).map((e) => bundleOf("bundles", e));
const fixtureBundles = fixtureIndex.map((e) => bundleOf("bundles/fixture", e));
const entry = (b: RunBundle): Extract<RunEntry, { state: "finished" }> => ({
  runId: b.runId,
  kind: b.kind,
  variant: b.variant,
  mode: b.mode,
  sample: b.sample,
  startedAt: b.startedAt,
  status: b.status,
  contentHash: b.contentHash,
  state: "finished",
});

// A small synthetic catalog so the rules are tested even if public/ changes.
const live = (runId: string, startedAt: string, over: Partial<RunBundle> = {}) =>
  ({ ...realBundles[0]!, runId, startedAt, mode: "live", replayOf: undefined, probes: [], decisions: [], ...over }) as RunBundle;
const replayOf = (of: RunBundle, startedAt: string) =>
  ({ ...of, runId: `${of.runId}-replay`, startedAt, mode: "replay", replayOf: of.runId }) as RunBundle;

describe("replays: labelled, listed after live runs, never the default", () => {
  const worked = live("live-worked", "2026-10-12T01:00:00.000Z", { probes: realBundles.flatMap((b) => b.probes).slice(0, 1) });
  const idle = live("live-idle", "2026-10-12T02:00:00.000Z");
  const rep = replayOf(worked, "2026-10-12T03:00:00.000Z");

  it("labels a replay with its original run (from the bundle), live runs not at all", () => {
    expect(isReplayRun(rep)).toBe(true);
    expect(replayBadge(rep)).toBe("Replay of live-worked");
    expect(replayBadge(entry(rep), [rep])).toBe("Replay of live-worked");
    expect(replayBadge(entry(rep))).toBe("Replay");
    expect(replayBadge(worked)).toBeUndefined();
    expect(replayOfRun(entry(rep), [rep])).toBe("live-worked");
    expect(runLabel(entry(rep), [rep])).toContain("Replay of live-worked");
    expect(runLabel(entry(worked))).not.toContain("Replay");
    expect(REPLAY_SPEND_TEXT).toBe("Re-served from the recording — no new spend");
  });

  it("lists live runs before replays (pickers and the Run page), newest first within each", () => {
    expect(liveFirst([worked, idle, rep]).map((b) => b.runId)).toEqual(["live-idle", "live-worked", "live-worked-replay"]);
    expect(pickerGroups([entry(worked), entry(idle), entry(rep)], "static")[0]!.runs.map((r) => r.runId)).toEqual([
      "live-idle",
      "live-worked",
      "live-worked-replay",
    ]);
    expect(groupRuns([entry(rep), entry(worked)]).real.map((r) => r.runId)).toEqual(["live-worked", "live-worked-replay"]);
    expect(pickRun([entry(rep), entry(idle)], null)?.runId).toBe("live-idle");
  });

  it("default run: guarded queue run, else the newest live run that recorded work, never a replay first", () => {
    expect(defaultRunId([worked, idle, rep])).toBe("live-worked");
    // Index entries only (no counts): the newest live run, still never the replay.
    expect(defaultRunId([entry(worked), entry(idle), entry(rep)])).toBe("live-idle");
    expect(defaultRunId([rep])).toBe("live-worked-replay");
    const guarded = live("guarded", "2026-10-11T00:00:00.000Z", { kind: "run", variant: "guarded" });
    expect(defaultRunId([worked, idle, rep, guarded])).toBe("guarded");
    // The published real runs: the default is a live run with probes.
    const pick = realBundles.find((b) => b.runId === defaultRunId(realBundles));
    expect(pick?.mode).toBe("live");
    expect(pick!.probes.length + pick!.decisions.length).toBeGreaterThan(0);
  });

  it("cost tables: replays after live runs; fixture scenarios in separate tables", () => {
    const tables = costTables([rep, worked, idle]);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.runs.map((b) => b.runId)).toEqual(["live-idle", "live-worked", "live-worked-replay"]);
    const fixture = costTables(fixtureBundles);
    expect(fixture.map((t) => t.key).sort()).toEqual(["fixture:change-api", "fixture:default"]);
    for (const t of fixture) expect(new Set(t.runs.map((b) => worldKeyOf(b))).size).toBe(1);
  });
});

describe("the fixture view never includes the synthetic sample", () => {
  it("sample-42 (kind sample) is left out of ?fixtures=1 and of the default view", () => {
    const runs = [...primary, ...fixtureIndex].map((e) => ({ ...e, state: "finished" as const }));
    const fixtureView = visibleRuns(runs, true);
    expect(fixtureView.some((r) => r.kind === "sample")).toBe(false);
    expect(fixtureView.length).toBe(fixtureIndex.length);
    expect(visibleRuns(runs, false).every((r) => !r.sample)).toBe(true);
  });
});

describe("timeline contents are tied to the verified bundle", () => {
  const timelines = [
    ...readdirSync(pub("bundles")).filter((f) => f.endsWith(".timeline.json")).map((f) => ["bundles", f] as const),
    ...readdirSync(pub("bundles/fixture")).filter((f) => f.endsWith(".timeline.json")).map((f) => ["bundles/fixture", f] as const),
  ];
  const load = (dir: string, f: string) => {
    const runId = f.replace(/\.timeline\.json$/, "");
    const index = dir === "bundles" ? primary : fixtureIndex;
    const bundle = bundleOf(dir, index.find((e) => e.runId === runId)!);
    return { bundle, raw: readJson(`${dir}/${f}`) as TimelineFile };
  };

  it("every published timeline agrees with its bundle", () => {
    expect(timelines.length).toBeGreaterThan(0);
    for (const [dir, f] of timelines) {
      const { bundle, raw } = load(dir, f);
      expect(timelineContentProblem(raw, bundle), f).toBeUndefined();
      expect(() => verifyTimelineFile(raw, bundle)).not.toThrow();
    }
  });

  it("a timeline with a dropped probe verdict, a stray probe or a stray decision is withheld", () => {
    const withProbes = timelines.map(([d, f]) => load(d, f)).find((t) => t.bundle.probes.length > 0)!;
    const withDecisions = timelines.map(([d, f]) => load(d, f)).find((t) => t.bundle.decisions.length > 0)!;
    const dropVerdict = { ...withProbes.raw, events: withProbes.raw.events.filter((e, i, all) => !(e.type === "probe.verdict" && i === all.findIndex((x) => x.type === "probe.verdict"))) };
    expect(() => verifyTimelineFile(dropVerdict, withProbes.bundle)).toThrow(/probe verdicts .*Data withheld/);
    const strayProbe = {
      ...withProbes.raw,
      events: withProbes.raw.events.map((e) => (e.type === "probe.committed" ? { ...e, recordIds: ["probe-not-in-bundle", ...e.recordIds.slice(1)] } : e)),
    };
    expect(() => verifyTimelineFile(strayProbe, withProbes.bundle)).toThrow(/probe-not-in-bundle is not in the bundle/);
    const strayDecision = {
      ...withDecisions.raw,
      events: withDecisions.raw.events.map((e) => (e.type === "decision" ? { ...e, recordIds: ["dec-forged", ...e.recordIds.slice(1)] } : e)),
    };
    expect(() => verifyTimelineFile(strayDecision, withDecisions.bundle)).toThrow(/dec-forged is not in the bundle.*Data withheld/);
  });
});

describe("Run page: one row set counted everywhere", () => {
  it("the stepper counts the bundle-derived opening row at its stage, so its total equals the row count", () => {
    const b = realBundles.find((x) => x.kind === "notarize" && x.claims.length > 0 && x.probes.length > 0)!;
    const dir = "bundles";
    const raw = readJson(`${dir}/${b.runId}.timeline.json`) as TimelineFile;
    const rows = buildRows(raw.events, { bundle: b });
    const derived = rows.filter((r) => r.seq === null).map((r) => r.stage);
    expect(derived).toEqual(["read"]);
    const steps = stageProgress(raw.events, new Set(), derived).steps;
    expect(steps.reduce((n, s) => n + s.count, 0)).toBe(rows.length);
    expect(steps.find((s) => s.stage === "read")!.count).toBe(rows.filter((r) => r.stage === "read").length);
  });
});

describe("approvals: one world per count and table; hidden runs never listed", () => {
  it("splits fixture scenarios and scopes counts to the selected run's world", () => {
    const worlds = approvalWorlds(fixtureBundles);
    expect(worlds.map((w) => w.key).sort()).toEqual(["fixture:change-api", "fixture:default"]);
    const selected = fixtureBundles.find((b) => b.runId === "demo-run-guarded")!;
    expect(worldRuns(fixtureBundles, selected).every((b) => worldKeyOf(b) === "fixture:default")).toBe(true);
  });

  it("live: a real pending item never shows when its run is not visible (e.g. under ?fixtures=1)", () => {
    const list: ApprovalsList = {
      testMode: true,
      pending: [{ id: "appr-0123456789abcdef", runId: "real-run", decisionId: "real-run:q01", requestId: "q01", action: "dodo.createRefund", reason: "held", missingBeliefs: [], amount: 100 }],
      decided: [],
    };
    const desk = buildDesk({ mode: "local", list, bundles: fixtureBundles, selected: fixtureBundles[0], visible: new Set(fixtureBundles.map((b) => b.runId)) });
    expect(desk.pending).toEqual([]);
    expect(desk.droppedHidden).toBe(1);
  });
});

describe("wording and dates", () => {
  it("dates are UTC and say so", () => {
    expect(dateTime("2026-10-12T01:14:04.667Z")).toBe("Oct 12, 2026, 1:14 AM UTC");
    expect(date("2026-10-12T23:59:00.000Z")).toBe("Oct 12, 2026, 11:59 PM UTC");
    expect(dateTime("not a date")).toBe("not a date");
  });

  it("the hosted build says how to go live, not 'start the server'", () => {
    expect(runControls("replay", undefined, true).start.note).toBe(HOSTED_START_NOTE);
    expect(runControls("replay", undefined, true).start.note).not.toMatch(/and reload/);
    expect(runControls("replay").start.note).toMatch(/pnpm notary serve/);
  });

  it("start-run confirmation states the cap only when /api/health reports one", () => {
    const facts = startRunFacts("Queue run (guarded)", {
      ok: true,
      service: "notary serve",
      integrations: [{ name: "dodo", state: "connected", label: "connected", checkedAt: "2026-10-12T00:00:00.000Z" }],
    });
    expect(facts.usdCap).toMatch(/^No USD cap reported/);
    expect(facts.integrations).toEqual([{ name: "Dodo Payments", label: "connected" }]);
    expect(startRunFacts("x", null).integrations).toEqual([]);
  });

  it("j/k ignore key presses in text fields", () => {
    expect(isTypingTarget(null)).toBe(false);
    if (typeof document === "undefined") return;
    const input = document.createElement("input");
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
  });
});

describe("default run and deep links on the Run page", () => {
  it("the published real runs open on the newest live run that recorded probes or decisions", () => {
    const newestFirst = [...realBundles].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const expected = newestFirst.find((b) => b.mode !== "replay" && b.probes.length + b.decisions.length > 0);
    expect(expected).toBeDefined();
    expect(defaultRunId(realBundles)).toBe(expected!.runId);
    // Newer live runs with no recorded work, and every replay, are passed over.
    const passed = newestFirst.slice(0, newestFirst.indexOf(expected!));
    expect(passed.every((b) => b.mode === "replay" || b.probes.length + b.decisions.length === 0)).toBe(true);
  });

  it("an explicit ?run= always wins; without one the page waits for the dashboard's default", () => {
    expect(runDefaultState("r-explicit", { loading: true, selectedRunId: "other" })).toEqual({ requested: "r-explicit", waiting: false });
    expect(runDefaultState("r-explicit", { loading: false, selectedRunId: "other" })).toEqual({ requested: "r-explicit", waiting: false });
    expect(runDefaultState(null, { loading: true })).toEqual({ requested: null, waiting: true });
    expect(runDefaultState(null, { loading: false, selectedRunId: "d" })).toEqual({ requested: "d", waiting: false });
    expect(runDefaultState(null, null)).toEqual({ requested: null, waiting: false });
  });

  it("a probe, decision or event deep link replays instantly; an explicit ?speed= still wins", () => {
    const q = (s: string) => replaySpeed(new URLSearchParams(s));
    expect(q("run=r")).toBe(1);
    expect(q("run=r&probe=p1")).toBe("instant");
    expect(q("run=r&decision=d1")).toBe("instant");
    expect(q("run=r&event=4")).toBe("instant");
    expect(q("run=r&probe=p1&speed=1")).toBe(1);
    expect(q("run=r&speed=4")).toBe(4);
  });
});

describe("Report: replays in the cost table", () => {
  it("labels every replay and says it added no spend, linking the original run; live runs keep their numbers", () => {
    const replays = realBundles.filter((b) => b.mode === "replay");
    expect(replays.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Costs, { bundles: realBundles })));
    expect(html).toContain(">Mode<");
    for (const r of replays) {
      expect(html).toContain(`Replay of ${r.replayOf}`);
      expect(html).toContain(`/app/run?run=${r.replayOf}`);
    }
    expect(html.split("Re-served from the recording — no new spend").length - 1).toBe(replays.length);
    expect(html.split(">Live<").length - 1).toBe(realBundles.length - replays.length);
  });

  it("a selected replay gets no per-role cost breakdown, only the no-new-spend line", () => {
    const rep = realBundles.find((b) => b.mode === "replay")!;
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Costs, { bundles: realBundles, selected: rep })));
    expect(html).not.toContain(`Show costs by role and endpoint for ${rep.runId}`);
    // Run ids are shown exactly as recorded (never case-folded).
    expect(html).toContain(`${rep.runId} is a replay of <a class="report-run-id" href="/app/run?run=${rep.replayOf}"`);
    expect(html).toContain("Re-served from the recording — no new spend; the original run holds the real cost.");
    // The id keeps its recorded case (an earlier version lower-cased the whole sentence).
    expect(rep.replayOf).toMatch(/[A-Z]/);
    expect(html).not.toContain(rep.replayOf!.toLowerCase());
  });
});

describe("Certificates header", () => {
  it("counts the claims listed without a certificate, the same rows as the stat row", () => {
    const cert = (status: "active" | "revoked") => ({ status }) as never;
    const summary = certificatesSummary({ certificates: [cert("active"), cert("revoked"), cert("active")], noCertificates: [{} as never] });
    expect(summary).toBe("2 active · 1 revoked · 1 claim without a certificate");
    expect(certificatesSummary({ certificates: [], noCertificates: [{} as never, {} as never] })).toContain("2 claims without a certificate");
    const src = readFileSync(new URL("../src/pages/certificates/CertificatesPage.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/counts\.unproven|still unproven/);
  });
});

// Keep the import used even when public/ has no fixture timelines.
void existsSync;
