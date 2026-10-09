/**
 * `guarded(registry, recorder)` returns the `wrap` that createTools() routes every Dodo and Crustdata
 * method through (TDD "Guarded clients"). `wrap(op, fn)` keeps the raw bound method private to this
 * closure and returns a function with the same signature that, on every call, applies the registry's
 * ACTIVE guards for `op` (looked up per call, so a guard retired mid-run stops applying at once):
 *
 *   block           refuse with the guard's reason (GuardBlockedError)
 *   require_param   add the rule's default when the param is missing; refuse when there is none
 *   transform       scale the param at `rule.param` by `rule.scale`; refuse if the result is not an
 *                   integer (`requireInteger`)
 *   precheck        existing_refund: the payment's refunds[] plus the customer's refunds paginated to
 *                   an empty page; refuse if any non-failed refund exists or the listing is incomplete.
 *                   pending_plan_change: read the subscription; refuse if a change is scheduled.
 *   paginate_fully  page from the requested page to an EMPTY page and return every item; refuse when
 *                   page_number stops advancing or the page cap is hit (completeness not proven)
 *   retry_policy    snapshot state, call once; on timeout/5xx read back: landed -> return the read-back
 *                   result (marked `readBack`), not landed -> retry (up to maxAttempts), unknown ->
 *                   UnknownWriteOutcomeError. Never a blind retry.
 *
 * Every guard that applies is reported to `recorder.fired` (default: the current Decision via
 * AsyncLocalStorage), and every call the guard layer makes on its own (prechecks, pages, read-backs,
 * failed write attempts) to `recorder.effect`, so they show on the Decision.
 */
import { parsePath } from "../checker/path.js";
import type { PathSegment } from "../checker/path.js";
import { RECON_PATH_PARAMS } from "../contracts/index.js";
import type { Guard } from "../schema/index.js";
import { ToolHttpError, ToolNetworkError } from "../tools/index.js";
import type { ToolResult, Wrap } from "../tools/index.js";
import { contextRecorder } from "./context.js";
import type { FiringRecorder } from "./context.js";
import { GuardBlockedError, UnknownWriteOutcomeError } from "./errors.js";
import { ledgerEntries, listAll, readBack, refundsForPayment } from "./readback.js";
import type { OnRead, PendingWrite, ReadFns } from "./readback.js";
import type { GuardRegistry } from "./registry.js";

// `any` is needed for a generic wrapper over arbitrary method signatures (same as tools/index.ts).
type AnyAsyncFn = (...args: any[]) => Promise<unknown>;

/** A write result the retry_policy guard produced from a read-back instead of an HTTP 2xx. */
export interface ReadBackMarker {
  readBack: { firstStatus: number | null; resultId?: string; detail: string };
}

export function isReadBackResult(r: unknown): r is ToolResult<unknown> & ReadBackMarker {
  return typeof r === "object" && r !== null && "readBack" in r;
}

/** Index of the params object in an op's arguments (ops with an id in the URL take it first). */
export function paramsIndex(op: string): number {
  return op in RECON_PATH_PARAMS ? 1 : 0;
}

/** True for a failure whose outcome is unknown: no HTTP answer, or a 5xx. */
export function isUnknownOutcome(err: unknown): boolean {
  return err instanceof ToolNetworkError || (err instanceof ToolHttpError && err.status >= 500);
}

function errStatus(err: unknown): number | null {
  return err instanceof ToolHttpError ? err.status : null;
}

// ------------------------------------------------------------------------------------ paths

type Loc = { parent: Record<string, unknown> | unknown[]; key: string | number };

/** Concrete locations of `path` inside `root` (expanding `[]`), only where the value exists. */
function locate(root: unknown, segs: PathSegment[]): Loc[] {
  if (segs.length === 0) return [];
  let frontier: Array<{ node: unknown; loc?: Loc }> = [{ node: root }];
  for (const seg of segs) {
    const next: Array<{ node: unknown; loc?: Loc }> = [];
    for (const { node } of frontier) {
      if (seg.kind === "key") {
        if (node && typeof node === "object" && !Array.isArray(node) && seg.key in (node as object)) {
          const parent = node as Record<string, unknown>;
          next.push({ node: parent[seg.key], loc: { parent, key: seg.key } });
        }
      } else if (Array.isArray(node)) {
        const idxs = seg.kind === "each" ? node.map((_, i) => i) : seg.index < node.length ? [seg.index] : [];
        for (const i of idxs) next.push({ node: node[i], loc: { parent: node, key: i } });
      }
    }
    frontier = next;
  }
  return frontier.flatMap((f) => (f.loc && f.node !== undefined && f.node !== null ? [f.loc] : []));
}

function getAt(loc: Loc): unknown {
  return (loc.parent as Record<string | number, unknown>)[loc.key];
}

function setAt(loc: Loc, value: unknown): void {
  (loc.parent as Record<string | number, unknown>)[loc.key] = value;
}

// ------------------------------------------------------------------------------------ guarded

