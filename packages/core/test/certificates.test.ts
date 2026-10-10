// Certificates (`notary export --certificates`). Every bundle here is TEST DATA built in this file
// with finalizeBundle (or from the REAL BeliefStore driven by test doubles); none of it is a result.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BeliefStore, beliefIdFor } from "../src/beliefs/store.js";
import { finalizeBundle } from "../src/bundle/index.js";
import {
  FIXTURE_CERT_DISCLOSURE,
  ToolCertificatesSchema,
  CertificateReportSchema,
  buildCertificates,
  buildReport,
  buildToolCertificates,
  countsFor,
  renderReportMd,
  verifyCertificate,
  verifyRevocation,
  writeCertificates,
} from "../src/certify/index.js";
import { certificateId } from "../src/certify/ledger.js";
import { allContracts, claimById } from "../src/contracts/index.js";
import { FIXTURE_DISCLOSURE } from "../src/demo/index.js";
import { compileGuards } from "../src/guards/compiler.js";
import { GuardRegistry, wireRetirement } from "../src/guards/registry.js";
import type { Belief, BeliefEvent, Claim, Guard, Hypothesis, Probe, RunBundle } from "../src/schema/index.js";
import { NotaryDb } from "../src/store/db.js";
import { T0, fakeProbe, notarize, unlearn } from "./fakes.js";

const ZERO = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
const TEST = "TEST bundle built in test/certificates.test.ts — not a Notary result";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "notary-cert-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Over = Partial<Omit<RunBundle, "contentHash">>;

function testBundle(runId: string, over: Over): RunBundle {
  return finalizeBundle({
    runId,
    kind: "notarize",
    variant: "notarize",
    mode: "live",
    sample: false,
    disclosure: [TEST],
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: "2026-10-11T10:05:00.000Z",
    status: "completed",
    seed: 0,
    tool: "dodo",
    queue: [],
    decisions: [],
    claims: [],
    anomalies: [],
    hypotheses: [],
    probes: [],
    beliefs: { before: [], after: [] },
    beliefEvents: [],
    guards: [],
    usageByRole: { executor: ZERO, reflector: ZERO, adversary: ZERO },
    credits: { byEndpoint: {}, total: 0, budget: 0 },
    metrics: {},
    traceLinks: {},
    cassettes: [],
    ...over,
  });
}

const claim = (id: string): Claim => claimById(id)!;
const UNIT = claim("dodo.refund.amount-minor-units");
const PAGE = claim("dodo.refunds.page-size-max-100");
const WALLET = claim("dodo.wallet.credit-amount-minor-units");
const PAY_PAGE = claim("dodo.payments.page-size-max-100");
const RETRY = claim("dodo.refund.full-retry-no-duplicate");
const CANDIDATE = claim("dodo.subscription.change-plan-pending-409");
const UNTESTED = claim("dodo.customer.missing-email-422");
const NEVER = claim("dodo.product.price-minor-units");
const CLAIMS = [UNIT, PAGE, WALLET, PAY_PAGE, RETRY, CANDIDATE, UNTESTED, NEVER];

const H: Hypothesis[] = [
  { id: "h-ok", anomalyId: "an-1", class: "honored", statement: "test", distinguishingTest: "unit_roundtrip" },
  { id: "h-unit", anomalyId: "an-1", class: "unit_mismatch", statement: "test", distinguishingTest: "unit_roundtrip" },
  { id: "h-trunc", anomalyId: "an-1", class: "silent_truncation", statement: "test", distinguishingTest: "boundary_sweep" },
];

