/**
 * Drift (FR-16, audit A-16). Everything here runs on a TEMPORARY TEST cassette written by this file
 * from a fake Dodo product API (test doubles, not recorded traffic). No real cassette exists, and
 * none is created: the drift fixture lives in a temp dir and is deleted after each test.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { designsToCross, replayDrift } from "../src/beliefs/drift.js";
import { designFingerprint } from "../src/beliefs/params.js";
import { BeliefStore, beliefIdFor } from "../src/beliefs/store.js";
import { claimById, contractEntryById } from "../src/contracts/index.js";
import { GuardRegistry, compileGuards, wireRetirement } from "../src/guards/index.js";
import type { CompleteRequest, CompleteResult, LlmLike } from "../src/llm/client.js";
import { runProbeLoop } from "../src/reflect/loop.js";
import { runProbe } from "../src/reflect/runner.js";
import { BurstCounter, SimplePaymentPool, buildCostModel, unitRoundtrip } from "../src/reflect/templates/index.js";
import type { PredictedObservation, ProbeDesign, ProbeIo, VariantParams } from "../src/reflect/templates/index.js";
import type { Anomaly, Claim, Hypothesis, Probe } from "../src/schema/index.js";
import { NotaryDb } from "../src/store/db.js";
import {
  DRIFT_NOTE,
  DRIFT_NOTE_BEHAVIOR,
  DriftFixtureError,
  loadDriftFixture,
  makeDriftFixture,
  parseAssignment,
  parseFieldPath,
  parseMatchArg,
  parseSetArg,
  parseTransform,
} from "../src/tools/drift-fixture.js";
import type { DriftFixture } from "../src/tools/drift-fixture.js";
import { CassetteMissError, CreditLedger } from "../src/tools/index.js";
import { canonicalJson, computeContentHash, loadCassette, saveCassette, sha256 } from "../src/tools/recorder.js";
import type { Cassette, Exchange } from "../src/tools/recorder.js";
import { passEvidence } from "./fakes.js";

const T0 = "2026-10-10T12:00:00.000Z";
const CLAIM_ID = "dodo.product.price-minor-units";
const OP = "dodo.createProduct";

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

/**
 * TEST double: a fake Dodo API recording each exchange. createProduct echoes price.price x100 (or
 * unchanged when `fixed`); any other op returns a small list body.
 */
