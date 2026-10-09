# Seeded queue (SEEDED FIXTURE)

**This is a seeded fixture, not real customer traffic.** Every request in `seeded.json` was written by hand to exercise Notary against Dodo Payments **test mode**. The customers, payments and subscriptions it refers to are created by `packages/core/scripts/seed-dodo.ts`. No real person or real money is involved.

## Files

- `seeded.json` holds 20 `QueueRequest`s (schema: `src/schema/queue.ts`). Customer, payment and subscription fields are seed handles (`cust:<h>`, `pay:<h>`, `sub:<h>`). `src/queue/manifest.ts` `resolveRef()` resolves them to real Dodo test ids through `fixtures/seed/manifest.json`, which is written only by a live seed run. Amounts are integer minor units (cents). The company domains are real, so Crustdata can enrich them.
- `expected.json` gives the correct tier, outcome, action and amount for each request. It was derived by hand from `POLICY_TABLE` in `src/queue/policy.ts` before any run. `tierSource` records the public knowledge each expected tier rests on. `test/queue-policy.test.ts` re-derives each entry with `decidePolicy()` to catch drift between the table and this file.

## Designed cases

| Request | What it tests |
| --- | --- |
| q05 | `note: "client-timeout-then-retry"` tells the executor to treat the first refund call as a client timeout and retry. A blind retry may refund twice. |
| q07 | The payment was already refunded during seeding. The customer has 106 payments, more than one 100-item page, so the refunded one lies past the first page of `listPayments`. |
| q03 | `amount` is 1999 minor units, while the free-text reason says "$19.99". The test is a units mix-up. |
| q04 | Partial refund (50%) of an odd amount. The policy floors 1999 to 999. |
| q02, q06 | Partial outcomes on subscription payments: 49900 becomes 24950 and 9900 becomes 4950. |
| q09, q10 | Partial refunds of a stated amount. |
| q11 | Deny: the request asks for more than the payment total. |
| q16 | Deny from the policy table: SMB on starter gets no goodwill credit. |
| q13, q19 | Escalate from the policy table: enterprise contract accounts. |
| q17 | Escalate: the credit is over the mid-market cap. |
| q12, q14 | Plan changes. |
| q08, q15, q18 | Credits through the customer wallet ledger. |
| q20 | **Tier boundary.** Zapier is publicly reported at about 800 employees, near the 1000-employee enterprise threshold. Mid-market approves the refund and enterprise would escalate it, so Crustdata's headcount decides. |

Expected tiers come from public knowledge, not from Crustdata. Where Crustdata disagrees, especially for the very small companies it may not index (which become tier `unknown`), that disagreement is something Notary should surface. It should not be patched in this file.