function unitProbe(id: string, c: Claim, sent: number, ratio: number, opts: { currency?: string; variant?: number } = {}): Probe {
  const write =
    c.id === WALLET.id
      ? { op: "dodo.createWalletLedgerEntry", params: { customer_id: "cus_t", amount: sent, currency: opts.currency ?? "USD", entry_type: "credit" } }
      : { op: "dodo.createRefund", params: { payment_id: "pay_t", items: [{ item_id: "prod_t", amount: sent }] } };
  return fakeProbe(id, c.id, {
    template: "unit_roundtrip",
    hypothesisIds: ["h-ok", "h-unit"],
    params: { steps: [{ op: "dodo.getPayment", params: {}, setup: true }, write], ...(opts.variant ? { variant: opts.variant } : {}) },
    control: { params: { steps: [{ ...write, params: { ...write.params, amount: 150 } }] } },
    ranAt: "2026-10-11T10:01:00.000Z",
    observed: { outcome: ratio === 1 ? "equal" : "x100", status: 200, sent, echoed: sent * ratio, ratio, reason: "test" },
    verdict: "confirmed",
    winningHypothesisId: ratio === 1 ? "h-ok" : "h-unit",
  });
}

function pageProbe(id: string, size: number): Probe {
  return fakeProbe(id, PAGE.id, {
    template: "pagination_completeness",
    params: { steps: [0, 1, 2].map((n) => ({ op: "dodo.listRefunds", params: { page_size: size, page_number: n } })) },
    control: { params: { steps: [{ op: "dodo.listRefunds", params: { page_size: size * 3, page_number: 0 } }] }, observed: { count: size * 3 } },
    observed: { outcome: "same_set", walked: size * 3, unique: size * 3, reason: "test" },
    verdict: "confirmed",
    winningHypothesisId: "h-ok",
  });
}

const at = (m: number): string => `2026-10-11T10:0${Math.floor(m / 10)}:${String((m % 10) * 5).padStart(2, "0")}.000Z`;

function ev(beliefId: string, m: number, from: BeliefEvent["from"], to: BeliefEvent["to"], alpha: number, beta: number, confidence: number, reason: string, probeId?: string): BeliefEvent {
  return { beliefId, at: at(m), from, to, alpha, beta, confidence, reason, ...(probeId ? { probeId } : {}) };
}

function belief(c: Claim, over: Partial<Belief>): Belief {
  return {
    id: beliefIdFor(c.id),
    claimId: c.id,
    tool: c.tool,
    statement: `test statement for ${c.id}`,
    alpha: 1,
    beta: 1,
    confidence: 0.5,
    status: "hypothesis",
    evidence: [],
    updatedAt: "2026-10-11T10:04:00.000Z",
    ...over,
  };
}

const evOf = (p: Probe) => ({ probeId: p.id, traceId: p.traceId, spanId: p.spanId!, valid: true });

