/**
 * P7 drift (FR-16). Everything here runs on a TEMPORARY TEST cassette written by this file from a
 * fake Dodo product API (test doubles, not recorded traffic). No real cassette exists, and none is
 * created: the drift fixture lives in a temp dir and is deleted after each test.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replayDrift } from "../src/beliefs/drift.js";
import { BeliefStore, beliefIdFor } from "../src/beliefs/store.js";
import { claimById, contractEntryById } from "../src/contracts/index.js";
import { GuardRegistry, compileGuards, wireRetirement } from "../src/guards/index.js";
import type { CompleteRequest, CompleteResult, LlmLike } from "../src/llm/client.js";
import { runProbeLoop } from "../src/reflect/loop.js";
import type { ProbeIo } from "../src/reflect/templates/index.js";
import type { Anomaly, Claim } from "../src/schema/index.js";
import { NotaryDb } from "../src/store/db.js";
import {
  DRIFT_NOTE,
  DriftFixtureError,
  loadDriftFixture,
  makeDriftFixture,
  parseAssignment,
  parseFieldPath,
} from "../src/tools/drift-fixture.js";
import type { DriftFixture } from "../src/tools/drift-fixture.js";
import { CassetteMissError, CreditLedger } from "../src/tools/index.js";
import { canonicalJson, computeContentHash, loadCassette, saveCassette, sha256 } from "../src/tools/recorder.js";
import type { Cassette, Exchange } from "../src/tools/recorder.js";

const T0 = "2026-10-10T12:00:00.000Z";
const CLAIM_ID = "dodo.product.price-minor-units";

function claimOf(id: string): Claim {
  const e = contractEntryById(id);
  if (!e) throw new Error(`no claim ${id}`);
  return e.claim;
}

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
const dbs: NotaryDb[] = [];
function freshDb(): NotaryDb {
  const db = new NotaryDb(":memory:");
  dbs.push(db);
  return db;
}
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const requestHash = (op: string, args: unknown[]): string => sha256(canonicalJson({ op, args }));

/** TEST double: a fake Dodo createProduct that echoes price.price x100, recording each exchange. */
class RecordingIo implements ProbeIo {
  readonly exchanges: Exchange[] = [];
  private readonly occ = new Map<string, number>();
  async call(op: string, args: unknown[]): Promise<Exchange[]> {
    const hash = requestHash(op, args);
    const occurrence = this.occ.get(hash) ?? 0;
    this.occ.set(hash, occurrence + 1);
    const body = args[0] as { price: { price: number } };
    const ex: Exchange = {
      id: `${op}#${hash.slice(0, 12)}#${occurrence}`,
      tool: "dodo",
      op,
      method: "POST",
      url: "https://test.invalid/products",
      requestHeaders: {},
      requestBody: body,
      status: 200,
      responseHeaders: {},
      responseBody: { product_id: `prod_test_${this.exchanges.length}`, price: { ...body.price, price: body.price.price * 100 } },
      latencyMs: 1,
      credits: null,
      recordedAt: T0,
      requestHash: hash,
      occurrence,
    };
    this.exchanges.push(ex);
    return [ex];
  }
  async sleep(): Promise<void> {}
}

/** TEST double: serves a cassette by request hash + occurrence; a miss throws like the recorder. */
class CassetteIo implements ProbeIo {
  private readonly occ = new Map<string, number>();
  constructor(private readonly cassette: Cassette) {}
  async call(op: string, args: unknown[]): Promise<Exchange[]> {
    const hash = requestHash(op, args);
    const occurrence = this.occ.get(hash) ?? 0;
    this.occ.set(hash, occurrence + 1);
    const hit = this.cassette.exchanges.find((e) => e.requestHash === hash && e.occurrence === occurrence);
    if (!hit) throw new CassetteMissError(op, "POST", "https://test.invalid/products", hash, occurrence);
    return [hit];
  }
  async sleep(): Promise<void> {}
}

