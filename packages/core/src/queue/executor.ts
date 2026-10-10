/**
 * Queue executor (TDD "Queue execution and guards", PRD Flow A).
 *
 * `naive` is the run-1 baseline: a doc-trusting agent with no gating and no guards. It does what a
 * reasonable integrator who believes the docs would do — nothing deliberately broken:
 * - enriches each company once per run via Crustdata (cached per domain) and tiers it;
 * - decides with the plain-code policy table;
 * - before a refund, reads ONE page (page_size 100, the documented max) of the customer's refunds
 *   and payments and treats it as complete; if the payment isn't on that page, or a partial refund
 *   needs its line items, it reads the payment by id and honours its `refunds[]` too;
 * - sends amounts as the minor-unit integers from the request (the docs say smallest unit);
 * - retries a write once after a timeout or a 5xx (the docs give no warning against it);
 * - uses the documented `idempotency_key` on wallet credits.
 *
 * A request noted "client-timeout-then-retry" simulates a client that gives up waiting: its first
 * write races a short AbortSignal.timeout. Only if the real request is still in flight when the
 * timer fires does the client treat it as timed out and retry; the abandoned request is still
 * awaited so its exchange is recorded. If it finished first, a note says no timeout occurred.
 * In replay the same rule is applied to the recorded latency of that exchange.
 *
 * `guarded` (P6) is the same agent made safe; its tools are built with createTools({wrap: guarded()}),
 * so every call already passes through the active guards. On top of that it:
 * - reads ALL pages (to an empty page) of the customer's refunds and payments, plus the payment
 *   itself, before a refund; an incomplete listing holds the item (no existing refund provable);
 * - asks `gate` before every irreversible action: any required belief not notarized -> held, with an
 *   evidence pack (missing beliefs, related probes, span ids, trace receipts); escalations and every
 *   other hold get an evidence pack too;
 * - runs each item inside a guard context, so the guards that fired land on Decision.guardsApplied and
 *   the guards' own reads on Decision.effects;
 * - persists the pending write (op, params, pre-write snapshot) BEFORE sending it (`runState`);
 * - never retries a write blindly: on timeout/5xx it reads back (src/guards/readback.ts) and retries
 *   once only when the read-back proves the write did not land; a guard refusal holds the item;
 * - sends plan changes with an explicit `effective_at: "immediately"` (no reliance on defaults);
 * - before a write an active transform guard would rewrite, asks the re-verification `sentinel`
 *   (src/queue/sentinel.ts, DECISIONS #105) to re-run that belief's experiment on probe-only
 *   resources; a belief that un-learns (or is contradicted, or can't be re-verified) holds the item,
 *   with the gate re-asked so the evidence pack names the revoked belief;
 * - on `resume`, keeps done items, reads back an item left in flight with a recorded write before
 *   doing anything else, and processes the rest normally.
 */
import { GuardBlockedError, UnknownWriteOutcomeError } from "../guards/errors.js";
import { isReadBackResult, isUnknownOutcome } from "../guards/guarded.js";
import { withGuardContext } from "../guards/context.js";
import { ledgerEntries, listAll, readBack } from "../guards/readback.js";
import type { OnRead, PendingWrite, ReadFns } from "../guards/readback.js";
import type { CompanyData, CrustdataTools, DodoTools, Exchange, PaymentListItem, RecorderMode, RefundListItem, ToolResult } from "../tools/index.js";
import { BudgetExceededError, CassetteMissError, TestModeLockError, ToolHttpError, ToolNetworkError, isBlocked } from "../tools/index.js";
import type {
  Decision,
  DecisionStatus,
  Effect,
  PolicyOutcome,
  QueueRequest,
  Tier,
} from "../schema/index.js";
import { withSpan } from "../trace/index.js";
import { isRef, resolveRef } from "./manifest.js";
import type { SeedManifest } from "./manifest.js";
import { decidePolicy, tierFromCompany } from "./policy.js";
import type { PolicyAction, PolicyDecision, PolicyInput } from "./policy.js";
import type { SentinelHook } from "./sentinel.js";

// ---------------------------------------------------------------------------------------------
// Types

export type { PolicyAction, PolicyDecision, PolicyInput };

/** The two policy functions (injectable so tests can pin the policy). */
export interface PolicyFns {
  tierFromCompany(company: CompanyData | null): { tier: Tier; basis: string };
  decidePolicy(input: PolicyInput): PolicyDecision;
}

/** The slice of `Tools` the executor uses (a real `Tools` satisfies it). */
export interface QueueTools {
  crustdata: Pick<CrustdataTools, "enrichCompany">;
  dodo: Pick<
    DodoTools,
    | "listRefunds"
    | "listPayments"
    | "getPayment"
    | "createRefund"
    | "getSubscription"
    | "changeSubscriptionPlan"
    | "createWalletLedgerEntry"
    | "listWalletLedgerEntries"
  >;
  recorder?: { readonly mode: RecorderMode; exchanges(): Exchange[] };
}