export function guarded(registry: GuardRegistry, recorder: FiringRecorder = contextRecorder): Wrap {
  const raw = new Map<string, AnyAsyncFn>();

  const readFns = (): ReadFns => ({
    ...(raw.has("dodo.getPayment") ? { getPayment: raw.get("dodo.getPayment") as ReadFns["getPayment"] } : {}),
    ...(raw.has("dodo.listRefunds") ? { listRefunds: raw.get("dodo.listRefunds") as ReadFns["listRefunds"] } : {}),
    ...(raw.has("dodo.getSubscription") ? { getSubscription: raw.get("dodo.getSubscription") as ReadFns["getSubscription"] } : {}),
    ...(raw.has("dodo.listWalletLedgerEntries")
      ? { listWalletLedgerEntries: raw.get("dodo.listWalletLedgerEntries") as ReadFns["listWalletLedgerEntries"] }
      : {}),
  });
  const onRead: OnRead = (op, params, status) => recorder.effect({ op, params, status });

  async function precheck(op: string, g: Guard, args: unknown[], params: Record<string, unknown>): Promise<void> {
    const check = g.rule.check;
    if (check === "existing_refund") {
      const pid = params.payment_id;
      if (typeof pid !== "string") throw new GuardBlockedError(g.id, op, "precheck existing_refund: no payment_id");
      const r = await refundsForPayment(readFns(), pid, undefined, onRead);
      if (r.refunds.length) {
        throw new GuardBlockedError(g.id, op, `existing refund ${r.refunds.map((x) => `${x.refund_id} (${x.status})`).join(", ")} on ${pid}`);
      }
      if (!r.complete) throw new GuardBlockedError(g.id, op, `cannot prove ${pid} has no refund: ${r.problem ?? "listing incomplete"}`);
      return;
    }
    if (check === "pending_plan_change") {
      const subId = args[0];
      const get = readFns().getSubscription;
      if (typeof subId !== "string" || !get) throw new GuardBlockedError(g.id, op, "precheck pending_plan_change: no subscription reader");
      const res = await get(subId);
      onRead("dodo.getSubscription", { subscription_id: subId }, res.status);
      if (res.data.scheduled_change) {
        throw new GuardBlockedError(g.id, op, `subscription ${subId} already has a scheduled change to ${res.data.scheduled_change.product_id}`);
      }
      return;
    }
    throw new GuardBlockedError(g.id, op, `unknown precheck ${String(check)}`);
  }

  async function paginate(op: string, g: Guard, fn: AnyAsyncFn, args: unknown[]): Promise<unknown> {
    const idx = paramsIndex(op);
    const base = (args[idx] ?? {}) as Record<string, unknown>;
    const pageSize = typeof g.rule.pageSize === "number" ? g.rule.pageSize : 100;
    const maxPages = typeof g.rule.maxPages === "number" ? g.rule.maxPages : 200;
    let first: ToolResult<{ items: unknown[] }> | undefined;
    const keyOf = (x: unknown): string => {
      const o = x as Record<string, unknown>;
      const k = o.refund_id ?? o.payment_id ?? o.customer_id ?? o.id;
      return typeof k === "string" ? k : JSON.stringify(x);
    };
    const res = await listAll<unknown>(
      async (page_number, page_size) => {
        const a = [...args];
        a[idx] = { ...base, page_size, page_number };
        const r = (await fn(...a)) as ToolResult<{ items: unknown[] }>;
        if (!first) first = r;
        else onRead(op, a[idx] as Record<string, unknown>, r.status);
        return r.data;
      },
      keyOf,
      { pageSize, maxPages, startPage: typeof base.page_number === "number" ? base.page_number : 0 },
    );
    if (!res.complete) throw new GuardBlockedError(g.id, op, `pagination not proven complete: ${res.problem ?? "unknown"}`);
    return { ...first!, data: { ...first!.data, items: res.items } };
  }

  async function pendingFor(op: string, args: unknown[], params: Record<string, unknown>): Promise<PendingWrite | null> {
    const fns = readFns();
    if (op === "dodo.createRefund" && typeof params.payment_id === "string" && fns.getPayment && fns.listRefunds) {
      const r = await refundsForPayment(fns, params.payment_id, undefined, onRead);
      if (!r.customerId) return null;
      return { op, paymentId: params.payment_id, customerId: r.customerId, params, pre: { refundIds: r.refunds.map((x) => x.refund_id) } };
    }
    if (op === "dodo.changeSubscriptionPlan" && typeof args[0] === "string" && typeof params.product_id === "string" && fns.getSubscription) {
      const sub = (await fns.getSubscription(args[0])).data;
      onRead("dodo.getSubscription", { subscription_id: args[0] }, 200);
      return {
        op,
        subscriptionId: args[0],
        productId: params.product_id,
        params,
        pre: { productId: sub.product_id ?? null, scheduledProductId: sub.scheduled_change?.product_id ?? null },
      };
    }
    if (op === "dodo.createWalletLedgerEntry" && typeof args[0] === "string" && typeof params.amount === "number" && fns.listWalletLedgerEntries) {
      const currency = typeof params.currency === "string" ? params.currency : "USD";
      const entries = await ledgerEntries(fns, args[0], currency, onRead);
      return { op, customerId: args[0], amount: params.amount, currency, params, pre: { entryIds: entries.items.map((e) => e.id) } };
    }
    return null;
  }

  async function retryWithReadBack(op: string, g: Guard, fn: AnyAsyncFn, args: unknown[], params: Record<string, unknown>): Promise<unknown> {
    const maxAttempts = typeof g.rule.maxAttempts === "number" ? Math.max(1, Math.min(2, g.rule.maxAttempts)) : 2;
    const pending = await pendingFor(op, args, params);
    let last = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn(...args);
      } catch (err) {
        if (!isUnknownOutcome(err)) throw err;
        const firstStatus = errStatus(err);
        last = err instanceof Error ? err.message : String(err);
        if (!pending) throw new UnknownWriteOutcomeError(g.id, op, `${last}; no read-back known for ${op}`);
        const rb = await readBack(readFns(), pending, onRead);
        if (rb.outcome === "landed") {
          const marker: ToolResult<unknown> & ReadBackMarker = {
            data: { ...(rb.resultId ? { id: rb.resultId } : {}) },
            status: 200,
            exchangeId: "",
            readBack: { firstStatus, ...(rb.resultId ? { resultId: rb.resultId } : {}), detail: rb.detail },
          };
          return marker;
        }
        if (rb.outcome === "unknown") throw new UnknownWriteOutcomeError(g.id, op, `${last}; ${rb.detail}`);
        // Proven not landed: record the failed attempt, then (if attempts remain) retry.
        recorder.effect({ op, params, status: firstStatus });
        last = `${last}; ${rb.detail}`;
      }
    }
    throw new UnknownWriteOutcomeError(g.id, op, `gave up after ${maxAttempts} attempt(s): ${last}`);
  }

  async function apply(op: string, fn: AnyAsyncFn, args: unknown[]): Promise<unknown> {
    const guards = registry.active(op);
    if (guards.length === 0) return fn(...args);
    const idx = paramsIndex(op);
    const original = args[idx];
    const params: Record<string, unknown> =
      original && typeof original === "object" ? (structuredClone(original) as Record<string, unknown>) : {};
    let touched = false;
    let paginateGuard: Guard | undefined;
    let retryGuard: Guard | undefined;

    for (const g of guards) {
      switch (g.kind) {
        case "block":
          recorder.fired(g, op);
          throw new GuardBlockedError(g.id, op, g.reason);
        case "require_param": {
          const name = String(g.rule.param ?? "");
          const present = name !== "" && locate(params, parsePath(name)).length > 0;
          if (present) break;
          recorder.fired(g, op);
          if (g.rule.default === undefined || name.includes("[")) throw new GuardBlockedError(g.id, op, `required param ${name} is missing`);
          params[name] = structuredClone(g.rule.default);
          touched = true;
          break;
        }
        case "transform": {
          const scale = g.rule.scale;
          const locs = locate(params, parsePath(String(g.rule.param ?? "")));
          if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) throw new GuardBlockedError(g.id, op, "transform has no valid scale");
          const numeric = locs.filter((l) => typeof getAt(l) === "number");
          if (numeric.length === 0) break;
          recorder.fired(g, op);
          for (const l of numeric) {
            const v = (getAt(l) as number) * scale;
            const rounded = Math.round(v);
            const isInt = Math.abs(v - rounded) < 1e-9;
            if (g.rule.requireInteger !== false && !isInt) {
              throw new GuardBlockedError(g.id, op, `${String(g.rule.param)} ${getAt(l) as number} x ${scale} = ${v} is not an integer amount`);
            }
            setAt(l, isInt ? rounded : v);
          }
          touched = true;
          break;
        }
        case "precheck":
          recorder.fired(g, op);
          await precheck(op, g, args, params);
          break;
        case "paginate_fully":
          paginateGuard ??= g;
          break;
        case "retry_policy":
          retryGuard ??= g;
          break;
      }
    }

    const callArgs = [...args];
    if (touched || original !== undefined) callArgs[idx] = touched ? params : original;
    if (paginateGuard) {
      recorder.fired(paginateGuard, op);
      return paginate(op, paginateGuard, fn, callArgs);
    }
    if (retryGuard) {
      recorder.fired(retryGuard, op);
      return retryWithReadBack(op, retryGuard, fn, callArgs, (callArgs[idx] ?? {}) as Record<string, unknown>);
    }
    return fn(...callArgs);
  }

  const wrap = <F extends AnyAsyncFn>(op: string, fn: F): F => {
    raw.set(op, fn);
    const g = (...args: unknown[]) => apply(op, fn, args);
    return g as unknown as F;
  };
  return wrap as Wrap;
}
