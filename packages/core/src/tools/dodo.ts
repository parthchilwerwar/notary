/**
 * RAW Dodo Payments client. Not exported from src/tools/index.ts: callers get these methods only
 * through createTools(), which routes each one through `wrap` (guarded() from P6).
 *
 * Test-mode lock (TDD "Security and safety controls"): in live mode the constructor throws
 * TestModeLockError unless NOTARY_MODE === "test" AND the base URL is the documented test URL.
 * A non-test base URL is refused in replay too. The docs define no live-key prefix, so the key
 * itself can't be checked by shape (docs/ENDPOINTS.md, open question 6).
 *
 * Amounts are passed through untouched: this layer never converts units. Endpoints:
 * docs/ENDPOINTS.md.
 */
import { buildUrl, encodeId, requireEnv, send } from "./client.js";
import type { QueryValue, ToolResult } from "./client.js";
import { CassetteMissError, MissingCredentialError, RequestNotSentError, TestModeLockError } from "./errors.js";
import type { CreditLedger } from "./ledger.js";
import type { Recorder, RecorderMode } from "./recorder.js";

/** From docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode. */
export const DODO_TEST_BASE_URL = "https://test.dodopayments.com";
export const DODO_LIVE_BASE_URL = "https://live.dodopayments.com";
const TOOL = "dodo";

// ---------------------------------------------------------------------------------------------
// Params and responses (key fields only; everything else passes through)

type Loose = { [k: string]: unknown };
export type Metadata = Record<string, string | number | boolean>;

export interface PageParams {
  /** Default 10, max 100 (docs). */
  page_size?: number;
  /** Zero-based, default 0. */
  page_number?: number;
  created_at_gte?: string;
  created_at_lte?: string;
}

export interface ListResponse<T> {
  items: T[];
  [k: string]: unknown;
}

export interface Customer extends Loose {
  customer_id: string;
  business_id: string;
  name: string;
  email: string;
  created_at: string;
}

export interface CreateCustomerParams {
  name: string;
  email: string;
  phone_number?: string | null;
  metadata?: Metadata;
}

export interface ListCustomersParams extends PageParams {
  email?: string;
  name?: string;
}

export type TaxCategory = "digital_products" | "saas" | "e_book" | "edtech" | "live_tutoring";
export type Interval = "Day" | "Week" | "Month" | "Year";

export interface OneTimePrice extends Loose {
  type: "one_time_price";
  /** Smallest currency unit (100 = $1.00). */
  price: number;
  currency: string;
  discount_bps?: number;
  purchasing_power_parity?: boolean;
  pay_what_you_want?: boolean;
  tax_inclusive?: boolean | null;
}

export interface RecurringPrice extends Loose {
  type: "recurring_price";
  /** Smallest currency unit. */
  price: number;
  currency: string;
  payment_frequency_count: number;
  payment_frequency_interval: Interval;
  subscription_period_count: number;
  subscription_period_interval: Interval;
  discount_bps?: number;
  purchasing_power_parity?: boolean;
  tax_inclusive?: boolean | null;
  trial_period_days?: number;
}

export interface CreateProductParams {
  name: string;
  tax_category: TaxCategory;
  price: OneTimePrice | RecurringPrice;
  description?: string | null;
  metadata?: Metadata;
}

export interface Product extends Loose {
  product_id: string;
  is_recurring: boolean;
  price: OneTimePrice | RecurringPrice;
}

export type CustomerRef = { customer_id: string } | { email: string; name?: string; phone_number?: string | null };

export interface BillingAddress {
  country: string;
  city?: string | null;
  state?: string | null;
  street?: string | null;
  zipcode?: string | null;
}

export interface CartItem {
  product_id: string;
  quantity: number;
  /** Pay-what-you-want only; smallest currency unit. */
  amount?: number | null;
}

export interface CreatePaymentParams {
  product_cart: CartItem[];
  customer: CustomerRef;
  billing: BillingAddress;
  payment_link?: boolean | null;
  return_url?: string | null;
  discount_codes?: string[] | null;
  metadata?: Metadata;
  [k: string]: unknown;
}

export interface CreatePaymentResponse extends Loose {
  payment_id: string;
  /** Smallest currency unit. */
  total_amount: number;
  payment_link?: string | null;
}

export interface CreateCheckoutSessionParams {
  product_cart: Array<{ product_id: string; quantity: number }>;
  customer?: CustomerRef;
  billing_address?: BillingAddress;
  return_url?: string | null;
  confirm?: boolean;
  discount_codes?: string[] | null;
  metadata?: Metadata;
  [k: string]: unknown;
}

export interface CheckoutSession extends Loose {
  session_id: string;
  checkout_url?: string | null;
  payment_id?: string | null;
}