/** What the guarded variant asks before a write (src/queue/gate.ts implements it). */
export interface GateContext {
  request: QueueRequest;
  tier: Tier;
  policy: PolicyDecision;
  /** The payment's total, when known (full vs partial refund). */
  paymentAmount?: number;
  /** Asked for an escalation's evidence pack: describe the request type's action, allow is ignored. */
  forEscalation?: boolean;
}
export interface GateVerdict {
  allow: boolean;
  missingBeliefs: string[];
  requiredBeliefs: string[];
  reason?: string;
  evidence?: { relatedProbeIds: string[]; spanIds: string[]; traceLinks: Record<string, string> };
}
export type GateHook = (ctx: GateContext) => Promise<GateVerdict>;

/** Per-item run-state persistence (src/queue/run-state.ts implements it). */
export interface RunStateHooks {
  start(requestId: string): void;
  /** Called BEFORE the write is sent, with the draft decision as of that moment. */
  beforeWrite(requestId: string, write: PendingWrite, draft: Decision): void;
  done(requestId: string, decision: Decision): void;
}

/** Saved state of one item of the run being resumed. */
export interface ResumeEntry {
  state: "pending" | "in_flight" | "done";
  decision?: Decision;
  lastWrite?: PendingWrite;
}

export interface ExecuteQueueOptions {
  queue: QueueRequest[];
  manifest: SeedManifest;
  tools: QueueTools;
  variant: "naive" | "guarded";
  gate?: GateHook;
  onDecision?: (d: Decision) => void;
  /** Default: the policy table in ./policy.ts. */
  policy?: PolicyFns;
  /** Map a "cust:/pay:/sub:/prod:" ref to a real id. Default: resolveRef against the manifest. */
  resolve?: (ref: string) => string;
  /** Used in idempotency keys and decision ids. */
  runId?: string;
  /** Client-side timeout for the first write of a "client-timeout-then-retry" item. */
  clientTimeoutMs?: number;
  now?: () => Date;
  /** Guarded: persist per-item state (crash recovery). */
  runState?: RunStateHooks;
  /** Guarded: state of the run being resumed, by request id. */
  resume?: ReadonlyMap<string, ResumeEntry>;
  /** Guarded: re-verification sentinel asked before each write (src/queue/sentinel.ts). */
  sentinel?: SentinelHook;
}

export interface ExecuteQueueResult {
  decisions: Decision[];
  /** Request ids never processed (budget stop). */
  notProcessed: string[];
  /** Resume: request ids whose decision was carried over from before the crash. */
  resumedDone?: string[];
  stopReason?: string;
  /** Human-readable facts for the bundle disclosure (e.g. whether a client timeout fired). */
  notes: string[];
}

export const CLIENT_TIMEOUT_NOTE = "client-timeout-then-retry";
export const DEFAULT_CLIENT_TIMEOUT_MS = 200;
/** Documented maximum page size for Dodo list endpoints. */
export const DOC_MAX_PAGE_SIZE = 100;
export const ENRICH_FIELDS = ["basic_info", "headcount", "funding"] as const;

// ---------------------------------------------------------------------------------------------
// Helpers

export function defaultResolver(manifest: SeedManifest): (ref: string) => string {
  return (ref) => (isRef(ref) ? resolveRef(manifest, ref) : ref);
}

/** targetPlan → product id: a "prod:" ref, a manifest product key/handle/plan/name, or a raw id. */
export function resolveProduct(manifest: SeedManifest, resolve: (ref: string) => string, target: string): string {
  if (isRef(target)) return resolve(target);
  return manifest.products[target]?.productId ?? target;
}

