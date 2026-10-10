import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BundleIndexSchema } from "../../core/src/schema/bundle";
import type { BundleIndexEntry } from "../../core/src/schema";
import { validateBundle } from "../src/data";
import {
  NAV_GROUPS,
  matchAppRoute,
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
  resolveDataMode,
  withRun,
} from "../src/state/data-mode";
import { chooseScenario, verifyToolFile } from "../src/data";
import { FixtureIndexSchema } from "../../core/src/schema";

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
  it("covers every /app path of the shell spec", () => {
    const required = [
      "/app",
      "/app/mission-control",
      "/app/runs",
      "/app/runs/:runId",
      "/app/probes",
      "/app/probes/:probeId",
      "/app/beliefs",
      "/app/beliefs/:beliefId",
      "/app/certificates",
      "/app/certificates/:certificateId",
      "/app/reports",
      "/app/reports/:tool",
      "/app/queue",
      "/app/queue/:decisionId",
      "/app/approvals",
      "/app/ask",
      "/app/economics",
      "/app/evidence",
      "/app/revocation-demo",
    ];
    expect(routes.map((r) => r.path).sort()).toEqual([...required].sort());
    expect(new Set(routes.map((r) => r.id)).size).toBe(routes.length);
  });
  it("keeps the sidebar groups exact", () => {
    const byGroup = Object.fromEntries(
      NAV_GROUPS.map((g) => [
        g,
        routes.filter((r) => r.group === g).map((r) => r.title),
      ]),
    );
    expect(byGroup).toEqual({
      Monitor: ["Overview", "Mission control", "Runs", "Probe log"],
      Trust: ["Certificates", "API reports"],
      Act: ["Queue", "Approval desk", "Ask Notary"],
      Business: ["Economics", "Evidence"],
    });
    expect(routes.filter((r) => r.badge === "held").map((r) => r.id)).toEqual([
      "queue",
      "approvals",
    ]);
    expect(routeById("certificates")?.badge).toBe("revocations");
  });
  it("gives every record its own URL and a parent list", () => {
    for (const kind of ["decision", "probe", "belief", "certificate"]) {
      const route = routes.find((r) => r.record === kind)!;
      expect(route.path).toMatch(/:/);
      expect(routeById(route.parent!)).toBeDefined();
    }
    expect(matchAppRoute("/app/queue/demo-run-guarded%3Aq01")?.route.id).toBe(
      "decision",
    );
    expect(matchAppRoute("/app/queue")?.route.id).toBe("queue");
    expect(matchAppRoute("/app/")?.route.id).toBe("overview");
    expect(matchAppRoute("/app/nope")).toBeUndefined();
    for (const r of redirects) expect(matchAppRoute(r.to)).toBeDefined();
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
    expect(withRun("/app/queue", "a b", { baseline: "x" })).toBe(
      "/app/queue?run=a+b&baseline=x",
    );
    expect(withRun("/app", undefined)).toBe("/app");
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
      `/app/probes/${encodeURIComponent(probe.id)}?run=${notarize.runId}`,
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