class RecordingIo implements ProbeIo {
  readonly exchanges: Exchange[] = [];
  private readonly occ = new Map<string, number>();
  constructor(private readonly fixed = false) {}
  async call(op: string, args: unknown[]): Promise<Exchange[]> {
    const hash = requestHash(op, args);
    const occurrence = this.occ.get(hash) ?? 0;
    this.occ.set(hash, occurrence + 1);
    const body = args[0] as { price?: { price: number } };
    const responseBody =
      op === OP && body.price
        ? { product_id: `prod_test_${this.exchanges.length}`, price: { ...body.price, price: this.fixed ? body.price.price : body.price.price * 100 } }
        : { items: [{ product_id: "prod_test_listed", price: 1234 }] };
    const ex: Exchange = {
      id: `${op}#${hash.slice(0, 12)}#${occurrence}`,
      tool: "dodo",
      op,
      method: op === OP ? "POST" : "GET",
      url: "https://test.invalid/products",
      requestHeaders: {},
      requestBody: body,
      status: 200,
      responseHeaders: {},
      responseBody,
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

function designOf(p: Probe): ProbeDesign {
  return {
    template: p.template,
    params: p.params as VariantParams,
    control: { params: (p.control?.params ?? { steps: [] }) as VariantParams },
    predictions: p.prediction as Record<string, PredictedObservation>,
    estCredits: 0,
    estCalls: p.calls,
  };
}

/** Re-run a recorded probe's exact design under a new id on `io` and apply its verdict (TEST helper). */
async function rerun(db: NotaryDb, store: BeliefStore, io: ProbeIo, runId: string, id: string, source: Probe, hyps: Map<string, Hypothesis>): Promise<void> {
  const res = await runProbe({
    io,
    db,
    runId,
    probeId: id,
    claim: claimOf(CLAIM_ID),
    template: unitRoundtrip,
    design: designOf(source),
    ctx: { runId, tag: id, costs: buildCostModel(), burst: new BurstCounter(), payments: new SimplePaymentPool() },
    ledger: new CreditLedger({ budget: Number.MAX_SAFE_INTEGER }),
  });
  expect(res.verdict.verdict).toBe("confirmed");
  store.applyProbe(beliefIdFor(CLAIM_ID), res.probe, res.verdict, hyps);
}

interface Learned {
  db: NotaryDb;
  cassetteDir: string;
  driftDir: string;
  cassette: Cassette;
  runId: string;
}

/**
 * Learn on the fake tool: 3 unit_roundtrip probes (3 distinct designs, variants 0/1/2) -> candidate
 * (unit_mismatch) -> adversary uphold (test verdict) -> notarized at Beta(1,4) -> guards compiled.
 *   replicates: each of the 3 designs is run once more in the same recorded session (identical
 *     requests, occurrence 1), applied to the belief as usual -> Beta(1,7), still notarized.
 *   honoredAfter: k later probes on a FIXED copy of the tool (another run, another cassette, not the
 *     drift source) confirm honored -> α + k, still notarized while P(holds) < 0.5.
 * The learn session's exchanges (+ one unrelated listProducts call) are saved as a TEST cassette.
 */
async function learn(opts: { replicates?: boolean; honoredAfter?: number } = {}): Promise<Learned> {
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
  passEvidence(store, beliefIdFor(claim.id));
  store.applyAdversary(beliefIdFor(claim.id), { verdict: "uphold", reason: "test-only uphold", model: "test-adversary" });
  registry.sync(compileGuards({ beliefs: store.list(), claimFor: (id) => claimById(id), probes: db.loadProbes(runId) }));
  const learned = db.loadProbes(runId);
  const hyps = new Map(db.loadHypotheses(runId).map((h) => [h.id, h]));
  if (opts.replicates) for (const p of learned) await rerun(db, store, io, runId, `${p.id}-rep`, p, hyps);
  const fixedIo = new RecordingIo(true);
  for (let i = 0; i < (opts.honoredAfter ?? 0); i++) await rerun(db, store, fixedIo, "later-test", `later-honored-${i}`, learned[i % learned.length]!, hyps);
  await io.call("dodo.listProducts", [{ page_size: 10 }]);
  unwire();
  expect(store.byClaim(CLAIM_ID)!.status).toBe("notarized");
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

const sentPrice = (e: Exchange): number | undefined => (e.requestBody as { price?: { price: number } }).price?.price;
const keyOf = (e: Exchange): string => `${e.requestHash}:${e.occurrence}`;

/** The first probe's treatment write (sent 1234; the fake echoed 123400). */
function firstTreatmentWrite(c: Cassette): Exchange {
  return c.exchanges.find((e) => sentPrice(e) === 1234)!;
}

/** The tool "now" echoes every price unchanged: every createProduct echo is divided by 100. */
function behaviorFixture(l: Learned, out = "test-drift"): DriftFixture {
  return makeDriftFixture({ from: "test-probes-dodo", op: OP, path: "$.price.price", transform: parseTransform("div100"), out, cassetteDir: l.cassetteDir, driftDir: l.driftDir }).fixture;
}

describe("make-drift: behavior rewrite (A-16)", () => {
  it("rewrites EVERY exchange of the op the same way, and only those; recomputes the hash; discloses each change", async () => {
    const l = await learn();
    const { cassette } = l;
    const fixture = behaviorFixture(l);
    const ops = cassette.exchanges.filter((e) => e.op === OP);
    expect(ops).toHaveLength(6); // 3 designs x (treatment + control)
    expect(cassette.exchanges.some((e) => e.op !== OP)).toBe(true);
    // Every createProduct echo changed at exactly the rewritten field; nothing else changed.
    expect(diffLeaves(cassette.exchanges, fixture.exchanges).sort()).toEqual(ops.map((e) => `$.${cassette.exchanges.indexOf(e)}.responseBody.price.price`).sort());
    // Consistent: every rewritten echo now equals what was sent (div100 of the x100 echo).
    for (const e of fixture.exchanges.filter((x) => x.op === OP)) expect((e.responseBody as { price: { price: number } }).price.price).toBe(sentPrice(e));
    expect(fixture.contentHash).toBe(computeContentHash(fixture.exchanges));
    expect(fixture.contentHash).not.toBe(cassette.contentHash);
    expect(fixture.drift).toMatchObject({ source: "test-probes-dodo", sourceContentHash: cassette.contentHash, op: OP, path: "$.price.price", transform: "div100", skipped: [], note: DRIFT_NOTE_BEHAVIOR });
    expect(fixture.drift.match).toBeUndefined();
    expect(fixture.drift.changed).toEqual(ops.map((e) => ({ exchange: keyOf(e), op: OP, before: sentPrice(e)! * 100, after: sentPrice(e) })));
    const path = join(l.driftDir, "test-drift.json");
    expect(loadCassette(path).contentHash).toBe(fixture.contentHash);
    expect(loadDriftFixture(path).drift.changed).toHaveLength(6);
    expect(loadCassette("test-probes-dodo", { dir: l.cassetteDir }).contentHash).toBe(cassette.contentHash);
  });

  it("--match narrows the rewrite to matching calls, and changes every recorded occurrence of them", async () => {
    const l = await learn({ replicates: true });
    const hits = l.cassette.exchanges.filter((e) => e.op === OP && sentPrice(e) === 1234);
    expect(hits.map((e) => e.occurrence)).toEqual([0, 1]); // the variant-0 treatment and its replicate
    const { fixture } = makeDriftFixture({
      from: "test-probes-dodo",
      op: OP,
      match: parseMatchArg("$request.price.price=1234"),
      ...parseSetArg("$.price.price=x100"),
      out: "test-match",
      cassetteDir: l.cassetteDir,
      driftDir: l.driftDir,
    });
    expect(fixture.drift.match).toEqual({ path: "$request.price.price", value: 1234 });
    expect(fixture.drift.transform).toBe("x100");
    expect(fixture.drift.changed).toEqual(hits.map((e) => ({ exchange: keyOf(e), op: OP, before: 123400, after: 12340000 })));
    expect(diffLeaves(l.cassette.exchanges, fixture.exchanges).sort()).toEqual(hits.map((e) => `$.${l.cassette.exchanges.indexOf(e)}.responseBody.price.price`).sort());
    // Matching on the response works too.
    const { fixture: byResponse } = makeDriftFixture({ from: "test-probes-dodo", op: OP, match: { path: "$response.price.price", value: 351700 }, path: "$.price.price", value: 3517, out: "test-match-res", cassetteDir: l.cassetteDir, driftDir: l.driftDir });
    expect(byResponse.drift.changed.map((c) => c.before)).toEqual([351700, 351700]);
  });

  it("refuses a rewrite that changes zero exchanges, and lists exchanges it left alone", async () => {
    const l = await learn();
    const base = { from: "test-probes-dodo", path: "$.price.price", cassetteDir: l.cassetteDir, driftDir: l.driftDir, out: "test-zero" };
    expect(() => makeDriftFixture({ ...base, op: "dodo.createRefund", value: 1 })).toThrow(/changes zero exchanges: 0 exchange\(s\) of test-probes-dodo match op dodo\.createRefund — no fixture was written/);
    expect(() => makeDriftFixture({ ...base, op: OP, match: { path: "$.price.price", value: 999 }, value: 1 })).toThrow(/changes zero exchanges: 0 exchange\(s\)/);
    // discount_bps is 0 everywhere: x100 leaves every one unchanged.
    expect(() => makeDriftFixture({ ...base, op: OP, path: "$.price.discount_bps", transform: parseTransform("x100") })).toThrow(
      /changes zero exchanges: 6 exchange\(s\) .* every one was left unchanged \(field \$\.price\.discount_bps already equals 0; \+5 more\)/,
    );
    expect(() => makeDriftFixture({ ...base, op: OP, path: "$.no_such", value: 1 })).toThrow(/every one was left unchanged \(field \$\.no_such does not exist/);
    expect(() => loadDriftFixture(join(l.driftDir, "test-zero.json"))).toThrow(/not found/);
    // Exchanges the rewrite leaves unchanged are disclosed under `skipped` (the 3 controls already echo 246800).
    const { fixture } = makeDriftFixture({ ...base, op: OP, value: 246800, out: "test-partial" });
    const controls = l.cassette.exchanges.filter((e) => e.op === OP && sentPrice(e) === 2468);
    expect(fixture.drift.changed.map((c) => c.before).sort()).toEqual([123400, 351700, 432100]);
    expect(fixture.drift.skipped).toEqual(controls.map((e) => ({ exchange: keyOf(e), reason: "field $.price.price already equals 246800" })));
    // Other ops are selectable too.
    const { fixture: list } = makeDriftFixture({ ...base, op: "dodo.listProducts", path: "$.items[0].price", transform: parseTransform("x100"), out: "test-list" });
    expect(list.drift.changed.map((c) => [c.before, c.after])).toEqual([[1234, 123400]]);
  });

  it("refuses: missing source cassette (BLOCKED, nothing created), both or neither selector, --match without --op", async () => {
    const l = await learn();
    const base = { path: "$.price.price", value: 1234, out: "test-drift", cassetteDir: l.cassetteDir, driftDir: l.driftDir };
    let err: unknown;
    try {
      makeDriftFixture({ ...base, from: "probes-dodo", op: OP });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DriftFixtureError);
    expect((err as DriftFixtureError).blocked).toBe(true);
    expect((err as Error).message).toMatch(/^BLOCKED: source cassette probes-dodo not found .* \(none was created\)$/);
    const hash = firstTreatmentWrite(l.cassette).requestHash;
    expect(() => makeDriftFixture({ ...base, from: "test-probes-dodo", op: OP, exchange: hash })).toThrow(/exactly one of --op .* or --exchange/);
    expect(() => makeDriftFixture({ ...base, from: "test-probes-dodo" })).toThrow(/exactly one of --op/);
    expect(() => makeDriftFixture({ ...base, from: "test-probes-dodo", exchange: hash, match: { path: "$.a", value: 1 } })).toThrow(/--match only applies with --op/);
  });
});

describe("make-drift: one exchange (legacy)", () => {
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
    expect(fixture.drift).toEqual({
      source: "test-probes-dodo",
      sourceContentHash: cassette.contentHash,
      exchange: `${target.requestHash}:0`,
      path: "$.price.price",
      transform: "set 1234",
      before: 123400,
      after: 1234,
      changed: [{ exchange: `${target.requestHash}:0`, op: OP, before: 123400, after: 1234 }],
      skipped: [],
      note: DRIFT_NOTE,
    });
    expect(loadCassette(path).contentHash).toBe(fixture.contentHash);
    expect(loadDriftFixture(path).drift.after).toBe(1234);
    expect(JSON.parse(readFileSync(path, "utf8")).drift.note).toBe("DRIFT FIXTURE — one response deliberately altered to simulate a tool behavior change");
  });

  it("$status changes the HTTP status only", async () => {
    const { cassetteDir, driftDir, cassette } = await learn();
    const target = firstTreatmentWrite(cassette);
    const { fixture } = makeDriftFixture({ from: "test-probes-dodo", exchange: target.requestHash, path: "$status", value: 500, out: "test-status", cassetteDir, driftDir });
    expect(diffLeaves(cassette.exchanges, fixture.exchanges)).toEqual([`$.${cassette.exchanges.indexOf(target)}.status`]);
    expect(fixture.drift).toMatchObject({ before: 200, after: 500 });
  });

  it("refuses: missing field, no-op value, unknown exchange/occurrence, existing output, a drift fixture as source", async () => {
    const { cassetteDir, driftDir, cassette } = await learn();
    const hash = firstTreatmentWrite(cassette).requestHash;
    const base = { from: "test-probes-dodo", exchange: hash, path: "$.price.price", value: 1234, out: "test-drift", cassetteDir, driftDir };
    expect(() => makeDriftFixture({ ...base, path: "$.price.no_such_field" })).toThrow(/does not exist in the recorded response/);
    expect(() => makeDriftFixture({ ...base, value: 123400 })).toThrow(/already equals 123400/);
    expect(() => makeDriftFixture({ ...base, exchange: "deadbeefdeadbeef" })).toThrow(/no exchange with request hash/);
    expect(() => makeDriftFixture({ ...base, exchange: `${hash}:7` })).toThrow(/has no occurrence 7/);
    const made = makeDriftFixture(base);
    expect(() => makeDriftFixture(base)).toThrow(/already exists/);
    expect(() => makeDriftFixture({ ...base, from: made.path, out: "test-drift-2" })).toThrow(/is itself a drift fixture/);
    expect(() => loadDriftFixture(join(cassetteDir, "test-probes-dodo.json"))).toThrow(/is not a drift fixture/);
  });
});

describe("make-drift: argument parsing", () => {
  it("parses field paths, --set values/expressions and --match", () => {
    expect(parseFieldPath("$.items[0].amount")).toEqual({ status: false, segments: ["items", 0, "amount"] });
    expect(parseFieldPath("price.price")).toEqual({ status: false, segments: ["price", "price"] });
    expect(parseFieldPath("$status")).toEqual({ status: true });
    expect(() => parseFieldPath("$")).toThrow(/whole response body/);
    expect(parseAssignment('$.a=1234')).toEqual({ path: "$.a", value: 1234 });
    expect(parseAssignment('$.a="x=y"')).toEqual({ path: "$.a", value: "x=y" });
    expect(() => parseAssignment("$.a=not json")).toThrow(/must be JSON/);
    expect(() => parseAssignment("1234")).toThrow(/needs <jsonPath>=<json value>/);
    expect(parseTransform("x100")).toEqual({ kind: "scale", factor: 100 });
    expect(parseTransform("div100")).toEqual({ kind: "divide", divisor: 100 });
    expect(parseTransform('"x100"')).toEqual({ kind: "set", value: "x100" });
    expect(parseTransform('{"a":1}')).toEqual({ kind: "set", value: { a: 1 } });
    expect(() => parseTransform("div0")).toThrow(/divide by zero/);
    expect(() => parseTransform("times100")).toThrow(/JSON .* or an expression/);
    expect(parseSetArg("$.amount=x100")).toEqual({ path: "$.amount", transform: { kind: "scale", factor: 100 } });
    expect(parseMatchArg('$request.reason="x"')).toEqual({ path: "$request.reason", value: "x" });
    expect(() => parseMatchArg("$.a=nope")).toThrow(/--match value must be JSON/);
  });
});

describe("replayDrift: one observation per distinct design (A-16, on a temp TEST cassette)", () => {
  it("designsToCross: contrary designs needed to cross 0.5 under the existing rule", () => {
    expect(designsToCross(1, 4, "violated")).toBe(4); // Beta(4,4) is exactly 0.5: not crossed
    expect(designsToCross(5, 7, "violated")).toBe(3);
    expect(designsToCross(4, 1, "honored")).toBe(4);
  });

  it("a freshly notarized belief (3 designs, Beta(1,4)) is NOT un-learned by its own 3 designs: reported, guard kept", async () => {
    const l = await learn();
    behaviorFixture(l);
    const guards = new GuardRegistry(l.db).all().filter((g) => g.beliefId === beliefIdFor(CLAIM_ID));
    expect(guards.length).toBeGreaterThan(0);
    const res = await replayDrift({ fixture: join(l.driftDir, "test-drift.json"), db: l.db, runId: l.runId, io: (f) => new CassetteIo(f) });
    const t = res.trajectories[0]!;
    expect(t.steps.map((s) => [s.alpha, s.beta, s.status])).toEqual([[2, 4, "notarized"], [3, 4, "notarized"], [4, 4, "notarized"]]);
    expect(t).toMatchObject({ distinctDesigns: 3, designsAgainst: 3, designsNeeded: 4, unlearned: false });
    expect(res.unlearned).toBe(false);
    expect(res.stopReason).toBe("not un-learned: only 3 distinct designs observed the change");
    expect(res.lines).toContain(`${t.beliefId}: not un-learned: only 3 distinct designs observed the change (crossing 0.5 from Beta(1, 4) needs at least 4; replicates of a design count once)`);
    expect(res.retiredGuards).toEqual([]);
    for (const g of guards) expect(new GuardRegistry(l.db).get(g.id)).toMatchObject({ active: true });
  });

  it("replicates count once: 3 designs + 3 replicates move α by 3, not 6; too few designs -> not un-learned", async () => {
    const l = await learn({ replicates: true });
    expect(new BeliefStore(l.db).byClaim(CLAIM_ID)).toMatchObject({ status: "notarized", alpha: 1, beta: 7 });
    behaviorFixture(l);
    const recorded = l.db.loadProbes(l.runId);
    expect(recorded).toHaveLength(6);
    const res = await replayDrift({ fixture: join(l.driftDir, "test-drift.json"), db: l.db, runId: l.runId, io: (f) => new CassetteIo(f) });
    // All 6 recorded probes were served a rewritten exchange, but only 3 distinct designs exist.
    expect(res.affectedProbeIds).toEqual(recorded.map((p) => p.id).sort());
    const t = res.trajectories[0]!;
    expect(t.steps).toHaveLength(3);
    expect(t.steps.map((s) => s.sourceProbeId)).toEqual(recorded.slice(0, 3).map((p) => p.id));
    expect(t.steps.map((s) => s.replicateIds)).toEqual(recorded.slice(0, 3).map((p) => [`${p.id}-rep`]));
    expect(t.final).toMatchObject({ status: "notarized", alpha: 4, beta: 7 });
    expect(t).toMatchObject({ distinctDesigns: 3, designsAgainst: 3, designsNeeded: 7, unlearned: false });
    expect(res.probes.map((p) => p.id)).toEqual(recorded.slice(0, 3).map((p) => `${p.id}~drift-test-drift`));
    expect(res.stopReason).toBe("not un-learned: only 3 distinct designs observed the change");
    expect(res.retiredGuards).toEqual([]);
    expect(res.events.some((e) => e.to === "unlearned")).toBe(false);
  });

  it("un-learns on 3 distinct designs (not the 6 recorded probes); trajectory shows α/β per design; guard retired on un-learn", async () => {
    // Beta(1,7) after replicates, then 4 honored observations from a later run on the fixed tool: Beta(5,7), still notarized.
    const l = await learn({ replicates: true, honoredAfter: 4 });
    const beliefId = beliefIdFor(CLAIM_ID);
    expect(new BeliefStore(l.db).get(beliefId)).toMatchObject({ status: "notarized", alpha: 5, beta: 7, class: "unit_mismatch" });
    const guards = new GuardRegistry(l.db).all().filter((g) => g.beliefId === beliefId);
    expect(guards.length).toBeGreaterThan(0);
    expect(guards.every((g) => g.active)).toBe(true);
    behaviorFixture(l);
    const recorded = l.db.loadProbes(l.runId);

    const res = await replayDrift({ fixture: join(l.driftDir, "test-drift.json"), db: l.db, runId: l.runId, io: (f: DriftFixture) => new CassetteIo(f) });
    const t = res.trajectories[0]!;
    expect(t.side).toBe("violated");
    const claim = claimOf(CLAIM_ID);
    const designs = recorded.slice(0, 3).map((p) => designFingerprint(claim, p));
    expect(new Set(designs).size).toBe(3);
    // One step per distinct design: Beta(5,7) -> (6,7) -> (7,7) -> (8,7). Counting replicates would give α = 11.
    expect(t.steps.map((s) => [s.design, s.alpha, s.beta, s.status])).toEqual([
      [designs[0], 6, 7, "notarized"],
      [designs[1], 7, 7, "notarized"],
      [designs[2], 8, 7, "unlearned"],
    ]);
    expect([t.start, ...t.steps].map((s) => Number(s.sideConfidence.toFixed(8)))).toEqual([0.72558594, 0.61279297, 0.5, 0.39526367]);
    expect(t.steps.every((s) => s.verdict === "confirmed" && s.against && s.replicateIds.length === 1)).toBe(true);
    expect(t).toMatchObject({ distinctDesigns: 3, designsAgainst: 3, designsNeeded: 3, unlearned: true });
    expect(t.final).toMatchObject({ status: "unlearned", alpha: 8, beta: 7 });
    expect(res.unlearned).toBe(true);
    expect(res.stopReason).toBe("unlearned on 3 distinct designs");

    // The un-learning came from BeliefStore's crossing-0.5 rule, and the guard retired with it.
    const unlearnEvent = res.events.find((e) => e.to === "unlearned")!;
    expect(unlearnEvent.reason).toMatch(/crossed back over 0.5 against the notarized side \(violated\): unlearned/);
    expect(res.retiredGuards.map((g) => g.id).sort()).toEqual(guards.map((g) => g.id).sort());
    const after = new GuardRegistry(l.db);
    for (const g of guards) expect(after.get(g.id)).toMatchObject({ active: false, retiredAt: unlearnEvent.at });

    // Replayed probes are recorded under new ids with the original pre-registered prediction.
    expect(res.probes.map((p) => p.id)).toEqual(recorded.slice(0, 3).map((p) => `${p.id}~drift-test-drift`));
    for (const [i, p] of res.probes.entries()) expect(p.predictionHash).toBe(recorded[i]!.predictionHash);
    expect(l.db.loadProbes("drift-test-drift").map((p) => p.id)).toEqual(res.probes.map((p) => p.id));
  });

  it("touches nothing when no recorded probe of the chosen claim consumed a changed exchange", async () => {
    const l = await learn();
    const fixture = behaviorFixture(l);
    const res = await replayDrift({ fixture, db: l.db, runId: l.runId, claimId: "dodo.refunds.amount-integer", io: (f) => new CassetteIo(f) });
    expect(res).toMatchObject({ affectedProbeIds: [], trajectories: [], retiredGuards: [], unlearned: false, stopReason: "no recorded probe was served the altered exchange" });
    expect(new BeliefStore(l.db).byClaim(CLAIM_ID)!.status).toBe("notarized");
  });
});
