# Notary — developer guide

Everything needed to install, run, record and reproduce Notary. The hackathon overview is in the [README](../README.md).

## Install the CLI

Needs **Node 22 or newer** (built on Node 24), **pnpm 11.7.0** (pinned in `package.json` → `packageManager`; for example `npm install -g pnpm@11.7.0`) and git.

```sh
git clone https://github.com/parthchilwerwar/notary.git
cd notary
pnpm install
pnpm notary --help
```

**Quick start, no keys.** The dashboard reads the real bundles already committed in `packages/web/public/`. The keyless walkthrough runs the whole pipeline against an in-process simulated API with model doubles, labels everything as fixture data, and writes only to the gitignored `packages/core/runs/demo/`:

```sh
pnpm notary demo --fixture
pnpm --filter @notary/web dev    # open http://127.0.0.1:5173/app/run (real runs); add ?fixtures=1 for the evaluation suite
```

**With keys.** Copy `.env.example` to `.env` (gitignored; Dodo Payments in test mode only) and check the setup:

```sh
cp .env.example .env
pnpm notary doctor          # one neatlogs test span (needs NEATLOGS_API_KEY)
pnpm notary doctor --llm    # model provider, each role model, one tiny call per role
```

A keyed command with a missing variable stops with `BLOCKED: <VAR> not set` (exit 3) before any network call. The full guide (every command, every variable, live mode, approvals, troubleshooting) is the `/docs` page of the web app: run `pnpm --filter @notary/web dev` and open http://127.0.0.1:5173/docs.

## 5-minute offline quickstart

Needs Node ≥ 22 (built on Node 24) and pnpm. No `.env` and no keys.

```sh
pnpm i && pnpm notary replay
```

