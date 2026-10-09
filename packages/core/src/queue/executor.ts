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
 * `guarded` (P6) will call `gate` before every write; until then it throws NotImplementedError.
 */
import { NotImplementedError } from "../errors.js";
import type { CompanyData, CrustdataTools, DodoTools, Exchange, RecorderMode, ToolResult } from "../tools/index.js";
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
  >;
  recorder?: { readonly mode: RecorderMode; exchanges(): Exchange[] };
}

/** What the guarded variant asks before a write (P6 implements it). */
export interface GateContext {
  request: QueueRequest;
  tier: Tier;
  policy: PolicyDecision;
}
export interface GateVerdict {
  allow: boolean;
  missingBeliefs: string[];
  requiredBeliefs: string[];
  reason?: string;
}
export type GateHook = (ctx: GateContext) => Promise<GateVerdict>;

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
}

export interface ExecuteQueueResult {
  decisions: Decision[];
  /** Request ids never processed (budget stop). */
  notProcessed: string[];
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

type Enriched = { company: CompanyData | null; error?: string };

class StopRun extends Error {
  constructor(readonly cause: BudgetExceededError) {
    super(cause.message);
  }
}

// ---------------------------------------------------------------------------------------------
// Executor

export async function executeQueue(opts: ExecuteQueueOptions): Promise<ExecuteQueueResult> {
  if (opts.variant === "guarded") throw new NotImplementedError("run (guarded)", "P6");

  const now = opts.now ?? (() => new Date());
  const policy: PolicyFns = opts.policy ?? { tierFromCompany, decidePolicy };
  const resolve = opts.resolve ?? defaultResolver(opts.manifest);
  const clientTimeoutMs = opts.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
  const runKey = opts.runId ?? "run";
  const { tools } = opts;

  const enrichCache = new Map<string, Enriched>();
  const decisions: Decision[] = [];
  const notes: string[] = [];

  for (let i = 0; i < opts.queue.length; i++) {
    const req = opts.queue[i]!;
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
        },
        () => processItem(req),
        {
          kind: "AGENT",
          onSpan: (ids) => {
            traceId = ids.traceId;
            spanId = ids.spanId;
          },
        },
      );
      decision.traceId = traceId;
      if (decision.evidencePack && spanId) decision.evidencePack.spanIds = [spanId];
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
        };
      }
      throw err;
    }
  }
  return { decisions, notProcessed: [], notes };

  // -------------------------------------------------------------------------------------------

  async function processItem(req: QueueRequest): Promise<Decision> {
    const effects: Effect[] = [];
    const base = {
      id: `${runKey}:${req.id}`,
      requestId: req.id,
      requiredBeliefs: [] as string[],
      missingBeliefs: [] as string[],
      guardsApplied: [] as string[],
      traceId: "",
    };

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
        // A 404 "No data found" or a network error leaves the company unknown (not cached).
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

    // 2. Reads the decision needs (refunds: one page, trusted as complete).
    let paymentAmount: number | undefined;
    let existingRefund: string | undefined;
    let paymentId: string | undefined;
    let lineItem: string | undefined;
    let paymentRead = false;
    // Reading the payment itself also shows its refunds[], which the agent honours.
    async function readPayment(pid: string): Promise<void> {
      const payment = await read("dodo.getPayment", { payment_id: pid }, () => tools.dodo.getPayment(pid));
      paymentRead = true;
      paymentAmount = payment.total_amount;
      lineItem = payment.product_cart?.[0]?.product_id;
      const prior = (payment.refunds ?? []).find((r) => r.status !== "failed");
      if (!existingRefund && prior) existingRefund = `payment lists refund ${prior.refund_id} (${prior.status})`;
    }
    const isRefund = req.type === "refund" || req.type === "partial_refund";
    try {
      if (isRefund) {
        if (!req.paymentId) return held("refund request has no paymentId", "escalate", "none");
        paymentId = resolve(req.paymentId);
        const pid = paymentId;

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

    // 4. Execute directly (no gate, no guards).
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
        outcome = await write(
          "dodo.createRefund",
          params,
          () => tools.dodo.createRefund(params),
          (r) => ({ resultId: r.refund_id, amount: typeof r.amount === "number" ? r.amount : full ? paymentAmount : amount, currency: r.currency ?? undefined }),
          full ? paymentAmount : amount,
          timeoutFirst,
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
        };
        outcome = await write(
          "dodo.changeSubscriptionPlan",
          { subscription_id: subId, ...params },
          () => tools.dodo.changeSubscriptionPlan(subId, params),
          (r) => ({ resultId: r.payment_id ?? undefined }),
          undefined,
          timeoutFirst,
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
        outcome = await write(
          "dodo.createWalletLedgerEntry",
          { customer_id: customerId, ...params },
          () => tools.dodo.createWalletLedgerEntry(customerId, params),
          () => ({ amount, currency: params.currency }),
          amount,
          timeoutFirst,
        );
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      return finish("held", decided.action, { error: `execution failed: ${errMessage(err)}` });
    }

    if (outcome.note) notes.push(`${req.id}: ${outcome.note}`);
    if (outcome.succeeded) return finish("executed", decided.action);
    return finish("held", decided.action, {
      error: outcome.unknown ? `write outcome unknown: ${outcome.error}` : `write failed: ${outcome.error}`,
    });

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
    }

    /** One write, retried once after a timeout/5xx. Every attempt is an effect. */
    async function write<T>(
      op: string,
      params: Record<string, unknown>,
      call: () => Promise<ToolResult<T>>,
      describe: (data: T) => { resultId?: string | undefined; amount?: number | undefined; currency?: string | undefined },
      sentAmount: number | undefined,
      clientTimeout: boolean,
    ): Promise<WriteOutcome> {
      let note: string | undefined;
      const record = (status: number | null, extra: { resultId?: string | undefined; amount?: number | undefined; currency?: string | undefined } = {}) => {
        const e: Effect = { op, params, status, at: now().toISOString() };
        if (extra.resultId) e.resultId = extra.resultId;
        const amt = extra.amount ?? sentAmount;
        if (amt !== undefined) e.amount = amt;
        if (extra.currency) e.currency = extra.currency;
        effects.push(e);
      };

      let lastError = "";
      let unknown = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        let res: ToolResult<T> | undefined;
        let err: unknown;
        if (attempt === 1 && clientTimeout) {
          const r = await withClientTimeout(call, clientTimeoutMs);
          if (r.timedOut) {
            record(null);
            unknown = true;
            lastError = `client timeout after ${clientTimeoutMs} ms`;
            note = `first ${op} still in flight at the ${clientTimeoutMs} ms client timeout; treated as timed out and retried`;
            // Let the abandoned request settle (so it is recorded), then say how it ended.
            const settled = await r.settled;
            note += settled.ok
              ? ` (the abandoned request later completed with HTTP ${settled.res.status})`
              : ` (the abandoned request later failed: ${errMessage(settled.err)})`;
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
          record(res.status, describe(res.data));
          return { succeeded: true, unknown: false, ...(note ? { note } : {}) };
        }
        if (isFatal(err)) throw err;
        const status = errStatus(err);
        record(status);
        lastError = errMessage(err);
        // A timeout or 5xx leaves the outcome unknown; a 4xx is a clear rejection.
        const retryable = err instanceof ToolNetworkError || (status !== null && status >= 500);
        if (retryable) unknown = true;
        if (!retryable) return { succeeded: false, unknown, error: lastError, ...(note ? { note } : {}) };
      }
      return { succeeded: false, unknown, error: lastError, ...(note ? { note } : {}) };
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
