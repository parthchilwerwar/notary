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

## P3 · Seeded world and naive run

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 28 | Seed script creates payments | Dodo test mode documents no API-only way to *complete* a payment: the first payment per customer needs a hosted checkout with the test card (11 human checkouts). The other ~108 use `POST /checkouts` with `confirm:true` + the saved `payment_method_id`; the docs don't say whether that charges without customer action. If it fails, the seed stops and writes no manifest | Doc facts; nothing faked |
| 29 | Policy | Tiers: SMB < 50 employees, enterprise ≥ 1000, mid-market between; headcount first (`headcount.total`, then ranges), funding only when headcount is missing ($500M+ enterprise, $20M+ mid). Partial = 50% floored to the minor unit. Credit caps SMB $50 / mid $200 / ent $1,000 | `src/queue/policy.ts` |
| 30 | Expected outcomes | `fixtures/queue/expected.json` was written by hand from the policy table with tiers from public knowledge; a test re-derives each outcome through `decidePolicy` to catch drift | Ground truth before any run |
| 31 | Naive executor | Doc-trusting, no deliberate bugs: one page (100) of refunds/payments as the existing-refund precheck, one retry on timeout/5xx, minor-unit amounts as given. The `client-timeout-then-retry` item races a 200 ms client timeout; if none fires, that's recorded | Naive failures must come from real tool behavior |
| 32 | "Existing refund on a later page" case | Probably won't trip the naive agent: that customer has a single refund, which `listRefunds` returns on page 1. Left as is; if the naive run shows zero misses, it's reported honestly | No forced failures |
| 33 | Executor model (Bedrock) | Queue decisions are policy code; the executor role isn't used in P3 | TDD: "The policy is plain code, not a prompt" |

## P4 · Reflector and probes

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 34 | `better-sqlite3` (TDD "Stack") | Node's built-in `node:sqlite` (`DatabaseSync`); prints a harmless ExperimentalWarning on Node 24 | No native build on Windows; same single-file store |
| 35 | Bedrock client | `@aws-sdk/client-bedrock-runtime` 3.1148.0, Converse API, temperature 0, default AWS credential chain (env keys or SSO profile). Credential errors become `BLOCKED` | Never read or log credentials |
| 36 | USD per role | Env overrides `NOTARY_PRICE_<ROLE>_IN/_OUT` first, else a small table of Claude Bedrock list prices; unknown model → $0 plus a recorded warning, never a guess. Newer model ids need the env override | No invented prices |
| 37 | Separation of duties | Reflector and adversary model ids must differ (also across `us.`/`global.` prefixes), else `ModelConfigError` | TDD security rule |
| 38 | Hypothesis → prediction | The model only proposes `{class, statement, distinguishingTest}`. Each template maps a defect class to a predicted observation in code; a class the template can't speak to gets a wildcard that separates nothing | Models only explain/propose; verdicts stay deterministic |
| 39 | Template choice | Templates are picked by the cost-aware score (λ = 1 by default, `NOTARY_PROBE_LAMBDA`), not by the model's `distinguishingTest` | The score is the TDD's selection rule |
| 40 | Prediction immutability | Prediction, sha256 and `committedAt` are written before any HTTP call; an SQLite trigger forbids changing them or deleting probes; `recordResult` re-verifies the hash | FR-4 / commit-then-run |
| 41 | `header_burst` | At most 10 requests per run across all probes, free read ops only, polite delays | TDD probe limits |
| 42 | Refund probes | Only use seeded payments that the queue never references; skipped (with reason) until the seed manifest exists | Probes never disturb the graded queue |

