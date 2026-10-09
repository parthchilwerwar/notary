# Endpoints

The endpoints Notary's raw clients call (`packages/core/src/tools/`), read from the official docs on Oct 10, 2026. Everything here is what the docs say, not what the wire does. P2 checks these claims against live responses, so where the docs are silent this file says so instead of guessing.

## Crustdata

Docs: https://docs.crustdata.com (API version `2025-11-01`).

- **Base URL:** `https://api.crustdata.com` ([API introduction](https://docs.crustdata.com/openapi-specs/2025-11-01/introduction.md)).
- **Auth:** `authorization: Bearer <key>` plus `x-api-version: 2025-11-01` on every request. Without the version header the API "may default to the latest version"; `/account/credits` returns `400` if it is missing.
- **Errors:** JSON `{ "error", "description" }`.
- **Credits:** every response carries `X-Credits-Used`, a decimal string, "on success and error responses". It is `0` when nothing was deducted and absent on `429` ([pricing](https://docs.crustdata.com/general/pricing.md)). The client settles the ledger from this header and falls back to the documented list price when it is absent. List prices "can change by plan, entitlement, and endpoint version".

| Op | Method and path | Purpose for Notary | Key params | Credit cost (list price) | Rate limit | Doc |
| --- | --- | --- | --- | --- | --- | --- |
| `crustdata.enrichCompany` | `POST /company/enrich` | Tier a customer's company (SMB, mid-market, enterprise) from headcount and funding | Exactly one identifier type: `domains[]` (or `names`, `crustdata_company_ids`, `professional_network_profile_urls`); `fields[]` (field groups; `headcount` and `funding` "must be listed explicitly", otherwise only `crustdata_company_id` and `basic_info` come back); `exact_match` (null = auto) | 2 per record; `technographics` adds 2 per company that returns technographics data | 15/min | [endpoint](https://docs.crustdata.com/api-reference/company-apis/get-full-company-enrichment.md), [reference](https://docs.crustdata.com/company-docs/enrichment/reference.md) |
| `crustdata.identifyCompany` | `POST /company/identify` | Cheap check that a domain resolves to a company before paying for enrichment | Same identifier types, 1 to 25 values; `fields[]` limited to `crustdata_company_id`, `basic_info`, `social_profiles` | Free | 30/min | [endpoint](https://docs.crustdata.com/api-reference/company-apis/identify-a-company-from-name-domain-id-or-profile-url.md) |
| `crustdata.getCreditBalance` | `GET /account/credits` | Record the account balance at run start and end | none | Free | 300/min | [endpoint](https://docs.crustdata.com/api-reference/account-apis/get-account-credit-balance.md) |

**Response shapes.** Enrich and identify both return a top-level array, one entry per submitted identifier: `{ matched_on, match_type, matches: [{ confidence_score, company_data }] }`. No match is `200` with `matches: []`. Fields the policy reads: `headcount.total` (nullable integer), `basic_info.employee_count_range` (string, for example `51-200`), `market_intel.num_employees_min` / `num_employees_max`, `funding.total_investment_usd`, `funding.last_round_type`, `funding.last_fundraise_date`. Credit balance returns `{ account: { credits, recurring_credits, ... } }`.

**Pagination.** None on these three endpoints.

## Dodo Payments

Docs: https://docs.dodopayments.com/api-reference/introduction.md

- **Base URLs:** test `https://test.dodopayments.com`, live `https://live.dodopayments.com` ([test vs live](https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode.md)). This matches the `DODO_BASE_URL` default in `.env.example`; no change needed.
- **Auth:** `Authorization: Bearer <key>`. A test key only works against the test URL and a live key only against the live URL. **The docs define no key prefix** for test or live keys, so the client cannot refuse a live key by its shape; the test-mode lock relies on `NOTARY_MODE=test` plus the base URL.
- **Data separation:** products, payments, refunds and webhooks are separate per mode; account settings, business profile and bank account are shared between modes.
- **Rate limits:** default 40/s burst, 240/min sustained; `429` with `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- **Amount units:** fields such as `total_amount`, `settlement_amount`, product `price` and `recurring_pre_tax_amount` are documented as "in the currency's smallest unit" (cents for USD). The refund feature guide says refund amounts are passed "in the smallest currency unit", but the refund API schema itself states no unit for `items[].amount`.
- **Pagination (list endpoints):** `page_size` (default 10, max 100) and `page_number` (zero-based, default 0). The response is `{ items: [...] }` with **no `has_more`, `total` or cursor**, so the docs give no way to detect the last page other than a short page. `GET /payments` notes `page_number` is "capped to limit deep OFFSET pagination" without saying where.
- **Idempotency:** the API reference and docs index mention **no `Idempotency-Key` header** for any endpoint. The only documented idempotency mechanism is the `idempotency_key` body field on wallet ledger entries.
- **Credits:** none. Dodo calls are counted per op in the ledger (`calls`), not charged.

| Op | Method and path | Purpose for Notary | Key params | Pagination | Doc |
| --- | --- | --- | --- | --- | --- |
| `dodo.createCustomer` | `POST /customers` | Seed test customers | `name`, `email` (required); `phone_number`, `metadata` | n/a | [create](https://docs.dodopayments.com/api-reference/customers/create-customer.md) |
| `dodo.listCustomers` | `GET /customers` | Find seeded customers | `email`, `name` (partial, case-insensitive), `created_at_gte/lte` | page_size ≤ 100 | [list](https://docs.dodopayments.com/api-reference/customers/get-customers.md) |
| `dodo.createProduct` | `POST /products` | Seed one-time and recurring products for payments and plan changes | `name`, `tax_category` (`digital_products`, `saas`, `e_book`, `edtech`, `live_tutoring`), `price` with `type` `one_time_price` or `recurring_price`; `price.price` is smallest unit ("100 = $1.00"); `discount_bps` (basis points) | n/a | [create](https://docs.dodopayments.com/api-reference/products/post-products.md) |
| `dodo.createPayment` | `POST /payments` | Seed a one-time payment; returns `payment_id` and, with `payment_link: true`, a link to complete it with a test card | `product_cart[]` (1–100 of `{product_id, quantity}`), `customer` (`{customer_id}` or `{email, name}`), `billing.country`, `payment_link`, `return_url` | n/a | [create](https://docs.dodopayments.com/api-reference/payments/post-payments.md) — **marked deprecated**, docs point to Checkout Sessions |
| `dodo.createCheckoutSession` | `POST /checkouts` | The documented replacement for `createPayment`; returns `session_id` and `checkout_url`; `payment_id` only when `confirm: true` created one | `product_cart[]` (≤ 20), `customer`, `billing_address.country`, `return_url`, `confirm` | n/a | [create](https://docs.dodopayments.com/api-reference/checkout-sessions/create.md) |
| `dodo.getPayment` | `GET /payments/{payment_id}` | Read a payment with its `refunds[]` array (the precheck before a refund) | path id | n/a | [get](https://docs.dodopayments.com/api-reference/payments/get-payments-1.md) |
| `dodo.listPayments` | `GET /payments` | Find a customer's payments; list items carry `refund_status` (`partial`, `full` or null), not the refunds themselves | `customer_id`, `subscription_id`, `status`, `product_id`, `currency`, `brand_id`, `created_at_gte/lte` | page_size ≤ 100 | [list](https://docs.dodopayments.com/api-reference/payments/get-payments.md) |
| `dodo.createRefund` | `POST /refunds` | Execute full or partial refunds | `payment_id` (required); `items[]` of `{item_id, amount?, tax_inclusive?}` for partial ("if None the whole item is refunded"; `tax_inclusive` defaults true); `reason` (≤ 3000 chars); `metadata`. Response has `is_partial`, `amount`, `status` (`succeeded`, `failed`, `pending`, `review`) | n/a | [create](https://docs.dodopayments.com/api-reference/refunds/post-refunds.md), [guide](https://docs.dodopayments.com/features/transactions/refunds.md) |
| `dodo.listRefunds` | `GET /refunds` | Find existing refunds before refunding again | `customer_id`, `subscription_id`, `status`, `created_at_gte/lte`. **No `payment_id` filter** | page_size ≤ 100 | [list](https://docs.dodopayments.com/api-reference/refunds/get-refunds.md) |
| `dodo.getRefund` | `GET /refunds/{refund_id}` | Read back a refund after an unknown outcome | path id | n/a | [get](https://docs.dodopayments.com/api-reference/refunds/get-refunds-1.md) |
| `dodo.getSubscription` | `GET /subscriptions/{subscription_id}` | Read plan, `status`, `next_billing_date`, `scheduled_change` | path id | n/a | [get](https://docs.dodopayments.com/api-reference/subscriptions/get-subscriptions.md) |
| `dodo.changeSubscriptionPlan` | `POST /subscriptions/{subscription_id}/change-plan` | Plan-change requests | `product_id`, `quantity`, `proration_billing_mode` (`prorated_immediately`, `full_immediately`, `difference_immediately`, `do_not_bill`) required; `effective_at` (`immediately` default, or `next_billing_date`); `on_payment_failure` (`prevent_change` or `apply_change`, else the dashboard setting); `discount_codes` | n/a | [change plan](https://docs.dodopayments.com/api-reference/subscriptions/change-plan.md), [guide](https://docs.dodopayments.com/features/subscription.md) |
| `dodo.listCustomerWallets` | `GET /customers/{customer_id}/wallets` | Read wallet balances before and after a credit | path id. Response `items[]` of `{currency, balance}` plus `total_balance_usd` ("in smallest unit") | n/a | [list](https://docs.dodopayments.com/api-reference/customers/get-customer-wallets.md) |
| `dodo.createWalletLedgerEntry` | `POST /customers/{customer_id}/wallets/ledger-entries` | The credit mechanism: grant account credit instead of a card refund | `amount` (int64), `currency`, `entry_type` (`credit` or `debit`) required; `idempotency_key` ("to prevent duplicate entries"); `reason`. `400` on "Insufficient balance for debit" | n/a | [create](https://docs.dodopayments.com/api-reference/customers/post-customer-wallets-ledger-entries.md), [guide](https://docs.dodopayments.com/features/customer-wallet.md) |
| `dodo.listWalletLedgerEntries` | `GET /customers/{customer_id}/wallets/ledger-entries` | Find prior credits (completeness check) | `currency`, `page_size`, `page_number` (no default or max stated) | page params, limits unstated | [list](https://docs.dodopayments.com/api-reference/customers/get-customer-wallets-ledger-entries.md) |

**Doc facts the guards will lean on**

- Refunds: total refunds on a payment "can't exceed the amount paid"; only one refund may be `pending` or `review` at a time and it "must finish before you start another"; refunds must start within 30 days of the payment by default; in test mode the test balance must cover the refund.
- Plan change: `prorated_immediately` credits unused time and charges a full new cycle; `difference_immediately` charges only the gap (a downgrade becomes credit); `full_immediately` charges the full new price; `do_not_bill` keeps the renewal date and bills the new price at renewal. All `*_immediately` modes reset the billing cycle. `409` when a plan change is already pending; `503 PlanChangeLinkCancelFailed` is the one case the docs call safe to retry. Changes are rejected while the subscription is `past_due`.
- Wallets: ledger amounts are "in the currency's smallest unit" per the wallet guide ("1000 in USD is $10.00"), though the API schema itself omits the unit. Wallet balance is applied first at renewals and plan-change charges. Re-sending the same `idempotency_key` creates no new entry and returns the current wallet.
- Discounts (`/discounts`) exist but are codes applied at checkout or plan change, not adjustments to a past payment, so Notary's "credit" action uses the wallet ledger instead.

## Open questions / unconfirmed in test mode

Not confirmed live: there were no API keys at P1 (`CRUSTDATA_API_KEY`, `DODO_PAYMENTS_API_KEY` empty), so the live recording step is **blocked** and nothing below has been checked against the wire.

1. **Dodo idempotency on writes.** No `Idempotency-Key` header is documented for refunds, payments or plan changes. Does a retried `POST /refunds` after a timeout create a second refund, or does the one-in-progress rule reject it?
2. **Refund `items[].amount` unit.** The guide says smallest currency unit; the schema is silent. Probe with a partial refund.
3. **Last page detection.** List responses have no `has_more` or total. Is a short page the only signal, and where is the `page_number` cap on `/payments`?
4. **`listRefunds` has no `payment_id` filter.** Is `GET /payments/{id}` → `refunds[]` complete, and does it agree with `listRefunds` filtered by customer?
5. **Creating a completed test payment without a human.** `POST /payments` is deprecated; `POST /checkouts` only returns a `payment_id` with `confirm: true`, and the docs don't say whether that charges without customer action. Seeding may need the payment link completed in a browser with a test card.
6. **Live-key detection.** No documented key prefix. The lock depends on `NOTARY_MODE` and the base URL only; a live key sent to the test URL should fail auth (docs say keys are mode-bound), which is unverified.
7. **Duplicate customer email.** `POST /customers` doesn't say what a repeated email does.
8. **`change-plan` `quantity`.** The schema says `minimum: 0`, the description says "Must be at least 1".
9. **Crustdata enrich credit on no-match or error.** Pricing doesn't say whether a no-match enrich is charged; `X-Credits-Used` will tell us.
10. **Crustdata `headcount.total` vs `employee_count_range`.** Two size fields with different semantics; which one tiers a company near a boundary is a P2 question.
11. **Wallet ledger list page limits.** `page_size` default and max are not stated.