export type RefundStatus = "succeeded" | "failed" | "pending" | "review";

export interface RefundListItem extends Loose {
  refund_id: string;
  payment_id: string;
  status: RefundStatus;
  created_at: string;
  is_partial: boolean;
  amount?: number | null;
  currency?: string | null;
}

export interface Payment extends Loose {
  payment_id: string;
  /** Smallest currency unit. */
  total_amount: number;
  currency: string;
  status?: string | null;
  refunds: RefundListItem[];
  customer: Loose & { customer_id: string };
  product_cart?: Array<{ product_id: string; quantity: number }> | null;
}

export interface PaymentListItem extends Loose {
  payment_id: string;
  total_amount: number;
  currency: string;
  status?: string | null;
  /** "partial" | "full" | null — a summary, not the refunds themselves. */
  refund_status?: "partial" | "full" | null;
  customer: Loose & { customer_id: string };
}

export interface ListPaymentsParams extends PageParams {
  customer_id?: string;
  subscription_id?: string;
  status?: string;
  product_id?: string;
  brand_id?: string;
  currency?: string;
}

export interface PartialRefundItem {
  /** Product or addon id. */
  item_id: string;
  /** Unit not stated in the API schema (guide says smallest unit); null/absent refunds the whole item. */
  amount?: number | null;
  tax_inclusive?: boolean;
}

export interface CreateRefundParams {
  payment_id: string;
  items?: PartialRefundItem[] | null;
  reason?: string | null;
  metadata?: Metadata;
}

export interface Refund extends RefundListItem {
  business_id: string;
  customer: Loose & { customer_id: string };
}

export interface ListRefundsParams extends PageParams {
  status?: RefundStatus;
  subscription_id?: string;
  customer_id?: string;
}

export interface Subscription extends Loose {
  subscription_id: string;
  status: string;
  product_id: string;
  quantity: number;
  /** Smallest currency unit. */
  recurring_pre_tax_amount: number;
  currency: string;
  next_billing_date: string;
  previous_billing_date: string;
  scheduled_change?: (Loose & { product_id: string; effective_at: string }) | null;
}

export type ProrationBillingMode = "prorated_immediately" | "full_immediately" | "difference_immediately" | "do_not_bill";

export interface ChangePlanParams {
  product_id: string;
  quantity: number;
  proration_billing_mode: ProrationBillingMode;
  effective_at?: "immediately" | "next_billing_date";
  on_payment_failure?: "prevent_change" | "apply_change";
  addons?: Array<{ addon_id: string; quantity: number }> | null;
  discount_codes?: string[] | null;
  metadata?: Metadata | null;
  [k: string]: unknown;
}

export interface ChangePlanResponse extends Loose {
  payment_id?: string | null;
  payment_link?: string | null;
}

export interface Wallet extends Loose {
  customer_id: string;
  currency: string;
  balance: number;
}

export interface CustomerWallets extends Loose {
  items: Wallet[];
  total_balance_usd: number;
}

export interface WalletLedgerEntryParams {
  /** Smallest currency unit per the wallet guide (the schema omits the unit). */
  amount: number;
  currency: string;
  entry_type: "credit" | "debit";
  idempotency_key?: string | null;
  reason?: string | null;
}

export interface WalletLedgerEntry extends Loose {
  id: string;
  amount: number;
  is_credit: boolean;
  event_type: string;
  before_balance: number;
  after_balance: number;
}

export interface ListLedgerEntriesParams {
  currency?: string;
  page_size?: number;
  page_number?: number;
}

// ---------------------------------------------------------------------------------------------

export interface DodoClientOptions {
  recorder: Recorder;
  ledger: CreditLedger;
  /** Default: DODO_BASE_URL (live) or the documented test URL (replay). */
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Throws TestModeLockError unless this configuration is allowed to run. */
export function assertTestMode(mode: RecorderMode, baseUrl: string, env: NodeJS.ProcessEnv): void {
  if (mode === "live" && env.NOTARY_MODE?.trim() !== "test") {
    throw new TestModeLockError(`NOTARY_MODE must be "test" (got ${env.NOTARY_MODE ? JSON.stringify(env.NOTARY_MODE) : "unset"})`);
  }
  if (normalizeBase(baseUrl) !== DODO_TEST_BASE_URL) {
    throw new TestModeLockError(`base URL must be ${DODO_TEST_BASE_URL} (got ${baseUrl})`);
  }
}

export class DodoClient {
  private readonly recorder: Recorder;
  private readonly ledger: CreditLedger;
  private readonly baseUrl: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: DodoClientOptions) {
    this.recorder = opts.recorder;
    this.ledger = opts.ledger;
    this.env = opts.env ?? process.env;
    const configured =
      opts.baseUrl ?? (opts.recorder.mode === "live" ? this.env.DODO_BASE_URL?.trim() || DODO_TEST_BASE_URL : DODO_TEST_BASE_URL);
    assertTestMode(opts.recorder.mode, configured, this.env);
    this.baseUrl = normalizeBase(configured);
  }