/** A notarize bundle: unit violated (uphold), page honored (uphold), wallet violated (narrow USD), payments page downgraded+abstained, retry candidate unreviewed, … */
function mainBundle(): RunBundle {
  const unitPs = [unitProbe("u1", UNIT, 100, 100), unitProbe("u2", UNIT, 120, 100, { variant: 1 }), unitProbe("u3", UNIT, 130, 100, { variant: 2 })];
  const pagePs = [pageProbe("g1", 10), pageProbe("g2", 5), pageProbe("g3", 15)];
  const walletPs = [unitProbe("w1", WALLET, 1234, 100), unitProbe("w2", WALLET, 3517, 1, { variant: 1 }), unitProbe("w3", WALLET, 4321, 100, { variant: 2 }), unitProbe("w4", WALLET, 5678, 100, { variant: 3 })];
  const payP = fakeProbe("pp1", PAY_PAGE.id, {
    template: "boundary_sweep",
    params: { steps: [{ op: "dodo.listPayments", params: { page_size: 101 } }] },
    control: { params: { steps: [{ op: "dodo.listPayments", params: { page_size: 1 } }] } },
    observed: { outcome: "clamped", over: { status: 200, length: 100 } },
    verdict: "confirmed",
    winningHypothesisId: "h-trunc",
  });
  const adv = { reason: "probes are clean", model: "test-model", backend: "bedrock" as const };
  const bU = beliefIdFor(UNIT.id);
  const bP = beliefIdFor(PAGE.id);
  const bW = beliefIdFor(WALLET.id);
  const bPP = beliefIdFor(PAY_PAGE.id);
  const bR = beliefIdFor(RETRY.id);
  return testBundle("notarize-dodo-1", {
    claims: CLAIMS.filter((c) => c.id !== UNTESTED.id),
    hypotheses: H,
    probes: [...unitPs, ...pagePs, ...walletPs, payP],
    traceLinks: { "trace-u1": "https://trace.example/u1" },
    beliefs: {
      before: [],
      after: [
        belief(UNIT, { class: "unit_mismatch", alpha: 1, beta: 4, confidence: 0.0625, status: "notarized", evidence: unitPs.map(evOf), adversary: { verdict: "uphold", ...adv } }),
        belief(PAGE, { class: "honored", alpha: 4, beta: 1, confidence: 0.9375, status: "notarized", evidence: pagePs.map(evOf), adversary: { verdict: "uphold", ...adv } }),
        belief(WALLET, {
          class: "unit_mismatch",
          alpha: 2,
          beta: 4,
          confidence: 0.1875,
          status: "notarized",
          evidence: walletPs.map(evOf),
          adversary: { verdict: "narrow", ...adv, reason: "only USD probed", scope: "USD only" },
        }),
        belief(PAY_PAGE, {
          class: "silent_truncation",
          alpha: 1,
          beta: 4,
          confidence: 0.0625,
          status: "abstained",
          evidence: [evOf(payP)],
          adversary: { verdict: "downgrade", ...adv, reason: "boundary sweep cannot tell clamping from a short data set" },
        }),
        belief(RETRY, { class: "idempotency_hazard", alpha: 1, beta: 4, confidence: 0.0625, status: "candidate", evidence: [] }),
        belief(NEVER, {}),
      ],
    },
    beliefEvents: [
      ev(bU, 1, null, "hypothesis", 1, 1, 0.5, "created at Beta(1, 1)"),
      ev(bU, 2, "hypothesis", "hypothesis", 1, 2, 0.25, "confirmed unit_mismatch (h-unit): β+1", "u1"),
      ev(bU, 3, "hypothesis", "hypothesis", 1, 3, 0.125, "confirmed unit_mismatch (h-unit): β+1", "u2"),
      ev(bU, 4, "hypothesis", "candidate", 1, 4, 0.0625, "confirmed unit_mismatch (h-unit): β+1; candidate", "u3"),
      ev(bU, 5, "candidate", "notarized", 1, 4, 0.0625, "adversary uphold (bedrock, test-model): probes are clean"),
      ev(bP, 6, "candidate", "notarized", 4, 1, 0.9375, "adversary uphold (bedrock, test-model): probes are clean"),
      ev(bW, 7, "candidate", "notarized", 2, 4, 0.1875, "adversary narrow (bedrock, test-model): only USD probed [scope: USD only]"),
      ev(bPP, 8, "candidate", "hypothesis", 1, 4, 0.0625, "adversary downgrade (bedrock, test-model): boundary sweep cannot tell clamping from a short data set"),
      ev(bPP, 9, "hypothesis", "abstained", 1, 4, 0.0625, "abstain: no further independent probe design between thresholds; P(holds)=0.0625"),
      ev(bR, 10, "hypothesis", "candidate", 1, 4, 0.0625, "confirmed idempotency_hazard: candidate"),
    ],
  });
}

