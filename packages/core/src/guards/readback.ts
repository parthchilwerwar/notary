/**
 * Read-back: decide from Dodo state whether a write whose outcome is unknown (timeout, 5xx, a crash
 * mid-call) actually landed. Used by the retry_policy guard, by the guarded executor, and by
 * `notary run --resume` for an item left in flight. A write is only ever retried when the read-back
 * PROVES it did not land: every listing is paginated to an empty page, and an incomplete listing
 * makes the outcome "unknown" (never retried).
 *
 * Each pending write carries a `pre` snapshot taken just before the write (the refunds already on the
 * payment, the subscription's product, the wallet's ledger entry ids), so "landed" means "something
 * new that matches this write appeared".
 */
import type { DodoTools, RefundListItem, ToolResult, WalletLedgerEntry } from "../tools/index.js";
import { ToolHttpError } from "../tools/index.js";

export const READBACK_PAGE_SIZE = 100;
export const READBACK_MAX_PAGES = 200;

export interface ListAllResult<T> {
  items: T[];
  /** True only when a page came back empty. */
  complete: boolean;
  problem?: string;
}

/**
 * Page until an EMPTY page (not a short one: a silently clamped page size would make a short page
 * look final). A page that adds nothing new means page_number stopped advancing: incomplete.
 */
export async function listAll<T>(
  fetchPage: (pageNumber: number, pageSize: number) => Promise<{ items: T[] }>,
  key: (item: T) => string,
  opts: { pageSize?: number; maxPages?: number; startPage?: number } = {},
): Promise<ListAllResult<T>> {
  const pageSize = opts.pageSize ?? READBACK_PAGE_SIZE;
  const maxPages = opts.maxPages ?? READBACK_MAX_PAGES;
  const seen = new Map<string, T>();
  const start = opts.startPage ?? 0;
  for (let page = start; page < start + maxPages; page++) {
    const { items } = await fetchPage(page, pageSize);
    if (!Array.isArray(items) || items.length === 0) return { items: [...seen.values()], complete: true };
    let added = 0;
    for (const it of items) {
      const k = key(it);
      if (!seen.has(k)) {
        seen.set(k, it);
        added++;
      }
    }
    if (added === 0) return { items: [...seen.values()], complete: false, problem: `page ${page} added nothing new (page_number not advancing)` };
  }
  return { items: [...seen.values()], complete: false, problem: `no empty page within ${maxPages} pages` };
}

/** The read ops a read-back needs (guarded or raw). */
export type ReadFns = Partial<Pick<DodoTools, "getPayment" | "listRefunds" | "getSubscription" | "listWalletLedgerEntries">>;

/** Called for every read a read-back makes (so it can be recorded as a Decision effect). */
export type OnRead = (op: string, params: Record<string, unknown>, status: number | null) => void;

export type PendingWrite =
  | {
      op: "dodo.createRefund";
      paymentId: string;
      customerId: string;
      /** Minor units the refund moves, when known (a full refund of a known payment total). */
      amount?: number;
      params: Record<string, unknown>;
      pre: { refundIds: string[] };
    }
  | {
      op: "dodo.changeSubscriptionPlan";
      subscriptionId: string;
      productId: string;
      params: Record<string, unknown>;
      pre: { productId: string | null; scheduledProductId: string | null };
    }
  | {
      op: "dodo.createWalletLedgerEntry";
      customerId: string;
      amount: number;
      currency: string;
      params: Record<string, unknown>;
      pre: { entryIds: string[] };
    };

export interface ReadBackResult {
  outcome: "landed" | "not_landed" | "unknown";
  resultId?: string;
  detail: string;
}

async function tracked<T>(op: string, params: Record<string, unknown>, onRead: OnRead | undefined, call: () => Promise<ToolResult<T>>): Promise<T> {
  try {
    const res = await call();
    onRead?.(op, params, res.status);
    return res.data;
  } catch (err) {
    onRead?.(op, params, err instanceof ToolHttpError ? err.status : null);
    throw err;
  }
}

function need<K extends keyof ReadFns>(fns: ReadFns, k: K): NonNullable<ReadFns[K]> {
  const f = fns[k];
  if (!f) throw new Error(`read-back needs ${String(k)}`);
  return f as NonNullable<ReadFns[K]>;
}

