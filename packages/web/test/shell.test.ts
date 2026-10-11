import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BundleIndexSchema } from "../../core/src/schema/bundle";
import type { BundleIndexEntry } from "../../core/src/schema";
import { validateBundle } from "../src/data";
import {
  matchAppRoute,
  navRoutes,
  redirectTarget,
  redirects,
  routeById,
  routes,
} from "../src/routes";
import {
  defaultRunId,
  groupRuns,
  heldCount,
  paletteEntries,
  pickBaseline,
  recordPath,
  resolveDataMode,
  withRun,
} from "../src/app/links";
import { chooseScenario, verifyToolFile } from "../src/data";
import { FixtureIndexSchema } from "../../core/src/schema";
import { activeNavId } from "../src/components/shell/Sidebar";
import { latestHealth, modeLabel } from "../src/components/shell/status";

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8"));
const fixtureIndex = BundleIndexSchema.parse(read("bundles/fixture/index.json"));
const fixtures = fixtureIndex.map((e) =>
  validateBundle(read(`bundles/fixture/${e.runId}.json`), e),
);
const guarded = fixtures.find((b) => b.runId === "demo-run-guarded")!;
const notarize = fixtures.find((b) => b.runId === "demo-notarize-dodo")!;
const real = (e: BundleIndexEntry, id: string): BundleIndexEntry => ({
  ...e,
  runId: id,
  sample: false,
});

describe("route table", () => {
  it("has exactly the redesign's pages", () => {
    expect(routes.map((r) => r.path).sort()).toEqual(
      [
        "/app/run",
        "/app/certificates",
        "/app/certificates/:certificateId",
        "/app/approvals",
        "/app/chat",
        "/app/report",
      ].sort(),
    );
    expect(new Set(routes.map((r) => r.id)).size).toBe(routes.length);
  });
  it("puts exactly four text-only items in the sidebar, in order", () => {
    expect(navRoutes().map((r) => r.title)).toEqual(["Run", "Certificates", "Approvals", "Chat"]);
    expect(routes.filter((r) => r.badge).map((r) => r.id)).toEqual(["approvals"]);
    // Report is reached from the sidebar footer, not the menu.
    expect(routeById("report")?.nav).toBeFalsy();
  });
  it("gives a certificate its own URL under its list page", () => {
    const route = routes.find((r) => r.record === "certificate")!;
    expect(route.path).toMatch(/:/);
    expect(routeById(route.parent!)?.id).toBe("certificates");
    expect(matchAppRoute("/app/certificates/cert-0123456789abcdef")?.route.id).toBe("certificate");
    expect(matchAppRoute("/app/certificates/")?.route.id).toBe("certificates");
    expect(matchAppRoute("/app/nope")).toBeUndefined();
    expect(activeNavId("/app/certificates/cert-0123456789abcdef")).toBe("certificates");
    expect(activeNavId("/app/report")).toBeUndefined();
  });
  it("redirects every old URL to a page that exists", () => {
    for (const r of redirects) {
      const params = Object.fromEntries([...r.from.matchAll(/:([A-Za-z]+)/g)].map((m) => [m[1], "x"]));
      const target = redirectTarget(r, params);
      expect(matchAppRoute(target.split("?")[0]!), `${r.from} -> ${target}`).toBeDefined();
    }
    const from = (path: string) => redirects.find((r) => r.from === path)!;
    expect(redirectTarget(from("/app"), {})).toBe("/app/run");
    for (const old of ["/app/overview", "/app/mission-control", "/app/runs", "/app/queue", "/app/probes"])
      expect(redirectTarget(from(old), {})).toBe("/app/run");
    for (const old of ["/app/economics", "/app/evidence", "/app/comparison"])
      expect(redirectTarget(from(old), {})).toBe("/app/report");
    for (const old of ["/app/beliefs", "/app/reports", "/app/revocation-demo"])
      expect(redirectTarget(from(old), {})).toBe("/app/certificates");
  });
  it("carries record ids and the old query into the new URL", () => {
    const from = (path: string) => redirects.find((r) => r.from === path)!;
    expect(redirectTarget(from("/app/queue/:decisionId"), { decisionId: "demo-run-guarded:q01" }, "?run=demo-run-guarded")).toBe(
      "/app/run?run=demo-run-guarded&decision=demo-run-guarded%3Aq01",
    );
    expect(redirectTarget(from("/app/probes/:probeId"), { probeId: "p1" }, "?run=r")).toBe("/app/run?run=r&probe=p1");
    // The run named in the old path wins over the old ?run=.
    expect(redirectTarget(from("/app/runs/:runId"), { runId: "b" }, "?run=a")).toBe("/app/run?run=b");
    expect(redirectTarget(from("/app/reports/:tool"), { tool: "dodo" }, "?run=r")).toBe("/app/certificates?run=r&tool=dodo");
    expect(redirectTarget(from("/app/beliefs/:beliefId"), { beliefId: "belief-x" })).toBe(
      "/app/certificates?belief=belief-x",
    );
  });
});