/** A later bundle where the unit belief is pushed back over 0.5 (notarized → unlearned) and its guard retired. */
function driftBundle(base: RunBundle): RunBundle {
  const back = [0, 1, 2, 3, 4].map((k) => unitProbe(`back${k}`, UNIT, 200 + k, 1, { variant: 10 + k }));
  const bU = beliefIdFor(UNIT.id);
  const prevUnit = base.beliefs.after.find((b) => b.id === bU)!;
  const guard: Guard = {
    id: "grd-unit",
    beliefId: bU,
    operation: UNIT.operation,
    kind: "transform",
    class: "unit_mismatch",
    rule: { param: UNIT.param, factor: 0.01 },
    reason: "test",
    active: false,
    compiledAt: at(5),
    retiredAt: "2026-10-12T10:00:30.000Z",
  };
  const t = (s: number) => `2026-10-12T10:00:${String(s).padStart(2, "0")}.000Z`;
  return testBundle("notarize-dodo-2", {
    startedAt: "2026-10-12T10:00:00.000Z",
    finishedAt: "2026-10-12T10:01:00.000Z",
    claims: [UNIT],
    hypotheses: H,
    probes: back,
    guards: [guard],
    beliefs: {
      before: [prevUnit],
      after: [{ ...prevUnit, alpha: 6, beta: 4, confidence: 0.623, status: "unlearned", evidence: [...prevUnit.evidence, ...back.map(evOf)] }],
    },
    beliefEvents: [
      { beliefId: bU, at: t(10), from: "notarized", to: "notarized", alpha: 2, beta: 4, confidence: 0.1875, reason: "confirmed honored (h-ok): α+1", probeId: "back0" },
      { beliefId: bU, at: t(15), from: "notarized", to: "notarized", alpha: 3, beta: 4, confidence: 0.34375, reason: "confirmed honored (h-ok): α+1", probeId: "back1" },
      { beliefId: bU, at: t(20), from: "notarized", to: "notarized", alpha: 4, beta: 4, confidence: 0.5, reason: "confirmed honored (h-ok): α+1", probeId: "back2" },
      {
        beliefId: bU,
        at: t(30),
        from: "notarized",
        to: "unlearned",
        alpha: 5,
        beta: 4,
        confidence: 0.63671875,
        reason: "confirmed honored (h-ok): α+1; P(holds)=0.6367 crossed back over 0.5 against the notarized side (violated): unlearned",
        probeId: "back3",
      },
    ],
  });
}

