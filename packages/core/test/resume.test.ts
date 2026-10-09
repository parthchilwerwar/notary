/**
 * Crash recovery (`notary run --resume`) tests. TEST DOUBLES ONLY (test/fakes.ts): a crash is a
 * SimulatedCrash thrown by the fake tool (before or after its write lands) or by onDecision after N
 * items; nothing touches the network.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BeliefStore } from "../src/beliefs/store.js";
import { verifyBundle } from "../src/bundle/index.js";
import { claimById } from "../src/contracts/index.js";
import { GuardRegistry, compileGuards, guarded } from "../src/guards/index.js";
import { executeQueue } from "../src/queue/executor.js";
import type { ResumeEntry } from "../src/queue/executor.js";
import { createGate } from "../src/queue/gate.js";
import { requiredClaims } from "../src/queue/required.js";
import { RunStateStore } from "../src/queue/run-state.js";
import { runQueue } from "../src/queue/run.js";
import type { QueueRequest } from "../src/schema/index.js";
import { NotaryDb } from "../src/store/db.js";
import { FakeDodo, SimulatedCrash, T0, fakeWorld, notarize, req, testManifest, testPolicy } from "./fakes.js";

const now = () => new Date(T0);

function setup(w: FakeDodo = fakeWorld()) {
  const db = new NotaryDb(":memory:");
  const store = new BeliefStore(db, { now });
  for (const a of ["full_refund", "credit"] as const) for (const c of requiredClaims(a)) if (!store.byClaim(c)) notarize(store, c, "honored");
  const reg = new GuardRegistry(db, { now });
  reg.sync(compileGuards({ beliefs: store.list(), claimFor: claimById, probes: [], now }));
  const gate = createGate({ beliefs: () => store.list(), probesForClaims: (ids) => db.loadProbesByClaims(ids) });
  const state = new RunStateStore(db, { now });
  return { db, w, gate, state, tools: w.tools(guarded(reg)) };
}

type S = ReturnType<typeof setup>;

const QUEUE: QueueRequest[] = [
  req("r1"),
  req("r2", { customerId: "cus_b", companyDomain: "b.example", paymentId: "pay_2" }),
  req("r3", { paymentId: "pay_3" }),
  req("c1", { type: "credit", amount: 700, paymentId: undefined }),
];

function start(s: S, runId = "run-guarded-test"): string {
  s.state.startRun(
    { runId, queueFile: "q.json", expectedFile: "e.json", variant: "guarded", mode: "live", startedAt: T0, cassettes: [runId], before: null },
    QUEUE.map((r) => r.id),
  );
  return runId;
}

function exec(s: S, runId: string, extra: Partial<Parameters<typeof executeQueue>[0]> = {}) {
  return executeQueue({
    queue: QUEUE,
    manifest: testManifest,
    tools: s.tools,
    variant: "guarded",
    gate: s.gate,
    policy: testPolicy,
    runId,
    now,
    runState: s.state.hooks(runId),
    ...extra,
  });
}

function resumeMap(s: S, runId: string): Map<string, ResumeEntry> {
  return new Map(
    s.state.items(runId).map((i) => [i.requestId, { state: i.state, ...(i.decision ? { decision: i.decision } : {}), ...(i.lastWrite ? { lastWrite: i.lastWrite } : {}) }]),
  );
}

describe("run state", () => {
  it("tracks pending -> in_flight (+ write persisted before sending) -> done, and finds the latest unfinished run", () => {
    const s = setup();
    const runId = start(s);
    expect(s.state.items(runId).map((i) => i.state)).toEqual(["pending", "pending", "pending", "pending"]);
    expect(s.state.latestIncomplete()?.runId).toBe(runId);
    s.state.finishRun(runId);
    expect(s.state.latestIncomplete()).toBeUndefined();
    s.db.close();
  });
});

describe("resume after a crash", () => {
  it("a crash between items: done items are kept, the rest continue, nothing is redone", async () => {
    const s = setup();
    const runId = start(s);
    let n = 0;
    await expect(
      exec(s, runId, {
        onDecision: () => {
          if (++n === 2) throw new SimulatedCrash("onDecision");
        },
      }),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    expect(s.state.items(runId).map((i) => i.state)).toEqual(["done", "done", "pending", "pending"]);
    expect(s.w.count("createRefund")).toBe(2);

    const res = await exec(s, runId, { resume: resumeMap(s, runId) });
    expect(res.resumedDone).toEqual(["r1", "r2"]);
    expect(res.decisions.map((d) => [d.requestId, d.status])).toEqual([
      ["r1", "executed"],
      ["r2", "executed"],
      ["r3", "executed"],
      ["c1", "executed"],
    ]);
    expect(s.w.count("createRefund")).toBe(3);
    expect(s.w.refunds).toHaveLength(3);
    expect(s.state.items(runId).every((i) => i.state === "done")).toBe(true);
    s.db.close();
  });

  it("a crash mid-write whose refund LANDED: read back on resume, executed, never re-sent", async () => {
    const s = setup();
    s.w.fault("dodo.createRefund", { crash: "after" }); // the first refund (r1) crashes after landing
    const runId = start(s);
    await expect(exec(s, runId)).rejects.toBeInstanceOf(SimulatedCrash);
    const r1 = s.state.items(runId)[0]!;
    expect(r1.state).toBe("in_flight");
    expect(r1.lastWrite).toMatchObject({ op: "dodo.createRefund", paymentId: "pay_1", customerId: "cus_a", amount: 2900, pre: { refundIds: [] } });
    expect(s.w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(1);

    const res = await exec(s, runId, { resume: resumeMap(s, runId) });
    const d = res.decisions[0]!;
    expect(d).toMatchObject({ requestId: "r1", status: "executed", action: "dodo.createRefund" });
    // The read-back reads come before any write, and the only createRefund effect is the original one.
    const ops = d.effects.map((e) => e.op);
    expect(ops.slice(-4)).toEqual(["dodo.getPayment", "dodo.listRefunds", "dodo.listRefunds", "dodo.createRefund"]);
    expect(d.effects.filter((e) => e.op === "dodo.createRefund")).toEqual([expect.objectContaining({ status: null, resultId: "ref_1", amount: 2900 })]);
    expect(s.w.count("createRefund")).toBe(3); // the crashed call + r2 + r3 (r1 never re-sent)
    expect(s.w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(1);
    expect(res.notes.join("\n")).toMatch(/r1: resumed after a crash with dodo.createRefund in flight; read-back: refund ref_1/);
    s.db.close();
  });

  it("a crash mid-write that did NOT land: read back proves it, then the item is processed again (one refund)", async () => {
    const s = setup();
    s.w.fault("dodo.createRefund", { crash: "before" });
    const runId = start(s);
    await expect(exec(s, runId)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(s.state.items(runId)[0]).toMatchObject({ state: "in_flight", lastWrite: { op: "dodo.createRefund" } });
    expect(s.w.refunds).toHaveLength(0);

    const res = await exec(s, runId, { resume: resumeMap(s, runId) });
    expect(res.decisions.map((d) => d.status)).toEqual(["executed", "executed", "executed", "executed"]);
    expect(s.w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(1);
    expect(res.notes.join("\n")).toMatch(/r1: resumed in flight; read-back proved dodo.createRefund did not land/);
    s.db.close();
  });

  it("a crash mid-credit that landed is found in the ledger by the read-back (no second credit)", async () => {
    const s = setup();
    s.w.fault("dodo.createWalletLedgerEntry", { crash: "after" });
    const runId = start(s);
    await expect(exec(s, runId)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(s.state.items(runId)[3]).toMatchObject({ state: "in_flight", lastWrite: { op: "dodo.createWalletLedgerEntry", amount: 700, pre: { entryIds: [] } } });
    const res = await exec(s, runId, { resume: resumeMap(s, runId) });
    expect(res.decisions[3]).toMatchObject({ status: "executed" });
    expect(s.w.ledger.get("cus_a")).toHaveLength(1);
    expect(s.w.count("createWalletLedgerEntry")).toBe(1);
    s.db.close();
  });

  it("an unprovable read-back on resume holds the item instead of retrying", async () => {
    const s = setup();
    s.w.fault("dodo.createRefund", { crash: "before" });
    const runId = start(s);
    await expect(exec(s, runId)).rejects.toBeInstanceOf(SimulatedCrash);
    s.w.addRefund("pay_3"); // something on page 0 ...
    s.w.stuckPages = true; // ... and pagination that never advances
    const res = await exec(s, runId, { resume: resumeMap(s, runId), queue: QUEUE.slice(0, 1) });
    expect(res.decisions[0]).toMatchObject({ status: "held" });
    expect(res.decisions[0]!.error).toMatch(/write outcome unknown after a crash/);
    expect(res.decisions[0]!.evidencePack).toBeDefined();
    expect(s.w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(0);
    expect(s.w.count("createRefund")).toBe(1);
    s.db.close();
  });
});

describe("notary run --resume (runQueue)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notary-resume-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a run killed mid-queue resumes from the last incomplete item and grades with zero unsafe actions", async () => {
    const q = join(dir, "seeded.json");
    writeFileSync(q, JSON.stringify(QUEUE));
    writeFileSync(
      join(dir, "expected.json"),
      JSON.stringify(
        QUEUE.map((r) => ({
          requestId: r.id,
          expectedTier: r.companyDomain === "b.example" ? "enterprise" : "smb",
          expectedOutcome: "approve",
          expectedAction: r.type === "credit" ? "dodo.createWalletLedgerEntry" : "dodo.createRefund",
          expectedAmount: r.type === "credit" ? 700 : r.paymentId === "pay_2" ? 9900 : r.paymentId === "pay_3" ? 4900 : 2900,
        })),
      ),
    );
    const s = setup();
    s.w.fault("dodo.createRefund", { crash: "after" }); // r1 lands, then the process "dies"
    const base = { queueFile: q, variant: "guarded" as const, mode: "live" as const, manifest: testManifest, makeTools: () => s.tools, policy: testPolicy, db: s.db, runsDir: dir, webBundlesDir: null, now };
    await expect(runQueue(base)).rejects.toThrow(/interrupted; its state is saved\. Continue with: notary run --resume --run run-guarded-/);

    const res = await runQueue({ variant: "guarded", mode: "live", resume: true, manifest: testManifest, makeTools: () => s.tools, policy: testPolicy, db: s.db, runsDir: dir, webBundlesDir: null, now });
    expect(res.exitCode).toBe(0);
    const v = verifyBundle(JSON.parse(readFileSync(res.bundlePath!, "utf8")));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.bundle.decisions.map((d) => d.status)).toEqual(["executed", "executed", "executed", "executed"]);
    expect(v.bundle.metrics).toMatchObject({ unsafe_actions_total: 0, unsafe_duplicates: 0, decision_accuracy: 1 });
    expect(v.bundle.disclosure.join("\n")).toMatch(/Resumed run: .*in flight at the crash: r1 \(read back before any retry\)/);
    expect(v.bundle.cassettes.some((c) => c.includes("-resume-"))).toBe(true);
    expect(s.w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(1);

    // Finished runs are not resumable.
    const again = await runQueue({ variant: "guarded", mode: "live", resume: true, db: s.db, makeTools: () => s.tools });
    expect(again.exitCode).toBe(1);
    s.db.close();
  });
});
