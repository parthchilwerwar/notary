/**
 * Required-beliefs map, gate and guarded executor tests. TEST DOUBLES ONLY (test/fakes.ts): the
 * "Dodo" is in memory and every belief below is driven to `notarized` by fixture probes.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subscribe } from "../src/api/bus.js";
import type { NotaryEvent } from "../src/api/bus.js";
import { BeliefStore, beliefIdFor } from "../src/beliefs/store.js";
import { verifyBundle } from "../src/bundle/index.js";
import { claimById } from "../src/contracts/index.js";
import { GuardRegistry, compileGuards, guarded } from "../src/guards/index.js";
import { executeQueue } from "../src/queue/executor.js";
import type { GateHook, QueueTools } from "../src/queue/executor.js";
import { createGate } from "../src/queue/gate.js";
import {
  REQUIRED_CLAIMS,
  requiredActionFor,
  requiredBeliefIds,
  requiredClaims,
  unresolvedRequiredClaims,
} from "../src/queue/required.js";
import type { RequiredAction } from "../src/queue/required.js";
import { runQueue } from "../src/queue/run.js";
import type { QueueRequest } from "../src/schema/index.js";
import { NotaryDb } from "../src/store/db.js";
import { FakeDodo, T0, fakeProbe, fakeWorld, notarize, req, testManifest, testPolicy } from "./fakes.js";

const now = () => new Date(T0);

describe("required beliefs map", () => {
  it("every required claim id resolves to a real contract claim", () => {
    expect(unresolvedRequiredClaims()).toEqual([]);
    for (const ids of Object.values(REQUIRED_CLAIMS)) for (const id of ids) expect(claimById(id), id).toBeDefined();
  });

  it("covers the TDD rows: refund unit, retry safety, list completeness, company size; partial adds the rounding proxy", () => {
    expect(requiredClaims("full_refund")).toEqual([
      "dodo.refund.amount-minor-units",
      "dodo.refund.full-retry-no-duplicate",
      "dodo.refunds.page-size-max-100",
      "dodo.payments.page-size-max-100",
      "dodo.payment.refunds-lists-issued-refund",
      "crustdata.enrich.headcount-total-integer",
    ]);
    expect(requiredClaims("partial_refund")).toEqual([...requiredClaims("full_refund"), "dodo.refunds.amount-integer"]);
    expect(requiredClaims("plan_change")).toEqual(["dodo.subscription.change-plan-pending-409"]);
    expect(requiredClaims("credit")).toEqual(["dodo.wallet.credit-amount-minor-units", "dodo.wallet.idempotency-key-no-duplicate"]);
    expect(requiredBeliefIds("credit")).toEqual(["belief-dodo.wallet.credit-amount-minor-units", "belief-dodo.wallet.idempotency-key-no-duplicate"]);
  });

  it("tells a full refund from a partial one by the amount moved", () => {
    expect(requiredActionFor("dodo.createRefund", 2900, 2900, "refund")).toBe("full_refund");
    expect(requiredActionFor("dodo.createRefund", undefined, undefined, "refund")).toBe("full_refund");
    expect(requiredActionFor("dodo.createRefund", 1450, 2900, "refund")).toBe("partial_refund"); // policy "partial" on a refund
    expect(requiredActionFor("dodo.createRefund", 500, undefined, "partial_refund")).toBe("partial_refund");
    expect(requiredActionFor("dodo.changeSubscriptionPlan", undefined, undefined, "plan_change")).toBe("plan_change");
    expect(requiredActionFor("none", undefined, undefined, "refund")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

interface Harness {
  db: NotaryDb;
  store: BeliefStore;
  gate: GateHook;
  w: FakeDodo;
  tools: QueueTools;
  calls: string[];
}

function harness(notarizedFor: RequiredAction[] = [], w: FakeDodo = fakeWorld()): Harness {
  const db = new NotaryDb(":memory:");
  const store = new BeliefStore(db, { now });
  for (const a of notarizedFor) for (const c of requiredClaims(a)) if (store.byClaim(c)?.status !== "notarized") notarize(store, c, "honored");
  const reg = new GuardRegistry(db, { now });
  reg.sync(compileGuards({ beliefs: store.list(), claimFor: claimById, probes: [], now }));
  const calls: string[] = [];
  const inner = createGate({ beliefs: () => store.list(), probesForClaims: (ids) => db.loadProbesByClaims(ids) });
  const gate: GateHook = async (c) => {
    calls.push(c.request.id);
    return inner(c);
  };
  return { db, store, gate, w, tools: w.tools(guarded(reg)), calls };
}

const runGuarded = (h: Harness, queue: QueueRequest[], extra: Partial<Parameters<typeof executeQueue>[0]> = {}) =>
  executeQueue({ queue, manifest: testManifest, tools: h.tools, variant: "guarded", gate: h.gate, policy: testPolicy, runId: "g", now, ...extra });

describe("gate", () => {
  it("holds an action whose required beliefs are not notarized, with a complete evidence pack", async () => {
    const h = harness();
    // Two probes already ran on one missing claim (in some notarize run): they are the related evidence.
    for (const k of [1, 2]) {
      const p = fakeProbe(`pr-${k}`, "dodo.refund.full-retry-no-duplicate");
      h.db.commitProbe({
        id: p.id,
        runId: "notarize-dodo-1",
        tool: p.tool,
        claimId: p.claimId,
        hypothesisIds: p.hypothesisIds,
        template: p.template,
        params: p.params,
        prediction: p.prediction,
        committedAt: p.committedAt,
        traceId: p.traceId,
        spanId: p.spanId!,
      });
    }
    const { decisions } = await runGuarded(h, [req("r1")]);
    const d = decisions[0]!;
    expect(d.status).toBe("held");
    expect(d.action).toBe("dodo.createRefund");
    expect(h.w.count("createRefund")).toBe(0);
    expect(d.requiredBeliefs).toEqual(requiredBeliefIds("full_refund"));
    expect(d.missingBeliefs).toEqual(requiredBeliefIds("full_refund"));
    expect(d.evidencePack).toMatchObject({
      missingBeliefs: requiredBeliefIds("full_refund"),
      relatedProbeIds: ["pr-1", "pr-2"],
      traceLinks: {
        "trace-pr-1": "runs/notarize-dodo-1/spans.jsonl#trace=trace-pr-1",
        "trace-pr-2": "runs/notarize-dodo-1/spans.jsonl#trace=trace-pr-2",
      },
    });
    expect(d.evidencePack!.spanIds).toEqual(expect.arrayContaining(["span-pr-1", "span-pr-2"]));
    expect(d.evidencePack!.reason).toMatch(/full refund needs 6 notarized belief\(s\); 6 missing/);
    h.db.close();
  });

  it("allows the action once every required belief is notarized (one missing still holds)", async () => {
    const h = harness(["full_refund"]);
    const { decisions } = await runGuarded(h, [req("r1")]);
    expect(decisions[0]).toMatchObject({ status: "executed", action: "dodo.createRefund", missingBeliefs: [] });
    expect(h.w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(1);

    // Partial needs one more belief (the rounding proxy), which is not notarized here.
    const p = await runGuarded(h, [req("r2", { type: "partial_refund", paymentId: "pay_3", amount: 1000 })]);
    expect(p.decisions[0]).toMatchObject({ status: "held", missingBeliefs: [beliefIdFor("dodo.refunds.amount-integer")] });
    h.db.close();
  });

  it("escalations carry an evidence pack too; denials and executions need none", async () => {
    const h = harness();
    const { decisions } = await runGuarded(h, [req("r1", { companyDomain: "unknown.example" })]);
    expect(decisions[0]).toMatchObject({ status: "escalated", policyOutcome: "escalate" });
    expect(decisions[0]!.evidencePack).toMatchObject({ reason: "unknown tier", missingBeliefs: requiredBeliefIds("full_refund") });
    h.db.close();
  });

  it("reads every page of refunds before refunding: a prior refund past page one is found and denied", async () => {
    const w = fakeWorld();
    w.pageCap = 100;
    w.addRefund("pay_1");
    for (let i = 0; i < 120; i++) {
      w.payments.push({ payment_id: `pay_z${i}`, customer_id: "cus_a", total_amount: 100, product_id: "p" });
      w.addRefund(`pay_z${i}`);
    }
    const h = harness(["full_refund"], w);
    const { decisions } = await runGuarded(h, [req("r1")]);
    // The payment's own refunds[] shows it too; the full listing must also have reached an empty page.
    expect(decisions[0]).toMatchObject({ status: "denied" });
    const pages = decisions[0]!.effects.filter((e) => e.op === "dodo.listRefunds").map((e) => e.params.page_number);
    expect(pages).toEqual([0, 1, 2]);
    expect(w.count("createRefund")).toBe(0);
    h.db.close();
  });

  it("holds (with a pack) when a guard refuses the write", async () => {
    const h = harness(["full_refund"]);
    // A notarized violation with no safe transform -> block guard on createRefund.
    const reg = GuardRegistry.fromGuards(
      compileGuards({
        beliefs: [{ ...h.store.byClaim("dodo.refund.amount-minor-units")!, class: "unit_mismatch" }],
        claimFor: claimById,
        probes: [],
        now,
      }),
    );
    const tools = h.w.tools(guarded(reg));
    const { decisions } = await runGuarded(h, [req("r1")], { tools });
    const d = decisions[0]!;
    expect(d.status).toBe("held");
    expect(d.guardsApplied).toEqual([reg.all()[0]!.id]);
    expect(d.evidencePack!.reason).toMatch(/^guard grd-[0-9a-f]{12} refused dodo.createRefund/);
    expect(h.w.count("createRefund")).toBe(0);
    h.db.close();
  });

  it("never retries blindly: a 5xx whose refund landed is read back (one refund), one that did not is retried once", async () => {
    const landed = harness(["full_refund"]);
    landed.w.fault("dodo.createRefund", { http: 502, after: true });
    const a = await runGuarded(landed, [req("r1")]);
    expect(a.decisions[0]).toMatchObject({ status: "executed" });
    expect(landed.w.count("createRefund")).toBe(1);
    expect(landed.w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(1);
    const write = a.decisions[0]!.effects.filter((e) => e.op === "dodo.createRefund");
    expect(write).toEqual([expect.objectContaining({ status: 502, resultId: "ref_1", amount: 2900 })]);
    landed.db.close();

    const lost = harness(["full_refund"]);
    lost.w.fault("dodo.createRefund", { network: true, after: false });
    const b = await runGuarded(lost, [req("r1")]);
    expect(b.decisions[0]).toMatchObject({ status: "executed" });
    expect(lost.w.count("createRefund")).toBe(2);
    expect(lost.w.refunds.filter((r) => r.payment_id === "pay_1")).toHaveLength(1);
    expect(b.notes.join("\n")).toMatch(/read-back: no new refund on pay_1 after a complete listing; retried once/);
    lost.db.close();
  });

  it("client-timeout-then-retry: the abandoned write is read back instead of being sent twice", async () => {
    const h = harness(["full_refund"]);
    const slow = h.w.methods();
    const tools = h.w.tools(guarded(new GuardRegistry()));
    const create = slow["dodo.createRefund"]!;
    (tools.dodo as unknown as Record<string, unknown>).createRefund = async (p: unknown) => {
      await new Promise((r) => setTimeout(r, 60));
      return create(p);
    };
    const { decisions, notes } = await runGuarded(h, [req("r1", { note: "client-timeout-then-retry" })], { tools, clientTimeoutMs: 10 });
    expect(decisions[0]).toMatchObject({ status: "executed" });
    expect(h.w.count("createRefund")).toBe(1);
    expect(notes.join("\n")).toMatch(/client timeout .*read-back: refund ref_1/);
    h.db.close();
  });

  it("plan changes send effective_at explicitly; credits snapshot the ledger before writing", async () => {
    const h = harness(["plan_change", "credit"]);
    const { decisions } = await runGuarded(h, [
      req("p1", { type: "plan_change", subscriptionId: "sub_1", targetPlan: "growth", paymentId: undefined }),
      req("c1", { type: "credit", amount: 500, paymentId: undefined }),
    ]);
    expect(decisions.map((d) => d.status)).toEqual(["executed", "executed"]);
    expect(h.w.calls.find((c) => c.op === "changeSubscriptionPlan")!.args[1]).toMatchObject({ effective_at: "immediately", product_id: "prod_growth" });
    expect(decisions[1]!.effects.map((e) => e.op)).toEqual(["dodo.listWalletLedgerEntries", "dodo.createWalletLedgerEntry"]);
    h.db.close();
  });

  it("the naive variant is unaffected: no gate, no full pagination, no ledger snapshot", async () => {
    const h = harness();
    const w = h.w;
    const { decisions } = await executeQueue({
      queue: [req("r1"), req("c1", { type: "credit", amount: 500, paymentId: undefined })],
      manifest: testManifest,
      tools: w.tools(),
      variant: "naive",
      gate: h.gate,
      policy: testPolicy,
      runId: "n",
      now,
    });
    expect(h.calls).toEqual([]);
    expect(decisions.map((d) => d.status)).toEqual(["executed", "executed"]);
    expect(decisions[0]!.effects.map((e) => e.op)).toEqual(["crustdata.enrichCompany", "dodo.listRefunds", "dodo.listPayments", "dodo.createRefund"]);
    expect(w.count("listWalletLedgerEntries")).toBe(0);
    expect(decisions.every((d) => d.guardsApplied.length === 0 && d.requiredBeliefs.length === 0)).toBe(true);
    h.db.close();
  });
});

describe("runQueue (guarded)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notary-guarded-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("compiles guards from the store, gates, emits decision events and writes a schema-valid bundle", async () => {
    const db = new NotaryDb(":memory:");
    const store = new BeliefStore(db, { now });
    for (const c of requiredClaims("full_refund")) notarize(store, c, "honored");
    // One notarized violation outside the queue's path -> one compiled (block) guard in the bundle.
    notarize(store, "crustdata.identify.max-25-identifiers", "silent_truncation");
    const q = join(dir, "seeded.json");
    writeFileSync(
      q,
      JSON.stringify([req("r1"), req("c1", { type: "credit", amount: 500, paymentId: undefined })]),
    );
    writeFileSync(
      join(dir, "expected.json"),
      JSON.stringify([
        { requestId: "r1", expectedTier: "smb", expectedOutcome: "approve", expectedAction: "dodo.createRefund", expectedAmount: 2900 },
        { requestId: "c1", expectedTier: "smb", expectedOutcome: "approve", expectedAction: "dodo.createWalletLedgerEntry", expectedAmount: 500 },
      ]),
    );
    const w = fakeWorld();
    const events: NotaryEvent[] = [];
    const off = subscribe((e) => events.push(e));
    const res = await runQueue({
      queueFile: q,
      variant: "guarded",
      mode: "live",
      manifest: testManifest,
      makeTools: (wrap) => w.tools(wrap),
      policy: testPolicy,
      db,
      runsDir: dir,
      webBundlesDir: null,
      now,
    });
    off();
    expect(res.exitCode).toBe(0);
    const v = verifyBundle(JSON.parse(readFileSync(res.bundlePath!, "utf8")));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const b = v.bundle;
    expect(b).toMatchObject({ variant: "guarded", kind: "run", status: "completed" });
    expect(b.decisions.map((d) => [d.requestId, d.status])).toEqual([
      ["r1", "executed"],
      ["c1", "held"],
    ]);
    expect(b.decisions[1]!.evidencePack!.missingBeliefs).toEqual(requiredBeliefIds("credit"));
    expect(b.metrics).toMatchObject({ unsafe_actions_total: 0, executed: 1, holds: 1 });
    expect(b.beliefs.before.filter((x) => x.status === "notarized")).toHaveLength(7);
    expect(b.guards).toMatchObject([{ operation: "crustdata.identifyCompany", kind: "block", active: true }]);
    expect(b.disclosure.join("\n")).toMatch(/Guarded variant/);
    expect(events.filter((e) => e.type === "decision").map((e) => (e.payload as { decision: { requestId: string } }).decision.requestId)).toEqual(["r1", "c1"]);
    expect(events.some((e) => e.type === "run.finished")).toBe(true);
    db.close();
  });
});
