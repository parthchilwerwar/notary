// Redesign R1 data layer: mode selection, LiveSource (mocked fetch + EventSource) and
// ReplaySource against the real published files in public/.
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse, RunBundle, TimelineEvent, TimelineFile } from "../../core/src/schema";
import {
  DataSourceProvider,
  FIXTURE_BANNER,
  LiveSource,
  PublishedFiles,
  ReplayOnlyError,
  ReplaySource,
  RunStillRunningError,
  TimelineMissingError,
  approvalId,
  integrationView,
  isHostedBuild,
  replayDelays,
  resolveApiBase,
  selectDataSource,
  shouldProbe,
  type EventSourceLike,
  type RunEntry,
  type Timers,
  useDataSource,
} from "../src/data";

const PUBLIC = new URL("../public/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, PUBLIC), "utf8"));
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

/** fetch over packages/web/public/ (base "/"), with optional per-path overrides. */
function diskFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.replace(/^\//, "");
    if (path in overrides) return json(overrides[path]);
    const file = new URL(path, PUBLIC);
    if (!existsSync(file)) return new Response("", { status: 404, statusText: "Not Found" });
    return new Response(readFileSync(file, "utf8"), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const replay = (fetchImpl = diskFetch(), timers?: Timers) =>
  new ReplaySource({ published: new PublishedFiles({ base: "/", fetchImpl }), timers });

const health: HealthResponse = {
  ok: true,
  service: "notary serve",
  integrations: [
    { name: "dodo", state: "missing", label: "missing DODO_PAYMENTS_API_KEY", variable: "DODO_PAYMENTS_API_KEY", checkedAt: "2026-10-11T00:00:00.000Z" },
    { name: "llm", state: "connected", label: "connected", checkedAt: "2026-10-11T00:00:00.000Z" },
    { name: "crustdata", state: "configured", label: "configured", checkedAt: "2026-10-11T00:00:00.000Z" },
    { name: "neatlogs", state: "error", label: "error 401 from neatlogs", detail: "401 from neatlogs", checkedAt: "2026-10-11T00:00:00.000Z" },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------- selection

describe("mode selection", () => {
  const dev = { PROD: false };
  it("live iff /api/health answers a schema-valid HealthResponse", async () => {
    const fetchImpl = vi.fn(async () => json(health));
    const s = await selectDataSource({ env: dev, hostname: "localhost", fetchImpl: fetchImpl as never });
    expect(s.mode).toBe("live");
    expect(s.source).toBeInstanceOf(LiveSource);
    expect(s.health).toEqual(health);
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:8787/api/health", expect.anything());
  });
  it("replay with a visible reason when /api/health answers something invalid", async () => {
    const s = await selectDataSource({
      env: dev,
      hostname: "localhost",
      fetchImpl: (async () => json({ ok: true, service: "something else", integrations: [] })) as never,
    });
    expect(s.mode).toBe("replay");
    expect(s.source).toBeInstanceOf(ReplaySource);
    expect(s.error).toMatch(/not a Notary health response/);
  });
  it("quiet replay when nothing answers (refused, 404, HTML)", async () => {
    for (const fetchImpl of [
      async () => {
        throw new TypeError("Failed to fetch");
      },
      async () => new Response("", { status: 404 }),
      async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
    ]) {
      const s = await selectDataSource({ env: dev, hostname: "127.0.0.1", fetchImpl: fetchImpl as never });
      expect(s.mode).toBe("replay");
      expect(s.error).toBeNull();
    }
  });
  it("the production (hosted) build is always replay and never probes", async () => {
    const fetchImpl = vi.fn();
    const s = await selectDataSource({ env: { PROD: true }, hostname: "localhost", fetchImpl: fetchImpl as never });
    expect(s.mode).toBe("replay");
    expect(s.hosted).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Even with an API configured at build time.
    await selectDataSource({ env: { PROD: true, VITE_NOTARY_API: "http://localhost:8787" }, fetchImpl: fetchImpl as never });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isHostedBuild({ PROD: true })).toBe(true);
    expect(isHostedBuild({ PROD: true, VITE_NOTARY_LIVE: "1" })).toBe(false);
    expect(isHostedBuild({ PROD: false })).toBe(false);
  });
  it("only probes from loopback pages unless VITE_NOTARY_API names the API", async () => {
    expect(shouldProbe(dev, "localhost")).toBe(true);
    expect(shouldProbe(dev, "127.0.0.1")).toBe(true);
    expect(shouldProbe(dev, "[::1]")).toBe(true);
    expect(shouldProbe(dev, "notary.localhost")).toBe(true);
    expect(shouldProbe(dev, undefined)).toBe(true);
    expect(shouldProbe(dev, "notary.vercel.app")).toBe(false);
    expect(shouldProbe({ ...dev, VITE_NOTARY_API: "http://127.0.0.1:8787" }, "notary.vercel.app")).toBe(true);
    const fetchImpl = vi.fn();
    const s = await selectDataSource({ env: dev, hostname: "notary.example.com", fetchImpl: fetchImpl as never });
    expect(s.mode).toBe("replay");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("API base: default is the serve port; '' or '/' is same origin (dev proxy)", () => {
    expect(resolveApiBase({})).toBe("http://localhost:8787");
    expect(resolveApiBase({ VITE_NOTARY_API: "http://127.0.0.1:9999/" })).toBe("http://127.0.0.1:9999");
    expect(resolveApiBase({ VITE_NOTARY_API: "" })).toBe("");
    expect(resolveApiBase({ VITE_NOTARY_API: "/" })).toBe("");
  });
  // No global mode banner (K4, DECISIONS #182): the provider's state is what pages read.
  const ModeProbe = () => {
    const { mode, ready, hosted } = useDataSource();
    return createElement("output", null, `${mode} ready=${ready} hosted=${hosted}`);
  };
  it("the provider is ready at once on the hosted build, in replay", () => {
    const html = renderToStaticMarkup(
      createElement(DataSourceProvider, { options: { env: { PROD: true } }, children: createElement(ModeProbe) }),
    );
    expect(html).toBe("<output>replay ready=true hosted=true</output>");
    expect(FIXTURE_BANNER).toBe("Fixture data — simulated APIs, not a live run");
  });
  it("an injected live source is live and ready", () => {
    const html = renderToStaticMarkup(
      createElement(
        DataSourceProvider,
        { value: { source: new LiveSource({ base: "", fetchImpl: vi.fn() as never }) }, children: createElement(ModeProbe) },
      ),
    );
    expect(html).toBe("<output>live ready=true hosted=false</output>");
  });
});

describe("integration status at the point of use", () => {
  it("names the missing variable, never a number", () => {
    expect(integrationView(health, "dodo", "live")).toMatchObject({
      connected: false,
      state: "missing",
      message: "Not connected — set DODO_PAYMENTS_API_KEY in .env",
    });
    expect(integrationView(health, "llm", "live")).toMatchObject({ connected: true, message: "Connected" });
    expect(integrationView(health, "crustdata", "live").connected).toBe(false);
    expect(integrationView(health, "crustdata", "live").message).toMatch(/not verified/);
    expect(integrationView(health, "neatlogs", "live").message).toBe("Error — 401 from neatlogs");
    expect(integrationView(health, "entire", "live")).toMatchObject({ state: "unknown", connected: false });
    expect(integrationView(null, "dodo", "replay")).toMatchObject({ state: "unknown", connected: false });
  });
});

// ------------------------------------------------------------------------------ LiveSource

const sample = read("bundles/sample-42.json") as RunBundle;
const fixtureIndex = read("bundles/fixture/index.json") as RunEntry[];
const guardedEntry = fixtureIndex.find((e) => e.runId === "demo-run-guarded")!;
const guardedBundle = read("bundles/fixture/demo-run-guarded.json") as RunBundle;
/** sample-42 dressed as a real, finished run the API serves (hash recomputed is not needed: */
/** validateBundle checks the hash of the bundle as served, so serve it unchanged). */
const servedEntry = {
  runId: sample.runId,
  kind: sample.kind,
  variant: sample.variant,
  mode: sample.mode,
  sample: sample.sample,
  startedAt: sample.startedAt,
  status: sample.status,
  contentHash: sample.contentHash,
  state: "finished" as const,
};

function apiFetch(routes: Record<string, () => Response>) {
  const disk = diskFetch();
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^http:\/\/localhost:8787/, "");
    if (path in routes) return routes[path]!();
    if (url.startsWith("http://localhost:8787")) return json({ error: "not found" }, { status: 404 });
    return disk(input, init);
  });
}

const live = (fetchImpl: unknown, extra: Partial<ConstructorParameters<typeof LiveSource>[0]> = {}) =>
  new LiveSource({
    base: "http://localhost:8787",
    fetchImpl: fetchImpl as typeof fetch,
    published: new PublishedFiles({ base: "/", fetchImpl: fetchImpl as typeof fetch }),
    token: () => "tok",
    ...extra,
  });

describe("LiveSource (mocked fetch)", () => {
  it("lists the API's runs plus published fixture runs it does not serve; validates the list", async () => {
    const running = { runId: "run-now", state: "running", kind: "run", startedAt: "2026-10-11T00:00:00.000Z" };
    const src = live(apiFetch({ "/api/runs": () => json({ runs: [servedEntry, running] }) }));
    const runs = await src.listRuns();
    expect(runs.find((r) => r.runId === "run-now")?.state).toBe("running");
    expect(runs.filter((r) => r.state === "finished" && r.sample && r.runId.startsWith("demo-")).length).toBe(fixtureIndex.length);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(runs.length);
    await expect(live(apiFetch({ "/api/runs": () => json({ runs: [{ runId: 1 }] }) })).listRuns()).rejects.toThrow(/shared schema/);
  });
  it("getRun verifies the served bundle's hash; 202 means still running", async () => {
    const tampered = { ...sample, metrics: { ...sample.metrics, unsafe_actions_total: 999 } };
    const fetchImpl = apiFetch({
      "/api/runs": () => json({ runs: [servedEntry] }),
      "/api/runs/sample-42": () => json(sample),
      "/api/runs/tampered": () => json(tampered),
      "/api/runs/run-now": () => json({ state: "running" }, { status: 202 }),
    });
    const src = live(fetchImpl);
    expect((await src.getRun("sample-42")).contentHash).toBe(sample.contentHash);
    await expect(src.getRun("tampered")).rejects.toThrow(/hash mismatch/);
    await expect(src.getRun("run-now")).rejects.toBeInstanceOf(RunStillRunningError);
    // Fixture runs come from the published files, still hash-verified.
    expect((await src.getRun("demo-run-guarded")).sample).toBe(true);
  });
  it("health() rejects a schema-invalid answer", async () => {
    await expect(live(apiFetch({ "/api/health": () => json({ ok: false }) })).health()).rejects.toThrow(/shared schema/);
    expect(await live(apiFetch({ "/api/health": () => json(health) })).health()).toEqual(health);
  });
  it("startRun posts a StartRunRequest with the token; invalid requests never leave the browser", async () => {
    const fetchImpl = apiFetch({ "/api/runs": () => json({ runId: "run-1", state: "running" }) });
    const src = live(fetchImpl);
    await expect(src.startRun({ kind: "queue", variant: "guarded" })).resolves.toEqual({ runId: "run-1", state: "running" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/api/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ kind: "queue", variant: "guarded" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    fetchImpl.mockClear();
    await expect(src.startRun({ kind: "queue", variant: "reckless" } as never)).rejects.toThrow(/shared schema/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(live(apiFetch({ "/api/runs": () => json({ runId: 7 }) })).startRun({ kind: "notarize", tool: "dodo" })).rejects.toThrow(/shared schema/);
  });
  it("approve/reject hit /api/approvals/:id/approve|reject; ask validates the answer", async () => {
    const record = {
      id: approvalId("r", "r:q1"),
      runId: "r",
      decisionId: "r:q1",
      requestId: "q1",
      action: "dodo.createRefund",
      decision: "rejected",
      reason: "no",
      humanOverride: true,
      effects: [],
      status: "closed",
      decidedAt: "2026-10-11T00:00:00.000Z",
    };
    const id = approvalId("r", "r:q1");
    const fetchImpl = apiFetch({
      [`/api/approvals/${id}/approve`]: () => json({ ...record, decision: "approved", confirmedAmount: 100, status: "executed" }),
      [`/api/approvals/${id}/reject`]: () => json(record),
      "/api/ask": () => json({ ok: true, answer: "Because.", citations: [] }),
    });
    const src = live(fetchImpl);
    expect((await src.approve(id, 100)).decision).toBe("approved");
    expect((await src.reject(id, "no")).decision).toBe("rejected");
    expect(fetchImpl.mock.calls.map(([u]) => String(u))).toEqual([
      `http://localhost:8787/api/approvals/${id}/approve`,
      `http://localhost:8787/api/approvals/${id}/reject`,
    ]);
    await expect(src.reject(id, "  ")).rejects.toThrow(/reason/);
    // An answer with no citations fails AskResponseSchema: rejected, never rendered.
    await expect(src.ask({ question: "why?" })).rejects.toThrow(/shared schema/);
  });
  it("real certificates: seals are recomputed; a tampered record is withheld", async () => {
    const report = read("certificates/report.json");
    const tools = report.tools.map((t: { file: string }) => read(`certificates/${t.file}`));
    const ok = await live(apiFetch({ "/api/certificates": () => json({ world: "real", tools, report }) })).certificates();
    expect(ok.world).toBe("real");
    expect(ok.sample).toBe(false);
    const changed = structuredClone(tools);
    changed[0].header = `${changed[0].header} (edited)`;
    await expect(
      live(apiFetch({ "/api/certificates": () => json({ world: "real", tools: changed, report }) })).certificates(),
    ).rejects.toThrow(/pinned in its report/);
  });
});

/** A controllable EventSource double. */
class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  closed = false;
  listeners = new Map<string, (ev: MessageEvent<string>) => void>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  send(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent<string>);
  }
  end() {
    this.listeners.get("end")?.({ data: "" } as MessageEvent<string>);
  }
}

describe("LiveSource SSE", () => {
  const ev = (seq: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
    runId: "run-1",
    seq,
    at: "2026-10-11T00:00:00.000Z",
    stage: "enforce",
    type: "decision",
    recordIds: [`d${seq}`],
    traceIds: [],
    summary: `event ${seq}`,
    ...over,
  });
  it("opens /api/runs/:id/events, delivers valid events once, drops invalid ones, ends", () => {
    const src = live(vi.fn(), { EventSourceImpl: FakeEventSource });
    const got: TimelineEvent[] = [];
    const errors: string[] = [];
    const onEnd = vi.fn();
    const stop = src.streamEvents("run-1", (e) => got.push(e), { onEnd, onError: (m) => errors.push(m) });
    const es = FakeEventSource.last;
    expect(es.url).toBe("http://localhost:8787/api/runs/run-1/events");
    es.send(ev(0));
    es.send(ev(1));
    es.send(ev(1)); // a reconnect replays the file: duplicate dropped
    es.send({ ...ev(2), type: "nonsense" }); // schema-invalid
    es.send(ev(3, { runId: "other-run" })); // another run
    es.send("{not json");
    es.send(ev(2));
    expect(got.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(errors.length).toBe(3);
    es.end();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(es.closed).toBe(true);
    stop();
  });
  it("accepts the server's named `timeline` events and passes provisional live events through", () => {
    const src = live(vi.fn(), { EventSourceImpl: FakeEventSource });
    const got: TimelineEvent[] = [];
    const errors: string[] = [];
    src.streamEvents("run-1", (e) => got.push(e), { onError: (m) => errors.push(m) });
    const es = FakeEventSource.last;
    const named = (e: unknown) => es.listeners.get("timeline")!({ data: JSON.stringify(e) } as MessageEvent<string>);
    named(ev(0));
    named(ev(1, { data: { live: true } })); // provisional
    named(ev(1)); // the final event with the same seq still arrives
    named(ev(1)); // a replayed duplicate does not
    expect(got.map((e) => [e.seq, e.data?.live === true])).toEqual([[0, false], [1, true], [1, false]]);
    es.onerror?.({ data: JSON.stringify({ error: "timeline unreadable" }) } as unknown as Event);
    expect(errors).toEqual(["The local API reported: timeline unreadable"]);
  });
  it("unsubscribe closes the stream", () => {
    const src = live(vi.fn(), { EventSourceImpl: FakeEventSource });
    const stop = src.streamEvents("run-1", () => {});
    stop();
    expect(FakeEventSource.last.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------- ReplaySource

describe("ReplaySource (real public/ data)", () => {
  it("lists every published run as finished, fixture runs flagged sample: true", async () => {
    const runs = await replay().listRuns();
    const primary = read("bundles/index.json") as RunEntry[];
    expect(runs.length).toBe(primary.length + fixtureIndex.length);
    expect(runs.every((r) => r.state === "finished")).toBe(true);
    for (const f of fixtureIndex) expect(runs.find((r) => r.runId === f.runId)).toMatchObject({ sample: true });
  });
  it("hash-verifies every bundle and withholds a tampered one", async () => {
    const src = replay();
    for (const r of await src.listRuns()) {
      const b = await src.getRun(r.runId);
      expect(r.state === "finished" && b.contentHash).toBe(r.state === "finished" && r.contentHash);
    }
    const tampered = replay(
      diskFetch({ "bundles/sample-42.json": { ...sample, metrics: { ...sample.metrics, unsafe_actions_total: 999 } } }),
    );
    await expect(tampered.getRun("sample-42")).rejects.toThrow(/hash mismatch/);
  });
  it("timelines are ordered and tied to their bundle's hash", async () => {
    const src = replay();
    for (const f of fixtureIndex) {
      const events = await src.getTimeline(f.runId);
      expect(events.length).toBeGreaterThan(0);
      events.forEach((e, i) => {
        expect(e.runId).toBe(f.runId);
        if (i) expect(e.seq).toBeGreaterThan(events[i - 1]!.seq);
      });
    }
    const file = read("bundles/fixture/demo-run-guarded.timeline.json") as TimelineFile;
    const wrongHash = replay(
      diskFetch({ "bundles/fixture/demo-run-guarded.timeline.json": { ...file, bundleHash: "0".repeat(64) } }),
    );
    await expect(wrongHash.getTimeline("demo-run-guarded")).rejects.toThrow(/hash mismatch/);
    const reordered = replay(
      diskFetch({ "bundles/fixture/demo-run-guarded.timeline.json": { ...file, events: [...file.events].reverse() } }),
    );
    await expect(reordered.getTimeline("demo-run-guarded")).rejects.toThrow(/out of order/);
    // sample-42 has no published timeline: "missing", not an error.
    await expect(src.getTimeline("sample-42")).rejects.toBeInstanceOf(TimelineMissingError);
  });

  /** Timers that record each delay and run callbacks when flushed. */
  function manualTimers() {
    const queue: { fn: () => void; ms: number }[] = [];
    const delays: number[] = [];
    const timers: Timers = {
      set: (fn, ms) => {
        delays.push(ms);
        const t = { fn, ms };
        queue.push(t);
        return t;
      },
      clear: (h) => {
        const i = queue.indexOf(h as never);
        if (i >= 0) queue.splice(i, 1);
      },
    };
    const flush = async () => {
      for (let guard = 0; guard < 10_000; guard++) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        const next = queue.shift();
        if (!next) return;
        next.fn();
      }
    };
    return { timers, delays, flush };
  }

  it("streams the recorded events in order at 1×, 4× (4 times faster) and instantly", async () => {
    const expected = await replay().getTimeline("demo-run-guarded");
    const at1 = manualTimers();
    const got1: number[] = [];
    const end1 = vi.fn();
    replay(diskFetch(), at1.timers).streamEvents("demo-run-guarded", (e) => got1.push(e.seq), { speed: 1, onEnd: end1 });
    await at1.flush();
    expect(got1).toEqual(expected.map((e) => e.seq));
    expect(end1).toHaveBeenCalledTimes(1);
    expect(at1.delays).toEqual(replayDelays(expected, 1));

    const at4 = manualTimers();
    const got4: number[] = [];
    replay(diskFetch(), at4.timers).streamEvents("demo-run-guarded", (e) => got4.push(e.seq), { speed: 4 });
    await at4.flush();
    expect(got4).toEqual(got1);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(sum(at4.delays)).toBeCloseTo(sum(at1.delays) / 4);
    expect(Math.min(...at1.delays)).toBeGreaterThanOrEqual(200);
    expect(Math.max(...at1.delays)).toBeLessThanOrEqual(1600);

    const instant = manualTimers();
    const gotI: number[] = [];
    const endI = vi.fn();
    replay(diskFetch(), instant.timers).streamEvents("demo-run-guarded", (e) => gotI.push(e.seq), { speed: "instant", onEnd: endI });
    await vi.waitFor(() => expect(endI).toHaveBeenCalled());
    expect(gotI).toEqual(got1);
    expect(instant.delays).toEqual([]);
  });
  it("unsubscribe stops delivery", async () => {
    const t = manualTimers();
    const got: number[] = [];
    const stop = replay(diskFetch(), t.timers).streamEvents("demo-run-guarded", (e) => got.push(e.seq));
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    stop();
    await t.flush();
    expect(got.length).toBeLessThanOrEqual(1);
  });
  it("certificates: real world for real runs, the run's own fixture scenario otherwise, never a stand-in", async () => {
    const src = replay();
    const realWorld = await src.certificates();
    expect(realWorld).toMatchObject({ world: "real", sample: false });
    expect(realWorld.report?.sample).toBe(false);
    const fx = await src.certificates({ ...guardedEntry, state: "finished" } as RunEntry);
    expect(fx.world).toBe("fixture:default");
    expect(fx.tools.every((t) => t.sample)).toBe(true);
    const changeApi = fixtureIndex.find((e) => e.runId === "demo-change-api-run-guarded")!;
    expect((await src.certificates({ ...changeApi, state: "finished" } as RunEntry)).world).toBe("fixture:change-api");
    const synthetic = await src.certificates({ ...servedEntry });
    expect(synthetic).toMatchObject({ world: "fixture:none", report: null, tools: [] });
  });
  it("approvals are the recorded held decisions, read-only, with no invented amounts", async () => {
    const list = await replay().approvals();
    expect(list.testMode).toBe(false);
    expect(list.decided).toEqual([]);
    const held = guardedBundle.decisions.filter((d) => d.status === "held");
    expect(held.length).toBeGreaterThan(0);
    for (const d of held) {
      const item = list.pending.find((p) => p.runId === guardedBundle.runId && p.decisionId === d.id);
      expect(item).toBeDefined();
      expect(item!.id).toBe(approvalId(guardedBundle.runId, d.id));
      expect(item!.amount).toBeUndefined();
    }
  });
  it("explain answers come from the published file; health is null", async () => {
    const src = replay();
    expect(await src.health()).toBeNull();
    const file = await src.explain();
    expect(file?.answers.length).toBe(read("content/explain.json").answers.length);
  });
  it("live-only operations throw ReplayOnlyError without any request", async () => {
    const fetchImpl = diskFetch();
    const src = replay(fetchImpl);
    await expect(src.startRun()).rejects.toBeInstanceOf(ReplayOnlyError);
    await expect(src.approve()).rejects.toBeInstanceOf(ReplayOnlyError);
    await expect(src.reject()).rejects.toBeInstanceOf(ReplayOnlyError);
    await expect(src.ask()).rejects.toThrow(/needs live mode/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
