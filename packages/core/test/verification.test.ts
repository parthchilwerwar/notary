/**
 * Verification probes (claims with no anomaly), the extra independent designs per template, the
 * uninformative-template demotion, and the probe-only seed resources. Everything runs on the
 * in-process FIXTURE API from src/demo (simulated Dodo/Crustdata; no network, no keys).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BeliefStore, beliefIdFor } from "../src/beliefs/store.js";
import { designFingerprint } from "../src/beliefs/params.js";
import { claimById, contractEntryById, crustdataContract, dodoContract } from "../src/contracts/index.js";
import { FixtureApi, FixtureWorld } from "../src/demo/fixture-api.js";
import { adversaryDecision, createFixtureLlm, fixtureConverseTransport, fixtureLlmEnv } from "../src/demo/fixture-llm.js";
import { LlmClient } from "../src/llm/client.js";
import { budgetSnapshot } from "../src/timeline/derive.js";
import type { CompleteRequest, CompleteResult, LlmLike } from "../src/llm/client.js";
import { REQUIRED_CLAIMS } from "../src/queue/required.js";
import {
  SEED_PLAN,
  plannedHandles,
  plannedPayments,
  probeHandles,
  probeSeedCost,
  queueCompanyDomains,
  refundedPaymentHandles,
  seedSteps,
} from "../src/queue/seed-plan.js";
import { defaultVerifyClaims, runProbeLoop, templateNamedIn, verificationRivals, verificationSubjectId } from "../src/reflect/loop.js";
import { SEEDED_QUEUE_PATH, notarize, probePaymentPool } from "../src/reflect/notarize.js";
import {
  BurstCounter,
  SimplePaymentPool,
  buildCostModel,
  probeIoFromTools,
  retryAfterTimeout,
  typeEdge,
  writeThenRead,
} from "../src/reflect/templates/index.js";
import type { ProbeContext, ProbeDesign, ProbeTemplateModule, Skip } from "../src/reflect/templates/index.js";
import type { Anomaly, Claim, Hypothesis, RunBundle } from "../src/schema/index.js";
import { NotaryDb } from "../src/store/db.js";
import { fakeProbe } from "./fakes.js";
import { CreditLedger, DEFAULT_CREDIT_BUDGET, createTools, setRecorderTransport } from "../src/tools/index.js";

const ENV = { NOTARY_MODE: "test", DODO_PAYMENTS_API_KEY: "fixture-placeholder", CRUSTDATA_API_KEY: "fixture-placeholder" };

/** A model client that must never be called (verification rivals are built by code). */
class NoModel implements LlmLike {
  calls = 0;
  async complete(_req: CompleteRequest): Promise<CompleteResult> {
    this.calls += 1;
    throw new Error("verification probes must not call a model");
  }
}

/** A reflector stand-in for anomaly tests: the same rival pair for every anomaly. */
class ScriptedReflector implements LlmLike {
  calls = 0;
  constructor(private readonly pairs: Array<[string, string]>) {}
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls += 1;
    const text = req.messages.map((m) => m.content).join("\n");
    const ids = [...new Set([...text.matchAll(/"anomalyId":\s*"([^"]+)"/g)].map((m) => m[1]!))];
    const body = { anomalies: ids.map((anomalyId) => ({ anomalyId, hypotheses: this.pairs.map(([cls, test]) => ({ class: cls, statement: `${cls} explains it`, distinguishingTest: test })) })) };
    return { text: JSON.stringify(body), inputTokens: 1, outputTokens: 1, usd: 0, modelId: "scripted", stopReason: "end_turn" };
  }
}

const dodoClaims = (): Claim[] => dodoContract.map((e) => e.claim);

let dir: string;
let restore: (() => void) | undefined;
let world: FixtureWorld;
let dbs: NotaryDb[] = [];

function setup(): { manifestPath: string; io: ReturnType<typeof probeIoFromTools>; ledger: CreditLedger; db: NotaryDb } {
  world = new FixtureWorld();
  const api = new FixtureApi(() => world, { slowFullRefundMs: 0 });
  restore = setRecorderTransport({ fetch: api.fetch, fixture: true });
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(world.seedManifest()));
  const ledger = new CreditLedger({ budget: DEFAULT_CREDIT_BUDGET });
  const tools = createTools({ mode: "live", cassette: "vp-test", cassetteDir: join(dir, "cassettes"), ledger, env: ENV });
  const db = new NotaryDb(":memory:");
  dbs.push(db);
  return { manifestPath, io: probeIoFromTools(tools, { sleep: async () => {} }), ledger, db };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notary-verify-"));
});
afterEach(() => {
  restore?.();
  restore = undefined;
  for (const db of dbs) db.close();
  dbs = [];
  rmSync(dir, { recursive: true, force: true });
});

