// /app/incidents: loader (404 -> empty, invalid -> error), the hash tie-in to bundles/index.json,
// cohort separation (fixture never mixed with real), counts from the file, links, and the render.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  IncidentKindSchema,
  IncidentsIndexSchema,
  type BundleIndexEntry,
  type Incident,
  type IncidentsFile,
  type IncidentsIndex,
} from "../../core/src/schema";
import { loadIncidents, type IncidentsLoad } from "../src/data/incidents";
import { FIXTURE_BANNER } from "../src/data/types";
import {
  ACTION_LABEL,
  KIND_LABEL,
  buildView,
  checkRun,
  matches,
  parseFilter,
  relatedLinks,
  statsOf,
  traceCell,
} from "../src/pages/incidents/model";
import { IncidentsContent, KIND_ICON, type IncidentsPageState } from "../src/pages/incidents/IncidentsPage";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TRACE = "0123456789abcdef0123456789abcdef";
const SPAN = "0123456789abcdef";
const NEATLOGS = "https://app.neatlogs.example/traces/0123456789abcdef0123456789abcdef";

let n = 0;
function incident(over: Partial<Incident> = {}): Incident {
  n += 1;
  return {
    id: `inc-${n.toString(16).padStart(16, "0")}`,
    runId: "run-real-1",
    kind: "guard_block",
    severity: "warning",
    at: "2026-10-11T10:00:00.000Z",
    summary: `Summary ${n}`,
    recordIds: [`rec-${n}`],
    exported: true,
    resolution: { status: "resolved", action: "action_refused", summary: "Refused; no money moved.", recordIds: [] },
    ...over,
  };
}

function file(over: Partial<IncidentsFile> = {}): IncidentsFile {
  return { runId: "run-real-1", sample: false, bundleHash: HASH_A, sources: ["bundle", "spans"], incidents: [], ...over };
}

const entry = (runId: string, contentHash: string, sample = false): BundleIndexEntry => ({
  runId,
  kind: "run",
  variant: "guarded",
  mode: "live",
  sample,
  startedAt: "2026-10-11T09:00:00.000Z",
  status: "completed",
  contentHash,
});

function ready(index: IncidentsIndex, primary: BundleIndexEntry[] | null = [], fixture: BundleIndexEntry[] | null = []) {
  return {
    status: "ready" as const,
    index: IncidentsIndexSchema.parse(index),
    primary: primary ? { entries: primary } : { entries: null },
    fixture: fixture ? { entries: fixture } : { entries: null },
  } satisfies IncidentsLoad;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });

function stubFetch(files: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    return url in files ? json(files[url]) : notFound();
  }) as typeof fetch;
}

const render = (state: IncidentsPageState, search = "") =>
  renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: [`/app/incidents${search}`] }, createElement(IncidentsContent, { state, params: new URLSearchParams(search) })),
  );

describe("incidents loader", () => {
  it("404 means nothing published (empty state, not an error)", async () => {
    expect(await loadIncidents({ base: "/", fetchImpl: stubFetch({}) })).toEqual({ status: "missing" });
  });

  it("a file that does not match the schema is an error", async () => {
    const fetchImpl = stubFetch({ "/incidents/index.json": { sample: false, runs: [{ runId: "x" }] } });
    await expect(loadIncidents({ base: "/", fetchImpl })).rejects.toThrow(/does not match the shared Notary schema/);
  });

  it("a valid file is read with both bundle indexes; an absent index is null, not an error", async () => {
    const index = { sample: false, runs: [file({ incidents: [incident()] })] };
    const fetchImpl = stubFetch({ "/incidents/index.json": index, "/bundles/index.json": [entry("run-real-1", HASH_A)] });
    const load = await loadIncidents({ base: "/", fetchImpl });
    expect(load.status).toBe("ready");
    if (load.status !== "ready") return;
    expect(load.index.runs[0]!.incidents).toHaveLength(1);
    expect(load.primary).toEqual({ entries: [entry("run-real-1", HASH_A)] });
    expect(load.fixture).toEqual({ entries: null });
  });

  it("fixture incidents come from their own file and stay marked as fixture", async () => {
    const fetchImpl = stubFetch({
      "/incidents/fixture/index.json": { sample: true, runs: [file({ runId: "demo-run", sample: false, incidents: [incident({ runId: "demo-run" })] })] },
    });
    const load = await loadIncidents({ base: "/", fetchImpl });
    if (load.status !== "ready") throw new Error("expected ready");
    expect(load.index.runs.map((r) => [r.runId, r.sample])).toEqual([["demo-run", true]]);
  });

  it("an unreadable bundle index is reported per run as unchecked", async () => {
    const index = { sample: false, runs: [file()] };
    const fetchImpl = stubFetch({ "/incidents/index.json": index, "/bundles/index.json": { not: "an index" } });
    const load = await loadIncidents({ base: "/", fetchImpl });
    if (load.status !== "ready") throw new Error("expected ready");
    expect(checkRun(load.index.runs[0]!, false, load.primary, load.fixture).state).toBe("unchecked");
  });
});