describe("buildCertificates: certificates from verified bundles", () => {
  const set = () => buildCertificates([mainBundle()], { claims: CLAIMS, tools: ["dodo"] });
  const dodo = () => set().tools[0]!;
  const cert = (claimId: string) => dodo().certificates.find((c) => c.claimId === claimId)!;

  it("honored → 'matches docs', with evidence, adversary, α/β and issuedAt from the notarization event", () => {
    const c = cert(PAGE.id);
    expect(c).toMatchObject({
      status: "active",
      side: "honored",
      verdictKind: "matches_docs",
      verdict: "matches docs",
      issuedAt: at(6),
      issuedFrom: "event",
      alpha: 4,
      beta: 1,
      confidence: 0.9375,
      adversary: { verdict: "uphold", model: "test-model", backend: "bedrock" },
      sourceBundle: { runId: "notarize-dodo-1" },
      sample: false,
      disclosure: [],
      docText: PAGE.docText,
      docUrl: PAGE.docUrl,
      claim: { operation: "dodo.listRefunds", param: "page_size", expect: PAGE.expect },
    });
    expect(c.evidence.map((e) => [e.probeId, e.traceId, e.template, e.verdict])).toEqual([
      ["g1", "trace-g1", "pagination_completeness", "confirmed"],
      ["g2", "trace-g2", "pagination_completeness", "confirmed"],
      ["g3", "trace-g3", "pagination_completeness", "confirmed"],
    ]);
    expect(c.scope).toMatchObject({ text: "as probed: dodo.listRefunds; page_size ∈ {5, 10, 15} (3 cited probes)", narrowed: null });
  });

  it("violated → 'contradicts docs: docs say …, observed …' from the expect rule and the cited probes' observations", () => {
    const c = cert(UNIT.id);
    expect(c.side).toBe("violated");
    expect(c.defectClass).toBe("unit_mismatch");
    expect(c.docsSay).toBe("`amount` is in the smallest currency unit (minor units)");
    expect(c.verdict).toBe(
      "contradicts docs: docs say `amount` is in the smallest currency unit (minor units), observed amount echoed ×100 in all 3 cited probes (sent 100 → amount 10000; sent 120 → amount 12000; sent 130 → amount 13000)",
    );
    expect(c.evidence[0]).toMatchObject({ probeId: "u1", traceId: "trace-u1", spanId: "span-u1", traceUrl: "https://trace.example/u1", valid: true });
    expect(c.scope.asProbed).toEqual({ operations: ["dodo.createRefund"], currencies: [], param: "items[].amount", values: ["100", "120", "130"], probes: 3 });
  });

  it("mixed evidence is stated, and an adversary-narrowed scope is carried with its parsed rule scope", () => {
    const c = cert(WALLET.id);
    expect(c.observed).toBe(
      "amount echoed ×100 in 3 of 4 cited probes (sent 1234 → balance 123400; sent 4321 → balance 432100; sent 5678 → balance 567800); other cited probes: amount echoed unchanged in 1 of 4 cited probes (sent 3517 → balance 3517)",
    );
    expect(c.scope.narrowed).toEqual({ text: "USD only", parsed: { currency: ["USD"] } });
    expect(c.scope.asProbed.currencies).toEqual(["USD"]);
    expect(c.scope.text).toMatch(/^as probed: dodo\.createWalletLedgerEntry in USD; amount ∈ \{1234, 3517, 4321, 5678\} \(4 cited probes\); narrowed by the adversary: "USD only" \(machine-checkable: currency USD\)$/);
    expect(c.adversary).toMatchObject({ verdict: "narrow", reason: "only USD probed" });
  });

  it("abstained, downgraded, candidate-without-review, never probed and not tested → noCertificate with reasons", () => {
    const no = new Map(dodo().noCertificates.map((n) => [n.claimId, n]));
    expect([...no.keys()].sort()).toEqual([PAY_PAGE.id, RETRY.id, CANDIDATE.id, UNTESTED.id, NEVER.id].sort());
    expect(no.get(PAY_PAGE.id)).toMatchObject({
      status: "abstained",
      kind: "downgraded",
      reason:
        "adversary downgraded (bedrock, test-model): boundary sweep cannot tell clamping from a short data set; then abstained: no further independent probe design between thresholds; P(holds)=0.0625",
    });
    expect(no.get(RETRY.id)).toMatchObject({ status: "candidate", kind: "candidate_unreviewed" });
    expect(no.get(RETRY.id)!.reason).toMatch(/^candidate without an adversary verdict: /);
    expect(no.get(NEVER.id)).toMatchObject({ status: "hypothesis", kind: "never_probed", reason: "never probed" });
    // CANDIDATE's claim is in the bundle but has no belief; UNTESTED is only in the contract list.
    expect(no.get(CANDIDATE.id)).toMatchObject({ status: "not_tested", kind: "not_tested", reason: "not tested: no belief for this claim in any source bundle" });
    expect(no.get(UNTESTED.id)).toMatchObject({ status: "not_tested", kind: "not_tested" });
    // A plain abstain (no downgrade) keeps its abstain reason.
    const plain = mainBundle();
    const b = finalizeBundle({
      ...plain,
      beliefs: { before: [], after: plain.beliefs.after.map((x) => (x.claimId === PAY_PAGE.id ? { ...x, adversary: undefined } : x)) },
    } as RunBundle);
    const n = buildToolCertificates([b], "dodo", { claims: CLAIMS }).noCertificates.find((x) => x.claimId === PAY_PAGE.id)!;
    expect(n).toMatchObject({ kind: "abstained", reason: "abstained: no further independent probe design between thresholds; P(holds)=0.0625" });
  });

  it("deterministic ids and sha256: rebuilt output is identical; a tampered certificate fails verifyCertificate", () => {
    const a = set();
    const b = set();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = cert(UNIT.id);
    expect(c.id).toBe(certificateId("dodo", UNIT.id, "violated", at(5)));
    expect(c.id).toMatch(/^cert-[0-9a-f]{16}$/);
    for (const x of dodo().certificates) expect(verifyCertificate(JSON.parse(JSON.stringify(x)))).toMatchObject({ ok: true });
    const tampered = { ...c, verdict: "matches docs" };
    expect(verifyCertificate(tampered)).toMatchObject({ ok: false, reason: "sha256" });
    expect(verifyCertificate({ ...c, sha256: "nope" })).toMatchObject({ ok: false, reason: "schema" });
    expect(ToolCertificatesSchema.safeParse(dodo()).success).toBe(true);
  });

  it("refuses to mix fixture and real bundles in one build", () => {
    const fx = finalizeBundle({ ...mainBundle(), sample: true } as RunBundle);
    expect(() => buildCertificates([mainBundle(), fx])).toThrow(/sample\/fixture bundle/);
    expect(() => buildCertificates([mainBundle()], { fixture: true })).toThrow(/real bundle/);
    const f = buildCertificates([fx], { fixture: true, claims: CLAIMS, tools: ["dodo"] }).tools[0]!;
    expect(f.sample).toBe(true);
    expect(f.disclosure).toEqual([FIXTURE_CERT_DISCLOSURE]);
    for (const c of f.certificates) expect(c).toMatchObject({ sample: true, disclosure: [FIXTURE_CERT_DISCLOSURE] });
    for (const n of f.noCertificates) expect(n.sample).toBe(true);
  });
});