describe("verification rivals (no anomaly, no model)", () => {
  it("are {honored, suspected class}, built by code, keyed to a verify: subject, never to a checker anomaly", () => {
    const claim = claimById("dodo.refund.full-retry-no-duplicate")!;
    const built = verificationRivals(claim);
    expect("hypotheses" in built).toBe(true);
    if (!("hypotheses" in built)) return;
    expect(built.hypotheses.map((h) => h.class).sort()).toEqual(["honored", "idempotency_hazard"]);
    for (const h of built.hypotheses) {
      expect(h.anomalyId).toBe(verificationSubjectId(claim.id));
      expect(h.distinguishingTest).toBe("retry_after_timeout");
      expect(h.statement).toMatch(/deterministic, not model-proposed/);
    }
    // Deterministic: the same ids every time.
    expect(verificationRivals(claim)).toEqual(built);
  });

  it("skip control claims (suspected class honored) and claims no template can exercise", () => {
    expect(verificationRivals(claimById("dodo.payment.refunds-array-present")!)).toMatchObject({ skip: expect.stringMatching(/control claim/) });
    expect(verificationRivals(claimById("dodo.customer.missing-email-422")!)).toMatchObject({ skip: expect.stringMatching(/no probe template applies/) });
  });

  it("default to every claim of the required-beliefs map", () => {
    expect(defaultVerifyClaims()).toEqual([...new Set(Object.values(REQUIRED_CLAIMS).flat())].sort());
  });
});