  // Customers
  createCustomer(params: CreateCustomerParams): Promise<ToolResult<Customer>> {
    return this.call("dodo.createCustomer", "POST", "/customers", { body: params });
  }
  listCustomers(params: ListCustomersParams = {}): Promise<ToolResult<ListResponse<Customer>>> {
    return this.call("dodo.listCustomers", "GET", "/customers", { query: { ...params } });
  }

  // Products
  createProduct(params: CreateProductParams): Promise<ToolResult<Product>> {
    return this.call("dodo.createProduct", "POST", "/products", { body: params });
  }

  // Payments
  /** POST /payments — documented as deprecated in favour of checkout sessions; still returns a payment_id. */
  createPayment(params: CreatePaymentParams): Promise<ToolResult<CreatePaymentResponse>> {
    return this.call("dodo.createPayment", "POST", "/payments", { body: params });
  }
  createCheckoutSession(params: CreateCheckoutSessionParams): Promise<ToolResult<CheckoutSession>> {
    return this.call("dodo.createCheckoutSession", "POST", "/checkouts", { body: params });
  }
  getPayment(paymentId: string): Promise<ToolResult<Payment>> {
    return this.call("dodo.getPayment", "GET", `/payments/${encodeId(paymentId)}`, {});
  }
  listPayments(params: ListPaymentsParams = {}): Promise<ToolResult<ListResponse<PaymentListItem>>> {
    return this.call("dodo.listPayments", "GET", "/payments", { query: { ...params } });
  }

  // Refunds
  createRefund(params: CreateRefundParams): Promise<ToolResult<Refund>> {
    return this.call("dodo.createRefund", "POST", "/refunds", { body: params });
  }
  listRefunds(params: ListRefundsParams = {}): Promise<ToolResult<ListResponse<RefundListItem>>> {
    return this.call("dodo.listRefunds", "GET", "/refunds", { query: { ...params } });
  }
  getRefund(refundId: string): Promise<ToolResult<Refund>> {
    return this.call("dodo.getRefund", "GET", `/refunds/${encodeId(refundId)}`, {});
  }

  // Subscriptions
  getSubscription(subscriptionId: string): Promise<ToolResult<Subscription>> {
    return this.call("dodo.getSubscription", "GET", `/subscriptions/${encodeId(subscriptionId)}`, {});
  }
  changeSubscriptionPlan(subscriptionId: string, params: ChangePlanParams): Promise<ToolResult<ChangePlanResponse>> {
    return this.call("dodo.changeSubscriptionPlan", "POST", `/subscriptions/${encodeId(subscriptionId)}/change-plan`, {
      body: params,
    });
  }

  // Credits: customer wallet ledger
  listCustomerWallets(customerId: string): Promise<ToolResult<CustomerWallets>> {
    return this.call("dodo.listCustomerWallets", "GET", `/customers/${encodeId(customerId)}/wallets`, {});
  }
  createWalletLedgerEntry(customerId: string, params: WalletLedgerEntryParams): Promise<ToolResult<Wallet>> {
    return this.call("dodo.createWalletLedgerEntry", "POST", `/customers/${encodeId(customerId)}/wallets/ledger-entries`, {
      body: params,
    });
  }
  listWalletLedgerEntries(customerId: string, params: ListLedgerEntriesParams = {}): Promise<ToolResult<ListResponse<WalletLedgerEntry>>> {
    return this.call("dodo.listWalletLedgerEntries", "GET", `/customers/${encodeId(customerId)}/wallets/ledger-entries`, {
      query: { ...params },
    });
  }

  private async call<T>(
    op: string,
    method: string,
    path: string,
    req: { body?: unknown; query?: Record<string, QueryValue> },
  ): Promise<ToolResult<T>> {
    try {
      const { result } = await send<T>(this.recorder, {
        tool: TOOL,
        op,
        method,
        url: buildUrl(this.baseUrl, path, req.query),
        body: req.body,
        headers: () => ({ authorization: `Bearer ${requireEnv(this.env, "DODO_PAYMENTS_API_KEY")}` }),
      });
      this.ledger.countCall(op);
      return result;
    } catch (err) {
      // Count every call that reached the API (HTTP or network errors), not ones never sent.
      if (!(err instanceof MissingCredentialError || err instanceof CassetteMissError || err instanceof RequestNotSentError)) this.ledger.countCall(op);
      throw err;
    }
  }
}