describe("incidents model", () => {
  it("every schema kind has a label and an icon", () => {
    for (const k of IncidentKindSchema.options) {
      expect(KIND_LABEL[k]).toBeTruthy();
      expect(KIND_ICON[k]).toBeTruthy();
    }
  });

  it("ties each run to its index entry: verified, mismatch (withheld), unpublished", () => {
    const load = ready(
      {
        sample: false,
        runs: [
          file({ runId: "run-ok", incidents: [incident({ runId: "run-ok" })] }),
          file({ runId: "run-bad", bundleHash: HASH_B, incidents: [incident({ runId: "run-bad" })] }),
          file({ runId: "run-new", incidents: [incident({ runId: "run-new" })] }),
        ],
      },
      [entry("run-ok", HASH_A), entry("run-bad", HASH_A)],
    );
    const view = buildView(load, false);
    expect(view.runs.map((r) => [r.runId, r.check.state, r.shown])).toEqual([
      ["run-ok", "verified", true],
      ["run-bad", "mismatch", false],
      ["run-new", "unpublished", true],
    ]);
    // The withheld run's incident is not counted.
    expect(view.stats.total).toBe(2);
  });

  it("never mixes fixture and real runs; a sample index makes every run fixture", () => {
    const load = ready({
      sample: false,
      runs: [file({ runId: "real", incidents: [incident({ runId: "real" })] }), file({ runId: "fx", sample: true, incidents: [incident({ runId: "fx" }), incident({ runId: "fx" })] })],
    });
    const real = buildView(load, false);
    const fixture = buildView(load, true);
    expect(real.runs.map((r) => r.runId)).toEqual(["real"]);
    expect(real.stats.total).toBe(1);
    expect(real.otherCohortRuns).toBe(1);
    expect(fixture.runs.map((r) => r.runId)).toEqual(["fx"]);
    expect(fixture.stats.total).toBe(2);
    const sampleIndex = ready({ sample: true, runs: [file({ runId: "real" })] });
    expect(buildView(sampleIndex, false).runs).toEqual([]);
    expect(buildView(sampleIndex, true).runs.map((r) => r.runId)).toEqual(["real"]);
  });

  it("counts by status, severity and kind come from the incidents", () => {
    const list = [
      incident({ severity: "error", kind: "unsafe_action_executed", resolution: { status: "open", action: "none", summary: "s", recordIds: [] } }),
      incident({ kind: "guard_hold", resolution: { status: "awaiting_human", action: "held_for_person", summary: "s", recordIds: [] } }),
      incident({ kind: "guard_block" }),
    ];
    const s = statsOf(list);
    expect([s.total, s.resolved, s.awaitingHuman, s.open, s.errors, s.warnings]).toEqual([3, 1, 1, 1, 1, 2]);
    expect(s.byKind).toEqual({ unsafe_action_executed: 1, guard_hold: 1, guard_block: 1 });
    const f = parseFilter(new URLSearchParams("status=open&kind=bogus"));
    expect(f).toEqual({ kind: null, severity: null, status: "open" });
    expect(list.filter((i) => matches(i, f))).toHaveLength(1);
  });

  it("links to the run, the decision, the certificate (certified/guard_compiled only) and approvals", () => {
    const hold = incident({ kind: "guard_hold", decisionId: "dec-1", beliefId: "bel-1", resolution: { status: "awaiting_human", action: "held_for_person", summary: "s", recordIds: [] } });
    expect(relatedLinks(hold).map((l) => l.to)).toEqual([
      "/app/run?run=run-real-1",
      "/app/run?run=run-real-1&decision=dec-1",
      "/app/approvals?run=run-real-1",
    ]);
    const certified = incident({ beliefId: "bel-2", resolution: { status: "resolved", action: "guard_compiled", summary: "s", recordIds: [] } });
    expect(relatedLinks(certified).map((l) => l.to)).toContain("/app/certificates?run=run-real-1&belief=bel-2");
  });

  it("uses only the recorded neatlogs URL; otherwise the trace id, or none", () => {
    expect(traceCell({ traceUrl: NEATLOGS, traceId: TRACE, exported: true })).toEqual({ kind: "link", url: NEATLOGS, traceId: TRACE, exported: true });
    expect(traceCell({ traceId: TRACE, spanId: SPAN, exported: false })).toEqual({ kind: "id", traceId: TRACE, spanId: SPAN, exported: false });
    expect(traceCell({ exported: false })).toEqual({ kind: "none" });
    expect(traceCell({ traceUrl: "javascript:alert(1)", exported: false } as never).kind).toBe("none");
  });

  it("labels every resolution action", () => {
    expect(Object.keys(ACTION_LABEL)).toHaveLength(15);
  });
});