describe("verification probes in the loop (fixture API)", () => {
  it("an honored required claim with no anomaly reaches candidate through the same commit-then-run loop, with no model call", async () => {
    const { manifestPath, io, ledger, db } = setup();
    const pool = probePaymentPool(manifestPath, SEEDED_QUEUE_PATH);
    const llm = new NoModel();
    const verify = ["dodo.payment.refunds-lists-issued-refund", "dodo.subscription.change-plan-pending-409"];
    const res = await runProbeLoop({
      tool: "dodo",
      anomalies: [],
      claims: dodoClaims(),
      tools: io,
      llm,
      db,
      runId: "vp-honored",
      ledger,
      burst: new BurstCounter(),
      payments: new SimplePaymentPool(pool.ids),
      subscriptions: new SimplePaymentPool(pool.subscriptionIds),
      verifyClaims: verify,
    });
    expect(llm.calls).toBe(0);
    expect(res.verification.claims).toEqual(verify);
    expect(res.probes).toHaveLength(6);
    const winners = res.probes.map((p) => res.hypotheses.find((h) => h.id === p.winningHypothesisId)?.class);
    expect(winners).toEqual(Array(6).fill("honored"));
    for (const p of res.probes) {
      expect(p.committedAt < (p.ranAt ?? "")).toBe(true);
      for (const id of p.hypothesisIds) expect(res.hypotheses.find((h) => h.id === id)!.anomalyId.startsWith("verify:")).toBe(true);
    }
    expect(new Set(res.probes.filter((p) => p.claimId === verify[0]).map((p) => p.template))).toEqual(new Set(["write_then_read"]));
    expect(new Set(res.probes.filter((p) => p.claimId === verify[1]).map((p) => p.template))).toEqual(new Set(["retry_after_timeout"]));
    const store = new BeliefStore(db);
    for (const c of verify) expect(store.byClaim(c)).toMatchObject({ status: "candidate", alpha: 4, beta: 1, class: "honored" });
    // Every refund / plan change hit a probe-only resource (DECISIONS #42): never the queue's.
    const probeSubs = new Set(probeHandles().subscriptions.map((h) => world.handles.subscriptions.get(h)!));
    const probePays = new Set(probeHandles().openPayments.map((h) => world.handles.payments.get(h)!));
    const json = JSON.stringify(res.probes.map((p) => p.params));
    for (const m of json.matchAll(/"(pay_fx_[^"]+)"/g)) expect(probePays.has(m[1]!), m[1]).toBe(true);
    for (const m of json.matchAll(/"(sub_fx_[^"]+)"/g)) expect(probeSubs.has(m[1]!), m[1]).toBe(true);
  });

  it("a violated required claim (planted fixture quirks Q4, Q5) reaches the violated side the same way", async () => {
    const { manifestPath, io, ledger, db } = setup();
    const pool = probePaymentPool(manifestPath, SEEDED_QUEUE_PATH);
    const res = await runProbeLoop({
      tool: "dodo",
      anomalies: [],
      claims: dodoClaims(),
      tools: io,
      llm: new NoModel(),
      db,
      runId: "vp-violated",
      ledger,
      payments: new SimplePaymentPool(pool.ids),
      verifyClaims: ["dodo.refund.amount-minor-units", "dodo.refund.full-retry-no-duplicate"],
    });
    const store = new BeliefStore(db);
    expect(store.byClaim("dodo.refund.amount-minor-units")).toMatchObject({ status: "candidate", beta: 4, class: "unit_mismatch" });
    expect(store.byClaim("dodo.refund.full-retry-no-duplicate")).toMatchObject({ status: "candidate", beta: 4, class: "idempotency_hazard" });
    // three distinct design fingerprints per claim (independence), retry repeats never above 3
    for (const id of ["dodo.refund.amount-minor-units", "dodo.refund.full-retry-no-duplicate"]) {
      const claim = claimById(id)!;
      const fps = res.probes.filter((p) => p.claimId === id).map((p) => designFingerprint(claim, p));
      expect(new Set(fps).size).toBe(3);
    }
    const repeats = res.probes.flatMap((p) => ((p.params as { steps: Array<{ repeat?: number }> }).steps ?? []).map((s) => s.repeat ?? 1));
    expect(Math.max(...repeats)).toBeLessThanOrEqual(3);
  });

  it("without probe-only resources the claims are skipped with a reason, not probed; anomaly claims are left to the anomaly path", async () => {
    const { io, ledger, db } = setup();
    const res = await runProbeLoop({
      tool: "dodo",
      anomalies: [{ id: "anom-x", claimId: "dodo.refunds.amount-integer", tool: "dodo", observed: {}, expected: {}, traceId: "", spanId: "" }],
      claims: dodoClaims(),
      tools: io,
      llm: new ScriptedReflector([["honored", "type_edge"], ["silent_coercion", "type_edge"]]),
      db,
      runId: "vp-skip",
      ledger,
      verifyClaims: ["dodo.refund.full-retry-no-duplicate", "dodo.subscription.change-plan-pending-409", "dodo.refunds.amount-integer"],
    });
    expect(res.verification.claims).toEqual(["dodo.refund.full-retry-no-duplicate", "dodo.subscription.change-plan-pending-409"]);
    expect(res.verification.skipped.map((s) => s.claimId)).toEqual(["dodo.refund.full-retry-no-duplicate", "dodo.subscription.change-plan-pending-409"]);
    expect(res.verification.skipped[0]!.reason).toMatch(/probe-reserved succeeded payment/);
    expect(res.verification.skipped[1]!.reason).toMatch(/probe-reserved active subscription/);
    expect(res.probes.every((p) => p.claimId === "dodo.refunds.amount-integer")).toBe(true);
    expect(res.skipped).toEqual([]);
  });
});