describe("shell status", () => {
  it("says Replay or Live, and flags a live server that stopped answering", () => {
    expect(modeLabel({ state: "replay" })).toEqual({ text: "Replay", tone: "neutral" });
    expect(modeLabel({ state: "checking", health: null }).text).toBe("Live");
    const health = { ok: true as const, service: "notary serve" as const, integrations: [] };
    expect(modeLabel({ state: "ok", health, checkedAt: "2026-10-11T00:00:00.000Z" })).toEqual({ text: "Live", tone: "neutral" });
    expect(
      modeLabel({ state: "unreachable", health, checkedAt: "2026-10-11T00:00:00.000Z", error: "refused" }),
    ).toEqual({ text: "Live", detail: "server not responding", tone: "unsafe" });
    expect(latestHealth({ state: "replay" })).toBeNull();
    expect(latestHealth({ state: "ok", health, checkedAt: "x" })).toBe(health);
  });
});

describe("data mode", () => {
  it("is Fixture for sample runs, Live only for real runs from the local API", () => {
    expect(resolveDataMode("api", { sample: false })).toBe("live");
    expect(resolveDataMode("static", { sample: false })).toBe("recorded");
    expect(resolveDataMode("api", { sample: true })).toBe("fixture");
    expect(resolveDataMode("static", { sample: true })).toBe("fixture");
    expect(resolveDataMode("static")).toBe("recorded");
  });
  it("defaults to a guarded queue run and prefers real data", () => {
    expect(defaultRunId(fixtureIndex)).toBe("demo-run-guarded");
    const withReal = [...fixtureIndex, real(fixtureIndex[0], "real-1")];
    expect(defaultRunId(withReal)).toBe("real-1");
  });
  it("puts URLs and the selected run together", () => {
    expect(withRun("/app/run", "a b", { baseline: "x" })).toBe("/app/run?run=a+b&baseline=x");
    expect(withRun("/app", undefined)).toBe("/app");
    // A record path keeps its own query; the run comes first.
    expect(withRun(recordPath.decision("r:q01"), "r")).toBe("/app/run?run=r&decision=r%3Aq01");
    // A path that names its run keeps it.
    expect(withRun(recordPath.run("b"), "a")).toBe("/app/run?run=b");
  });
  it("points every record kind at a page that exists", () => {
    for (const make of Object.values(recordPath))
      expect(matchAppRoute(make("x").split("?")[0]!)).toBeDefined();
  });
});

describe("run picker", () => {
  it("never mixes fixture and real runs in one section", () => {
    const entries = [
      ...fixtureIndex,
      real(fixtureIndex[0], "real-a"),
      real(fixtureIndex[1], "real-b"),
    ];
    for (const source of ["static", "api"] as const) {
      const groups = groupRuns(entries, source);
      expect(groups.map((g) => g.kind)).toEqual([
        source === "api" ? "live" : "recorded",
        "fixture",
      ]);
      expect(groups[0].runs.every((r) => !r.sample)).toBe(true);
      expect(groups[1].runs.every((r) => r.sample)).toBe(true);
      expect(groups[1].runs).toHaveLength(fixtureIndex.length);
    }
    expect(groupRuns(fixtureIndex, "static").map((g) => g.kind)).toEqual([
      "fixture",
    ]);
  });
  it("only offers same-cohort baselines, preferring the same simulated world", () => {
    const changed = fixtures.find(
      (b) => b.runId === "demo-change-api-run-guarded",
    )!;
    expect(pickBaseline(guarded, fixtures, null)?.runId).toBe("demo-run-naive");
    expect(pickBaseline(changed, fixtures, null)?.runId).toBe(
      "demo-change-api-run-naive",
    );
    const fakeReal = { ...guarded, runId: "real", sample: false };
    expect(pickBaseline(fakeReal, fixtures, "demo-run-naive")).toBeUndefined();
  });
});