function errStatus(err: unknown): number | null {
  return err instanceof ToolHttpError ? err.status : null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Errors that must stop the whole run rather than become a held decision. */
function isFatal(err: unknown): boolean {
  return (
    isBlocked(err) ||
    err instanceof TestModeLockError ||
    err instanceof CassetteMissError ||
    err instanceof BudgetExceededError ||
    (err instanceof Error && err.message.startsWith("BLOCKED:"))
  );
}

function firstCompany(data: unknown): CompanyData | null {
  if (!Array.isArray(data)) return null;
  const match = (data[0] as { matches?: Array<{ company_data?: CompanyData }> } | undefined)?.matches?.[0];
  return match?.company_data ?? null;
}

function enrichmentFields(company: CompanyData | null): Record<string, unknown> {
  if (!company) return { matched: false };
  return {
    matched: true,
    crustdataCompanyId: company.crustdata_company_id ?? null,
    name: company.basic_info?.name ?? null,
    primaryDomain: company.basic_info?.primary_domain ?? null,
    employeeCountRange: company.basic_info?.employee_count_range ?? null,
    headcountTotal: company.headcount?.total ?? null,
    numEmployeesMin: company.market_intel?.num_employees_min ?? null,
    numEmployeesMax: company.market_intel?.num_employees_max ?? null,
    fundingTotalUsd: company.funding?.total_investment_usd ?? null,
    lastRoundType: company.funding?.last_round_type ?? null,
    lastFundraiseDate: company.funding?.last_fundraise_date ?? null,
  };
}

/** An answer from a tool or the guard layer (as opposed to a crash of the agent itself). */
function isToolOrGuardError(err: unknown): boolean {
  return (
    err instanceof ToolHttpError ||
    err instanceof ToolNetworkError ||
    err instanceof GuardBlockedError ||
    err instanceof UnknownWriteOutcomeError
  );
}

/** The minor-unit amount a pending write moves, when it states one. */
function writeAmount(w: PendingWrite): number | undefined {
  if (w.op === "dodo.createWalletLedgerEntry") return w.amount;
  if (w.op === "dodo.createRefund") {
    if (w.amount !== undefined) return w.amount;
    const items = w.params.items as Array<{ amount?: unknown }> | undefined;
    const a = items?.[0]?.amount;
    return typeof a === "number" ? a : undefined;
  }
  return undefined;
}

type Enriched = { company: CompanyData | null; error?: string };

class StopRun extends Error {
  constructor(readonly cause: BudgetExceededError) {
    super(cause.message);
  }
}

// ---------------------------------------------------------------------------------------------
// Executor

export async function executeQueue(opts: ExecuteQueueOptions): Promise<ExecuteQueueResult> {
  const guardedMode = opts.variant === "guarded";
  if (guardedMode && !opts.gate) throw new Error("executeQueue: the guarded variant needs a gate");

  const now = opts.now ?? (() => new Date());
  const policy: PolicyFns = opts.policy ?? { tierFromCompany, decidePolicy };
  const resolve = opts.resolve ?? defaultResolver(opts.manifest);
  const clientTimeoutMs = opts.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
  const runKey = opts.runId ?? "run";
  const { tools } = opts;
  const readFns: ReadFns = {
    getPayment: tools.dodo.getPayment,
    listRefunds: tools.dodo.listRefunds,
    getSubscription: tools.dodo.getSubscription,
    ...(tools.dodo.listWalletLedgerEntries ? { listWalletLedgerEntries: tools.dodo.listWalletLedgerEntries } : {}),
  };

  const enrichCache = new Map<string, Enriched>();
  const decisions: Decision[] = [];
  const notes: string[] = [];
  const resumedDone: string[] = [];
  /** Errors thrown by a write call that are not tool answers (a simulated or real crash). */
  const crashes = new WeakSet<object>();

  for (let i = 0; i < opts.queue.length; i++) {
    const req = opts.queue[i]!;
    const saved = opts.resume?.get(req.id);
    if (saved?.state === "done" && saved.decision) {
      decisions.push(saved.decision);
      resumedDone.push(req.id);
      continue;
    }
    let traceId = "";
    let spanId: string | undefined;
    try {
      const decision = await withSpan(
        "notary.queue.item",
        {
          "notary.requestId": req.id,
          "notary.requestType": req.type,
          "notary.variant": opts.variant,
          "notary.plan": req.plan,
          ...(req.note ? { "notary.note": req.note } : {}),
          ...(saved ? { "notary.resumedFrom": saved.state } : {}),
        },
        () => handleItem(req, saved),
        {
          kind: "AGENT",
          onSpan: (ids) => {
            traceId = ids.traceId;
            spanId = ids.spanId;
          },
        },
      );
      decision.traceId = traceId;
      if (decision.evidencePack && spanId) decision.evidencePack.spanIds = [spanId, ...decision.evidencePack.spanIds.filter((s) => s !== spanId)];
      opts.runState?.done(req.id, decision);
      decisions.push(decision);
      opts.onDecision?.(decision);
    } catch (err) {
      if (err instanceof StopRun) {
        const notProcessed = opts.queue.slice(i).map((r) => r.id);
        return {
          decisions,
          notProcessed,
          stopReason: `Crustdata credit budget exhausted at ${req.id}: ${err.cause.message}. ${notProcessed.length} item(s) not processed: ${notProcessed.join(", ")}`,
          notes,
          ...(resumedDone.length ? { resumedDone } : {}),
        };
      }
      throw err;
    }
  }
  return { decisions, notProcessed: [], notes, ...(resumedDone.length ? { resumedDone } : {}) };

  // -------------------------------------------------------------------------------------------

  /** Guarded: resume an in-flight item by reading back first, and give every hold an evidence pack. */
  async function handleItem(req: QueueRequest, saved: ResumeEntry | undefined): Promise<Decision> {
    if (guardedMode && saved?.state === "in_flight" && saved.lastWrite && saved.decision) {
      const resumed = await resumeInFlight(req, saved.lastWrite, saved.decision);
      if (resumed) return withPack(resumed);
      // Proven not landed: process the item again from scratch (the write is retried after fresh checks).
      notes.push(`${req.id}: resumed in flight; read-back proved ${saved.lastWrite.op} did not land, so the item was processed again`);
    }
    opts.runState?.start(req.id);
    if (!guardedMode) return processItem(req);
    const effects: Effect[] = [];
    const guardsApplied: string[] = [];
    const d = await withGuardContext({ guardsApplied, effects, now }, () => processItem(req, effects, guardsApplied));
    return withPack(d);
  }

  function withPack(d: Decision): Decision {
    if (!guardedMode || d.status !== "held" || d.evidencePack) return d;
    return {
      ...d,
      evidencePack: {
        reason: d.error ?? "held",
        missingBeliefs: d.missingBeliefs,
        relatedProbeIds: [],
        spanIds: [],
        traceLinks: {},
      },
    };
  }

  /** null = proven not landed (reprocess); otherwise the final decision. */
  async function resumeInFlight(req: QueueRequest, w: PendingWrite, draft: Decision): Promise<Decision | null> {
    const effects: Effect[] = [...draft.effects];
    const onRead: OnRead = (op, params, status) => effects.push({ op, params, status, at: now().toISOString() });
    let rb;
    try {
      rb = await readBack(readFns, w, onRead);
    } catch (err) {
      if (isFatal(err)) throw err;
      rb = { outcome: "unknown" as const, detail: `read-back failed: ${errMessage(err)}` };
    }
    const sent = writeAmount(w);
    if (rb.outcome === "landed") {
      const e: Effect = { op: w.op, params: w.params, status: null, at: now().toISOString() };
      if (rb.resultId) e.resultId = rb.resultId;
      if (sent !== undefined) e.amount = sent;
      effects.push(e);
      notes.push(`${req.id}: resumed after a crash with ${w.op} in flight; read-back: ${rb.detail}; not re-sent`);
      const done: Decision = { ...draft, status: "executed", effects };
      delete done.error;
      return done;
    }
    if (rb.outcome === "not_landed") return null;
    notes.push(`${req.id}: resumed after a crash with ${w.op} in flight; read-back inconclusive (${rb.detail}); held, not retried`);
    return {
      ...draft,
      status: "held",
      effects,
      error: `write outcome unknown after a crash: ${rb.detail}; not retried`,
    };
  }

  async function processItem(req: QueueRequest, effects: Effect[] = [], guardsApplied: string[] = []): Promise<Decision> {
    const base = {
      id: `${runKey}:${req.id}`,
      requestId: req.id,
      requiredBeliefs: [] as string[],
      missingBeliefs: [] as string[],
      guardsApplied,
      traceId: "",
    };
    const onRead: OnRead = (op, params, status) => effects.push({ op, params, status, at: now().toISOString() });

    // Reads are recorded as effects too, so read-backs are visible on the decision.
    async function read<T>(op: string, params: Record<string, unknown>, call: () => Promise<ToolResult<T>>): Promise<T> {
      try {
        const res = await call();
        effects.push({ op, params, status: res.status, at: now().toISOString() });
        return res.data;
      } catch (err) {
        if (!(isBlocked(err) || err instanceof CassetteMissError || err instanceof BudgetExceededError)) {
          effects.push({ op, params, status: errStatus(err), at: now().toISOString() });
        }
        throw err;
      }
    }

    // 1. Enrich (cached per domain within the run).
    const domain = req.companyDomain.trim().toLowerCase();
    let enriched = enrichCache.get(domain);
    let source: "crustdata" | "cache" = "cache";
    if (!enriched) {
      source = "crustdata";
      const params = { domains: [domain], fields: [...ENRICH_FIELDS] };
      try {
        const data = await read("crustdata.enrichCompany", params, () => tools.crustdata.enrichCompany(params));
        enriched = { company: firstCompany(data) };
        enrichCache.set(domain, enriched);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw new StopRun(err);
        if (isFatal(err)) throw err;
        // A 404 "No data found", a guard refusal or a network error leaves the company unknown (not cached).
        enriched = { company: null, error: errMessage(err) };
      }
    }
    const { tier, basis } = policy.tierFromCompany(enriched.company);
    const enrichment: Record<string, unknown> = {
      domain,
      source,
      ...enrichmentFields(enriched.company),
      tierBasis: basis ?? null,
      ...(enriched.error ? { error: enriched.error } : {}),
    };

    let customerId: string;
    try {
      customerId = resolve(req.customerId);
    } catch (err) {
      return held(`cannot resolve customer: ${errMessage(err)}`, "escalate", "none");
    }

    // 2. Reads the decision needs. Naive: one page, trusted as complete. Guarded: every page.
    let paymentAmount: number | undefined;
    let existingRefund: string | undefined;
    let paymentId: string | undefined;
    let lineItem: string | undefined;
    let paymentRead = false;
    /** Guarded: non-failed refunds already on the payment (the pre-write snapshot). */
    const priorRefundIds = new Set<string>();
    // Reading the payment itself also shows its refunds[], which the agent honours.
    async function readPayment(pid: string): Promise<void> {
      const payment = await read("dodo.getPayment", { payment_id: pid }, () => tools.dodo.getPayment(pid));
      paymentRead = true;
      paymentAmount = payment.total_amount;
      lineItem = payment.product_cart?.[0]?.product_id;
      const live = (payment.refunds ?? []).filter((r) => r.status !== "failed");
      for (const r of live) priorRefundIds.add(r.refund_id);
      const prior = live[0];
      if (!existingRefund && prior) existingRefund = `payment lists refund ${prior.refund_id} (${prior.status})`;
    }
    const isRefund = req.type === "refund" || req.type === "partial_refund";
    try {
      if (isRefund) {
        if (!req.paymentId) return held("refund request has no paymentId", "escalate", "none");
        paymentId = resolve(req.paymentId);
        const pid = paymentId;

        if (guardedMode) {
          await readPayment(pid);
          const refunds = await listAll<RefundListItem>(
            (page_number, page_size) => {
              const p = { customer_id: customerId, page_size, page_number };
              return read("dodo.listRefunds", p, () => tools.dodo.listRefunds(p));
            },
            (r) => r.refund_id,
          );
          for (const r of refunds.items) {
            if (r.payment_id !== pid || r.status === "failed") continue;
            priorRefundIds.add(r.refund_id);
            if (!existingRefund) existingRefund = `refund ${r.refund_id} (${r.status}) in the customer's full refund list`;
          }
          const payments = await listAll<PaymentListItem>(
            (page_number, page_size) => {
              const p = { customer_id: customerId, page_size, page_number };
              return read("dodo.listPayments", p, () => tools.dodo.listPayments(p));
            },
            (x) => x.payment_id,
          );
          const item = payments.items.find((p) => p.payment_id === pid);
          if (!existingRefund && item?.refund_status) existingRefund = `payment refund_status is "${item.refund_status}"`;
          if (!existingRefund && (!refunds.complete || !payments.complete)) {
            return held(
              `cannot prove ${pid} has no existing refund: ${[refunds.problem, payments.problem].filter(Boolean).join("; ")}`,
              "escalate",
              "none",
            );
          }
        } else {
          const pageParams = { customer_id: customerId, page_size: DOC_MAX_PAGE_SIZE };
          const refunds = await read("dodo.listRefunds", pageParams, () => tools.dodo.listRefunds(pageParams));
          const hit = refunds.items.find((r) => r.payment_id === pid && r.status !== "failed");
          if (hit) existingRefund = `refund ${hit.refund_id} (${hit.status}) on the first page of refunds`;

          const payments = await read("dodo.listPayments", pageParams, () => tools.dodo.listPayments(pageParams));
          const item = payments.items.find((p) => p.payment_id === pid);
          if (item) {
            paymentAmount = item.total_amount;
            if (!existingRefund && item.refund_status) existingRefund = `payment refund_status is "${item.refund_status}"`;
          }
          // Not on the page: look the payment up by id instead.
          if (!item) await readPayment(pid);
        }
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      return held(`read failed before deciding: ${errMessage(err)}`, "escalate", "none");
    }

    // 3. Decide.
    const decided = policy.decidePolicy({
      tier,
      plan: req.plan,
      type: req.type,
      ...(req.amount === undefined ? {} : { amount: req.amount }),
      ...(paymentAmount === undefined ? {} : { paymentAmount }),
    });

    const finish = (status: DecisionStatus, action: string, extra: Partial<Decision> = {}): Decision => ({
      ...base,
      customerId,
      tier,
      requestType: req.type,
      policyOutcome: decided.outcome,
      action,
      status,
      effects,
      enrichment,
      ...extra,
    });

    if (decided.outcome === "deny") return finish("denied", "none");
    if (decided.outcome === "escalate") {
      if (guardedMode) {
        const v = await opts.gate!({ request: req, tier, policy: decided, ...(paymentAmount === undefined ? {} : { paymentAmount }), forEscalation: true });
        return finish("escalated", "none", {
          evidencePack: {
            reason: decided.reason,
            missingBeliefs: v.missingBeliefs,
            relatedProbeIds: v.evidence?.relatedProbeIds ?? [],
            spanIds: v.evidence?.spanIds ?? [],
            traceLinks: v.evidence?.traceLinks ?? {},
          },
        });
      }
      return finish("escalated", "none", {
        evidencePack: { reason: decided.reason, missingBeliefs: [], relatedProbeIds: [], spanIds: [], traceLinks: {} },
      });
    }
    if (decided.action === "none") return finish("executed", "none");

    // A partial amount is refunded against a line item, which only the payment itself lists.
    const refundAmount = decided.refundAmount ?? (req.type === "partial_refund" ? req.amount : undefined);
    const fullRefund = refundAmount === undefined || (paymentAmount !== undefined && refundAmount >= paymentAmount);
    if (decided.action === "dodo.createRefund" && !fullRefund && !paymentRead) {
      try {
        await readPayment(paymentId!);
      } catch (err) {
        if (isFatal(err)) throw err;
        return finish("held", decided.action, { error: `payment read failed: ${errMessage(err)}` });
      }
    }

    if (decided.action === "dodo.createRefund" && existingRefund) {
      return finish("denied", "none", { error: `existing refund found: ${existingRefund}` });
    }

    // 4. Gate (guarded): every required belief notarized, else hold with an evidence pack.
    if (guardedMode) {
      const v = await opts.gate!({ request: req, tier, policy: decided, ...(paymentAmount === undefined ? {} : { paymentAmount }) });
      base.requiredBeliefs = v.requiredBeliefs;
      base.missingBeliefs = v.missingBeliefs;
      if (!v.allow) {
        return finish("held", decided.action, {
          error: v.reason ?? "required beliefs not notarized",
          evidencePack: {
            reason: v.reason ?? "required beliefs not notarized",
            missingBeliefs: v.missingBeliefs,
            relatedProbeIds: v.evidence?.relatedProbeIds ?? [],
            spanIds: v.evidence?.spanIds ?? [],
            traceLinks: v.evidence?.traceLinks ?? {},
          },
        });
      }
    }

    // 5. Execute (naive: directly; guarded: through the guarded clients, never retried blindly).
    const timeoutFirst = req.note === CLIENT_TIMEOUT_NOTE;
    let outcome: WriteOutcome;
    try {
      if (decided.action === "dodo.createRefund") {
        const pid = paymentId!;
        const amount = refundAmount;
        const full = fullRefund;
        if (!full && !lineItem) {
          return finish("held", decided.action, { error: "partial refund: payment has no line item to refund against" });
        }
        const params = full
          ? { payment_id: pid, reason: req.reason }
          : { payment_id: pid, reason: req.reason, items: [{ item_id: lineItem!, amount: amount! }] };
        const sent = full ? paymentAmount : amount;
        const reheld = await reverify("dodo.createRefund", params);
        if (reheld) return reheld;
        const pending: PendingWrite = {
          op: "dodo.createRefund",
          paymentId: pid,
          customerId,
          ...(sent === undefined ? {} : { amount: sent }),
          params,
          pre: { refundIds: [...priorRefundIds].sort() },
        };
        outcome = await write(
          "dodo.createRefund",
          params,
          () => tools.dodo.createRefund(params),
          (r) => ({ resultId: r.refund_id, amount: typeof r.amount === "number" ? r.amount : full ? paymentAmount : amount, currency: r.currency ?? undefined }),
          full ? paymentAmount : amount,
          timeoutFirst,
          pending,
        );
      } else if (decided.action === "dodo.changeSubscriptionPlan") {
        if (!req.subscriptionId || !req.targetPlan) {
          return finish("held", decided.action, { error: "plan change needs subscriptionId and targetPlan" });
        }
        const subId = resolve(req.subscriptionId);
        const productId = resolveProduct(opts.manifest, resolve, req.targetPlan);
        const sub = await read("dodo.getSubscription", { subscription_id: subId }, () => tools.dodo.getSubscription(subId));
        const params = {
          product_id: productId,
          quantity: typeof sub.quantity === "number" && sub.quantity > 0 ? sub.quantity : 1,
          proration_billing_mode: "prorated_immediately" as const,
          ...(guardedMode ? { effective_at: "immediately" as const } : {}),
        };
        const reheldPlan = await reverify("dodo.changeSubscriptionPlan", { subscription_id: subId, ...params });
        if (reheldPlan) return reheldPlan;
        const pending: PendingWrite = {
          op: "dodo.changeSubscriptionPlan",
          subscriptionId: subId,
          productId,
          params: { subscription_id: subId, ...params },
          pre: { productId: sub.product_id ?? null, scheduledProductId: sub.scheduled_change?.product_id ?? null },
        };
        outcome = await write(
          "dodo.changeSubscriptionPlan",
          { subscription_id: subId, ...params },
          () => tools.dodo.changeSubscriptionPlan(subId, params),
          (r) => ({ resultId: r.payment_id ?? undefined }),
          undefined,
          timeoutFirst,
          pending,
        );
      } else {
        const amount = decided.refundAmount ?? req.amount;
        if (amount === undefined) return finish("held", decided.action, { error: "credit request has no amount" });
        const params = {
          amount,
          currency: req.currency ?? "USD",
          entry_type: "credit" as const,
          idempotency_key: `notary-${runKey}-${req.id}`,
          reason: req.reason,
        };
        const reheldCredit = await reverify("dodo.createWalletLedgerEntry", { customer_id: customerId, ...params });
        if (reheldCredit) return reheldCredit;
        let pending: PendingWrite | undefined;
        if (guardedMode) {
          const entries = await ledgerEntries(readFns, customerId, params.currency, onRead);
          if (!entries.complete) {
            return finish("held", decided.action, { error: `cannot snapshot the wallet ledger before crediting: ${entries.problem ?? "listing incomplete"}` });
          }
          pending = {
            op: "dodo.createWalletLedgerEntry",
            customerId,
            amount,
            currency: params.currency,
            params: { customer_id: customerId, ...params },
            pre: { entryIds: entries.items.map((e) => e.id).sort() },
          };
        }
        outcome = await write(
          "dodo.createWalletLedgerEntry",
          { customer_id: customerId, ...params },
          () => tools.dodo.createWalletLedgerEntry(customerId, params),
          () => ({ amount, currency: params.currency }),
          amount,
          timeoutFirst,
          pending,
        );
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      if (guardedMode && typeof err === "object" && err !== null && crashes.has(err)) throw err; // a crash, not a tool answer
      return finish("held", decided.action, { error: `execution failed: ${errMessage(err)}` });
    }

    if (outcome.note) notes.push(`${req.id}: ${outcome.note}`);
    if (outcome.succeeded) return finish("executed", decided.action);
    if (outcome.blocked) {
      const b = outcome.blocked;
      return finish("held", decided.action, {
        error: `guard ${b.guardId} refused ${b.op}: ${b.reason}`,
        evidencePack: {
          reason: `guard ${b.guardId} refused ${b.op}: ${b.reason}`,
          missingBeliefs: base.missingBeliefs,
          relatedProbeIds: [],
          spanIds: [],
          traceLinks: {},
        },
      });
    }
    return finish("held", decided.action, {
      error: outcome.unknown ? `write outcome unknown: ${outcome.error}` : `write failed: ${outcome.error}`,
    });

    /**
     * Guarded: the re-verification sentinel, asked right before a write with its final params. null =
     * proceed; otherwise the held decision. When a belief left notarized, the gate is asked again so
     * the evidence pack names the revoked belief and every probe on its claim (sentinel probes included).
     */
    async function reverify(op: string, params: Record<string, unknown>): Promise<Decision | null> {
      if (!guardedMode || !opts.sentinel) return null;
      const s = await opts.sentinel({ requestId: req.id, op, params });
      if (!s.ran) return null;
      notes.push(`${req.id}: ${s.reason ?? "re-verification sentinel ran"}${s.hold ? "; HELD" : "; proceeding"}`);
      if (!s.hold) return null;
      const v = await opts.gate!({ request: req, tier, policy: decided, ...(paymentAmount === undefined ? {} : { paymentAmount }) });
      const missing = [...new Set([...v.missingBeliefs, ...s.leftNotarized])];
      base.requiredBeliefs = v.requiredBeliefs;
      base.missingBeliefs = missing;
      const reason = `${s.reason ?? "re-verification sentinel hold"}${v.allow ? "" : `. Gate re-checked: ${v.reason ?? "required beliefs not notarized"}`}`;
      return finish("held", decided.action, {
        error: reason,
        evidencePack: {
          reason,
          missingBeliefs: missing,
          relatedProbeIds: [...new Set([...s.probeIds, ...(v.evidence?.relatedProbeIds ?? [])])],
          spanIds: v.evidence?.spanIds ?? [],
          traceLinks: v.evidence?.traceLinks ?? {},
        },
      });
    }

    function held(error: string, outcome: PolicyOutcome, action: string): Decision {
      return {
        ...base,
        customerId: (() => {
          try {
            return resolve(req.customerId);
          } catch {
            return req.customerId;
          }
        })(),
        tier,
        requestType: req.type,
        policyOutcome: outcome,
        action,
        status: "held",
        effects,
        enrichment,
        error,
      };
    }

    // -----------------------------------------------------------------------------------------

    interface WriteOutcome {
      succeeded: boolean;
      unknown: boolean;
      error?: string;
      note?: string;
      blocked?: GuardBlockedError;
    }

    /**
     * One write. Naive: retried once after a timeout/5xx. Guarded: the pending write is persisted
     * first; a timeout/5xx is read back and retried once only if it provably did not land.
     * Every attempt is an effect.
     */
    async function write<T>(
      op: string,
      params: Record<string, unknown>,
      call: () => Promise<ToolResult<T>>,
      describe: (data: T) => { resultId?: string | undefined; amount?: number | undefined; currency?: string | undefined },
      sentAmount: number | undefined,
      clientTimeout: boolean,
      pending?: PendingWrite,
    ): Promise<WriteOutcome> {
      let note: string | undefined;
      const record = (status: number | null, extra: { resultId?: string | undefined; amount?: number | undefined; currency?: string | undefined } = {}): Effect => {
        const e: Effect = { op, params, status, at: now().toISOString() };
        if (extra.resultId) e.resultId = extra.resultId;
        const amt = extra.amount ?? sentAmount;
        if (amt !== undefined) e.amount = amt;
        if (extra.currency) e.currency = extra.currency;
        effects.push(e);
        return e;
      };
      const withNote = (o: WriteOutcome): WriteOutcome => (note ? { ...o, note } : o);

      if (guardedMode && pending) {
        opts.runState?.beforeWrite(
          req.id,
          pending,
          finish("held", op, { requiredBeliefs: base.requiredBeliefs, missingBeliefs: base.missingBeliefs, effects: [...effects], guardsApplied: [...guardsApplied], error: "write in flight" }),
        );
      }

      /** Guarded: after an unknown outcome, decide from Dodo state. */
      async function decideByReadBack(effect: Effect, why: string): Promise<"landed" | "not_landed" | "unknown"> {
        if (!pending) {
          note = `${note ? `${note}; ` : ""}${why}; no read-back for ${op}`;
          return "unknown";
        }
        const rb = await readBack(readFns, pending, onRead);
        note = `${note ? `${note}; ` : ""}${why}; read-back: ${rb.detail}`;
        if (rb.outcome === "landed" && rb.resultId) effect.resultId = rb.resultId;
        return rb.outcome;
      }

      let lastError = "";
      let unknown = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        let res: ToolResult<T> | undefined;
        let err: unknown;
        if (attempt === 1 && clientTimeout) {
          const r = await withClientTimeout(call, clientTimeoutMs);
          if (r.timedOut) {
            const e = record(null);
            unknown = true;
            lastError = `client timeout after ${clientTimeoutMs} ms`;
            // Let the abandoned request settle (so it is recorded), then say how it ended.
            const settled = await r.settled;
            const ended = settled.ok
              ? `the abandoned request later completed with HTTP ${settled.res.status}`
              : `the abandoned request later failed: ${errMessage(settled.err)}`;
            if (guardedMode) {
              const rb = await decideByReadBack(e, `first ${op} still in flight at the ${clientTimeoutMs} ms client timeout (${ended})`);
              if (rb === "landed") return withNote({ succeeded: true, unknown: false });
              if (rb === "unknown") return withNote({ succeeded: false, unknown: true, error: lastError });
              note += "; retried once";
              continue;
            }
            note = `first ${op} still in flight at the ${clientTimeoutMs} ms client timeout; treated as timed out and retried (${ended})`;
            continue;
          }
          if (r.latencyMs !== undefined) {
            note = `first ${op} completed in ${r.latencyMs} ms, before the ${clientTimeoutMs} ms client timeout; no timeout occurred, so no retry was sent`;
          }
          if (r.settledNow.ok) res = r.settledNow.res;
          else err = r.settledNow.err;
        } else {
          try {
            res = await call();
          } catch (e) {
            err = e;
          }
        }

        if (res) {
          if (guardedMode && isReadBackResult(res)) {
            const rbk = res.readBack;
            record(rbk.firstStatus, { resultId: rbk.resultId });
            note = `${note ? `${note}; ` : ""}${op} outcome unknown (${rbk.firstStatus ?? "no response"}); retry_policy read-back: ${rbk.detail}`;
            return withNote({ succeeded: true, unknown: false });
          }
          record(res.status, describe(res.data));
          return withNote({ succeeded: true, unknown: false });
        }
        if (isFatal(err)) throw err;
        if (guardedMode) {
          if (err instanceof GuardBlockedError) return withNote({ succeeded: false, unknown: false, blocked: err, error: err.message });
          if (err instanceof UnknownWriteOutcomeError) {
            record(null);
            return withNote({ succeeded: false, unknown: true, error: err.message });
          }
          if (!isToolOrGuardError(err)) {
            // A crash, not a tool answer: propagate it (the run state keeps the pending write for --resume).
            if (typeof err === "object" && err !== null) crashes.add(err);
            throw err;
          }
        }
        const status = errStatus(err);
        const e = record(status);
        lastError = errMessage(err);
        // A timeout or 5xx leaves the outcome unknown; a 4xx is a clear rejection.
        const retryable = isUnknownOutcome(err);
        if (retryable) unknown = true;
        if (!retryable) return withNote({ succeeded: false, unknown, error: lastError });
        if (guardedMode) {
          const rb = await decideByReadBack(e, `${op} attempt ${attempt}: ${lastError}`);
          if (rb === "landed") return withNote({ succeeded: true, unknown: false });
          if (rb === "unknown") return withNote({ succeeded: false, unknown: true, error: lastError });
          unknown = false; // proven not landed
          if (attempt === 1) note += "; retried once";
        }
      }
      return withNote({ succeeded: false, unknown, error: lastError });
    }
  }


  type Settled<T> = { ok: true; res: ToolResult<T> } | { ok: false; err: unknown };

  /**
   * Race the call against a client-side AbortSignal.timeout. Live: the timer is real. Replay: the
   * call returns instantly, so the recorded latency of its exchange decides instead.
   */
  async function withClientTimeout<T>(
    call: () => Promise<ToolResult<T>>,
    ms: number,
  ): Promise<
    | { timedOut: true; settled: Promise<Settled<T>> }
    | { timedOut: false; settledNow: Settled<T>; latencyMs?: number }
  > {
    const started = performance.now();
    const settledP: Promise<Settled<T>> = call().then(
      (res) => ({ ok: true as const, res }),
      (err: unknown) => ({ ok: false as const, err }),
    );

    if (tools.recorder?.mode === "replay") {
      const s = await settledP;
      const exchangeId = s.ok ? s.res.exchangeId : (s.err as { exchangeId?: string }).exchangeId;
      const ex = exchangeId ? tools.recorder.exchanges().find((e) => e.id === exchangeId) : undefined;
      if (ex && ex.latencyMs >= ms) return { timedOut: true, settled: Promise.resolve(s) };
      return { timedOut: false, settledNow: s, ...(ex ? { latencyMs: ex.latencyMs } : {}) };
    }

    const signal = AbortSignal.timeout(ms);
    const timer = new Promise<"timeout">((resolveTimer) => {
      if (signal.aborted) resolveTimer("timeout");
      else signal.addEventListener("abort", () => resolveTimer("timeout"), { once: true });
    });
    const first = await Promise.race([settledP, timer]);
    if (first === "timeout") return { timedOut: true, settled: settledP };
    let latencyMs = Math.round(performance.now() - started);
    const exchangeId = first.ok ? first.res.exchangeId : (first.err as { exchangeId?: string }).exchangeId;
    const ex = exchangeId ? tools.recorder?.exchanges().find((e) => e.id === exchangeId) : undefined;
    if (ex) latencyMs = ex.latencyMs;
    return { timedOut: false, settledNow: first, latencyMs };
  }
}