describe("independent designs per claim", () => {
  const ctx = (over: Partial<ProbeContext> = {}): ProbeContext => ({
    runId: "r",
    tag: "r-p1",
    costs: buildCostModel({ claims: [...crustdataContract, ...dodoContract].map((e) => e.claim) }),
    burst: new BurstCounter(),
    payments: new SimplePaymentPool(["pay_a", "pay_b", "pay_c", "pay_d"]),
    subscriptions: new SimplePaymentPool(["sub_a"]),
    ...over,
  });
  const rivals = (claim: Claim, cls: string): Hypothesis[] => [
    { id: "h-honored", anomalyId: `verify:${claim.id}`, class: "honored", statement: "s", distinguishingTest: "type_edge" },
    { id: "h-defect", anomalyId: `verify:${claim.id}`, class: cls as Hypothesis["class"], statement: "s", distinguishingTest: "type_edge" },
  ];
  const designs = (t: ProbeTemplateModule, claim: Claim, cls: string, n: number, over: Partial<ProbeContext> = {}): ProbeDesign[] => {
    const out: ProbeDesign[] = [];
    for (let k = 0; k < n; k++) {
      const d = t.design(claim, rivals(claim, cls), { ...ctx(over), entry: contractEntryById(claim.id)!, variant: k }) as ProbeDesign | Skip;
      if ("skip" in d) break;
      out.push(d);
    }
    return out;
  };

  it("Crustdata type claims get 5 designs over the recon and seeded-queue domains, within the credit budget", () => {
    const claim = claimById("crustdata.enrich.headcount-total-integer")!;
    const ds = designs(typeEdge, claim, "silent_coercion", 10);
    expect(ds).toHaveLength(5);
    expect(new Set(ds.map((d) => designFingerprint(claim, { template: d.template, params: d.params }))).size).toBe(5);
    const domains = ds.flatMap((d) => [...d.params.steps, ...d.control.params.steps].flatMap((s) => s.params.domains as string[]));
    for (const dom of domains) expect(["stripe.com", "notion.so", ...queueCompanyDomains()]).toContain(dom);
    expect(queueCompanyDomains()).not.toContain(SEED_PLAN.customers[SEED_PLAN.probe.customer]!.companyDomain);
    // credit estimate: recon (list price) + 5 designs x 4 credits for each of the 5 Crustdata type claims
    expect(ds.every((d) => d.estCredits === 4)).toBe(true);
    const cost = buildCostModel();
    const recon = crustdataContract.flatMap((e) => e.recon).reduce((s, st) => s + cost.creditsPerCall(st.op, st.params), 0);
    const typeClaims = crustdataContract.filter((e) => e.claim.expect.kind === "type").length;
    expect(recon + typeClaims * 5 * 4).toBeLessThanOrEqual(DEFAULT_CREDIT_BUDGET);
  });

  it("wallet idempotency, refund retry, change-plan, refund listing and write_then_read each have 3 distinct designs", () => {
    const cases: Array<[ProbeTemplateModule, string, string]> = [
      [retryAfterTimeout, "dodo.wallet.idempotency-key-no-duplicate", "idempotency_hazard"],
      [retryAfterTimeout, "dodo.refund.full-retry-no-duplicate", "idempotency_hazard"],
      [retryAfterTimeout, "dodo.subscription.change-plan-pending-409", "idempotency_hazard"],
      [typeEdge, "dodo.refunds.amount-integer", "silent_coercion"],
      [writeThenRead, "dodo.payment.refunds-lists-issued-refund", "eventual_consistency"],
    ];
    for (const [t, id, cls] of cases) {
      const claim = claimById(id)!;
      const ds = designs(t, claim, cls, 5);
      expect(ds.length, id).toBe(3);
      expect(new Set(ds.map((d) => designFingerprint(claim, { template: d.template, params: d.params }))).size, id).toBe(3);
      for (const d of ds) for (const s of d.params.steps) expect(s.repeat ?? 1, id).toBeLessThanOrEqual(3);
    }
    // wallet variants: different amounts and idempotency keys (each on its own fresh customer)
    const wallet = designs(retryAfterTimeout, claimById("dodo.wallet.idempotency-key-no-duplicate")!, "idempotency_hazard", 3);
    expect(wallet.map((d) => (d.params.steps[1]!.params as { amount: number }).amount)).toEqual([500, 700, 900]);
  });
});

describe("uninformative template demotion", () => {
  it("a boundary sweep that saw nothing is not repeated: pagination_completeness settles the refund-list claim", async () => {
    const { io, ledger, db } = setup();
    const claim = claimById("dodo.refunds.page-size-max-100")!;
    const anomaly: Anomaly = { id: "anom-r", claimId: claim.id, tool: "dodo", observed: {}, expected: {}, traceId: "", spanId: "" };
    const res = await runProbeLoop({
      tool: "dodo",
      anomalies: [anomaly],
      claims: [claim],
      tools: io,
      llm: new ScriptedReflector([["silent_truncation", "boundary_sweep"], ["honored", "pagination_completeness"]]),
      db,
      runId: "vp-demote",
      ledger,
      verifyClaims: [],
    });
    expect(res.probes.map((p) => `${p.template}:${p.verdict}`)).toEqual([
      "boundary_sweep:uninformative",
      "pagination_completeness:confirmed",
      "pagination_completeness:confirmed",
      "pagination_completeness:confirmed",
    ]);
    expect(new BeliefStore(db).byClaim(claim.id)).toMatchObject({ status: "candidate", class: "honored" });
    expect(new BeliefStore(db).get(beliefIdFor(claim.id))?.probesToCandidate).toBe(4);
  });
});