**What `replay` does today:** it reads the real bundles published in [`packages/web/public/bundles/`](../packages/web/public/bundles/), recomputes each sha256 content hash, re-runs every recorded live run from its cassettes in [`packages/core/fixtures/cassettes/`](../packages/core/fixtures/cassettes/) with no environment at all, and compares every metric, and every probe, belief and decision record, exactly. The three replayable live runs (`notarize-crustdata-20261012T011404Z`, `recon-dodo-20261012T013640Z`, `notarize-dodo-20261012T014032Z`) match exactly. `notarize-dodo-20261012T012315Z` is disclosed as skipped, not counted as a pass: its cassette lacks one wallet-credit exchange ([DECISIONS #200](DECISIONS.md)). Any cassette miss, tampered file or mismatch exits 1; with nothing recorded it exits 3.

Other things that run offline today:

```sh
pnpm test                       # vitest across the workspace
pnpm notary guards coverage     # every raw client method reachable only through guarded(); exit 0 = 0 unguarded
pnpm notary export --sample     # (re)write the synthetic SAMPLE bundle for dashboard development
pnpm notary export              # regenerate docs/EVALUATION.md, export/TOOLS.md, export/guards.json (runs pnpm test + coverage)
pnpm notary export --certificates [--fixture]  # certificates, revocations, Notarized API Report (export/REPORT.md)
pnpm notary export --content    # dashboard glossary generated from code
pnpm notary export --evidence   # sponsor evidence.json from facts on disk
pnpm notary export --entire     # Entire checkpoints + coverage result → packages/web/public/evidence/entire.json
pnpm notary economics           # unit economics from real bundles → economics.json, docs/BUSINESS.md, export/cfo-inputs.csv
pnpm notary demo --fixture [--scenario change-api] [--publish]  # whole flow on a labelled simulated world
pnpm --filter @notary/core seed:dodo --plan   # print the Dodo test world the seed would create; no network
node scripts/fresh-clone-check.mjs            # clone HEAD to a temp dir, install, run replay with credentials stripped
```

Node 24 prints `ExperimentalWarning: SQLite is an experimental feature` the first time the store opens. It is harmless ([DECISIONS #34](DECISIONS.md)).

## Recording real runs

Copy [`.env.example`](../.env.example) to `.env` (gitignored) and fill in the variables each step needs. Steps are listed in order. Every command exits 3 with `BLOCKED: <reason>` when something it needs is missing, before it makes any network call.

| # | Command | Needs (from `.env.example`) | Produces |
| --- | --- | --- | --- |
| 1 | `pnpm --filter @notary/core seed:dodo` | `DODO_PAYMENTS_API_KEY` (test mode), `NOTARY_MODE=test`, `DODO_BASE_URL=https://test.dodopayments.com`. **Plus a human:** the script prints **12 hosted test-card checkout URLs**, one per seeded customer (incl. the probe-only customer, [DECISIONS #82](DECISIONS.md)), and polls until each one is completed in a browser ([DECISIONS #28](DECISIONS.md)). Dodo test mode documents no API-only way to complete a first payment. `--wait-minutes <n>` (default 30). | The Dodo test world (7 products, 12 customers, 167 payments, 31 refunds per `--plan`), `packages/core/fixtures/seed/manifest.json`, cassette `seed-dodo`. If headless `confirm:true` checkouts don't charge, it stops and writes no manifest. |
| 2 | `pnpm notary notarize --tool crustdata` | `CRUSTDATA_API_KEY`, `CRUSTDATA_CREDIT_BUDGET` (default 200), `NOTARY_MODEL_REFLECTOR`, `NOTARY_MODEL_ADVERSARY` (must differ from the reflector), and the model provider: `NOTARY_LLM_PROVIDER=litellm` + `LITELLM_BASE_URL` + `LITELLM_API_KEY` (used for the Oct 12 runs), or `bedrock` + `AWS_REGION` + AWS credentials (default chain). Optional: `NEATLOGS_API_KEY`, `NOTARY_MAX_PROBES_PER_CLAIM`. `--adversary session` needs the `claude` CLI on PATH. | Notarize bundle in `packages/core/runs/<runId>/`, cassettes `<runId>-recon/-probes/-llm/-inputs` in `packages/core/fixtures/cassettes/`, beliefs + guards in `packages/core/runs/notary.sqlite` |
| 3 | `pnpm notary notarize --tool dodo --priors-from crustdata` | `DODO_PAYMENTS_API_KEY` (test), the same model + AWS variables, and the seed manifest from step 1 (refund probes use only seeded payments the queue never touches, [DECISIONS #42](DECISIONS.md)) | Dodo beliefs that start from Crustdata-learned priors |
| 3b | `pnpm notary notarize --tool dodo --compare-priors --priors-from crustdata` | No keys: it replays the `probes-dodo` cassette twice | `probes_to_candidate_with_priors` / `_without_priors` |
| 4 | `pnpm notary run --queue packages/core/fixtures/queue/seeded.json --naive` | `CRUSTDATA_API_KEY`, `DODO_PAYMENTS_API_KEY` (test), seed manifest | Run-1 baseline bundle (no gate, no guards) |
| 5 | `pnpm notary run --queue packages/core/fixtures/queue/seeded.json` | Same as step 4, plus the notarized beliefs from steps 2–3 in the local store | Guarded run bundle. After a crash, continue it with `pnpm notary run --resume [--run <runId>]` |
| 6 | `pnpm notary eval noise-floor --queue packages/core/fixtures/queue/seeded.json [--runs 3]` | Same as step 5 | `noiseFloor` written into each run bundle and `runs/noise-floor.json` |
| 7 | `pnpm notary replay` | Nothing: no `.env` is loaded | Replay bundles with `replayOf`, plus an exact metric comparison |
| 8 | `pnpm --filter @notary/core make:drift --from <cassette> --exchange <requestHash>[:occurrence] --set '<jsonPath>=<json value>' --out <name>`, then `pnpm notary replay --drift <name>` | Nothing (a real recorded probes cassette) | A labelled drift fixture in `packages/core/fixtures/drift/`, a belief trajectory and the guards it retires |
| 9 | `pnpm notary export` | Nothing | `docs/EVALUATION.md`, `export/TOOLS.md`, `export/guards.json`, and the newest real bundle per category copied to `packages/web/public/bundles/` |

Read these caveats before running the sequence:

- **The seeded world is single-use.** Each live run moves real test-mode state. The naive run's refunds are still in Dodo when the guarded run starts, and `eval noise-floor` doesn't re-seed between its runs (comment in [`src/eval/noise-floor.ts`](../packages/core/src/eval/noise-floor.ts)). Re-seeding means `seed:dodo --force` and another 12 human checkouts. The code doesn't automate this, and no re-seed step has been tried.
- **Run step 9 before committing.** `packages/core/runs/` is gitignored, so a fresh clone can only replay bundles that `export` copied to `packages/web/public/bundles/`, and it copies only the newest bundle per category.
- Optional tuning variables (listed in `.env.example`): `NOTARY_PROBE_LAMBDA`, `NOTARY_PRIOR_STRENGTH`, `NOTARY_MAX_PROBES_PER_CLAIM`, `NOTARY_CRUSTDATA_RPM` (can only lower Crustdata's 15/min), `NOTARY_PRICE_<ROLE>_IN` / `_OUT` (needed for USD on model ids missing from the built-in price table, [DECISIONS #36](DECISIONS.md)).
- `pnpm notary doctor` sends one neatlogs smoke span. Run it first to confirm `NEATLOGS_API_KEY` works.

## CLI reference

Run commands with `pnpm notary <command>` from the repo root, and see `pnpm notary <command> --help` for details. Commands load `.env`, except `replay` and `eval noise-floor --replay`, which never read it.

| Command | Flags | Does |
| --- | --- | --- |
| `notarize` | `--tool <crustdata\|dodo>` (required) · `--priors-from <crustdata\|dodo>` · `--priors-bundle <path>` · `--recon-only` · `--replay` · `--adversary <bedrock\|session>` (default `bedrock`) · `--compare-priors` | Recon → checker → reflector → probes → beliefs → evidence check → adversary → notarize bundle. `--recon-only` stops after the checker. `--replay` serves the `recon-<tool>`/`probes-<tool>` cassettes. `--compare-priors` replays the probe loop twice (without and with priors). |
| `run` | `--queue <file>` (required unless `--resume`) · `--naive` · `--resume` · `--run <runId>` (with `--resume`) · `--replay <cassette>` | Works the queue and writes a run bundle. Guarded by default. `--naive` is the ungated run-1 baseline. |
| `replay` | `--bundle <id>` · `--drift <fixture>` | Keyless re-run of every recorded live bundle (or one), with exact metric comparison. Exit 0 match, 1 miss/tamper/mismatch, 3 nothing recorded. `--drift` replays a drift fixture. |
| `eval noise-floor` | `--queue <file>` (required) · `--runs <n>` (default 3) · `--replay` | Runs the guarded queue N times and records max − min per metric as its noise floor |
| `export` | `--sample` · `--seed <n>` (default 42, with `--sample`) · `--out <dir>` · `--runs-dir <dir>` · `--root <dir>` · `--no-checks` | Writes `export/TOOLS.md`, `export/guards.json` and `docs/EVALUATION.md` from real bundles only, and copies the newest bundles to the dashboard. `--sample` writes the synthetic SAMPLE bundle instead. |
| `guards coverage` | `--json` · `--backend <auto\|entire\|tsc>` (default `auto`) | Caller check over every raw client method. Exits non-zero on any unguarded call site. |
| `serve` | `--port <port>` (default 8787) · `--host <host>` (default `127.0.0.1`) | Local API + SSE for the dashboard's live mode: health, runs, bundles, certificates, SSE stream. Starting runs, ask/chat and approvals need the session token it prints once (localhost only) |
| `economics` | `--cfo-import <file>` · `--runs-dir <dir>` · `--out <file>` | Unit economics from real bundles only → `packages/web/public/economics.json`, `docs/BUSINESS.md`, `export/cfo-inputs.csv`; `--cfo-import` adds a cfo.ai plan |
| `cfo connect` / `cfo status` / `cfo sync` / `cfo push` | `connect --org <id>` · `sync --table <name> --scenario <name>` | cfo.ai over its MCP server (browser OAuth): connect a workspace, show status, read the plan into `economics.json`. `push` explains why costs go in by CSV upload (exit 3) |
| `demo` | `--fixture` (required) · `--scenario <default|change-api>` · `--publish` | The whole pipeline on FIXTURE data: simulated APIs and model doubles, every output labelled |
| `trace-link` | `--example <url>` · `--trace-id <id>` | Derives the neatlogs trace URL template from one real trace URL copied from the neatlogs UI |
| `doctor` | `--llm` | Emits one neatlogs test span and flushes; `--llm` checks the model provider, each role model and one tiny call per role. Exit 3 BLOCKED when a variable is missing |

| Script | Does |
| --- | --- |
| `pnpm test` / `pnpm typecheck` | vitest / tsc across the workspace |
| `pnpm check:secrets` | Key-pattern and `.env`-value scan of tracked files and fixtures (the pre-commit hook in `.githooks/`) |
| `pnpm --filter @notary/core seed:dodo [--plan] [--force] [--wait-minutes <n>]` | Seed the Dodo test world (`--plan`: print only, no network) |
| `pnpm --filter @notary/core make:drift --from … --exchange … --set … --out … [--force]` | Make a drift fixture from a real cassette |
| `node scripts/fresh-clone-check.mjs [--include-uncommitted] [--test] [--keep]` | Fresh-clone install + keyless replay with credentials stripped from the environment |

## Safety

- **Test mode only.** The Dodo client refuses to start unless `NOTARY_MODE=test` and the base URL is `https://test.dodopayments.com`. The docs define no live-key prefix, so the lock relies on those two values ([DECISIONS #15](DECISIONS.md)).
- **Secrets.** Keys live only in `.env` (gitignored). Cassettes are redacted before writing (auth headers, secret-named fields, and any `.env` value whose name looks secret), and callers receive the redacted body even in live mode. Models never see keys. The adversary packet is scrubbed, and the `session` adversary is denied `.env` reads. `pnpm check:secrets` runs as a pre-commit hook. In a fresh clone, enable it with `git config core.hooksPath .githooks`.
- **Budgets and caps.** There is a hard per-run Crustdata credit budget: a reservation that would cross it never sends, and the run stops cleanly with `stopped_budget`. Probe caps: at most `NOTARY_MAX_PROBES_PER_CLAIM` probes per claim (default 5), `header_burst` at most 10 requests per run on free read ops with polite delays, and recon repeat and delay caps. Seeding stays under Dodo's documented sustained rate limit.
- **No blind write retries.** Pending writes are persisted before they are sent. On timeout, 5xx or `--resume`, Dodo state is read back with full pagination. A write is retried only when the read-back proves it didn't land. An undecidable outcome is held.
- **Model output is data.** Reflector and adversary replies are validated with zod. A malformed reply fails safe (no belief change), and no model output ever reaches the grader.

## Disclosure: seeded and synthetic data

- **Seeded queue (SEEDED FIXTURE).** [`packages/core/fixtures/queue/seeded.json`](../packages/core/fixtures/queue/seeded.json) holds 20 hand-written requests against Dodo test-mode customers created by [`packages/core/scripts/seed-dodo.ts`](../packages/core/scripts/seed-dodo.ts). Company domains are real so Crustdata can enrich them. Expected outcomes in [`expected.json`](../packages/core/fixtures/queue/expected.json) were written by hand from the policy table before any run. See [`fixtures/queue/README.md`](../packages/core/fixtures/queue/README.md) for the designed cases. No real person or real money is involved.
- **Sample bundle (SYNTHETIC).** [`packages/web/public/bundles/sample-42.json`](../packages/web/public/bundles/sample-42.json) is generated by [`src/bundle/sample.ts`](../packages/core/src/bundle/sample.ts) for dashboard development: fictional companies on example.com, `[sample]` doc text, seeded-PRNG numbers. It is flagged `sample: true`, and `export` never uses it as a source of results.
- **Drift fixtures (DELIBERATELY ALTERED).** Each one is a copy of a real cassette with exactly one response field changed, carrying a `drift` disclosure block. None exist yet: real cassettes were recorded on Oct 12, but no drift fixture has been made from one ([`fixtures/drift/README.md`](../packages/core/fixtures/drift/README.md)).
- **Evaluation suite (SIMULATED APIs).** [`packages/web/public/bundles/fixture/`](../packages/web/public/bundles/fixture/) holds the bundles of `pnpm notary demo --fixture --publish`: the real pipeline against an in-process simulated Crustdata and Dodo with planted quirks and model doubles. They are `sample: true`, appear on the dashboard only with `?fixtures=1` under the "Fixture data — simulated APIs, not a live run" banner, and are never mixed with real runs.
- Every bundle carries a `disclosure` array that the dashboard must show.

## Repo map

- [`packages/core`](../packages/core/): the agent, CLI, schema, fixtures, tests (Claude Code)
- [`packages/web`](../packages/web/): the landing page, `/docs` guide and dashboard (Claude Code; Codex built the first shell, U1). It reads bundles through the shared zod schema and recomputes every hash in the browser.
- [`packages/showreel`](../packages/showreel/): the 15-second Remotion film ([`docs/media/notary-showreel.mp4`](media/notary-showreel.mp4))
- [`docs/`](): [PRD](PRD.md), [TDD](TDD.md), [ARCHITECTURE](ARCHITECTURE.md), [DECISIONS](DECISIONS.md), [ENDPOINTS](ENDPOINTS.md), [EVALUATION](EVALUATION.md) (generated), [BUILD_PLAN](BUILD_PLAN.md), [BUSINESS](BUSINESS.md) (generated), [ENTIRE](ENTIRE.md), [AUDIT](AUDIT.md), [DEMO_SCRIPT](DEMO_SCRIPT.md)
- [`export/`](../export/): [TOOLS.md](../export/TOOLS.md) (corrected tool spec) and [guards.json](../export/guards.json), both generated

## Full results (PRD metrics and keyless checks)

Every row links to [`docs/EVALUATION.md`](EVALUATION.md), which `pnpm notary export` generates from hash-verified run bundles. Nothing in that file is typed by hand. **Today it is generated from 7 real bundles** (4 live, 3 replays, all notarize runs). Queue-run metrics stay *not computable* until the seeded queue runs exist.

### PRD success metrics

| Metric | PRD target | Value today | Command that produced it (or will) |
| --- | --- | --- | --- |
| [Unsafe money actions](EVALUATION.md#success-metrics-prd) | Run 1 > 0; run 2 = 0 | **not measured on real APIs** (BLOCKED: Dodo seed needs 12 human checkouts). Shown only on the [evaluation suite, simulated APIs](EVALUATION.md#evaluation-suite) | `pnpm notary run --queue packages/core/fixtures/queue/seeded.json --naive`, then the same without `--naive` |
| [Belief precision](EVALUATION.md#success-metrics-prd) | ≥ 0.8, false beliefs = 0 | **1, false beliefs 0** (n = 1 on Crustdata, n = 4 on Dodo). Measured against the deterministic checker on the same recording, not an independent ground truth ([AUDIT A-14](AUDIT.md)) | `pnpm notary notarize --tool crustdata`, `pnpm notary notarize --tool dodo --priors-from crustdata` |
| [Unguarded call sites](EVALUATION.md#success-metrics-prd) | 0 | **0** in every real bundle, and 0 at export time (33 sites: 26 guarded, 7 raw-by-design; `entire` backend) | `pnpm notary guards coverage` |
| [Cost per queue run](EVALUATION.md#success-metrics-prd) | Run 2 lower than run 1 | **not measured** (no queue run). Cost per live notarize run: [$0.0316 + 15.5 credits](../packages/web/public/economics.json) | `pnpm notary run --queue packages/core/fixtures/queue/seeded.json [--naive]` |
| [Probes to confirm on Dodo, with vs without priors](EVALUATION.md#success-metrics-prd) | Fewer with priors | **not measured** (no compare-priors bundle yet) | `pnpm notary notarize --tool dodo --compare-priors --priors-from crustdata` |
| [Automation rate](EVALUATION.md#success-metrics-prd) | Reported honestly | **not measured** (no queue run) | `pnpm notary run --queue packages/core/fixtures/queue/seeded.json` |
| [Reproducibility](EVALUATION.md#success-metrics-prd) | Exact match | **exact match** on every metric for the 3 replayed runs; `notarize-dodo-20261012T012315Z` can't replay ([DECISIONS #200](DECISIONS.md)) | `pnpm notary replay` |
| [Noise floor](EVALUATION.md#not-yet-measured-blocked) | Measured before claiming change | **not measured** (needs three guarded queue runs) | `pnpm notary eval noise-floor --queue packages/core/fixtures/queue/seeded.json` |
| [Drift un-learning (FR-16)](EVALUATION.md#not-yet-measured-blocked) | Belief un-learns, guard retires | **not measured on a real cassette** (real cassettes now exist; no drift fixture has been made from one yet). Shown on the evaluation suite's `change-api` scenario | `pnpm --filter @notary/core make:drift …`, then `pnpm notary replay --drift <name>` |

### Checks that don't need API keys

These values are copied from [`docs/EVALUATION.md` → Checks that don't need API keys](EVALUATION.md#checks-that-dont-need-api-keys). Export ran each command at the time stamped in that file. Re-run the command to reproduce it. If code has changed since the last export, the count can differ.

| Command | Result (from EVALUATION.md) |
| --- | --- |
| [`pnpm test`](EVALUATION.md#checks-that-dont-need-api-keys) | PASS: core 1033 passed, 0 failed (2 local-only checks skip on a fresh clone) ([EVALUATION.md](EVALUATION.md#checks-that-dont-need-api-keys)); web 360 passed, 0 failed (`pnpm test` runs both) |
| [`pnpm notary guards coverage --json`](EVALUATION.md#checks-that-dont-need-api-keys) | PASS: unguarded_call_sites = 0 (33 sites: 26 guarded, 7 raw-by-design; backend entire) |

The `tsc` backend reports the same 33 sites and 0 unguarded call sites ([`docs/ENTIRE.md`](ENTIRE.md)).