/** TEST double reflector: rivals honored vs unit_mismatch. */
class FakeLlm implements LlmLike {
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const text = req.messages.map((m) => m.content).join("\n");
    const ids = [...new Set([...text.matchAll(/"anomalyId":\s*"([^"]+)"/g)].map((m) => m[1]!))];
    const reply = {
      anomalies: ids.map((anomalyId) => ({
        anomalyId,
        hypotheses: (["honored", "unit_mismatch"] as const).map((cls) => ({ class: cls, statement: `${cls} explains ${anomalyId}`, distinguishingTest: "unit_roundtrip" })),
      })),
    };
    return { text: JSON.stringify(reply), inputTokens: 10, outputTokens: 5, usd: 0, modelId: "fake", stopReason: "end_turn" };
  }
}

/**
 * Learn on the fake tool: 3 unit_roundtrip probes -> candidate (unit_mismatch) -> adversary uphold
 * (test verdict) -> notarized -> guards compiled. Then save the recorded exchanges as a TEST cassette.
 */
async function learn(): Promise<{ db: NotaryDb; cassetteDir: string; driftDir: string; cassette: Cassette; runId: string }> {
  const db = freshDb();
  const claim = claimOf(CLAIM_ID);
  const store = new BeliefStore(db);
  const registry = new GuardRegistry(db);
  const unwire = wireRetirement(store, registry);
  const io = new RecordingIo();
  const anomaly: Anomaly = { id: "anom-test", claimId: claim.id, tool: "dodo", observed: {}, expected: {}, traceId: "", spanId: "" };
  const runId = "learn-test";
  const loop = await runProbeLoop({ tool: "dodo", anomalies: [anomaly], claims: [claim], tools: io, llm: new FakeLlm(), db, runId, ledger: new CreditLedger({ budget: 10 }), beliefs: store });
  expect(loop.probes.map((p) => p.verdict)).toEqual(["confirmed", "confirmed", "confirmed"]);
  store.applyAdversary(beliefIdFor(claim.id), { verdict: "uphold", reason: "test-only uphold", model: "test-adversary" });
  registry.sync(compileGuards({ beliefs: store.list(), claimFor: (id) => claimById(id), probes: db.loadProbes(runId) }));
  unwire();
  const cassetteDir = tempDir("notary-test-cassettes-");
  const driftDir = tempDir("notary-test-drift-");
  const cassette: Cassette = { name: "test-probes-dodo", tool: "dodo", createdAt: T0, exchanges: io.exchanges, contentHash: computeContentHash(io.exchanges) };
  saveCassette(cassette, cassetteDir);
  return { db, cassetteDir, driftDir, cassette, runId };
}

/** Leaf paths whose values differ between two JSON values. */
function diffLeaves(a: unknown, b: unknown, path = "$"): string[] {
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) => diffLeaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
  }
  return canonicalJson(a) === canonicalJson(b) ? [] : [path];
}

/** The first probe's treatment write (sent 1234; the fake echoed 123400). */
function firstTreatmentWrite(c: Cassette): Exchange {
  return c.exchanges.find((e) => (e.requestBody as { price: { price: number } }).price.price === 1234)!;
}