describe("incidents page render", () => {
  it("missing file: the empty state and how incidents get published", () => {
    const html = render({ status: "missing" });
    expect(html).toContain("No incidents published yet");
    expect(html).toContain("pnpm notary export");
  });

  it("invalid file: a visible error", () => {
    const html = render({ status: "error", message: "incidents/index.json does not match the shared Notary schema. Incidents withheld." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Incidents withheld");
  });

  it("real runs: counts, neatlogs link exactly as recorded, trace id fallback, hash mismatch, no fixture banner", () => {
    const load = ready(
      {
        sample: false,
        runs: [
          file({
            runId: "run-real-1",
            incidents: [
              incident({ traceUrl: NEATLOGS, traceId: TRACE, spanId: SPAN, agent: "guard", tool: "dodo", summary: "Refund refused" }),
              incident({ traceId: TRACE, exported: false, summary: "Local only" }),
              incident({ exported: false, summary: "Untraced" }),
            ],
          }),
          file({ runId: "run-bad", bundleHash: HASH_B, incidents: [incident({ runId: "run-bad", summary: "Hidden" })] }),
        ],
      },
      [entry("run-real-1", HASH_A), entry("run-bad", HASH_A)],
    );
    const html = render({ status: "ready", load });
    expect(html).not.toContain(FIXTURE_BANNER);
    expect(html).toContain(`href="${NEATLOGS}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Open in neatlogs");
    expect(html).toContain("local span only (not exported to neatlogs)");
    expect(html).toContain("No trace (tracing was off)");
    expect(html).toContain("Incidents were derived from a different bundle than the one published");
    expect(html).not.toContain("Hidden");
    expect(html).toContain("Refund refused");
    expect(html).toContain("Guard");
    // Only one neatlogs URL appears: the recorded one.
    expect(html.match(/neatlogs\.example/g)).toHaveLength(1);
  });

  it("fixture view: the exact banner, fixture runs only", () => {
    const load = ready({ sample: true, runs: [file({ runId: "fx", sample: true, incidents: [incident({ runId: "fx", summary: "Fixture thing" })] })] });
    const real = render({ status: "ready", load });
    expect(real).not.toContain("Fixture thing");
    expect(real).toContain("Open the fixture view");
    const fx = render({ status: "ready", load }, "?fixtures=1");
    expect(fx).toContain(FIXTURE_BANNER);
    expect(FIXTURE_BANNER).toBe("Fixture data — simulated APIs, not a live run");
    expect(fx).toContain("Fixture thing");
    expect(fx).toContain("Bundle not published");
  });
});
