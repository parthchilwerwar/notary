/**
 * The ONLY public surface of src/tools. The raw Crustdata and Dodo clients are not exported:
 * every client method is reachable only as `wrap(opName, boundRawMethod)`. Today `wrap` defaults
 * to identity; P6 passes `guarded`, so nothing outside this module can call a raw method.
 */
import { CrustdataClient } from "./crustdata.js";
import { DodoClient } from "./dodo.js";
import { CreditLedger } from "./ledger.js";
import { Recorder, loadCassette } from "./recorder.js";
import type { Cassette, ExchangeListener, RecorderMode } from "./recorder.js";

export * from "./errors.js";
export { CreditLedger, DEFAULT_CREDIT_BUDGET, budgetFromEnv } from "./ledger.js";
export type { LedgerSnapshot } from "./ledger.js";
export {
  Recorder,
  Redactor,
  DEFAULT_CASSETTE_DIR,
  canonicalJson,
  collectSecrets,
  computeContentHash,
  listCassettes,
  loadCassette,
  saveCassette,
} from "./recorder.js";
export type {
  Cassette,
  Exchange,
  ExchangeListener,
  RecordedResponse,
  RecorderMode,
  RecorderOptions,
  RequestSpec,
} from "./recorder.js";
export type { ToolResult } from "./client.js";
export { CRUSTDATA_BASE_URL, CRUSTDATA_API_VERSION, CRUSTDATA_LIST_PRICE } from "./crustdata.js";
export type {
  CompanyData,
  CompanyIdentifiers,
  CompanyMatchResult,
  CreditBalance,
  EnrichCompanyParams,
  EnrichFieldGroup,
  IdentifyCompanyParams,
  IdentifyFieldGroup,
} from "./crustdata.js";
export { DODO_TEST_BASE_URL, DODO_LIVE_BASE_URL } from "./dodo.js";
export type {
  BillingAddress,
  CartItem,
  ChangePlanParams,
  ChangePlanResponse,
  CheckoutSession,
  CreateCheckoutSessionParams,
  CreateCustomerParams,
  CreatePaymentParams,
  CreatePaymentResponse,
  CreateProductParams,
  CreateRefundParams,
  Customer,
  CustomerRef,
  CustomerWallets,
  ListCustomersParams,
  ListLedgerEntriesParams,
  ListPaymentsParams,
  ListRefundsParams,
  ListResponse,
  OneTimePrice,
  PageParams,
  PartialRefundItem,
  Payment,
  PaymentListItem,
  Product,
  ProrationBillingMode,
  RecurringPrice,
  Refund,
  RefundListItem,
  RefundStatus,
  Subscription,
  TaxCategory,
  Wallet,
  WalletLedgerEntry,
  WalletLedgerEntryParams,
} from "./dodo.js";

// `any` is needed for a generic higher-order wrapper over arbitrary method signatures.
type AnyAsyncFn = (...args: any[]) => Promise<unknown>;

/** Wraps one client method. Must return a function with the same signature. */
export type Wrap = <F extends AnyAsyncFn>(op: string, fn: F) => F;

export const identityWrap: Wrap = (_op, fn) => fn;

/** Op name per public method. The single list of what each tool exposes. */
export const CRUSTDATA_OPS = {
  enrichCompany: "crustdata.enrichCompany",
  identifyCompany: "crustdata.identifyCompany",
  getCreditBalance: "crustdata.getCreditBalance",
} as const satisfies Partial<Record<keyof CrustdataClient, string>>;

export const DODO_OPS = {
  createCustomer: "dodo.createCustomer",
  listCustomers: "dodo.listCustomers",
  createProduct: "dodo.createProduct",
  createPayment: "dodo.createPayment",
  createCheckoutSession: "dodo.createCheckoutSession",
  getPayment: "dodo.getPayment",
  listPayments: "dodo.listPayments",
  createRefund: "dodo.createRefund",
  listRefunds: "dodo.listRefunds",
  getRefund: "dodo.getRefund",
  getSubscription: "dodo.getSubscription",
  changeSubscriptionPlan: "dodo.changeSubscriptionPlan",
  listCustomerWallets: "dodo.listCustomerWallets",
  createWalletLedgerEntry: "dodo.createWalletLedgerEntry",
  listWalletLedgerEntries: "dodo.listWalletLedgerEntries",
} as const satisfies Partial<Record<keyof DodoClient, string>>;