describe("revocations: notarized → unlearned in a later bundle", () => {
  const build = () => {
    const base = mainBundle();
    return buildToolCertificates([driftBundle(base), base], "dodo", { claims: CLAIMS });
  };

  it("revokes the certificate (same deterministic id), with trigger probes/traces and retired guards", () => {
    const t = build();
    expect(t.sourceBundles.map((s) => s.runId)).toEqual(["notarize-dodo-1", "notarize-dodo-2"]);
    const c = t.certificates.find((x) => x.claimId === UNIT.id)!;
    expect(t.revocations).toHaveLength(1);
    const r = t.revocations[0]!;
    expect(r).toMatchObject({
      certificateId: c.id,
      tool: "dodo",
      claimId: UNIT.id,
      from: "notarized",
      to: "unlearned",
      revokedAt: "2026-10-12T10:00:30.000Z",
      triggerProbeIds: ["back3", "back0", "back1", "back2"],
      triggerTraceIds: ["trace-back3", "trace-back0", "trace-back1", "trace-back2"],
      guardsRetired: [{ id: "grd-unit", kind: "transform", operation: UNIT.operation, retiredAt: "2026-10-12T10:00:30.000Z" }],
      sourceBundle: { runId: "notarize-dodo-2" },
    });
    expect(r.reason).toMatch(/crossed back over 0.5 against the notarized side \(violated\): unlearned/);
    expect(c).toMatchObject({ status: "revoked", revocation: { id: r.id, revokedAt: r.revokedAt }, issuedAt: at(5) });
    // Evidence is what was cited at issuance, not the later contrary probes.
    expect(c.evidence.map((e) => e.probeId)).toEqual(["u1", "u2", "u3"]);
    expect(verifyCertificate(c).ok).toBe(true);
    expect(verifyRevocation(r).ok).toBe(true);
    expect(verifyRevocation({ ...r, triggerProbeIds: [] }).ok).toBe(false);
    expect(t.noCertificates.find((n) => n.claimId === UNIT.id)).toMatchObject({ status: "unlearned", kind: "revoked" });
    // Input order does not matter.
    const base = mainBundle();
    expect(JSON.stringify(buildToolCertificates([base, driftBundle(base)], "dodo", { claims: CLAIMS }))).toBe(JSON.stringify(t));
  });

  it("REAL BeliefStore: the unlearn event records the triggering probe and onUnlearn retires the guard; both flow into the revocation", () => {
    const now = () => new Date(T0);
    const db = new NotaryDb(":memory:");
    const store = new BeliefStore(db, { now });
    const reg = new GuardRegistry(db, { now });
    wireRetirement(store, reg);
    const id = "dodo.refund.full-retry-no-duplicate";
    notarize(store, id, "idempotency_hazard");
    reg.sync(compileGuards({ beliefs: store.list(), claimFor: claimById, probes: [], now }));
    const active = reg.all().filter((g) => g.active);
    expect(active.length).toBeGreaterThan(0);
    expect(unlearn(store, id).status).toBe("unlearned");

    const events = store.events(beliefIdFor(id));
    const unlearnEvent = events.find((e) => e.to === "unlearned")!;
    expect(unlearnEvent.probeId).toMatch(/^p-dodo\.refund\.full-retry-no-duplicate-back-\d$/);
    expect(reg.all().every((g) => !g.active && g.retiredAt === T0)).toBe(true);

    const hyps: Hypothesis[] = [
      { id: "h-v", anomalyId: "an-1", class: "idempotency_hazard", statement: "t", distinguishingTest: "boundary_sweep" },
      { id: "h-ok", anomalyId: "an-1", class: "honored", statement: "t", distinguishingTest: "boundary_sweep" },
    ];
    const probeIds = events.flatMap((e) => (e.probeId ? [e.probeId] : []));
    const probes = [...new Set(probeIds)].map((pid) =>
      fakeProbe(pid, id, { verdict: "confirmed", winningHypothesisId: pid.includes("-back-") ? "h-ok" : "h-v", params: { variant: Number(pid.split("-").pop()) } }),
    );
    const bundle = testBundle("store-run", { claims: [claimById(id)!], hypotheses: hyps, probes, beliefs: { before: [], after: store.list() }, beliefEvents: events, guards: reg.all() });
    const t = buildToolCertificates([bundle], "dodo", { claims: [claimById(id)!] });
    expect(t.certificates).toHaveLength(1);
    expect(t.certificates[0]).toMatchObject({ status: "revoked", side: "violated" });
    const r = t.revocations[0]!;
    expect(r.triggerProbeIds[0]).toBe(unlearnEvent.probeId);
    expect(r.triggerTraceIds[0]).toBe(`trace-${unlearnEvent.probeId}`);
    expect(r.guardsRetired.map((g) => g.id).sort()).toEqual(reg.all().map((g) => g.id).sort());
    db.close();
  });
});

