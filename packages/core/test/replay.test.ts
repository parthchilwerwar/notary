/**
 * P8 replay (PRD FR-11). Everything here runs against a FAKE in-process Dodo/Crustdata HTTP API
 * (a stubbed global fetch) and a FAKE model client — test doubles, not recorded traffic. A "live"
 * run records TEMPORARY TEST cassettes and bundles into temp dirs (deleted after each test); then
 * `notary replay` reproduces them with fetch disabled and an empty environment. No real cassette or
 * bundle is read or written.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeBundle, verifyBundle } from "../src/bundle/index.js";
import { runNoiseFloor } from "../src/eval/noise-floor.js";
import type { CompleteRequest, CompleteResult, LlmLike } from "../src/llm/client.js";
import { runQueue } from "../src/queue/run.js";
import { notarize } from "../src/reflect/notarize.js";
import { BLOCKED_NOTHING_RECORDED, runReplay } from "../src/replay/index.js";
import { normalizeVolatile } from "../src/replay/llm-cassette.js";
import { parseRef, pinRef } from "../src/replay/pins.js";
import type { Probe, RunBundle } from "../src/schema/index.js";
import { makeDriftFixture } from "../src/tools/drift-fixture.js";
import { computeContentHash, loadCassette, saveCassette } from "../src/tools/index.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const LIVE_ENV = {
  DODO_PAYMENTS_API_KEY: "test_fake_dodo_key_0001",
  CRUSTDATA_API_KEY: "test_fake_crustdata_key_0001",
  NOTARY_MODE: "test",
};

// ---------------------------------------------------------------------------------------------
// TEST DOUBLES

function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** A deterministic fake Dodo + Crustdata API: same request in, same response out. */
async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const raw = typeof init?.body === "string" ? init.body : undefined;
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
  const id = shortHash(`${method} ${url.pathname}${url.search} ${raw ?? ""}`);
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (url.hostname.includes("crustdata")) {
    if (url.pathname.endsWith("/company/enrich")) return json(200, [{ matches: [{ company_data: { headcount: { total: 30 }, basic_info: { name: "Example" } } }] }]);
    return json(200, { credits: 1000 });
  }
  if (method === "GET") {
    if (/\/(refunds|payments|customers|subscriptions|products)$/.test(url.pathname)) return json(200, { items: [] });
    if (url.pathname.includes("/payments/")) return json(200, { payment_id: url.pathname.split("/").pop(), total_amount: 2900, currency: "USD", status: "succeeded" });
    return json(200, { id: `obj_${id}` });
  }
  if (url.pathname.endsWith("/refunds")) return json(200, { refund_id: `ref_${id}`, payment_id: body?.payment_id, status: "succeeded", amount: body?.amount ?? 2900 });
  // Echo writes (with amounts x100 on product prices, a deliberate unit quirk for the checker to find).
  const price = (body?.price as { price?: number } | undefined)?.price;
  return json(200, { ...(body ?? {}), id: `obj_${id}`, ...(typeof price === "number" ? { price: { ...(body!.price as object), price: price * 100 } } : {}) });
}

function refuseFetch(): never {
  throw new Error("network access during replay");
}