describe("probe-only seed resources", () => {
  const queueText = readFileSync(SEEDED_QUEUE_PATH, "utf8");

  it("the probe-only customer and its payments and subscriptions are never referenced by the seeded queue", () => {
    const h = probeHandles();
    expect(queueText).not.toContain(`cust:${h.customer}`);
    for (const p of plannedPayments().filter((x) => x.customer === h.customer)) expect(queueText).not.toContain(`pay:${p.handle}"`);
    for (const s of h.subscriptions) expect(queueText).not.toContain(`sub:${s}"`);
    expect(plannedHandles().subscriptions.has(h.subscriptions[1]!)).toBe(true);
  });

  it("refunds at least 30 probe-only payments (refund-list probes) and states the added cost", () => {
    const cost = probeSeedCost();
    expect(cost.refunds).toBeGreaterThanOrEqual(30);
    expect(cost.humanCheckouts).toBe(1);
    expect(cost.payments).toBe(1 + SEED_PLAN.probe.refunded + SEED_PLAN.probe.open + SEED_PLAN.probe.extraSubscriptions);
    expect(cost.chargedMinor).toBeGreaterThan(cost.refundedMinor);
    const refundSteps = seedSteps().filter((s) => s.op === "dodo.createRefund").map((s) => s.handle.slice(4));
    expect(refundSteps).toEqual(refundedPaymentHandles());
    // a probe refund amount x100 still fits inside a probe payment (so a unit mismatch shows as x100, not a cap)
    expect(SEED_PLAN.products[SEED_PLAN.probe.product]!.price).toBeGreaterThan(150 * 100);
  });

  it("the fixture world picks it up via SEED_PLAN; the queue's own refund set is unchanged", () => {
    const w = new FixtureWorld();
    expect(w.refunds.length).toBe(refundedPaymentHandles().length);
    const retool = w.handles.customers.get("mid-retool")!;
    expect(w.refunds.filter((r) => r.customer_id === retool)).toHaveLength(SEED_PLAN.existingRefunds.length);
    const manifest = w.seedManifest();
    for (const s of probeHandles().subscriptions) expect(manifest.subscriptions[s]?.customerHandle).toBe(SEED_PLAN.probe.customer);
  });

  it("the probe pool offers only open probe-only payments and probe-only subscriptions", () => {
    const w = new FixtureWorld();
    const path = join(dir, "m.json");
    writeFileSync(path, JSON.stringify(w.seedManifest()));
    const pool = probePaymentPool(path, SEEDED_QUEUE_PATH);
    expect(pool.ids).toEqual(probeHandles().openPayments.map((h) => w.handles.payments.get(h)!));
    expect(pool.subscriptionIds).toEqual(probeHandles().subscriptions.map((h) => w.handles.subscriptions.get(h)!));
  });
});

describe("adversary double (regression)", () => {
  it("does not downgrade a type_edge belief for sending the same `fields` to different records (record-varying template)", () => {
    const probe = (id: string, a: string, b: string) => ({
      id,
      cited: true,
      template: "type_edge",
      params: { steps: [{ op: "crustdata.enrichCompany", params: { domains: [a], fields: ["headcount"] } }] },
      control: { params: { steps: [{ op: "crustdata.enrichCompany", params: { domains: [b], fields: ["headcount"] } }] } },
      observed: {},
    });
    const d = adversaryDecision({
      belief: { id: "b", class: "honored", alpha: 4, beta: 1, confidence: 0.94 },
      claim: { id: "crustdata.enrich.headcount-total-integer", operation: "crustdata.enrichCompany", param: "fields", expect: { kind: "type" } },
      probes: [probe("p1", "a.com", "b.com"), probe("p2", "b.com", "c.com")],
    });
    expect(d.verdict).toBe("uphold");
  });
});

