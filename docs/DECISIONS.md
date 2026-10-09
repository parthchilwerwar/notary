# Decisions

Where the docs and reality disagree, or a choice the docs leave open. Newest phase last.

## P0 · Scaffold

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 1 | Node 22 LTS (TDD "Stack") | Built and tested on Node 24.14.1; `engines.node` is `>=22` | The machine has Node 24. The TDD's reason for 22 is `neatlogs-cli`, which supports 22 and 24. |
| 2 | — | No `dotenv`; the CLI loads `.env` with Node's built-in `process.loadEnvFile()` | `dotenv@18` was younger than pnpm's minimum release age; the built-in does the same job with no dependency. |
| 3 | — | TypeScript pinned to `~5.9.3` | npm `latest` is TS 7 (native port); 5.9 is the stable line the rest of the toolchain targets. |
| 4 | Guard `kind`: block, transform, require-param, retry-policy (TDD "Data model") | Schema uses `transform, require_param, precheck, retry_policy, paginate_fully, block` | TDD "Queue execution and guards" lists the fuller set; the data-model table is a subset with different casing. |
| 5 | `entire enable` at P0 | Entire CLI was not installed on the build machine at P0, so no Entire checkpoint on the P0 commit | Must be installed and enabled before P1 (`entire enable`). |
| 6 | neatlogs `init`, `span`, `trace`, `log` (TDD "Integrations") | All exist in `neatlogs` 1.1.26, but per-span metadata only works through `trace({ attributes })`; `span()` ignores `metadata`/`tags`; `init({ metadata })` never reaches spans, so `withSpan` stamps `notary.runId` itself; `log()` needs `init({ captureLogs: true })`; flushing is `flush()` / `shutdown()` | Read from the SDK's README and shipped code; full notes in `packages/core/src/trace/index.ts` |
| 7 | — | `neatlogs` resolved to 1.1.26, not 1.1.28 | 1.1.27/1.1.28 were under a day old and held back by pnpm's minimum release age |
| 8 | — | `protobufjs` build scripts disabled in `pnpm-workspace.yaml` | Its postinstall only prints a version warning; nothing depends on it |

## P1 · Tool clients, recorder, schema freeze

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 9 | Crustdata endpoint unspecified | `POST /company/enrich` (2 credits/record, +2 with technographics; headcount/funding must be requested by name; 15 req/min), `POST /company/identify` (free), `GET /account/credits` (free). Auth `Authorization: Bearer` + `x-api-version: 2025-11-01`. Ledger settles from `X-Credits-Used`, else list price | Crustdata docs; see `docs/ENDPOINTS.md` |
| 10 | Dodo "idempotency" implied | No `Idempotency-Key` header is documented. Only wallet ledger entries take an `idempotency_key` body field | Retry safety on refunds must be proven by probes, not assumed |
| 11 | Dodo pagination | `page_size` (max 100) + `page_number`; responses are `{items}` with no `has_more`/total; `listRefunds` has no `payment_id` filter | Makes the `pagination_completeness` and "missed existing refund" cases real |
| 12 | Dodo amounts | Guides say smallest currency unit; the refund schema's `items[].amount` states no unit | Exactly the kind of claim Notary must notarize |
| 13 | "Credit or discount" action | Implemented via the customer wallet ledger (`createWalletLedgerEntry`); Dodo discounts are checkout codes and don't fit | Closest real mechanism |
| 14 | `POST /payments` | Deprecated in favour of `POST /checkouts`; both exposed | Seed script (P3) picks whichever works in test mode |
| 15 | Dodo live-key prefix | Docs define none, so the lock is `NOTARY_MODE=test` + exact test base URL `https://test.dodopayments.com` | Matches `.env.example` |
| 16 | `undici` fetch | Node 24 global `fetch` (which is undici) | No extra dependency |
| 17 | Recorder | Callers receive the *redacted* body even in live mode, so live and replay make identical decisions; identical repeated requests are keyed by `requestHash` + `occurrence` | Replay must reproduce live exactly |
| 18 | Bundle schema | Frozen at end of P1 (`src/schema/bundle.ts`). Additions over the TDD: `kind`, `variant`, `sample`, `disclosure`, `status`/`stopReason`, `hypotheses`, `beliefEvents`, `noiseFloor`, `cassettes`, `replayOf`; Decision `effects`/`evidencePack`/`grade`/`enrichment`; Guard `active`/`retiredAt`; Probe `control`/`predictionHash`; `credits` = `{byEndpoint,total,budget}`; metrics may be `null` (not computable) | Everything P2–P9 and the dashboard need, decided once |
| 19 | sha256 | `src/bundle/hash.ts` is a pure-JS sha256 (tested against `node:crypto`) | The dashboard recomputes bundle hashes in the browser |
| 20 | Claude Code never touches `packages/web` | Generated bundle JSON is written to `packages/web/public/bundles/` (no UI code) | BUILD_PLAN P1/P3/P8 sanction this explicitly |

## P2 · Contracts and deterministic checker

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 21 | — | 26 claims (11 Crustdata, 15 Dodo) in `src/contracts/`, each quoting ≤25 words of doc text with its URL; promises only implied by the docs are prefixed `[implied]` | Don't invent promises |
| 22 | Partial-refund rounding (TDD required beliefs) | The Dodo docs make no rounding promise, so there is no claim. "Immediate vs next billing date" on plan change can't be expressed by any expect rule | Recorded as a gap for P6's required-beliefs map |
| 23 | Refund guide | "Only one refund per payment can be in progress" (Dodo refund guide) | Relevant to the retry/duplicate cases |
| 24 | Crustdata enrich | Also documents 404 "No data found" next to 200 with empty `matches`; 402 on insufficient credits ("Do not retry"); `x-ratelimit-*` headers; identifier arrays capped at 25 | Doc pages differ; both outcomes are claims |
| 25 | `ReconStep` | Added `setup?: boolean`: setup steps feed `$from` refs but are never checked against the claim | Otherwise a setup 200 trips `statusOnError` |
| 26 | Checker association | Claims with recon steps are evaluated only on their own recon exchanges; queue/probe traffic is matched by op only for `recon: []` claims and never for `statusOnError`/`errorOnUnknownParam`/`consistentWithin` | Those rules need deliberately crafted requests |
| 27 | `entire graph` raw-client check | Entire CLI not installed; the static scan in `test/tools.test.ts` checks that nothing outside `src/tools` imports the raw clients | Until Entire is installed |
