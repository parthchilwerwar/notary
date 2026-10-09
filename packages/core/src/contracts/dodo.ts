/**
 * Dodo Payments contract: documented promises (Claims) for the endpoints behind Notary's refund,
 * plan-change and credit actions, each with the cheapest test-mode recon that exercises it. Doc
 * text is quoted verbatim from docs.dodopayments.com (read Oct 10, 2026).
 *
 * Path ids: ops whose URL carries an id take it from the param named in RECON_PATH_PARAMS
 * (index.ts), e.g. dodo.getPayment {payment_id}; the remaining params are the body or query.
 *
 * State: a refund needs a SUCCEEDED payment and a plan change needs an ACTIVE subscription. Test
 * mode cannot create either without a hosted checkout (docs/ENDPOINTS.md open question 5), so those
 * claims have `recon: []` and are observed from the P3 seeded world and queue traffic.
 */
import type { ContractEntry, ReconStep } from "./types.js";

const DOCS = "https://docs.dodopayments.com";
const REFUND_CREATE_URL = `${DOCS}/api-reference/refunds/post-refunds.md`;
const REFUND_LIST_URL = `${DOCS}/api-reference/refunds/get-refunds.md`;
const REFUND_GUIDE_URL = `${DOCS}/features/transactions/refunds.md`;
const PAYMENT_GET_URL = `${DOCS}/api-reference/payments/get-payments-1.md`;
const PAYMENT_LIST_URL = `${DOCS}/api-reference/payments/get-payments.md`;
const PRODUCT_CREATE_URL = `${DOCS}/api-reference/products/post-products.md`;
const CUSTOMER_CREATE_URL = `${DOCS}/api-reference/customers/create-customer.md`;
const CHANGE_PLAN_URL = `${DOCS}/api-reference/subscriptions/change-plan.md`;
const WALLET_GUIDE_URL = `${DOCS}/features/customer-wallet.md`;
const WALLET_LEDGER_CREATE_URL = `${DOCS}/api-reference/customers/post-customer-wallets-ledger-entries.md`;
const WALLETS_LIST_URL = `${DOCS}/api-reference/customers/get-customer-wallets.md`;

/** A fresh test customer; every wallet claim starts from a zero balance. */
function freshCustomer(tag: string): ReconStep {
  return {
    op: "dodo.createCustomer",
    params: { name: `Notary recon ${tag}`, email: `recon+${tag}@notary.test` },
    setup: true,
    note: "Create a fresh test customer (empty wallets)",
  };
}

const oneTimeProduct: ReconStep = {
  op: "dodo.createProduct",
  params: {
    name: "Notary recon one-time 12.34",
    tax_category: "saas",
    price: { type: "one_time_price", price: 1234, currency: "USD", discount_bps: 0, purchasing_power_parity: false },
  },
  note: "Create a one-time USD product priced 1234 (= $12.34 if minor units)",
};

/** The same product step as a setup step (when the claim is about something downstream). */
const oneTimeProductSetup: ReconStep = { ...oneTimeProduct, setup: true };