describe("re-examination after an adversary downgrade", () => {
  it("templateNamedIn reads the template the adversary names (untested alternative first), deterministically", () => {
    expect(templateNamedIn("x boundary_sweep y. Untested alternative: a pagination_completeness probe would tell")).toBe("pagination_completeness");
    expect(templateNamedIn("only boundary_sweep probes were cited")).toBe("boundary_sweep");
    expect(templateNamedIn("no template here")).toBeUndefined();
  });

  it("the extra round runs only never-applied designs, starting with the named template, with no model call", async () => {
    const { io, ledger, db } = setup();
    const claim = claimById("dodo.payments.page-size-max-100")!;
    const anomaly: Anomaly = { id: "anom-p", claimId: claim.id, tool: "dodo", observed: {}, expected: {}, traceId: "", spanId: "" };
    const first = await runProbeLoop({
      tool: "dodo", anomalies: [anomaly], claims: [claim], tools: io, db, runId: "vp-re", ledger, verifyClaims: [],
      llm: new ScriptedReflector([["silent_truncation", "boundary_sweep"], ["honored", "pagination_completeness"]]),
    });
    const store = new BeliefStore(db);
    const id = beliefIdFor(claim.id);
    expect(store.get(id)).toMatchObject({ status: "candidate", class: "silent_truncation" });
    const reason = "Every cited probe is a boundary_sweep. Untested alternative: a pagination_completeness probe would tell them apart.";
    store.applyAdversary(id, { verdict: "downgrade", reason, model: "test" });
    const before = store.appliedFingerprints(id);
    const llm = new NoModel();
    const round = await runProbeLoop({
      tool: "dodo", anomalies: [], claims: [claim], tools: io, db, runId: "vp-re", ledger, llm, verifyClaims: [],
      reexamine: [{ claimId: claim.id, rivals: first.hypotheses, prefer: templateNamedIn(reason)! }],
      seqStart: first.probes.length,
    });
    expect(llm.calls).toBe(0);
    expect(round.reexamined).toEqual({ claims: [claim.id], skipped: [] });
    expect(round.probes.length).toBeGreaterThan(0);
    expect(round.probes[0]!.template).toBe("pagination_completeness");
    for (const p of round.probes) expect(before.has(designFingerprint(claim, p))).toBe(false);
    expect(new Set([...first.probes, ...round.probes].map((p) => p.id)).size).toBe(first.probes.length + round.probes.length);
    // fixture Q1 clamps but keeps lists complete: the evidence is genuinely mixed -> abstained, reason recorded
    const after = store.get(id)!;
    expect(after.status).toBe("abstained");
    expect(store.events(id).at(-1)!.reason).toContain("re-examined after downgrade");
  });

  it("respects the per-run probe cap and the credit budget", async () => {
    const { io, db } = setup();
    const claim = claimById("crustdata.enrich.headcount-total-integer")!;
    const rivals = (verificationRivals(claim) as { hypotheses: Hypothesis[] }).hypotheses;
    const capped = await runProbeLoop({
      tool: "crustdata", anomalies: [], claims: [claim], tools: io, db, runId: "vp-cap", ledger: new CreditLedger({ budget: 200 }), llm: new NoModel(),
      reexamine: [{ claimId: claim.id, rivals }], maxProbesPerRun: 1,
    });
    expect(capped.probes).toHaveLength(1);
    expect(capped.stoppedReason).toMatch(/probe cap/);
    const broke = await runProbeLoop({
      tool: "crustdata", anomalies: [], claims: [claim], tools: io, db, runId: "vp-budget", ledger: new CreditLedger({ budget: 1 }), llm: new NoModel(),
      reexamine: [{ claimId: claim.id, rivals }],
    });
    expect(broke.probes).toHaveLength(0);
    expect(broke.stoppedReason).toMatch(/budget/i);
  });

  it("notarize at NOTARY_MAX_USD stops cleanly: stopped_budget bundle naming the cap, budget snapshot reports it", async () => {
    setup();
    // The real LlmClient over the fixture double, with a $0 cap: the first reflector call is refused before any I/O.
    const llm = new LlmClient({ env: { ...fixtureLlmEnv(), NOTARY_MAX_USD: "0" }, transport: fixtureConverseTransport() });
    const res = await notarize({
      tool: "dodo",
      env: ENV,
      runsDir: join(dir, "runs"),
      cassetteDir: join(dir, "cassettes"),
      dbPath: join(dir, "notary.sqlite"),
      llm,
      manifestPath: join(dir, "manifest.json"),
      queuePath: SEEDED_QUEUE_PATH,
      sleep: async () => {},
      recordReplay: false,
      runId: "vp-notarize-usd-cap",
    });
    expect(res.exitCode).toBe(0);
    expect(res.status).toBe("stopped_budget");
    expect(res.lines).toContainEqual(expect.stringMatching(/^STOPPED: USD cap reached: NOTARY_MAX_USD=0 /));
    expect(res.loop!.probes).toEqual([]);
    expect(llm.meter.snapshot().reflector.calls).toBe(0);
    const bundle = JSON.parse(readFileSync(res.bundlePath!, "utf8")) as RunBundle;
    expect(bundle.status).toBe("stopped_budget");
    expect(bundle.stopReason).toMatch(/NOTARY_MAX_USD=0/);
    expect(budgetSnapshot(bundle).usdCap).toBe(0);
  }, 60_000);

  it("notarize runs at most ONE extra round and ONE more review per downgraded claim (reviewer that always downgrades)", async () => {
    setup();
    const manifestPath = join(dir, "manifest.json");
    let reviews = 0;
    const res = await notarize({
      tool: "dodo",
      env: ENV,
      runsDir: join(dir, "runs"),
      cassetteDir: join(dir, "cassettes"),
      dbPath: join(dir, "notary.sqlite"),
      llm: createFixtureLlm(),
      manifestPath,
      queuePath: SEEDED_QUEUE_PATH,
      sleep: async () => {},
      recordReplay: false,
      runId: "vp-notarize-reexam",
      review: async () => {
        reviews += 1;
        return { review: { verdict: "downgrade", reason: "test: always downgrade. Untested alternative: none named", model: "test" } };
      },
    });
    expect(res.bundlePath).toBeDefined();
    const events = res.beliefs!.events;
    const byBelief = new Map<string, number>();
    for (const e of events.filter((x) => x.reason.startsWith("adversary downgrade"))) byBelief.set(e.beliefId, (byBelief.get(e.beliefId) ?? 0) + 1);
    expect(byBelief.size).toBeGreaterThan(0);
    for (const n of byBelief.values()) expect(n).toBeLessThanOrEqual(2);
    expect(reviews).toBe([...byBelief.values()].reduce((a, b) => a + b, 0));
    // one round, shared per-run cap (30): it reaches as many downgraded claims as the cap allows
    const reIds = res.loop!.reexamined!.claims.map((c) => beliefIdFor(c));
    expect(reIds.length).toBeGreaterThan(0);
    for (const id of reIds) expect(byBelief.has(id)).toBe(true);
    expect(res.loop!.probes.length).toBeLessThanOrEqual(30);
    for (const id of byBelief.keys()) {
      const b = res.beliefs!.after.find((x) => x.id === id)!;
      expect(b.status).toBe("abstained");
      expect(events.filter((e) => e.beliefId === id).at(-1)!.reason).toContain("re-examined after downgrade");
    }
  }, 60_000);
});

