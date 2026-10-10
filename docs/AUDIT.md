# Self-audit (P9)

Oct 10, 2026. A hostile review of the repo at `12b376e` plus the fixes listed below, run before judges see it. Every claim here comes from reading the code or running a command; the commands are listed in [Commands run](#commands-run).

**Bottom line.** No API keys were ever available, so there is **no real evidence**: no cassettes, no live bundles, no notarized beliefs, no headline numbers. This audit therefore checks the *code paths* that would produce evidence. It found 6 places where a belief or result could move without the evidence the rules require. All 6 are now fixed with tests. Everything that can't be defended without live runs is listed as a known limit.

## Evidence integrity: real bundles

| What was checked | Result |
| --- | --- |
| `packages/core/fixtures/cassettes/` | Does not exist. 0 cassettes. |
| `packages/core/runs/` | Only `notary.sqlite`: anomalies 0, hypotheses 0, probes 0, run_meta 0, run_items 0. The `beliefs` table was never created. |
| `packages/web/public/bundles/` | Only `sample-42.json` (`sample: true`, `kind: "sample"`, disclosure "SAMPLE DATA — synthetic"). |
| Notarized beliefs to audit (cited probes varied the parameter, controls behaved, nothing rests on an uninformative observation) | **None exist.** Nothing to audit, so nothing was downgraded. The enforcing code was audited instead (A-01 to A-04). |

## Findings

Severity: Critical = could disqualify the submission; High = a belief, number or safety rule could be wrong; Medium = a weaker guarantee than claimed; Low = defense in depth; Info = verified, noted for reviewers.

| ID | Area | Severity | Finding | Evidence | Resolution |
| --- | --- | --- | --- | --- | --- |
| A-01 | Beliefs | High | Evidence that failed the FR-10 check kept its +1 on α/β. The belief reverted to `hypothesis`, but its confidence still counted the invalid probe. A later **uninformative** probe re-ran the status check and promoted it to `candidate` on that invalid weight (Beta(4,1) with 2 valid probes). | `src/beliefs/store.ts:568` (`applyEvidenceCheck`) | **Fixed.** An invalidated probe's +1 is taken back off α/β, and restored if a later check passes it. Never subtracted twice. Tests: `test/audit.test.ts` AUDIT-01 (3 tests). Updated the expectation in `test/evidence.test.ts` (β 4 → 3). |
| A-02 | Beliefs / adversary | High | `applyAdversary` notarized any `candidate`, including one whose cited evidence had never been through the FR-10 check (`valid` NULL). Only the call order inside `runBeliefsPhase` stopped this. | `src/beliefs/store.ts:532` | **Fixed.** `uphold`/`narrow` now require at least 2 independent cited probes on the belief's side whose evidence **passed** the check (`valid = 1`), otherwise they throw. `downgrade` is always allowed. Tests: AUDIT-02 (2). Test helpers now run the evidence check before an uphold (`test/fakes.ts` `passEvidence`). |
| A-03 | Beliefs | Medium | `applyProbe` used the verdict and winner the caller passed in, even when the probe record said otherwise. A probe recorded as `uninformative` could be applied as `confirmed`. | `src/beliefs/store.ts:399` | **Fixed.** A verdict or winner that differs from the probe's recorded one is refused. Tests: AUDIT-03 (2). |
| A-04 | Commit-then-run | Medium | SQL triggers made predictions immutable, but recorded **results** (verdict, observed, winner, trace id) could be rewritten with a plain `UPDATE` after `recordResult`. | `src/store/db.ts:105` | **Fixed.** New trigger `probes_result_immutable` aborts any change to result columns, `trace_id`, `run_id` or `tool` once a verdict exists. Test: AUDIT-04. |
| A-05 | Replay | Medium | `notary replay --drift` exited 0 even when the fixture un-learned nothing, so a drift demo could "pass" without showing FR-16. | `src/replay/index.ts:381` | **Fixed.** Exit 1 with `FAIL: the drift fixture un-learned no belief` when no affected belief reaches `unlearned`. Test: `test/replay.test.ts` "P9 AUDIT-05". |
| A-06 | Safety: test mode | Medium | The Dodo test-mode lock lived only in the `DodoClient` constructor. `createTools()` also returns the generic `Recorder`, which would send a live request to any host, including `live.dodopayments.com`. No code does this today. | `src/tools/dodo.ts:313`; `src/tools/recorder.ts:355` | **Fixed.** The recorder, the only place a live request is sent, refuses every `*.dodopayments.com` host except `https://test.dodopayments.com` (`assertDodoTestHost`, `src/tools/recorder.ts:269`). Test: AUDIT-06 (checks that `fetch` is never called). |
| A-07 | Safety: secrets | Low | Nothing stopped a bundle that contained a secret from being written, and bundles are published via `packages/web/public`. Bundles are built from redacted traffic, so this is a backstop only. | `src/bundle/index.ts:52` | **Fixed.** `writeBundle` refuses a bundle containing the value of any `*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*`/`*CREDENTIAL*` env var. Test: AUDIT-07. |
| A-08 | Safety: secrets | Low | Reflector prompts had no secret-scrub backstop (the adversary packet did). Inputs come from redacted exchanges. | `src/llm/client.ts:161` | **Fixed.** `LlmClient.complete` masks secret env values in the system and user text before they reach Bedrock. Test: AUDIT-08. |
| A-09 | Faked/derived results | Medium | The sample bundle used metric keys that **no real bundle has** (`automationRate`, `beliefs.notarized`, `usd.perNotarizedBelief`, …). A dashboard built on the sample would show blanks on real bundles, or need sample-only code paths. | `src/bundle/sample.ts:1147` | **Fixed.** The sample now uses the real keys (`HEADLINE_KEYS` from `src/eval/metrics.ts`, the grader's own keys, `credits_<endpoint>`). Dropped derived sample-only keys. Regenerated with `pnpm notary export --sample` (`sample-42.json` and `index.json` changed; it is still synthetic). Test: AUDIT-09. |
| A-10 | Guard coverage | Medium | `unguarded_call_sites = 0` counts the two `createTools()` sites in `src/queue/run.ts` as raw-by-design through a **file-level** allow-list. The static check can't tell a guarded run from the naive baseline there. | `src/guards/coverage.ts:118`; `pnpm notary guards coverage` (run.ts:241, run.ts:255) | **Fixed (runtime) + disclosed.** A guarded run now refuses to start if its wrap is the identity wrap (`src/queue/run.ts:229`). No new test: the condition can't be reached through the current code. The static number still rests on the allow-list. |
| A-11 | Hackathon authenticity | Critical | Every commit (P0 `7881199` to P8 `12b376e`) is timestamped 2026-10-10 02:49–05:42 +05:30. The PRD gives the start as 12:30 PM IST that day and calls pre-start history a hard gate. All of P0–P8 also landed within 3 hours, where the PRD's "many sessions beat one burst" asks for spread-out work. | `git log --format="%h %ad" --date=iso-strict` | **Open: owner decision.** This isn't a code fix. Raise it with the organizers. Do not rewrite history. |
| A-12 | Evidence | High | There is no real traffic, so every PRD headline metric is "not computable", and every live "done when" from P1–P8 is BLOCKED. | `pnpm notary replay` → BLOCKED, exit 3; `docs/EVALUATION.md` | **Known limit.** See [Unverified because no API keys](#unverified-because-no-api-keys). |
| A-13 | Sponsor integration | High | The mandatory sponsors are unexercised. Entire CLI isn't installed: no checkpoints, the `entire graph` coverage backend is unverified, and the `session` adversary has never run. `NEATLOGS_API_KEY` isn't set, so no span has reached neatlogs. `neatlogs-cli` isn't installed, so the FR-10 check reads local JSONL. The cfo.ai plan is not done (P10). | `PLAN.md` P0/P2/P5/P7 notes; `src/beliefs/evidence.ts:19`; DECISIONS #5, #48, #50, #61 | **Known limit.** |
| A-14 | Metrics | Medium | `belief_precision` takes its ground truth from the deterministic checker on the **same run's recon traffic** that produced the anomalies the probes chase. It measures recon/probe agreement, not "matches a confirmed real behavior" (PRD). | `src/eval/metrics.ts:72`; DECISIONS #65 | **Downgraded.** Report it as recon/probe agreement. It is not independent precision. |
| A-15 | Evidence | Medium | FR-10 receipts are `runs/<runId>/spans.jsonl` files written by Notary's own process, so they are self-attested. They are not read back from neatlogs. | `src/beliefs/evidence.ts:19`; DECISIONS #48 | **Known limit** until `neatlogs-cli` is installed and verified. |
| A-16 | Drift | Medium | Drift replay re-plays the **same** altered response for up to 10 passes and counts each pass as a fresh observation. Un-learning in 4 passes (DECISIONS #60) reflects the pass count, not independent evidence. | `src/beliefs/drift.ts:18` | **Downgraded.** The drift demo shows the un-learning mechanism, not a strength of evidence. |
| A-17 | Grader | Medium | `expected.json` tiers were assigned by hand from public knowledge, not from Crustdata. `decision_accuracy` partly measures agreement with that guess. | DECISIONS #30; `fixtures/queue/expected.json` | **Known limit.** Disclose next to any accuracy number. |
| A-18 | Probes | Low | No control/instrument check for `unknown_param` (by design: control is the baseline). `header_burst` skips it when no rate-limit header comes back. | `src/reflect/templates/unknown_param.ts:78`; `header_burst.ts:106` | **Known limit.** |
| A-19 | Replay | Low | The `replay` CLI verdict compares `bundle.metrics` only. Record-level identity (probes, verdicts, beliefs, decisions) is asserted in tests, not by the command. | `src/replay/index.ts:265`; `test/replay.test.ts` | **Known limit.** |
| A-20 | Replay vs live | Low | One branch in decision code depends on the mode. The client-timeout item uses the recorded latency in replay and a real timer live. Everything else differs only in the recorder and bookkeeping. | `src/queue/executor.ts:898` | **Known limit** (deterministic by design). |
| A-21 | Safety: budget | Low | The budget is reserved **before** each call, but only for the estimated cost. A call that charges more than its estimate (`X-Credits-Used`) can overshoot the budget by the difference. | `src/tools/crustdata.ts:164` | **Known limit.** |
| A-22 | Beliefs | Low | `NOTARY_PRIOR_STRENGTH` has no upper bound. A strong transfer prior plus 2 independent probes can reach `candidate`. | `src/beliefs/priors.ts:49` | **Known limit** (operator setting; default 2). |
| A-23 | Adversary | Low | The `session` backend records its model as `claude-code-session`. The real model is not pinned, so separation of duties from the reflector is not enforced for that backend. | `src/adversary/session.ts:33` | **Known limit.** |
| A-24 | Safety: test mode | Low | A live Dodo key can't be told apart from a test key (no documented prefix). The lock relies on `NOTARY_MODE=test`, the test base URL, and now the host check from A-06. | `docs/ENDPOINTS.md` open question 6 | **Known limit.** |
| A-25 | Sample data | Info | The sample bundle says `mode: "replay"` and uses fictional ops and endpoints. It is flagged `sample: true` with a disclosure, and is never used as results: excluded by export (`src/export/collect.ts:69`), replay (`src/replay/index.ts:115`), priors (`src/beliefs/priors.ts:277`) and the noise floor (`src/eval/noise-floor.ts:102`). | as cited | **Verified.** |
| A-26 | Secrets scan | Info | `check:secrets` ran with 0 `.env` values, because every key in `.env` is blank. Only the key-shape patterns were checked. | `pnpm check:secrets` | **Verified (pattern scan only).** |

**Counts: 26 findings (1 Critical, 4 High, 10 Medium, 9 Low, 2 Info).** Fixed with tests: 9 (A-01 to A-09). Fixed at runtime: 1 (A-10). Downgraded: 2 (A-14, A-16). Open, needs the owner: 1 (A-11). The rest are known limits or verified.

## Verified, no finding

- **Grader independence.** The transitive import closure of `src/queue/grader.ts` is `schema/*`, `tools/*` (type-only) and `queue/manifest.ts`. For `src/eval/metrics.ts` it is `guards/compiler.ts`, `guards/coverage.ts`, `bundle/hash.ts` and `schema/*`. Neither reaches `llm/`, `reflect/` or `adversary/`. Neither do `queue/executor.ts`, `queue/policy.ts`, `queue/gate.ts` or `checker/check.ts`. Checked with an import walker over relative imports, type-only included.
- **Commit-then-run.** The prediction, its hash and `committedAt` are inserted before any call (`src/reflect/runner.ts`). The IO refuses calls until the row exists (`CommitOrderError`). `recordResult` re-hashes the stored prediction.
- **Uninformative and invalid verdicts** never move α/β (`applyProbe`: only `confirmed` does). The FR-10 check also rejects non-`confirmed` or null-outcome evidence, and a probe that didn't vary `claim.param` (`src/beliefs/evidence.ts`, `src/beliefs/params.ts`).
- **≥ 2 independent probes**: different probe id and design fingerprint, enforced at `candidate`, and since A-02 also at `notarized`.
- **No fabricated responses** outside test doubles: a grep for fake/mock/stub/simulat/hardcod in `src` and `scripts` found only the documented `client-timeout-then-retry` item and the drift-fixture label. No hardcoded metrics: every bundle metric is computed (`consolidateMetrics`, grader), and `null` means not computable.
- **`docs/EVALUATION.md`** contains only two numbers, the test count and `unguarded_call_sites`. Both come from commands that `pnpm notary export` runs.
- **Replay can't silently pass.** With nothing recorded it prints BLOCKED and exits 3 (run below). A cassette miss, a tampered bundle or cassette, or a changed queue exits 1 (`test/replay.test.ts`). Replay runs the same `runQueue` / `notarize` / `reconOnly` code with `mode: "replay"`.
- **Safety caps.** Crustdata reserves credits before any I/O (`src/tools/crustdata.ts:148`). `header_burst` allows at most 10 requests per run (`BurstCounter`, one per notarize run). Guarded writes retry only after a read-back proves the first write did not land; an unknown outcome is held (`src/queue/executor.ts`, `src/guards/guarded.ts`). Secrets are redacted in cassettes (`Redactor`), spans (`trace/index.ts` mask) and adversary packets (`scrubSecrets`), and now in bundles and prompts too (A-07, A-08).

## Unverified because no API keys

Every row of the PRD success-metrics table is currently unproven:

| PRD metric | Target | Status | What it needs |
| --- | --- | --- | --- |
| Unsafe money actions | Run 1 > 0; run 2 = 0 | **Unproven.** No naive or guarded run exists. | Crustdata + Dodo test keys, `seed:dodo` + 11 human test checkouts, both runs |
| Belief precision | ≥ 0.8, false = 0 | **Unproven.** No notarized belief exists. If measured, it is recon/probe agreement only (A-14). | Notarize runs: tool keys, Bedrock model ids, AWS credentials |
| Unguarded call sites | 0 via entire-graph callers | **Partly proven.** 0 with the tsc backend; the static number rests on an allow-list (A-10). The entire-graph backend has never run. | Entire CLI installed |
| Cost per queue run | Run 2 < run 1 | **Unproven.** No runs, no neatlogs cost data. | Live runs + `NEATLOGS_API_KEY` |
| Probes to confirm on tool 2 | Fewer with priors | **Unproven.** No Crustdata notarize bundle, no Dodo probe cassette. | Both notarize runs, then `--compare-priors` |
| Automation rate | Reported honestly | **Unproven.** No run exists. | Live runs |
| Reproducibility | `notary replay` exact match | **Unproven.** Nothing recorded. Shown only on test cassettes in `test/replay.test.ts`. | Recorded live runs |

These are also unverified live: FR-4 (prediction span in neatlogs), FR-7 (adversary verdicts from a real model), FR-10 via `neatlogs-cli`, FR-15, FR-16 on a real drift fixture, and FR-17 via Entire.

## Commands run

Run on this working tree after the fixes, on Windows 11, Node 24.14.1.

| Command | Result |
| --- | --- |
| `pnpm test` | PASS: 481 passed, 0 failed, 28 files (before the audit: 468 in 27) |
| `pnpm typecheck` | PASS (`tsc --noEmit` clean; web is a placeholder) |
| `pnpm check:secrets` | PASS: clean, 169 files, 0 `.env` secret values (A-26) |
| `pnpm notary guards coverage` | PASS: 27 sites, 21 guarded, 6 raw-by-design, 0 unguarded, exit 0 (tsc backend) |
| `pnpm notary replay` | `BLOCKED: no recorded live runs to replay (fixtures/cassettes is empty)`, exit 3 |
| `pnpm notary export` | exit 0. 0 real bundles. Rewrote `docs/EVALUATION.md` and `export/TOOLS.md` (timestamp and test count only); `export/guards.json` unchanged (0 guards) |
| `pnpm notary export --sample` | Regenerated `packages/web/public/bundles/sample-42.json` with the real metric keys (A-09) |