## P5 · Beliefs and adversary

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 43 | "P(holds) < 0.1 / > 0.9" (TDD step 7) | `confidence = P(θ > 0.5 \| Beta(α,β))`, where θ is the rate at which the doc claim holds (exact binomial sum for integer α,β). From Beta(1,1) a threshold takes **3** same-side confirmed probes: Beta(4,1) = 0.9375, Beta(1,4) = 0.0625 | The posterior *mean* would need ~9 violations to drop below 0.1 |
| 44 | Updates | Only `confirmed` verdicts move α/β (honored → α+1, any defect class → β+1). Inconclusive, uninformative, invalid and refuted log an event but change nothing | FR-6 |
| 45 | "at least two independent probes" | Independent = different probe id **and** different design fingerprint (template + treatment value at `claim.param` + variant). Repeats move α/β but add no independence; invalid evidence never counts | Documented rule, tested |
| 46 | Probe loop | Keeps probing a claim until its belief is a candidate or `NOTARY_MAX_PROBES_PER_CLAIM` (default 5) / the budget ends, then abstains with the reason. Fingerprints are never reused, including across runs | Without this, beliefs could never reach candidate |
| 47 | Crustdata type claims | `type_edge` has only 2 variants (the two recon domains), so these claims can abstain unless another template applies | Known limit; more domains cost credits |
| 48 | Evidence source (FR-10) | `neatlogs-cli` is not installed, so the check reads `runs/<runId>/spans.jsonl`, which the span sink now writes even when neatlogs is off. A probe must vary `claim.param` (or, for count templates, send the operation more often; for `type_edge`, send the param across different records) | Offline-verifiable receipts |
| 49 | Adversary input | Belief + claim + raw probe records (template, params, control, predictions with defect classes, observed, verdict, trace ids). Hypothesis statements / reflector prose are excluded and asserted absent | TDD step 8 |
| 50 | `session` backend | Headless `claude -p --output-format json --tools Read,Write --permission-mode dontAsk --strict-mcp-config --disable-slash-commands`, allowed to read only `adversary/inbox/<id>.json` and edit only `adversary/verdicts/<id>.json`; `.env` reads disallowed. The verdict and inbox files are committed (`adversary: <verdict> <beliefId>`). The allowed-tools rule hasn't been exercised live yet | Entire checkpoints each review next to the belief |
| 51 | Adversary verdicts | uphold → notarized; narrow → notarized with a narrowed scope; downgrade → back to `hypothesis`; malformed/failed → stays candidate | FR-7, fail safe |

## P6 · Guards, gated queue, recovery

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 52 | Guards compile from notarized beliefs | Only notarized beliefs on the *violated* side compile; honored beliefs compile nothing. unit_mismatch → transform (ratio from the unit_roundtrip probes; no/inconsistent ratio → block); idempotency_hazard → retry_policy + precheck; silent_truncation → paginate_fully on list ops; undocumented_flag → require_param; refunds[]-listing claims → existing-refund precheck; every other class → block | No guard without evidence |
| 53 | Required beliefs (TDD table) | Full refund: `dodo.refund.amount-minor-units`, `dodo.refund.full-retry-no-duplicate`, `dodo.refunds.page-size-max-100`, `dodo.payments.page-size-max-100`, `dodo.payment.refunds-lists-issued-refund`, `crustdata.enrich.headcount-total-integer`. Partial: + `dodo.refunds.amount-integer`. Plan change: `dodo.subscription.change-plan-pending-409`. Credit: `dodo.wallet.credit-amount-minor-units`, `dodo.wallet.idempotency-key-no-duplicate` | Mapped to claims that exist |
| 54 | Partial-refund rounding / plan-change timing | No doc claim exists for either. Rounding: the policy floors client-side and `dodo.refunds.amount-integer` is required as the closest notarizable proxy. Timing: the guarded run sends `effective_at: "immediately"` explicitly. Both gaps are written into the run bundle's disclosure | Honest gaps, not silent ones |
| 55 | Recovery | Per-item state in SQLite; the pending write is persisted before it's sent. On `--resume`, an in-flight item is read back (fully paginated): landed → executed, no resend; proven not landed → reprocessed; undecidable → held | "No blind write retries" |
| 56 | `entire graph` coverage | Not installed; a static scan asserts every `createTools` call passes a `wrap`, except recon and probing, which deliberately exercise raw tool behavior | Until P7's coverage command can use Entire |
| 57 | Local API | hono 4.13.13 + @hono/node-server 2.1.4; read-only (writes → 405), localhost-only CORS, binds 127.0.0.1 by default. A tampered bundle returns 200 with `X-Notary-Hash-Mismatch: 1` and an `error` field so the dashboard shows it | TDD dashboard contract |