/** TEST double model: reflector rivals honored vs unit_mismatch per anomaly; adversary always upholds. Usage is fake but nonzero. */
class FakeLlm implements LlmLike {
  calls = 0;
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls += 1;
    const usage = { inputTokens: 100 + this.calls, outputTokens: 20, usd: 0.0005, modelId: `fake-${req.role}`, stopReason: "end_turn" };
    if (req.role === "adversary") return { ...usage, text: JSON.stringify({ verdict: "uphold", reason: "test-only uphold" }) };
    const text = req.messages.map((m) => m.content).join("\n");
    const ids = [...new Set([...text.matchAll(/"anomalyId":\s*"([^"]+)"/g), ...text.matchAll(/"id":\s*"(anom-[^"]+)"/g)].map((m) => m[1]!))];
    const reply = {
      anomalies: ids.map((anomalyId) => ({
        anomalyId,
        hypotheses: [
          { class: "honored", statement: `honored explains ${anomalyId}`, distinguishingTest: "unit_roundtrip" },
          { class: "unit_mismatch", statement: `unit_mismatch explains ${anomalyId}`, distinguishingTest: "unit_roundtrip" },
        ],
      })),
    };
    return { ...usage, text: JSON.stringify(reply) };
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function readBundle(path: string): RunBundle {
  const v = verifyBundle(JSON.parse(readFileSync(path, "utf8")));
  if (!v.ok) throw new Error(v.error);
  return v.bundle;
}

function writeRaw(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Probe fields that must be identical between a run and its replay (timestamps and trace ids differ). */
function stable(p: Probe) {
  return {
    id: p.id,
    claimId: p.claimId,
    template: p.template,
    params: p.params,
    control: p.control,
    prediction: p.prediction,
    predictionHash: p.predictionHash,
    observed: p.observed,
    verdict: p.verdict,
    winningHypothesisId: p.winningHypothesisId,
    costCredits: p.costCredits,
    calls: p.calls,
  };
}

async function liveNotarize(dirsOut: { runs: string; cassettes: string }, dbPath = ":memory:") {
  const r = await notarize({
    tool: "dodo",
    env: LIVE_ENV,
    llm: new FakeLlm(),
    dbPath,
    runsDir: dirsOut.runs,
    cassetteDir: dirsOut.cassettes,
    manifestPath: join(dirsOut.runs, "no-manifest.json"),
    sleep: async () => {},
    unguardedCallSites: async () => 0,
  });
  expect(r.bundlePath, r.lines.join("\n")).toBeDefined();
  return readBundle(r.bundlePath!);
}

function queueFixtures(dir: string) {
  const queue = join(dir, "queue.json");
  const expected = join(dir, "expected.json");
  const manifest = join(dir, "manifest.json");
  writeRaw(queue, [
    { id: "r1", customerId: "cust:a", companyDomain: "a.example", type: "refund", plan: "starter", paymentId: "pay:a1", currency: "USD", reason: "test refund" },
    { id: "r2", customerId: "cust:b", companyDomain: "b.example", type: "refund", plan: "starter", paymentId: "pay:b1", amount: 1999, currency: "USD", reason: "test refund" },
  ]);
  writeRaw(expected, [
    { requestId: "r1", expectedTier: "smb", expectedOutcome: "approve", expectedAction: "dodo.createRefund", expectedAmount: 2900 },
    { requestId: "r2", expectedTier: "smb", expectedOutcome: "approve", expectedAction: "dodo.createRefund", expectedAmount: 1999 },
  ]);
  writeRaw(manifest, {
    createdAt: "2026-10-10T00:00:00.000Z",
    mode: "live",
    cassette: "seed-test-not-recorded",
    customers: {
      a: { customerId: "cus_a", email: "a@example.com", companyDomain: "a.example" },
      b: { customerId: "cus_b", email: "b@example.com", companyDomain: "b.example" },
    },
    products: {},
    payments: {
      a1: { paymentId: "pay_a1", customerHandle: "a", amount: 2900, currency: "USD", status: "succeeded" },
      b1: { paymentId: "pay_b1", customerHandle: "b", amount: 1999, currency: "USD", status: "succeeded" },
    },
    subscriptions: {},
  });
  return { queue, expected, manifest };
}

async function liveRun(variant: "naive" | "guarded", d: { runs: string; cassettes: string; fixtures: string }, dbPath = ":memory:") {
  const f = queueFixtures(d.fixtures);
  const r = await runQueue({
    queueFile: f.queue,
    expectedFile: f.expected,
    manifestPath: f.manifest,
    variant,
    mode: "live",
    env: LIVE_ENV,
    runsDir: d.runs,
    cassetteDir: d.cassettes,
    webBundlesDir: null,
    ...(variant === "guarded" ? { dbPath } : {}),
    unguardedCallSites: async () => 0,
  });
  expect(r.exitCode, r.lines.join("\n")).toBe(0);
  return readBundle(r.bundlePath!);
}

function dirsFor() {
  return { runs: tempDir("notary-replay-runs-"), cassettes: tempDir("notary-replay-cassettes-"), fixtures: tempDir("notary-replay-fixtures-") };
}

// ---------------------------------------------------------------------------------------------

describe("replay identity (P7 carry-over: a replay re-derives the SAME probe ids and tags)", () => {
  it("a replayed notarize over a test cassette reproduces identical probes, verdicts, beliefs and metrics", async () => {
    const d = dirsFor();
    const original = await liveNotarize(d);
    expect(original.mode).toBe("live");
    expect(original.probes.length).toBeGreaterThan(0);
    // Probe ids (and the tags in their request bodies) derive from the recorded runId.
    expect(original.probes.every((p) => p.id.startsWith(`${original.runId}-p`))).toBe(true);
    // Every cassette replay needs is pinned to its content hash.
    expect(original.cassettes.map((c) => parseRef(c).name)).toEqual([
      `${original.runId}-recon`,
      `${original.runId}-probes`,
      `${original.runId}-llm`,
      `${original.runId}-inputs`,
    ]);
    expect(original.cassettes.every((c) => parseRef(c).hash !== undefined)).toBe(true);

    vi.stubGlobal("fetch", refuseFetch);
    const res = await runReplay({ runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode, res.lines.join("\n")).toBe(0);
    expect(res.replays).toHaveLength(1);
    const replay = res.replays[0]!.replay!;
    expect(replay).toMatchObject({ mode: "replay", replayOf: original.runId, kind: "notarize", tool: "dodo" });
    expect(replay.runId).toBe(`${original.runId}-replay`);
    expect(replay.probes.map(stable)).toEqual(original.probes.map(stable));
    expect(replay.hypotheses).toEqual(original.hypotheses);
    expect(replay.anomalies.map((a) => ({ ...a, traceId: "", spanId: "" }))).toEqual(original.anomalies.map((a) => ({ ...a, traceId: "", spanId: "" })));
    const beliefView = (b: RunBundle["beliefs"]["after"][number]) => ({ id: b.id, status: b.status, alpha: b.alpha, beta: b.beta, confidence: b.confidence, class: b.class, statement: b.statement, evidence: b.evidence.map((e) => [e.probeId, e.valid]), adversary: b.adversary?.verdict });
    expect(replay.beliefs.after.map(beliefView)).toEqual(original.beliefs.after.map(beliefView));
    expect(replay.usageByRole).toEqual(original.usageByRole);
    expect(replay.metrics).toEqual(original.metrics);
    expect(res.replays[0]!.rows!.every((r) => r.match)).toBe(true);
    expect(res.lines.some((l) => l.includes("REPLAY OK"))).toBe(true);
    // The fake API echoes product prices x100: the price-unit belief is notarized (adversary upheld)
    // in the original AND in the replay, from recorded model answers.
    const price = replay.beliefs.after.find((b) => b.claimId === "dodo.product.price-minor-units")!;
    expect(price).toMatchObject({ status: "notarized", class: "unit_mismatch", adversary: { verdict: "uphold" } });
    expect(replay.metrics).toMatchObject({ beliefs_notarized: 1, belief_precision: 1, beliefs_false: 0, belief_precision_n: 1, "adversary.uphold": 1 });
  }, 60_000);

  it("probe tags come from the recorded runId: replaying under the fresh replay id instead misses the cassette", async () => {
    const d = dirsFor();
    const original = await liveNotarize(d);
    vi.stubGlobal("fetch", refuseFetch);
    const { ReplayLlm } = await import("../src/replay/llm-cassette.js");
    const llm = new ReplayLlm(loadCassette(`${original.runId}-llm`, { dir: d.cassettes }));
    const { CassetteMissError } = await import("../src/tools/index.js");
    // Same cassettes, same recorded model answers, but tags derived from a new runId (the P7 bug).
    await expect(
      notarize({
        tool: "dodo",
        replay: true,
        env: {},
        llm,
        dbPath: ":memory:",
        runId: "notarize-dodo-replay-fresh-id",
        reconCassette: `${original.runId}-recon`,
        probesCassette: `${original.runId}-probes`,
        runsDir: d.runs,
        cassetteDir: d.cassettes,
        paymentPool: [],
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(CassetteMissError);
  }, 60_000);

  it("guarded and naive queue runs replay to identical decisions and metrics (guarded from the recorded store snapshot)", async () => {
    const d = dirsFor();
    // A persistent TEMP store: notarize first (one notarized belief, guards compiled), then the queue.
    const dbPath = join(d.runs, "notary.sqlite");
    await liveNotarize(d, dbPath);
    const naive = await liveRun("naive", d);
    const guarded = await liveRun("guarded", d, dbPath);
    expect(guarded.beliefs.before.some((b) => b.status === "notarized")).toBe(true);
    expect(guarded.guards.some((g) => g.active)).toBe(true);
    expect(guarded.cassettes.map((c) => parseRef(c).name)).toContain(`${guarded.runId}-inputs`);
    vi.stubGlobal("fetch", refuseFetch);
    const res = await runReplay({ runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode, res.lines.join("\n")).toBe(0);
    for (const original of [naive, guarded]) {
      const r = res.replays.find((x) => x.runId === original.runId)!;
      expect(r.ok).toBe(true);
      expect(r.replay!.replayOf).toBe(original.runId);
      expect(r.replay!.metrics).toEqual(original.metrics);
      const view = (x: RunBundle) =>
        x.decisions.map((dd) => ({
          id: dd.requestId,
          status: dd.status,
          action: dd.action,
          grade: dd.grade,
          guards: dd.guardsApplied,
          missing: dd.missingBeliefs,
          pack: dd.evidencePack ? { reason: dd.evidencePack.reason, missing: dd.evidencePack.missingBeliefs, probes: dd.evidencePack.relatedProbeIds } : null,
          effects: dd.effects.map((e) => [e.op, e.status, e.amount]),
        }));
      expect(view(r.replay!)).toEqual(view(original));
    }
  }, 60_000);
});

describe("recon-only bundles replay too", () => {
  it("notarize --recon-only live -> replay reproduces anomalies and metrics", async () => {
    const d = dirsFor();
    const { reconOnly } = await import("../src/checker/notarize.js");
    const live = await reconOnly({ tool: "dodo", env: LIVE_ENV, runsDir: d.runs, cassetteDir: d.cassettes, sleep: async () => {}, unguardedCallSites: async () => 0 });
    expect(live.exitCode, live.lines.join("\n")).toBe(0);
    const original = readBundle(live.bundlePath!);
    expect(original.cassettes.map((c) => parseRef(c).name)).toEqual([`${original.runId}-recon`, `${original.runId}-inputs`]);
    vi.stubGlobal("fetch", refuseFetch);
    const res = await runReplay({ runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode, res.lines.join("\n")).toBe(0);
    const replay = res.replays[0]!.replay!;
    expect(replay).toMatchObject({ replayOf: original.runId, mode: "replay" });
    expect(replay.anomalies.map((a) => a.id)).toEqual(original.anomalies.map((a) => a.id));
    expect(replay.metrics).toEqual(original.metrics);
  }, 60_000);
});

describe("notary replay fails loudly", () => {
  it("no recorded bundles and no cassettes -> BLOCKED, exit 3 (not a pass)", async () => {
    const d = dirsFor();
    const res = await runReplay({ runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode).toBe(3);
    expect(res.lines.at(-1)).toBe(BLOCKED_NOTHING_RECORDED);
  });

  it("a cassette miss fails with the exchange (op, url, request hash, occurrence) and exit 1", async () => {
    const d = dirsFor();
    const original = await liveRun("naive", d);
    // A consistent but incomplete recording: drop the last exchange, re-hash the file and the pin.
    const cassette = loadCassette(original.runId, { dir: d.cassettes });
    const dropped = cassette.exchanges.at(-1)!;
    const exchanges = cassette.exchanges.slice(0, -1);
    saveCassette({ ...cassette, exchanges, contentHash: computeContentHash(exchanges) }, d.cassettes);
    const repinned = finalizeBundle({
      ...original,
      cassettes: original.cassettes.map((c) => (parseRef(c).name === original.runId ? pinRef(original.runId, computeContentHash(exchanges)) : c)),
    });
    writeRaw(join(d.runs, original.runId, `${original.runId}.json`), repinned);

    vi.stubGlobal("fetch", refuseFetch);
    const res = await runReplay({ runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode).toBe(1);
    const fail = res.lines.find((l) => l.includes("CASSETTE MISS"));
    expect(fail).toBeDefined();
    expect(fail).toContain(dropped.op);
    expect(fail).toContain(dropped.requestHash);
    expect(fail).toContain(`occurrence ${dropped.occurrence}`);
    expect(res.lines.at(-1)).toMatch(/^REPLAY FAILED/);
  }, 60_000);

  it("a model-cassette miss (the replayed prompt differs) also fails loudly", async () => {
    const d = dirsFor();
    const original = await liveNotarize(d);
    const ref = original.cassettes.find((c) => parseRef(c).name === `${original.runId}-llm`)!;
    const llm = loadCassette(parseRef(ref).name, { dir: d.cassettes });
    const exchanges = llm.exchanges.map((e) => (e.op === "llm.reflector" ? { ...e, requestHash: "0".repeat(64) } : e));
    saveCassette({ ...llm, exchanges, contentHash: computeContentHash(exchanges) }, d.cassettes);
    writeRaw(
      join(d.runs, original.runId, `${original.runId}.json`),
      finalizeBundle({ ...original, cassettes: original.cassettes.map((c) => (c === ref ? pinRef(llm.name, computeContentHash(exchanges)) : c)) }),
    );
    vi.stubGlobal("fetch", refuseFetch);
    const res = await runReplay({ runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode).toBe(1);
    expect(res.lines.some((l) => l.includes("CASSETTE MISS: llm.reflector"))).toBe(true);
  }, 60_000);

  it("a tampered bundle (metric edited, hash not recomputed) is a visible failure", async () => {
    const d = dirsFor();
    const original = await liveRun("naive", d);
    const file = join(d.runs, original.runId, `${original.runId}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as RunBundle;
    raw.metrics.decision_accuracy = 1;
    raw.metrics.unsafe_actions_total = 0;
    raw.disclosure.push("edited");
    writeRaw(file, raw);
    const res = await runReplay({ runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode).toBe(1);
    expect(res.lines.some((l) => l.startsWith("TAMPERED OR INVALID BUNDLE") && l.includes("content hash mismatch"))).toBe(true);
  }, 60_000);

  it("a tampered cassette fails: edited without re-hashing, or re-hashed but no longer the pinned recording", async () => {
    const d = dirsFor();
    const original = await liveRun("naive", d);
    const file = join(d.cassettes, `${original.runId}.json`);
    const cassette = JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof loadCassette>;
    const edited = cassette.exchanges.map((e, i) => (i === 0 ? { ...e, status: 500 } : e));
    writeRaw(file, { ...cassette, exchanges: edited });
    let res = await runReplay({ runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode).toBe(1);
    expect(res.lines.find((l) => l.includes("FAIL:"))).toMatch(/TAMPERED OR MISSING: cassette .*content hash mismatch/);

    writeRaw(file, { ...cassette, exchanges: edited, contentHash: computeContentHash(edited) });
    res = await runReplay({ runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode).toBe(1);
    expect(res.lines.find((l) => l.includes("FAIL:"))).toMatch(/does not match the bundle's pin/);
  }, 60_000);

  it("a changed queue file is refused (the replay record pins its sha256)", async () => {
    const d = dirsFor();
    await liveRun("naive", d);
    const q = join(d.fixtures, "queue.json");
    writeFileSync(q, readFileSync(q, "utf8").replace("test refund", "edited refund"), "utf8");
    const res = await runReplay({ runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode).toBe(1);
    expect(res.lines.some((l) => /queue file .* changed since the run/.test(l))).toBe(true);
  }, 60_000);
});

describe("noise floor command", () => {
  it("live without keys -> BLOCKED exit 3, nothing written", async () => {
    const d = dirsFor();
    const f = queueFixtures(d.fixtures);
    const r = await runNoiseFloor({ queueFile: f.queue, runs: 3, env: {}, runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes });
    expect(r.exitCode).toBe(3);
    expect(r.lines.some((l) => l.startsWith("BLOCKED:"))).toBe(true);
  });

  it("--replay without a recorded guarded run -> BLOCKED exit 3", async () => {
    const d = dirsFor();
    const f = queueFixtures(d.fixtures);
    const r = await runNoiseFloor({ queueFile: f.queue, replay: true, runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes });
    expect(r.exitCode).toBe(3);
  });

  it("--replay over a recorded guarded run: floor 0 everywhere, written to the bundle and runs/noise-floor.json", async () => {
    const d = dirsFor();
    const original = await liveRun("guarded", d);
    vi.stubGlobal("fetch", refuseFetch);
    const r = await runNoiseFloor({ queueFile: join(d.fixtures, "queue.json"), replay: true, runs: 3, runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(r.exitCode, r.lines.join("\n")).toBe(0);
    expect(Object.values(r.floor!).every((v) => v === 0)).toBe(true);
    expect(r.floor!.decision_accuracy).toBe(0);
    const summary = JSON.parse(readFileSync(r.summaryPath!, "utf8")) as { runs: string[]; floor: Record<string, number> };
    expect(summary.runs).toHaveLength(3);
    const replayBundle = readBundle(join(d.runs, r.runIds![0]!, `${r.runIds![0]}.json`));
    expect(replayBundle.noiseFloor).toEqual(r.floor);
    expect(replayBundle.replayOf).toBe(original.runId);
  }, 60_000);
});

describe("model-call normalization", () => {
  it("only trace ids, span ids and timestamps are normalized; probe ids and values are not", () => {
    const text = `{"probeId":"notarize-dodo-20261010T120000Z-p001","traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","committedAt":"2026-10-10T12:00:00.123Z","amount":2900}`;
    expect(normalizeVolatile(text)).toBe(`{"probeId":"notarize-dodo-20261010T120000Z-p001","traceId":"<trace-id>","spanId":"<span-id>","committedAt":"<ts>","amount":2900}`);
  });
});

describe("notary replay --drift", () => {
  it("replays the fixture's source run, then un-learns: prints the belief trajectory and the retired guards", async () => {
    const d = dirsFor();
    const driftDir = tempDir("notary-replay-drift-");
    const original = await liveNotarize(d);
    const probes = loadCassette(`${original.runId}-probes`, { dir: d.cassettes });
    // TEST drift fixture: the first treatment write now echoes the price unchanged (the tool "fixed" its units).
    const target = probes.exchanges.find((e) => (e.requestBody as { name?: string }).name?.includes("-p1-t "))!;
    makeDriftFixture({ from: `${original.runId}-probes`, exchange: `${target.requestHash}:${target.occurrence}`, path: "$.price.price", value: 1234, out: "test-drift", cassetteDir: d.cassettes, driftDir });

    vi.stubGlobal("fetch", refuseFetch);
    const res = await runReplay({ drift: "test-drift", driftDir, runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes, unguardedCallSites: async () => 0 });
    expect(res.exitCode, res.lines.join("\n")).toBe(0);
    expect(res.lines).toContain(`drift: source run ${original.runId} (replayed first to rebuild its store)`);
    expect(res.lines).toContain("trajectory belief-dodo.product.price-minor-units (violated):");
    expect(res.lines.some((l) => /^  pass \d+ confirmed .* status=unlearned$/.test(l))).toBe(true);
    expect(res.lines.find((l) => l.startsWith("retired guards:"))).toMatch(/^retired guards: .+ on dodo\./);
    expect(res.lines).toContain("stop: unlearned after 4 pass(es)");
  }, 60_000);

  it("a fixture whose source cassette no recorded bundle pins is refused", async () => {
    const d = dirsFor();
    const driftDir = tempDir("notary-replay-drift-");
    const original = await liveNotarize(d);
    const probes = loadCassette(`${original.runId}-probes`, { dir: d.cassettes });
    const target = probes.exchanges.find((e) => (e.requestBody as { name?: string }).name?.includes("-p1-t "))!;
    makeDriftFixture({ from: `${original.runId}-probes`, exchange: target.requestHash, path: "$.price.price", value: 1234, out: "test-drift", cassetteDir: d.cassettes, driftDir });
    rmSync(join(d.runs, original.runId), { recursive: true, force: true });
    const res = await runReplay({ drift: "test-drift", driftDir, runsDir: d.runs, webBundlesDir: null, cassetteDir: d.cassettes });
    expect(res.exitCode).toBe(1);
    expect(res.lines.at(-1)).toMatch(/no recorded notarize bundle pins the drift fixture's source cassette/);
  }, 60_000);
});