describe("make-drift", () => {
  it("copies a cassette changing exactly one response field, recomputes the hash and discloses the drift", async () => {
    const { cassetteDir, driftDir, cassette } = await learn();
    const target = firstTreatmentWrite(cassette);
    const { fixture, path } = makeDriftFixture({
      from: "test-probes-dodo",
      exchange: `${target.requestHash.slice(0, 10)}:0`, // a unique prefix works
      path: "$.price.price",
      value: 1234,
      out: "test-drift",
      cassetteDir,
      driftDir,
    });
    expect(path).toBe(join(driftDir, "test-drift.json"));
    expect(diffLeaves(cassette.exchanges, fixture.exchanges)).toEqual([`$.${cassette.exchanges.indexOf(target)}.responseBody.price.price`]);
    expect(fixture.contentHash).toBe(computeContentHash(fixture.exchanges));
    expect(fixture.contentHash).not.toBe(cassette.contentHash);
    expect(fixture.drift).toEqual({
      source: "test-probes-dodo",
      sourceContentHash: cassette.contentHash,
      exchange: `${target.requestHash}:0`,
      path: "$.price.price",
      before: 123400,
      after: 1234,
      note: DRIFT_NOTE,
    });
    // The file is a loadable cassette (hash verified) and a valid drift fixture; the source is untouched.
    expect(loadCassette(path).contentHash).toBe(fixture.contentHash);
    expect(loadDriftFixture(path).drift.after).toBe(1234);
    expect(loadCassette("test-probes-dodo", { dir: cassetteDir }).contentHash).toBe(cassette.contentHash);
    expect(JSON.parse(readFileSync(path, "utf8")).drift.note).toBe("DRIFT FIXTURE — one response deliberately altered to simulate a tool behavior change");
  });

  it("$status changes the HTTP status only", async () => {
    const { cassetteDir, driftDir, cassette } = await learn();
    const target = firstTreatmentWrite(cassette);
    const { fixture } = makeDriftFixture({ from: "test-probes-dodo", exchange: target.requestHash, path: "$status", value: 500, out: "test-status", cassetteDir, driftDir });
    expect(diffLeaves(cassette.exchanges, fixture.exchanges)).toEqual([`$.${cassette.exchanges.indexOf(target)}.status`]);
    expect(fixture.drift).toMatchObject({ before: 200, after: 500 });
  });

  it("refuses: missing source cassette (BLOCKED), missing field, no-op value, existing output, a drift fixture as source", async () => {
    const { cassetteDir, driftDir, cassette } = await learn();
    const hash = firstTreatmentWrite(cassette).requestHash;
    const base = { from: "test-probes-dodo", exchange: hash, path: "$.price.price", value: 1234, out: "test-drift", cassetteDir, driftDir };

    let err: unknown;
    try {
      makeDriftFixture({ ...base, from: "probes-dodo" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DriftFixtureError);
    expect((err as DriftFixtureError).blocked).toBe(true);
    expect((err as Error).message).toMatch(/^BLOCKED: source cassette probes-dodo not found .* \(none was created\)$/);

    expect(() => makeDriftFixture({ ...base, path: "$.price.no_such_field" })).toThrow(/does not exist in the recorded response/);
    expect(() => makeDriftFixture({ ...base, value: 123400 })).toThrow(/already equals 123400/);
    expect(() => makeDriftFixture({ ...base, exchange: "deadbeefdeadbeef" })).toThrow(/no exchange with request hash/);
    expect(() => makeDriftFixture({ ...base, exchange: `${hash}:7` })).toThrow(/has no occurrence 7/);
    const made = makeDriftFixture(base);
    expect(() => makeDriftFixture(base)).toThrow(/already exists/);
    expect(() => makeDriftFixture({ ...base, from: made.path, out: "test-drift-2" })).toThrow(/is itself a drift fixture/);
    expect(() => loadDriftFixture(join(cassetteDir, "test-probes-dodo.json"))).toThrow(/is not a drift fixture/);
  });

  it("parses field paths and --set assignments", () => {
    expect(parseFieldPath("$.items[0].amount")).toEqual({ status: false, segments: ["items", 0, "amount"] });
    expect(parseFieldPath("price.price")).toEqual({ status: false, segments: ["price", "price"] });
    expect(parseFieldPath("$status")).toEqual({ status: true });
    expect(() => parseFieldPath("$")).toThrow(/whole response body/);
    expect(parseAssignment('$.a=1234')).toEqual({ path: "$.a", value: 1234 });
    expect(parseAssignment('$.a="x=y"')).toEqual({ path: "$.a", value: "x=y" });
    expect(() => parseAssignment("$.a=not json")).toThrow(/must be JSON/);
    expect(() => parseAssignment("1234")).toThrow(/needs <jsonPath>=<json value>/);
  });
});

describe("replayDrift (FR-16 un-learning, on a temp TEST cassette)", () => {
  it("lowers confidence step by step until the belief is unlearned and its guard is retired", async () => {
    const { db, cassetteDir, driftDir, cassette, runId } = await learn();
    const beliefId = beliefIdFor(CLAIM_ID);
    const before = new BeliefStore(db).get(beliefId)!;
    expect(before).toMatchObject({ status: "notarized", alpha: 1, beta: 4, class: "unit_mismatch" });
    const guards = new GuardRegistry(db).all().filter((g) => g.beliefId === beliefId);
    expect(guards.length).toBeGreaterThan(0);
    expect(guards.every((g) => g.active)).toBe(true);

    // The tool "now" echoes the first probe's price unchanged: one response field altered.
    const target = firstTreatmentWrite(cassette);
    makeDriftFixture({ from: "test-probes-dodo", exchange: `${target.requestHash}:0`, path: "$.price.price", value: 1234, out: "test-drift", cassetteDir, driftDir });
    const firstProbe = db.loadProbes(runId)[0]!;

    const res = await replayDrift({
      fixture: join(driftDir, "test-drift.json"),
      db,
      runId,
      io: (f: DriftFixture) => new CassetteIo(f),
    });

    // Only the probe that was served the altered exchange is re-observed.
    expect(res.affectedProbeIds).toEqual([firstProbe.id]);
    expect(res.trajectories).toHaveLength(1);
    const t = res.trajectories[0]!;
    expect(t.side).toBe("violated");
    const conf = [t.start, ...t.steps].map((s) => s.sideConfidence);
    // Beta(1,4) -> (2,4) -> (3,4) -> (4,4) -> (5,4): confidence in "violated" falls every step.
    expect(conf.map((c) => Number(c.toFixed(8)))).toEqual([0.9375, 0.8125, 0.65625, 0.5, 0.36328125]);
    for (let i = 1; i < conf.length; i++) expect(conf[i]!).toBeLessThan(conf[i - 1]!);
    expect(t.steps.map((s) => s.verdict)).toEqual(["confirmed", "confirmed", "confirmed", "confirmed"]);
    expect(t.steps.map((s) => s.status)).toEqual(["notarized", "notarized", "notarized", "unlearned"]);
    expect(t.final).toMatchObject({ status: "unlearned", alpha: 5, beta: 4 });
    expect(res.passes).toBe(4);
    expect(res.stopReason).toBe("unlearned after 4 pass(es)");

    // The un-learning came from BeliefStore's crossing-0.5 rule, and the guard retired with it.
    const unlearnEvent = res.events.find((e) => e.to === "unlearned")!;
    expect(unlearnEvent.reason).toMatch(/crossed back over 0.5 against the notarized side \(violated\): unlearned/);
    expect(res.retiredGuards.map((g) => g.id).sort()).toEqual(guards.map((g) => g.id).sort());
    const after = new GuardRegistry(db);
    for (const g of guards) expect(after.get(g.id)).toMatchObject({ active: false, retiredAt: unlearnEvent.at });

    // Replayed probes are recorded under new ids with the original pre-registered prediction.
    expect(res.probes.map((p) => p.id)).toEqual([1, 2, 3, 4].map((k) => `${firstProbe.id}~drift-test-drift-${k}`));
    expect(res.probes.every((p) => p.predictionHash === firstProbe.predictionHash)).toBe(true);
    expect(db.loadProbes("drift-test-drift").map((p) => p.id)).toEqual(res.probes.map((p) => p.id));
  });

  it("touches nothing when no recorded probe of the chosen claim consumed the altered exchange", async () => {
    const { db, cassetteDir, driftDir, cassette, runId } = await learn();
    const target = firstTreatmentWrite(cassette);
    const { fixture } = makeDriftFixture({ from: "test-probes-dodo", exchange: target.requestHash, path: "$.price.price", value: 1234, out: "test-drift", cassetteDir, driftDir });
    const res = await replayDrift({ fixture, db, runId, claimId: "dodo.refunds.amount-integer", io: (f) => new CassetteIo(f) });
    expect(res).toMatchObject({ affectedProbeIds: [], trajectories: [], retiredGuards: [], passes: 0, stopReason: "no recorded probe was served the altered exchange" });
    expect(new BeliefStore(db).byClaim(CLAIM_ID)!.status).toBe("notarized");
  });
});