## P7 · Transfer, drift, coverage

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 58 | Transfer priors (TDD step 9) | Base rate per defect class = settled (notarized/candidate) source beliefs that came out violated with class c ÷ settled beliefs relevant to c. Target claim → suspected class from `src/contracts/priors-map.ts` (copied from the contract comments, no LLM). Prior = Beta(1 + s(1−r), 1 + s·r), s = `NOTARY_PRIOR_STRENGTH` (default 2); no evidence → Beta(1,1) | Deterministic, small pseudo-counts |
| 59 | "probes-to-candidate with vs without priors" | `notarize --compare-priors` replays the *same* cassette twice (no new spending) and records `probes_to_candidate_with_priors` / `_without_priors` | Paired comparison on identical traffic |
| 60 | Drift fixture | `make:drift` copies a **real** cassette, changes exactly one response field, recomputes the hash and stamps a `drift` disclosure block. No fixture exists yet because no real cassette exists. The un-learning path is tested on a temp test cassette (confidence 0.94 → 0.81 → 0.66 → 0.50 → 0.36 → `unlearned`, guard retired) | A fabricated "real" drift fixture would be fake data |
| 61 | `entire graph` callers | Real command (Entire docs, https://docs.entire.io/cli-reference/graph): `entire graph neighbors --symbol Class.method --direction in --format json`. Implemented as the `entire` backend but **unverified** (Entire not installed). The default fallback is a TypeScript-checker walk over src + scripts | FR-17 must still be checkable |
| 62 | Coverage allow-list | Raw-by-design call sites: recon, probing (`notarize.ts`), seeding, and the naive baseline's identity wrap in `queue/run.ts`. Everything else must route through `guarded` | Probes must see raw tool behavior; naive is the unguarded control |

## P8 · Replay and evaluation

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 63 | Replay | Probe ids/tags derive from the *recorded* run's id (`identityRunId`), not the replay's runId. Live runs also write a model-call cassette (`<runId>-llm`) and an inputs record (`<runId>-inputs`: params, file sha256s, priors source, pre-run store snapshot). `bundle.cassettes` entries are pinned as `name@sha256` | Replay must re-derive identical requests; schema unchanged |
| 64 | Replay failures | Fails loudly (exit 1) on a cassette miss (op, URL, hash, occurrence), a tampered bundle/cassette or pin mismatch, a changed queue file, or a resumed run. With no recorded runs: `BLOCKED`, exit 3, never a pass | FR-11 |
| 65 | belief precision | Notarized beliefs whose side matches the deterministic checker's verdict on the run's recorded recon traffic ÷ notarized beliefs that have such a verdict; null when none | Ground truth from recorded evidence only, no model |
| 66 | Noise floor | `notary eval noise-floor --queue <f> [--runs 3] [--replay]`: floor = max − min per metric; `|Δ| ≤ floor` is "no change". Each live run mutates Dodo test-mode state, so re-seed between runs | TDD noise floor |
| 67 | `docs/EVALUATION.md` | Generated by `pnpm notary export` from verified real bundles only (never the sample). Bundles don't store their command line, so the command is rebuilt from bundle fields (stated in the file). Keyless checks (`pnpm test`, `guards coverage --json`) are run at export time | No hand-typed numbers |

## P9 · Self-audit and README

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 68 | Bundles at `export/bundles/` (TDD layout) | Bundles are written to `packages/core/runs/<runId>/` (gitignored); `notary export` copies the newest real bundle per category into `packages/web/public/bundles/` (committed), which is what a fresh clone can replay | Keeps scratch runs out of git |
| 69 | Trace links click through to neatlogs | `traceLinks` are local `runs/<runId>/spans.jsonl` receipts in run bundles and empty in notarize bundles; neatlogs URLs need a real ingest key to learn the trace URL format | No invented URLs |
| 70 | Noise floor "three identical runs" | Nothing re-seeds Dodo between runs, so later runs start with earlier runs' refunds in place; re-seeding needs 11 more hosted checkouts. EVALUATION's command is now `notary eval noise-floor` with a re-seed note | Honest about the measurement |
| 71 | Audit (docs/AUDIT.md) | 26 findings (1 Critical, 4 High, 10 Medium, 9 Low, 2 Info); 9 fixed with tests, incl. invalidated evidence still weighing on confidence (A-01) and the adversary notarizing unchecked evidence (A-02). Belief precision and the drift demo are downgraded in how they may be reported | See AUDIT.md |
| 72 | Hackathon start 12:30 IST | All commits P0–P9 are timestamped Oct 10 before 12:30 IST. Not rewritten; for the user to raise with the organizers | AUDIT critical finding; history left intact |

## Keyless hardening (session 3)

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 73 | Every keyed command fails BLOCKED / exit 3 without keys | `notary doctor` exited 1 with a JSON report; now prints `BLOCKED: NEATLOGS_API_KEY not set` and exits 3 (a set-but-failing key still exits 1) | Found by the keyless health check |
| 74 | SSE live mode (TDD Local API) | The bus was in-memory, so events from `notary run`/`notarize`/`eval` in another process never reached `notary serve`. Producers now append events to `runs/events.jsonl` (gitignored); `serve` tails it from the current end, skipping its own pid and tolerating partial lines / recreated files. Verified live: an event emitted by a separate process arrived on `/api/stream` | Dashboard live mode would have been silent |
| 75 | Coverage allow-list (A-10) | Entries name the function and exact call-site count instead of whole files; a new raw call in an allow-listed file is UNGUARDED | Audit Medium finding |
| 76 | Replay identity (A-19) | `notary replay` compares probes, hypotheses, anomalies, beliefs and decisions record by record, not just metrics; any difference exits 1 | Matching metrics can hide different behavior |
| 77 | Prior strength (A-22) | `NOTARY_PRIOR_STRENGTH` is capped at 2 (larger values throw), so two contrary probes always outweigh a transferred prior | Priors may speed probing, never decide it |