/** Every non-failed refund on a payment: the customer's refunds fully paginated, plus the payment's refunds[]. */
export async function refundsForPayment(
  fns: ReadFns,
  paymentId: string,
  customerId: string | undefined,
  onRead?: OnRead,
): Promise<{ refunds: RefundListItem[]; complete: boolean; customerId: string | undefined; problem?: string }> {
  const getPayment = need(fns, "getPayment");
  const payment = await tracked("dodo.getPayment", { payment_id: paymentId }, onRead, () => getPayment(paymentId));
  const cid = customerId ?? payment.customer?.customer_id;
  const byId = new Map<string, RefundListItem>();
  for (const r of payment.refunds ?? []) if (r.status !== "failed") byId.set(r.refund_id, r);
  if (!cid) return { refunds: [...byId.values()], complete: false, customerId: cid, problem: "payment names no customer to list refunds for" };
  const listRefunds = need(fns, "listRefunds");
  const listed = await listAll<RefundListItem>(
    (page_number, page_size) => {
      const params = { customer_id: cid, page_size, page_number };
      return tracked("dodo.listRefunds", params, onRead, () => listRefunds(params));
    },
    (r) => r.refund_id,
  );
  for (const r of listed.items) if (r.payment_id === paymentId && r.status !== "failed") byId.set(r.refund_id, r);
  return {
    refunds: [...byId.values()],
    complete: listed.complete,
    customerId: cid,
    ...(listed.problem ? { problem: `refunds for ${cid}: ${listed.problem}` } : {}),
  };
}

/** All ledger entries of a customer's wallet (fully paginated). */
export async function ledgerEntries(
  fns: ReadFns,
  customerId: string,
  currency: string | undefined,
  onRead?: OnRead,
): Promise<ListAllResult<WalletLedgerEntry>> {
  const list = need(fns, "listWalletLedgerEntries");
  return listAll<WalletLedgerEntry>(
    (page_number, page_size) => {
      const params = { ...(currency ? { currency } : {}), page_size, page_number };
      return tracked("dodo.listWalletLedgerEntries", { customer_id: customerId, ...params }, onRead, () => list(customerId, params));
    },
    (e) => e.id,
  );
}

/** Decide from Dodo state whether `w` landed. See the header. */
export async function readBack(fns: ReadFns, w: PendingWrite, onRead?: OnRead): Promise<ReadBackResult> {
  if (w.op === "dodo.createRefund") {
    const r = await refundsForPayment(fns, w.paymentId, w.customerId, onRead);
    const pre = new Set(w.pre.refundIds);
    const fresh = r.refunds.filter((x) => !pre.has(x.refund_id));
    if (fresh.length) {
      return { outcome: "landed", resultId: fresh[0]!.refund_id, detail: `refund ${fresh[0]!.refund_id} (${fresh[0]!.status}) now exists on ${w.paymentId}` };
    }
    if (!r.complete) return { outcome: "unknown", detail: `no new refund seen, but the listing is incomplete (${r.problem ?? "unknown"})` };
    return { outcome: "not_landed", detail: `no new refund on ${w.paymentId} after a complete listing` };
  }
  if (w.op === "dodo.changeSubscriptionPlan") {
    const get = need(fns, "getSubscription");
    const sub = await tracked("dodo.getSubscription", { subscription_id: w.subscriptionId }, onRead, () => get(w.subscriptionId));
    const scheduled = sub.scheduled_change?.product_id ?? null;
    if (sub.product_id === w.productId && w.pre.productId !== w.productId) {
      return { outcome: "landed", detail: `subscription ${w.subscriptionId} is now on ${w.productId}` };
    }
    if (scheduled === w.productId && w.pre.scheduledProductId !== w.productId) {
      return { outcome: "landed", detail: `subscription ${w.subscriptionId} has a change to ${w.productId} scheduled` };
    }
    return { outcome: "not_landed", detail: `subscription ${w.subscriptionId} shows no change to ${w.productId}` };
  }
  const entries = await ledgerEntries(fns, w.customerId, w.currency, onRead);
  const pre = new Set(w.pre.entryIds);
  const fresh = entries.items.filter((e) => !pre.has(e.id) && e.is_credit && e.amount === w.amount);
  if (fresh.length) return { outcome: "landed", resultId: fresh[0]!.id, detail: `ledger entry ${fresh[0]!.id} (credit ${w.amount}) now exists` };
  if (!entries.complete) return { outcome: "unknown", detail: `no new ledger entry seen, but the listing is incomplete (${entries.problem ?? "unknown"})` };
  return { outcome: "not_landed", detail: `no new ${w.amount} credit for ${w.customerId} after a complete listing` };
}