describe("after an adversary downgrade, only NEW confirmed independent evidence re-promotes (A-01 class)", () => {
  it("uninformative / inconclusive / invalid probes and replicated fingerprints never return it to candidate", () => {
    const db = new NotaryDb(":memory:");
    dbs.push(db);
    const store = new BeliefStore(db);
    const claimId = "dodo.payments.page-size-max-100";
    const id = beliefIdFor(claimId);
    store.ensure(claimById(claimId)!);
    const v: Hypothesis = { id: "h-v", anomalyId: "a", class: "silent_truncation", statement: "s", distinguishingTest: "boundary_sweep" };
    const hyps = new Map([[v.id, v]]);
    const probe = (pid: string, variant: number, verdict: "confirmed" | "uninformative" | "inconclusive" | "invalid") => {
      const p = fakeProbe(pid, claimId, { params: { variant }, verdict, ...(verdict === "confirmed" ? { winningHypothesisId: "h-v" } : {}) });
      return store.applyProbe(id, p, { verdict, ...(verdict === "confirmed" ? { winningHypothesisId: "h-v" } : {}), reason: "test" }, hyps).belief;
    };
    for (const k of [0, 1, 2]) probe(`p${k}`, k, "confirmed");
    expect(store.get(id)!.status).toBe("candidate");
    store.applyAdversary(id, { verdict: "downgrade", reason: "test downgrade", model: "test" });
    expect(probe("pu", 5, "uninformative").status).toBe("hypothesis");
    expect(probe("pi", 6, "inconclusive").status).toBe("hypothesis");
    expect(probe("pv", 7, "invalid").status).toBe("hypothesis");
    // a confirmed replicate of a design cited before the downgrade adds no independence
    expect(probe("pr", 1, "confirmed").status).toBe("hypothesis");
    // a NEW confirmed, independent probe on that side may re-promote it
    expect(probe("pn", 8, "confirmed").status).toBe("candidate");
  });
});