export const dodoContract: ContractEntry[] = [
  // ---------------------------------------------------------------- refunds
  {
    // suspect: unit_mismatch (items[].amount read as major units, i.e. 100x the intended refund)
    claim: {
      id: "dodo.refund.amount-minor-units",
      tool: "dodo",
      operation: "dodo.createRefund",
      param: "items[].amount",
      docText: "the `amount` to refund in the smallest currency unit.",
      expect: { kind: "unit", field: "amount", unit: "minor" },
      docUrl: REFUND_GUIDE_URL,
      endpoint: "POST /refunds",
      costCredits: 0,
    },
    // Observed from seeded/queue traffic: needs a succeeded payment (P3 seed).
    recon: [],
  },
  {
    // suspect: idempotency_hazard (a retried full refund after a timeout creates a second refund)
    claim: {
      id: "dodo.refund.full-retry-no-duplicate",
      tool: "dodo",
      operation: "dodo.createRefund",
      param: "refund_id",
      docText:
        "[implied] The refund, together with any earlier refunds on the payment, can't exceed the amount paid.",
      expect: { kind: "idempotentOnRetry" },
      docUrl: REFUND_GUIDE_URL,
      endpoint: "POST /refunds",
      costCredits: 0,
    },
    // Observed from seeded/queue traffic: a full refund repeated on a seeded succeeded payment
    // (P4 retry_after_timeout probe). No Idempotency-Key header is documented.
    recon: [],
  },
  {
    // suspect: silent_coercion (partial-refund amount rounded or returned as a float)
    claim: {
      id: "dodo.refunds.amount-integer",
      tool: "dodo",
      operation: "dodo.listRefunds",
      param: "",
      docText: "amount: integer or null (int32). The refunded amount.",
      expect: { kind: "type", field: "items[].amount", type: "integer|null" },
      docUrl: REFUND_LIST_URL,
      endpoint: "GET /refunds",
      costCredits: 0,
    },
    recon: [{ op: "dodo.listRefunds", params: { page_size: 100 }, note: "List refunds (first page, max size)" }],
  },
  {
    // suspect: silent_truncation (page_size above 100 accepted and silently clamped)
    claim: {
      id: "dodo.refunds.page-size-max-100",
      tool: "dodo",
      operation: "dodo.listRefunds",
      param: "page_size",
      docText: "Page size default is 10 max is 100",
      expect: { kind: "maxItems", max: 100 },
      docUrl: REFUND_LIST_URL,
      endpoint: "GET /refunds",
      costCredits: 0,
    },
    recon: [
      { op: "dodo.listRefunds", params: { page_size: 100 }, note: "Max documented page size" },
      { op: "dodo.listRefunds", params: { page_size: 101 }, note: "One over the documented max" },
    ],
  },

  // ---------------------------------------------------------------- payments
  {
    // suspect: silent_truncation (page_size above 100 accepted and silently clamped)
    claim: {
      id: "dodo.payments.page-size-max-100",
      tool: "dodo",
      operation: "dodo.listPayments",
      param: "page_size",
      docText: "Page size default is 10 max is 100",
      expect: { kind: "maxItems", max: 100 },
      docUrl: PAYMENT_LIST_URL,
      endpoint: "GET /payments",
      costCredits: 0,
    },
    recon: [
      { op: "dodo.listPayments", params: { page_size: 100 }, note: "Max documented page size" },
      { op: "dodo.listPayments", params: { page_size: 101 }, note: "One over the documented max" },
    ],
  },
  {
    // suspect: honored (control) — refunds[] is a required field on a single payment
    claim: {
      id: "dodo.payment.refunds-array-present",
      tool: "dodo",
      operation: "dodo.getPayment",
      param: "payment_id",
      docText: "refunds: List of refunds issued for this payment (required)",
      expect: { kind: "fieldPresent", field: "refunds" },
      docUrl: PAYMENT_GET_URL,
      endpoint: "GET /payments/{payment_id}",
      costCredits: 0,
    },
    recon: [
      oneTimeProductSetup,
      {
        op: "dodo.createPayment",
        params: {
          product_cart: [{ product_id: "$from:0:product_id", quantity: 1 }],
          customer: { email: "recon+payment@notary.test", name: "Notary recon payment" },
          billing: { country: "US" },
          payment_link: true,
        },
        setup: true,
        note: "Create an (unpaid) one-time payment for the product",
      },
      { op: "dodo.getPayment", params: { payment_id: "$from:1:payment_id" }, note: "Read the payment back" },
    ],
  },
  {
    // suspect: eventual_consistency (a fresh refund missing from the payment's refunds[] precheck)
    claim: {
      id: "dodo.payment.refunds-lists-issued-refund",
      tool: "dodo",
      operation: "dodo.createRefund",
      param: "refund_id",
      docText: "[implied] refunds: List of refunds issued for this payment",
      expect: { kind: "consistentWithin", ms: 1000 },
      docUrl: PAYMENT_GET_URL,
      endpoint: "POST /refunds",
      costCredits: 0,
    },
    // Observed from seeded/queue traffic: createRefund on a seeded succeeded payment followed by
    // getPayment reads (P4 write_then_read probe).
    recon: [],
  },

  // ---------------------------------------------------------------- products / customers
  {
    // suspect: honored (control) — product price round-trips in minor units
    claim: {
      id: "dodo.product.price-minor-units",
      tool: "dodo",
      operation: "dodo.createProduct",
      param: "price.price",
      docText: "The payment amount, in the smallest denomination of the currency (e.g., cents for USD).",
      expect: { kind: "unit", field: "price.price", unit: "minor" },
      docUrl: PRODUCT_CREATE_URL,
      endpoint: "POST /products",
      costCredits: 0,
    },
    recon: [oneTimeProduct],
  },
  {
    // suspect: silent_coercion (a customer created without its required email)
    claim: {
      id: "dodo.customer.missing-email-422",
      tool: "dodo",
      operation: "dodo.createCustomer",
      param: "email",
      docText: "required: name, email. 422: Invalid Request Object or Parameters",
      expect: { kind: "statusOnError", status: 422 },
      docUrl: CUSTOMER_CREATE_URL,
      endpoint: "POST /customers",
      costCredits: 0,
    },
    recon: [
      { op: "dodo.createCustomer", params: { name: "Notary recon no email" }, note: "Omit the required email" },
    ],
  },

  // ---------------------------------------------------------------- subscriptions
  {
    // suspect: idempotency_hazard (a retried change-plan stacks a second change instead of 409)
    claim: {
      id: "dodo.subscription.change-plan-pending-409",
      tool: "dodo",
      operation: "dodo.changeSubscriptionPlan",
      param: "subscription_id",
      docText: "409: A pending plan change already exists for this subscription (PendingPlanChangeExists).",
      expect: { kind: "statusOnError", status: 409 },
      docUrl: CHANGE_PLAN_URL,
      endpoint: "POST /subscriptions/{subscription_id}/change-plan",
      costCredits: 0,
    },
    // Observed from seeded/queue traffic: needs an active seeded subscription with a pending change.
    recon: [],
  },

  // ---------------------------------------------------------------- wallet credits
  {
    // suspect: unit_mismatch (credit amount treated as major units: 1000 -> $1000 instead of $10)
    claim: {
      id: "dodo.wallet.credit-amount-minor-units",
      tool: "dodo",
      operation: "dodo.createWalletLedgerEntry",
      param: "amount",
      docText: "`amount` is a positive integer in the smallest currency unit.",
      // Fresh customer, so the returned wallet balance must equal the credited amount. Only valid on
      // this crafted recon: on queue traffic a non-empty wallet makes balance != amount.
      expect: { kind: "unit", field: "balance", unit: "minor" },
      docUrl: WALLET_GUIDE_URL,
      endpoint: "POST /customers/{customer_id}/wallets/ledger-entries",
      costCredits: 0,
    },
    recon: [
      freshCustomer("wallet-unit"),
      {
        op: "dodo.createWalletLedgerEntry",
        params: { customer_id: "$from:0:customer_id", amount: 1000, currency: "USD", entry_type: "credit", reason: "notary recon unit" },
        note: "Credit 1000 to an empty USD wallet; balance should read 1000",
      },
    ],
  },
  {
    // suspect: idempotency_hazard (same idempotency_key creates duplicate ledger entries)
    claim: {
      id: "dodo.wallet.idempotency-key-no-duplicate",
      tool: "dodo",
      operation: "dodo.createWalletLedgerEntry",
      param: "",
      docText: "If you repeat a request with the same key, Dodo Payments creates no new entry and returns the current wallet.",
      // The ledger of a fresh customer after N identical keyed credits must list at most 1 entry.
      expect: { kind: "maxItems", max: 1 },
      docUrl: WALLET_GUIDE_URL,
      endpoint: "POST /customers/{customer_id}/wallets/ledger-entries",
      costCredits: 0,
    },
    recon: [
      freshCustomer("wallet-idem"),
      {
        op: "dodo.createWalletLedgerEntry",
        params: {
          customer_id: "$from:0:customer_id",
          amount: 500,
          currency: "USD",
          entry_type: "credit",
          idempotency_key: "notary-recon-wallet-idem-1",
          reason: "notary recon idempotency",
        },
        repeat: 3,
        note: "Send the same keyed credit three times",
      },
      {
        op: "dodo.listWalletLedgerEntries",
        params: { customer_id: "$from:0:customer_id", currency: "USD" },
        delayMs: 1000,
        note: "Count ledger entries; expect exactly one",
      },
    ],
  },
  {
    // suspect: honored (control) — overdraft is refused
    claim: {
      id: "dodo.wallet.debit-insufficient-400",
      tool: "dodo",
      operation: "dodo.createWalletLedgerEntry",
      param: "entry_type",
      docText: "A debit larger than the balance fails with `400`.",
      expect: { kind: "statusOnError", status: 400 },
      docUrl: WALLET_GUIDE_URL,
      endpoint: "POST /customers/{customer_id}/wallets/ledger-entries",
      costCredits: 0,
    },
    recon: [
      freshCustomer("wallet-debit"),
      {
        op: "dodo.createWalletLedgerEntry",
        params: { customer_id: "$from:0:customer_id", amount: 500, currency: "USD", entry_type: "debit", reason: "notary recon overdraft" },
        note: "Debit 500 from an empty USD wallet",
      },
    ],
  },
  {
    // suspect: honored (control) — aggregate balance is an integer in minor units
    claim: {
      id: "dodo.wallets.total-balance-usd-integer",
      tool: "dodo",
      operation: "dodo.listCustomerWallets",
      param: "customer_id",
      docText: "total_balance_usd: integer (int64). Sum of all wallet balances converted to USD (in smallest unit)",
      expect: { kind: "type", field: "total_balance_usd", type: "integer" },
      docUrl: WALLETS_LIST_URL,
      endpoint: "GET /customers/{customer_id}/wallets",
      costCredits: 0,
    },
    recon: [
      freshCustomer("wallet-list"),
      { op: "dodo.listCustomerWallets", params: { customer_id: "$from:0:customer_id" }, note: "Read wallets of a fresh customer" },
    ],
  },
  {
    // suspect: silent_coercion (wallet balance returned as a decimal major-unit amount)
    claim: {
      id: "dodo.wallet.ledger-response-balance-integer",
      tool: "dodo",
      operation: "dodo.createWalletLedgerEntry",
      param: "",
      docText: "balance: integer (int64) (CustomerWalletResponse)",
      expect: { kind: "type", field: "balance", type: "integer" },
      docUrl: WALLET_LEDGER_CREATE_URL,
      endpoint: "POST /customers/{customer_id}/wallets/ledger-entries",
      costCredits: 0,
    },
    recon: [
      freshCustomer("wallet-type"),
      {
        op: "dodo.createWalletLedgerEntry",
        params: { customer_id: "$from:0:customer_id", amount: 250, currency: "EUR", entry_type: "credit", reason: "notary recon type" },
        note: "Credit 250 to an empty EUR wallet",
      },
    ],
  },
];