describe("command palette", () => {
  it("lists every decision, probe and belief of the selected bundle, with record URLs", () => {
    const entries = paletteEntries(notarize);
    const beliefIds = new Set(
      [...notarize.beliefs.before, ...notarize.beliefs.after].map((b) => b.id),
    );
    expect(entries.filter((e) => e.group === "Probes")).toHaveLength(
      notarize.probes.length,
    );
    expect(entries.filter((e) => e.group === "Beliefs")).toHaveLength(
      beliefIds.size,
    );
    expect(entries.filter((e) => e.group === "Decisions")).toHaveLength(
      notarize.decisions.length,
    );
    const probe = entries.find((e) => e.id === notarize.probes[0].id)!;
    expect(probe.path).toBe(
      `/app/run?run=${notarize.runId}&probe=${encodeURIComponent(probe.id)}`,
    );
    const decisions = paletteEntries(guarded).filter(
      (e) => e.group === "Decisions",
    );
    expect(decisions.map((d) => d.id)).toEqual(
      guarded.decisions.map((d) => d.id),
    );
    expect(paletteEntries(undefined)).toEqual([]);
  });
  it("includes certificates of the current data world", () => {
    const tool = read("certificates/fixture/default/dodo.json");
    const entries = paletteEntries(notarize, tool.certificates);
    expect(entries.filter((e) => e.group === "Certificates")).toHaveLength(
      tool.certificates.length,
    );
  });
  it("counts held decisions for the sidebar badge", () => {
    expect(heldCount(guarded)).toBe(
      guarded.decisions.filter((d) => d.status === "held").length,
    );
    expect(heldCount(undefined)).toBe(0);
  });
});

describe("certificate world", () => {
  const index = FixtureIndexSchema.parse(read("certificates/fixture/index.json"));
  it("picks the fixture scenario that lists the run, else its own world's, never another world's", () => {
    expect(chooseScenario(index, "demo-change-api-notarize-dodo")?.scenario.scenario).toBe(
      "change-api",
    );
    // Queue runs are not certificate sources; they share their notarize runs' world.
    expect(chooseScenario(index, "demo-run-guarded")?.scenario.scenario).toBe("default");
    expect(chooseScenario(index, "demo-change-api-run-guarded")?.scenario.scenario).toBe("change-api");
    // A run of no published scenario's world gets no certificates (no stand-in world).
    expect(chooseScenario(index, "sample-42")).toBeUndefined();
    expect(chooseScenario(index, undefined)).toBeUndefined();
  });
  it("verifies published files against their report and rejects tampering", () => {
    for (const scenario of index.scenarios) {
      const dir = scenario.report.slice(0, scenario.report.lastIndexOf("/") + 1);
      const report = read(`certificates/fixture/${scenario.report}`);
      for (const t of report.tools) {
        const raw = read(`certificates/fixture/${dir}${t.file}`);
        expect(
          verifyToolFile(raw, report.toolFileHashes[t.file], true, t.file).tool,
        ).toBe(t.tool);
        expect(() =>
          verifyToolFile(raw, report.toolFileHashes[t.file], false, t.file),
        ).toThrow("mixes");
        if (raw.certificates.length) {
          const tampered = structuredClone(raw);
          tampered.certificates[0].confidence = 1;
          expect(() =>
            verifyToolFile(tampered, report.toolFileHashes[t.file], true, t.file),
          ).toThrow("Data withheld");
        }
      }
    }
    const realReport = read("certificates/report.json");
    for (const t of realReport.tools)
      expect(
        verifyToolFile(
          read(`certificates/${t.file}`),
          realReport.toolFileHashes[t.file],
          false,
          t.file,
        ).sample,
      ).toBe(false);
  });
});


// Data-source selection and the replay catalog moved to the data layer: test/data-layer.test.ts.

describe("live toasts", () => {
  it("toasts held decisions, revocations and finished runs, once per record", async () => {
    const { toastFor } = await import("../src/app/live-toasts");
    const { verifyTimelineFile } = await import("../src/data");
    const entry = fixtureIndex.find((e) => e.runId === "demo-change-api-run-guarded")!;
    const bundle = validateBundle(read(`bundles/fixture/${entry.runId}.json`), entry);
    const events = verifyTimelineFile(read(`bundles/fixture/${entry.runId}.timeline.json`), bundle).events;
    const held = events.find((e) => e.type === "decision" && e.data?.status === "held")!;
    expect(toastFor(held)?.title).toBe("Decision held");
    expect(toastFor(events.find((e) => e.type === "certificate.revoked")!)?.tone).toBe("error");
    expect(toastFor(events.at(-1)!)?.title).toBe(`Run finished: ${String(events.at(-1)!.data?.status).replaceAll("_", " ")}`);
    expect(toastFor(events.find((e) => e.type === "probe.verdict")!)).toBeNull();
    expect(toastFor({ ...held, seq: 999, data: { ...held.data, live: true } })?.id).toBe(toastFor(held)?.id);
    const finished = events.at(-1)!;
    for (const status of ["failed", "stopped_budget", "blocked"])
      expect(toastFor({ ...finished, data: { ...finished.data, status } })?.tone).toBe("error");
    expect(toastFor({ ...finished, data: { ...finished.data, status: "completed" } })?.tone).toBe("success");
  });
});
