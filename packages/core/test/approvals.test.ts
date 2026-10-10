/**
 * Approval desk: GET/POST /api/approvals. TEST DOUBLES ONLY (test/fakes.ts): the "Dodo" is in
 * memory, the held decisions come from a real guarded runQueue over it, and nothing is a run result.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/api/bus.js";
import type { NotaryEvent } from "../src/api/bus.js";
import { DODO_KEY_BLOCKED, approvalIdFor, dodoTestMode } from "../src/api/approvals.js";
import type { ApprovalsOptions } from "../src/api/approvals.js";
import { createApp } from "../src/api/server.js";
import { createSession } from "../src/api/session.js";
import { BeliefStore } from "../src/beliefs/store.js";
import { GuardRegistry, compileGuards, guarded } from "../src/guards/index.js";
import { claimById } from "../src/contracts/index.js";
import { executeQueue } from "../src/queue/executor.js";
import { createGate } from "../src/queue/gate.js";
import type { SeedManifest } from "../src/queue/manifest.js";
import { runQueue } from "../src/queue/run.js";
import { ApprovalsFileSchema, ApprovalsListSchema, ApprovalRecordSchema } from "../src/schema/approval.js";
import type { ApprovalRecord, ApprovalsList } from "../src/schema/approval.js";
import type { QueueRequest } from "../src/schema/index.js";
import { TimelineEventSchema } from "../src/schema/timeline.js";
import { NotaryDb } from "../src/store/db.js";
import { FakeDodo, T0, fakeWorld, notarize, req, testManifest, testPolicy } from "./fakes.js";

const now = () => new Date(T0);
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const KEYED_TEST_ENV = { NOTARY_MODE: "test", DODO_PAYMENTS_API_KEY: "fake-dodo-key-for-approval-tests" };

const manifest: SeedManifest = {
  ...testManifest,
  payments: {
    p1: { paymentId: "pay_1", customerHandle: "a", amount: 2900, currency: "USD", status: "succeeded" },
    p3: { paymentId: "pay_3", customerHandle: "a", amount: 4900, currency: "USD", status: "succeeded" },
  },
};

const queue: QueueRequest[] = [
  req("r1", { paymentId: "pay:p1", currency: "USD" }),
  req("r2", { type: "partial_refund", paymentId: "pay:p3", amount: 1000, currency: "USD" }),
  req("c1", { type: "credit", paymentId: undefined, amount: 500, currency: "USD" }),
  req("s1", { type: "plan_change", paymentId: undefined, subscriptionId: "sub_1", targetPlan: "growth" }),
];

let root: string;
let runsDir: string;
let runId: string;
let runDir: string;
let w: FakeDodo;
let db: NotaryDb;
const session = createSession();
const bus = new EventBus();
const busEvents: NotaryEvent[] = [];

function app(env: NodeJS.ProcessEnv, extra: Partial<ApprovalsOptions> = {}) {
  return createApp({
    bundleDirs: [],
    runsDir,
    bus,
    session,
    approvals: { env, db, manifest, makeTools: (wrap) => w.tools(wrap), decidePolicy: testPolicy.decidePolicy, now, ...extra },
  });
}

const headers = () => ({ Host: "localhost:8787", Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" });

async function post(env: NodeJS.ProcessEnv, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app(env).request("/api/approvals", { method: "POST", headers: headers(), body: JSON.stringify(body) }, LOOPBACK);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function list(env: NodeJS.ProcessEnv = KEYED_TEST_ENV): Promise<ApprovalsList> {
  const res = await app(env).request("/api/approvals", { headers: headers() }, LOOPBACK);
  expect(res.status).toBe(200);
  return ApprovalsListSchema.parse(await res.json());
}

const decisionId = (requestId: string) => `${runId}:${requestId}`;
const approvalsPath = () => join(runDir, "approvals.json");
const timelinePath = () => join(runDir, "timeline.jsonl");
/** approval.decided events in the run's timeline (the run itself may have written other events). */
const approvalEvents = () =>
  existsSync(timelinePath())
    ? readFileSync(timelinePath(), "utf8").trim().split("\n").filter(Boolean).map((l) => TimelineEventSchema.parse(JSON.parse(l))).filter((e) => e.type === "approval.decided")
    : [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "notary-approvals-"));
  runsDir = join(root, "runs");
  const q = join(root, "queue.json");
  writeFileSync(q, JSON.stringify(queue));
  writeFileSync(
    join(root, "expected.json"),
    JSON.stringify(queue.map((r) => ({ requestId: r.id, expectedTier: "smb", expectedOutcome: "approve", expectedAction: "none" }))),
  );
  w = fakeWorld();
  db = new NotaryDb(":memory:");
  // No notarized beliefs: the gate holds every write. That is the run the approval desk works from.
  const res = await runQueue({ queueFile: q, variant: "guarded", mode: "live", manifest, makeTools: (wrap) => w.tools(wrap), policy: testPolicy, db, runsDir, webBundlesDir: null, now });
  expect(res.exitCode).toBe(0);
  runId = res.runId!;
  runDir = join(runsDir, runId);
  bus.subscribe((e) => busEvents.push(e));
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/approvals", () => {
  it("lists the held local decisions with the amount the action would move, and the test-mode lock state", async () => {
    const l = await list();
    expect(l.testMode).toBe(true);
    expect(l.decided).toEqual([]);
    expect(l.pending.map((p) => [p.decisionId, p.action, p.amount, p.currency])).toEqual([
      [decisionId("r1"), "dodo.createRefund", 2900, "USD"],
      [decisionId("r2"), "dodo.createRefund", 1000, "USD"],
      [decisionId("c1"), "dodo.createWalletLedgerEntry", 500, "USD"],
      [decisionId("s1"), "dodo.changeSubscriptionPlan", 9900, "USD"],
    ]);
    expect(l.pending[0]!.missingBeliefs.length).toBeGreaterThan(0);
    expect(l.pending[0]!.reason).toMatch(/notarized/);
    expect((await list({})).testMode).toBe(false);
  });

  it("never lists sample / fixture bundles (they are simulated)", async () => {
    const { buildSampleBundle, writeBundle } = await import("../src/bundle/index.js");
    await writeBundle(buildSampleBundle(42), join(runsDir, "sample-42"));
    const l = await list();
    expect(l.pending.every((p) => p.runId === runId)).toBe(true);
    rmSync(join(runsDir, "sample-42"), { recursive: true, force: true });
  });

  it("test-mode lock state follows NOTARY_MODE and DODO_BASE_URL", () => {
    expect(dodoTestMode({ NOTARY_MODE: "test" }).testMode).toBe(true);
    expect(dodoTestMode({ NOTARY_MODE: "test", DODO_BASE_URL: "https://live.dodopayments.com" }).testMode).toBe(false);
    expect(dodoTestMode({}).testMode).toBe(false);
  });
});