export const ALL_OPS: readonly string[] = [...Object.values(CRUSTDATA_OPS), ...Object.values(DODO_OPS)];

export type CrustdataTools = Pick<CrustdataClient, keyof typeof CRUSTDATA_OPS>;
export type DodoTools = Pick<DodoClient, keyof typeof DODO_OPS>;

export interface CreateToolsOptions {
  mode: RecorderMode;
  /**
   * live: cassette name to record into (written after every exchange; omit to keep in memory).
   * replay: cassette name to serve from.
   */
  cassette?: string;
  /** replay: more cassettes (names or loaded objects), served in order after `cassette`. */
  cassettes?: Array<string | Cassette>;
  cassetteDir?: string;
  ledger?: CreditLedger;
  wrap?: Wrap;
  onExchange?: ExchangeListener;
  /** Default process.env. Replay reads nothing from it. */
  env?: NodeJS.ProcessEnv;
  dodoBaseUrl?: string;
  crustdataBaseUrl?: string;
  timeoutMs?: number;
}

export interface Tools {
  crustdata: CrustdataTools;
  dodo: DodoTools;
  recorder: Recorder;
  ledger: CreditLedger;
}

function exposed<C extends object, M extends Record<string, string>>(client: C, ops: M, wrap: Wrap): Pick<C, keyof M & keyof C> {
  const out: Record<string, AnyAsyncFn> = {};
  for (const [method, op] of Object.entries(ops)) {
    const raw = (client as Record<string, unknown>)[method];
    if (typeof raw !== "function") throw new Error(`No method ${method} for op ${op}`);
    out[method] = wrap(op, (raw as AnyAsyncFn).bind(client));
  }
  return Object.freeze(out) as unknown as Pick<C, keyof M & keyof C>;
}

/**
 * Build the tool clients. Live mode constructs the Dodo client immediately, so a missing
 * NOTARY_MODE=test or a non-test base URL throws TestModeLockError here ("refuses to start").
 * Missing API keys throw MissingCredentialError only on the first live call.
 */
export function createTools(opts: CreateToolsOptions): Tools {
  const env = opts.mode === "replay" ? (opts.env ?? {}) : (opts.env ?? process.env);
  const dir = opts.cassetteDir;
  const loadOpts = dir === undefined ? {} : { dir };

  const cassettes: Cassette[] = [];
  if (opts.mode === "replay") {
    if (opts.cassette) cassettes.push(loadCassette(opts.cassette, loadOpts));
    for (const c of opts.cassettes ?? []) cassettes.push(typeof c === "string" ? loadCassette(c, loadOpts) : c);
  } else if (opts.cassettes?.length) {
    throw new Error("createTools: `cassettes` is for replay; in live mode pass `cassette` to record into");
  }

  const recorder = new Recorder({
    mode: opts.mode,
    cassettes,
    ...(opts.mode === "live" && opts.cassette ? { record: { name: opts.cassette } } : {}),
    ...(dir === undefined ? {} : { cassetteDir: dir }),
    ...(opts.onExchange ? { onExchange: opts.onExchange } : {}),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    env,
  });
  const ledger = opts.ledger ?? new CreditLedger({ env });
  const wrap = opts.wrap ?? identityWrap;

  const crustdata = new CrustdataClient({
    recorder,
    ledger,
    env,
    ...(opts.crustdataBaseUrl ? { baseUrl: opts.crustdataBaseUrl } : {}),
  });
  const dodo = new DodoClient({ recorder, ledger, env, ...(opts.dodoBaseUrl ? { baseUrl: opts.dodoBaseUrl } : {}) });

  return {
    crustdata: exposed(crustdata, CRUSTDATA_OPS, wrap),
    dodo: exposed(dodo, DODO_OPS, wrap),
    recorder,
    ledger,
  };
}