describe("report", () => {
  it("counts per tool and overall from the certificates (no hand-typed numbers)", () => {
    const base = mainBundle();
    const set = buildCertificates([base, driftBundle(base)], { claims: CLAIMS, tools: ["dodo"] });
    const counts = countsFor(set.tools[0]!);
    // 8 claims; active: page (matches), wallet (contradicts); unit revoked → unproven.
    expect(counts).toEqual({ claimsTotal: 8, certified: 2, matchesDocs: 1, contradictsDocs: 1, unproven: 6, revoked: 1 });
    const report = buildReport(set, { "dodo.json": "a".repeat(64) }, (t) => `${t}.json`);
    expect(CertificateReportSchema.safeParse(report).success).toBe(true);
    expect(report.overall).toEqual(counts);
    expect(report.header).toMatch(/^Generated by `pnpm notary export --certificates` from 2 hash-verified real bundle\(s\)/);
    const md = renderReportMd(report, set);
    expect(md).toContain("| Dodo Payments (test mode) | 8 | 2 | 1 | 1 | 6 | 1 |");
    expect(md).toContain("**REVOKED**");
    expect(md).toContain("`grd-unit` (transform");
    expect(md).toContain("`notarize-dodo-1`");
  });
});

describe("writeCertificates (notary export --certificates)", () => {
  function layout(): { runs: string; demo: string; web: string; exp: string } {
    const root = tempDir();
    const runs = join(root, "runs");
    const demo = join(runs, "demo");
    const real = mainBundle();
    mkdirSync(join(runs, real.runId), { recursive: true });
    writeFileSync(join(runs, real.runId, `${real.runId}.json`), JSON.stringify(real));
    // A sample bundle next to it must be excluded from the real export.
    const sample = finalizeBundle({ ...mainBundle(), runId: "sample-x", sample: true } as RunBundle);
    mkdirSync(join(runs, "sample-x"), { recursive: true });
    writeFileSync(join(runs, "sample-x", "sample-x.json"), JSON.stringify(sample));
    const fx = finalizeBundle({ ...mainBundle(), runId: "demo-notarize-dodo", sample: true, disclosure: [FIXTURE_DISCLOSURE] } as RunBundle);
    mkdirSync(join(demo, fx.runId), { recursive: true });
    writeFileSync(join(demo, fx.runId, `${fx.runId}.json`), JSON.stringify(fx));
    writeFileSync(join(demo, fx.runId, "index.json"), "[]");
    return { runs, demo, web: join(root, "web", "certificates"), exp: join(root, "export") };
  }

  it("real and fixture outputs never mix; REPORT.md is written only from real data", async () => {
    const p = layout();
    const real = await writeCertificates({ runsDir: p.runs, webDir: p.web, exportDir: p.exp });
    expect(real.bundles.map((b) => b.runId)).toEqual(["notarize-dodo-1"]);
    const dodo = ToolCertificatesSchema.parse(JSON.parse(readFileSync(join(p.web, "dodo.json"), "utf8")));
    expect(dodo.sample).toBe(false);
    expect(dodo.certificates.every((c) => !c.sample)).toBe(true);
    expect(existsSync(join(p.web, "crustdata.json"))).toBe(true);
    const report = CertificateReportSchema.parse(JSON.parse(readFileSync(join(p.web, "report.json"), "utf8")));
    expect(report.sample).toBe(false);
    expect(existsSync(join(p.exp, "REPORT.md"))).toBe(true);
    expect(existsSync(join(p.exp, "REPORT.fixture.md"))).toBe(false);
    const realMd = readFileSync(join(p.exp, "REPORT.md"), "utf8");

    const fx = await writeCertificates({ fixture: true, runsDir: p.demo, webDir: p.web, exportDir: p.exp });
    expect(fx.bundles.map((b) => b.runId)).toEqual(["demo-notarize-dodo"]);
    const f = ToolCertificatesSchema.parse(JSON.parse(readFileSync(join(p.web, "fixture", "dodo.json"), "utf8")));
    expect(f).toMatchObject({ sample: true, disclosure: [FIXTURE_CERT_DISCLOSURE], generatedBy: "pnpm notary export --certificates --fixture" });
    expect(f.certificates.length).toBeGreaterThan(0);
    for (const c of f.certificates) expect(c).toMatchObject({ sample: true, disclosure: [FIXTURE_CERT_DISCLOSURE], sourceBundle: { runId: "demo-notarize-dodo" } });
    const fr = CertificateReportSchema.parse(JSON.parse(readFileSync(join(p.web, "fixture", "report.json"), "utf8")));
    expect(fr.sample).toBe(true);
    expect(fr.header).toMatch(/^FIXTURE — simulated APIs and models, not a live run\./);
    // The fixture export touched neither the real JSON nor REPORT.md.
    expect(readFileSync(join(p.exp, "REPORT.md"), "utf8")).toBe(realMd);
    expect(JSON.parse(readFileSync(join(p.web, "dodo.json"), "utf8"))).toEqual(dodo);
    expect(readFileSync(join(p.exp, "REPORT.fixture.md"), "utf8")).toMatch(/^# Notary certificates — FIXTURE/);

    await expect(writeCertificates({ runsDir: p.runs, webDir: join(p.web, "fixture"), exportDir: p.exp })).rejects.toThrow(/fixture directory/);
  });

  it("0 real bundles: honest files, every claim not tested, counts zero, 'no real runs yet'", async () => {
    const root = tempDir();
    const web = join(root, "certificates");
    const exp = join(root, "export");
    const res = await writeCertificates({ runsDir: join(root, "no-runs"), webDir: web, exportDir: exp });
    const total = allContracts.length;
    expect(res.report.overall).toEqual({ claimsTotal: total, certified: 0, matchesDocs: 0, contradictsDocs: 0, unproven: total, revoked: 0 });
    expect(res.report.header).toMatch(/^No real runs yet/);
    for (const tool of ["crustdata", "dodo"] as const) {
      const t = ToolCertificatesSchema.parse(JSON.parse(readFileSync(join(web, `${tool}.json`), "utf8")));
      expect(t.header).toMatch(/^no real runs yet/);
      expect(t.certificates).toEqual([]);
      expect(t.revocations).toEqual([]);
      expect(t.noCertificates.length).toBe(allContracts.filter((e) => e.claim.tool === tool).length);
      expect(t.noCertificates.every((n) => n.kind === "not_tested" && n.reason === "not tested: no runs yet")).toBe(true);
    }
    expect(readFileSync(join(exp, "REPORT.md"), "utf8")).toContain("None: no real runs yet");
  });
});