describe("POST /api/approvals", () => {
  it("rejects a confirmed amount that differs from the held amount (400), writing nothing", async () => {
    const r = await post(KEYED_TEST_ENV, { decision: "approved", runId, decisionId: decisionId("r1"), confirmedAmount: 29 });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/does not equal the held amount 2900/);
    expect(w.count("createRefund")).toBe(0);
    expect(existsSync(approvalsPath())).toBe(false);
  });

  it("refuses to approve outside Dodo test mode (403)", async () => {
    const r = await post({ DODO_PAYMENTS_API_KEY: "fake-dodo-key-for-approval-tests" }, { decision: "approved", runId, decisionId: decisionId("r1"), confirmedAmount: 2900 });
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/test mode/);
    expect(w.count("createRefund")).toBe(0);
    expect(existsSync(approvalsPath())).toBe(false);
  });

  it("is BLOCKED (503) without DODO_PAYMENTS_API_KEY and records nothing", async () => {
    const r = await post({ NOTARY_MODE: "test" }, { decision: "approved", runId, decisionId: decisionId("r1"), confirmedAmount: 2900 });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe(DODO_KEY_BLOCKED);
    expect(w.count("createRefund")).toBe(0);
    expect(existsSync(approvalsPath())).toBe(false);
    expect(approvalEvents()).toEqual([]);
  });

  it("404 for a decision that is not held in a local run", async () => {
    expect((await post(KEYED_TEST_ENV, { decision: "approved", runId, decisionId: `${runId}:nope`, confirmedAmount: 1 })).status).toBe(404);
    expect((await post(KEYED_TEST_ENV, { decision: "approved", runId: "sample-42", decisionId: "x", confirmedAmount: 1 })).status).toBe(404);
  });

  it("approve: executes the held action exactly once through the guarded clients, records it everywhere", async () => {
    const before = busEvents.length;
    const r = await post(KEYED_TEST_ENV, { decision: "approved", runId, decisionId: decisionId("r1"), confirmedAmount: 2900 });
    expect(r.status).toBe(200);
    const rec = ApprovalRecordSchema.parse(r.json);
    expect(rec).toMatchObject({
      id: approvalIdFor(runId, decisionId("r1")),
      runId,
      decisionId: decisionId("r1"),
      requestId: "r1",
      action: "dodo.createRefund",
      decision: "approved",
      confirmedAmount: 2900,
      currency: "USD",
      humanOverride: true,
      status: "executed",
    });
    expect(w.count("createRefund")).toBe(1);
    const write = rec.effects.filter((e) => e.op === "dodo.createRefund");
    expect(write).toHaveLength(1);
    expect(write[0]).toMatchObject({ amount: 2900, status: 200 });
    // The executor's pre-write reads ran (existing-refund check) before the write.
    expect(rec.effects.some((e) => e.op === "dodo.listRefunds")).toBe(true);
    expect(rec.traceId).toMatch(/^[0-9a-f]{32}$/);

    // approvals.json (atomic, schema-valid; no temp file left behind)
    const file = ApprovalsFileSchema.parse(JSON.parse(readFileSync(approvalsPath(), "utf8")));
    expect(file.approvals).toEqual([rec]);
    expect(readdirSync(runDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // timeline.jsonl
    const events = readFileSync(timelinePath(), "utf8").trim().split("\n").map((l) => TimelineEventSchema.parse(JSON.parse(l)));
    const ev = events.find((e) => e.type === "approval.decided")!;
    expect(ev).toMatchObject({
      runId,
      stage: "enforce",
      type: "approval.decided",
      recordIds: [rec.id, rec.decisionId],
      traceIds: [rec.traceId],
      data: { decision: "approved", amount: 2900, currency: "USD", status: "executed" },
    });

    // span in runs/<runId>/spans.jsonl, same trace as the record
    const spans = readFileSync(join(runDir, "spans.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { name: string; traceId: string; attrs: Record<string, unknown> });
    const span = spans.find((s) => s.name === "notary.approval")!;
    expect(span.traceId).toBe(rec.traceId);
    expect(span.attrs).toMatchObject({ "notary.approval.decision": "approved", "notary.approval.status": "executed", "notary.approval.humanOverride": true });
    expect(spans.some((s) => s.name === "notary.queue.item" && s.traceId === rec.traceId)).toBe(true);

    // bus
    const emitted = busEvents.slice(before).filter((e) => e.type === "timeline");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({ type: "approval.decided", recordIds: [rec.id, rec.decisionId] });

    // the session token is in none of it
    for (const f of readdirSync(runDir)) expect(readFileSync(join(runDir, f), "utf8")).not.toContain(session.token);
  });

  it("a second approval of the same decision is refused (409) and nothing executes again", async () => {
    const r = await post(KEYED_TEST_ENV, { decision: "approved", runId, decisionId: decisionId("r1"), confirmedAmount: 2900 });
    expect(r.status).toBe(409);
    expect(w.count("createRefund")).toBe(1);
    const both = await Promise.all([1, 2].map(() => post(KEYED_TEST_ENV, { decision: "rejected", runId, decisionId: decisionId("r1"), reason: "late" })));
    expect(both.map((b) => b.status)).toEqual([409, 409]);
  });

  it("concurrent approvals of one item: exactly one executes", async () => {
    const both = await Promise.all([1, 2].map(() => post(KEYED_TEST_ENV, { decision: "approved", runId, decisionId: decisionId("c1"), confirmedAmount: 500 })));
    expect(both.map((b) => b.status).sort()).toEqual([200, 409]);
    expect(w.count("createWalletLedgerEntry")).toBe(1);
  });

  it("reject needs a non-empty reason (400)", async () => {
    for (const reason of ["", "   "]) {
      const r = await post({}, { decision: "rejected", runId, decisionId: decisionId("s1"), reason });
      expect(r.status).toBe(400);
    }
    const missing = await post({}, { decision: "rejected", runId, decisionId: decisionId("s1") });
    expect(missing.status).toBe(400);
  });

  it("reject works keylessly, closes the item and makes no external call", async () => {
    const calls = w.calls.length;
    const r = await post({}, { decision: "rejected", runId, decisionId: decisionId("s1"), reason: "customer withdrew the request" });
    expect(r.status).toBe(200);
    const rec = ApprovalRecordSchema.parse(r.json);
    expect(rec).toMatchObject({ decision: "rejected", status: "closed", effects: [], humanOverride: true, reason: "customer withdrew the request" });
    expect(w.calls.length).toBe(calls);
    const events = readFileSync(timelinePath(), "utf8").trim().split("\n").map((l) => TimelineEventSchema.parse(JSON.parse(l)));
    expect(events.filter((e) => e.type === "approval.decided").at(-1)).toMatchObject({ data: { decision: "rejected", status: "closed" } });
  });

  it("guards still apply under the human override: a blocking guard fails the approval and nothing is written", async () => {
    // A notarized unit_mismatch belief with no observed ratio compiles to a BLOCK guard on createRefund.
    notarize(new BeliefStore(db, { now }), "dodo.refund.amount-minor-units", "unit_mismatch");
    const r = await post(KEYED_TEST_ENV, { decision: "approved", runId, decisionId: decisionId("r2"), confirmedAmount: 1000 });
    expect(r.status).toBe(200);
    const rec = ApprovalRecordSchema.parse(r.json);
    expect(rec.status).toBe("failed");
    expect(rec.error).toMatch(/guard .* refused dodo\.createRefund/);
    expect(w.count("createRefund")).toBe(1);
  });

  it("GET afterwards: nothing pending, every decision listed", async () => {
    const l = await list();
    expect(l.pending).toEqual([]);
    expect(l.decided.map((d: ApprovalRecord) => [d.requestId, d.decision, d.status])).toEqual([
      ["r1", "approved", "executed"],
      ["c1", "approved", "executed"],
      ["s1", "rejected", "closed"],
      ["r2", "approved", "failed"],
    ]);
  });
});

describe("executeQueue humanOverride hook", () => {
  const setup = () => {
    const d = new NotaryDb(":memory:");
    const store = new BeliefStore(d, { now });
    const reg = new GuardRegistry(d, { now });
    reg.sync(compileGuards({ beliefs: store.list(), claimFor: claimById, probes: [], now }));
    const gate = createGate({ beliefs: () => store.list(), probesForClaims: (ids) => d.loadProbesByClaims(ids) });
    const world = fakeWorld();
    return { d, gate, world, tools: world.tools(guarded(reg)) };
  };

  it("bypasses only the gate: the same item is held without it and executed with it", async () => {
    const s = setup();
    const held = await executeQueue({ queue: [req("x1")], manifest: testManifest, tools: s.tools, variant: "guarded", gate: s.gate, policy: testPolicy, runId: "h", now });
    expect(held.decisions[0]!.status).toBe("held");
    expect(s.world.count("createRefund")).toBe(0);
    const done = await executeQueue({ queue: [req("x1")], manifest: testManifest, tools: s.tools, variant: "guarded", gate: s.gate, policy: testPolicy, runId: "h", now, humanOverride: true });
    expect(done.decisions[0]!.status).toBe("executed");
    // The overridden gate verdict stays on the decision.
    expect(done.decisions[0]!.missingBeliefs.length).toBeGreaterThan(0);
    expect(s.world.count("createRefund")).toBe(1);
    s.d.close();
  });

  it("is refused for the naive variant", async () => {
    const s = setup();
    await expect(executeQueue({ queue: [req("x1")], manifest: testManifest, tools: s.world.tools(), variant: "naive", policy: testPolicy, now, humanOverride: true })).rejects.toThrow(/guarded variant only/);
    s.d.close();
  });
});
