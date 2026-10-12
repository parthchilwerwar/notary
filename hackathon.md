# neatHack — Notary submission log

Notary: *certifies how your payment APIs actually behave, and won't move money on anything it hasn't certified* — Read → Test → Challenge → Certify → Enforce.
This file tracks hackathon facts, sponsor evidence and submission status. Details live in
[PLAN.md](PLAN.md), [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/AUDIT.md](docs/AUDIT.md).

## Start time and authenticity (AUDIT A-11, DECISIONS #72)

| Source | Start given |
| --- | --- |
| Luma event page | **12:00 AM IST, Oct 10, 2026** |
| Organizers' email, Oct 9 | **12:00 AM IST, Oct 10, 2026** |
| Hackathon website | 12:30 PM IST, Oct 10, 2026 (discrepancy) |

| Repo fact | Time (IST) |
| --- | --- |
| Planning docs written (`docs/PRD.md`, `TDD.md`, `BUILD_PLAN.md`; file mtimes) | Oct 9, ~20:57 — specs only, no code |
| Empty `.git` created | Oct 10, 02:22 |
| First commit `7881199` (P0 scaffold) | **Oct 10, 02:49:08** — 2 h 49 min after the Luma/email start |
| P9 committed (`95aed48`) | Oct 10, 06:04 |

History has not been rewritten. Keep the Luma page and the Oct 9 email as evidence of the start
time. Residual note: P0–P9 landed within ~3.5 hours; later work (sessions 3–4) is spread over the day.

## Sponsor evidence

Machine-readable copy for the dashboard: [packages/web/public/evidence/evidence.json](packages/web/public/evidence/evidence.json).

| Sponsor | Status | Evidence |
| --- | --- | --- |
| neatlogs | **live** — UI trace link pending | Real notarize runs exported traces `9db41ecd43406cef291c93ef8c9ab1cd` (Crustdata) and `a0e6fda50d71a9eb2fec0f04843bff4d` (Dodo): AGENT, LLM, TOOL, GUARDRAIL and EVALUATOR spans, probe spans carrying the prediction committed before the call, incidents logged with the same ids as `packages/web/public/incidents/` (DECISIONS #204, #205). A real trace was read back from the ingest API (56 spans). Pending: one neatlogs UI URL for `pnpm notary trace-link --example <url> --trace-id <id>`, and `NEATLOGS_SERVICE_TOKEN` for neatlogs-cli |
| Entire | **live** — enabled late | CLI 0.11.4 + entire-graph v0.4.0, enabled Oct 12 (DECISIONS #207). Checkpoints on every commit since `409fd51` (first: `01M4Q2CJDTHF76EE7QK11TEEV1`; current list in `packages/web/public/evidence/entire.json`) under `refs/entire/checkpoints/`, pushed to origin. Only 2 of ~83 commits are checkpointed because Entire was enabled late. `guards coverage --backend entire`: 33 sites, 26 guarded, 7 raw-by-design, 0 unguarded (`packages/web/public/evidence/entire.json`) |
| cfo.ai | **integrated** — connected over MCP | No REST API or key; MCP server with browser OAuth (DECISIONS #206). `notary economics` writes real costs (`packages/web/public/economics.json`, `docs/BUSINESS.md`, `export/cfo-inputs.csv`); Business tab shows $0.0316 + 15.5 credits per live run. `notary cfo connect` / `cfo sync` read the plan over MCP; no plan imported yet (`economics.json` → `plan: null`) |
| Crustdata | **live** | Live notarize run `notarize-crustdata-20261012T011404Z`: 62 credits, $0.0394 in model calls; the deterministic checker found 3 doc contradictions (enrich no-match 400 vs documented 200; identify no-match 400 vs 200; identify invalid fields 403 vs 400), not yet certified; 1 certificate ("matches docs") |
| Dodo Payments | **live (test mode)** — queue runs blocked | Two live notarize runs + one recon sweep; 4 certificates, all "matches docs", each narrowed by the adversary. Queue runs BLOCKED on the seed: `seed:dodo` + 12 hosted test-card checkouts by a person. `notarize-dodo-20261012T012315Z` can't replay (DECISIONS #200) |
| LiteLLM | **live** | Provider for every model call on Oct 12: reflector `claude-sonnet-4.6`, adversary `claude-opus-4.6`, chat `claude-sonnet-4.6`, executor `claude-haiku` (DECISIONS #198); `notary doctor --llm` passes all four roles |
| AWS | **integrated** — credentials verified | Credentials configured for us-east-1 and verified with STS `GetCallerIdentity` (Oct 12). ECS Express deploy scripts in `deploy/aws/` (DECISIONS #203), ready to run; not deployed yet (billable), Docker image not built. Bedrock client kept as the optional provider |

## What exists now

Real (live APIs, Oct 12):

- 4 live bundles + 3 replays in `packages/web/public/bundles/`; every replay matches its live run on every metric. `docs/EVALUATION.md` is generated from these 7 bundles.
- 5 real certificates, all "matches docs", 21 of 26 claims unproven (`packages/web/public/certificates/report.json`, `export/REPORT.md`). The adversary (`claude-opus-4.6`) narrowed all 5.
- 3 Crustdata doc contradictions found by the deterministic checker; every one of the 19 live probes committed a hashed prediction before its call.
- Belief precision 1, false beliefs 0 (n = 1 Crustdata, n = 4 Dodo; measured against the checker on the same recording, AUDIT A-14). Unguarded call sites 0.
- Notary Chat as a tool-calling agent on LiteLLM (read-only tools, citations checked by code, never moves money); `/app/incidents`; `/app/business` with real computed costs.
- Tests: `pnpm test` passes — core 1033 (+2 local-only skips on a fresh clone), web 360 (core row in `docs/EVALUATION.md` → Checks that don't need API keys); typecheck clean; `pnpm check:secrets` clean.

Evaluation suite (simulated APIs, never mixed with real results):

- `notary demo --fixture`: the whole pipeline on a simulated, clearly labelled fixture world — naive run 9 unsafe actions, guarded run 0 (executes 2 plan changes, holds 12 with evidence packs); Stage 11 shows a drift replay un-learning a mixed-evidence belief and retiring its guard. Published under `packages/web/public/bundles/fixture/` (sample: true), shown only with `?fixtures=1` and the fixture banner.
- `notary demo --fixture --scenario change-api`: the simulated Dodo switches the refund amount unit mid-run; the re-verification sentinel un-learns the belief, the certificate is revoked, its guard retires and the refund that would have gone out 100× short is held.
- Fixture certificate reports under `packages/web/public/certificates/fixture/<scenario>/`.

## v2 — Agent Control Center (V0–V5 shipped)

- V1 core support shipped: run timelines, deterministic explain engine (`explain.json`), local `POST /api/ask` and `GET/POST /api/approvals` (localhost + per-session token, Dodo test mode only), browser-safe certificate schemas. 780 core tests pass.
- V2–V4 dashboard shipped (Claude Code now owns `packages/web`): app shell with ⌘K palette and record URLs, Mission control (five-stage graph, event feed, budget meters, live SSE / fixture replay), decision trail with "Model said" / "Verified" tags, Ask Notary (⌘J, cited answers), Approval desk (typed-amount confirm, local test mode only). 138 web tests.
- V5: landing page at `/`, full screenshot review (1440/390, light/dark) with contrast and state fixes, Vercel config (not deployed yet). Tests: 780 core + 152 web.
- Session 8: LiteLLM provider, `notary doctor --llm`, actionable BLOCKED messages, `NOTARY_MAX_USD` cap, model-call and Ask rate limits, one neatlogs trace per Ask question (retrieve → model call → citation validation). 850 core + 152 web tests.
- Sessions 9–10: real backend wiring (health, runs, events, certificates, approvals endpoints; one web data layer), Notary Chat (multi-turn, 11 read-only tools, citations validated, one trace per message, can never move money), sky-blue landing + dashboard on one shared UI kit, agent names from one source of truth, evaluation-suite section in docs/EVALUATION.md (simulated APIs disclosed). 925 core + 221 web tests. Screenshots in docs/screenshots/.
- Session 12: first real runs on live keys, Notary Chat as a real tool-calling agent, neatlogs agent monitoring + incidents, cfo.ai round trip + Business tab, Entire installed and enabled, AWS deploy scripts (PLAN.md Session 12).
- Still blocked: live approvals (needs the Dodo seed and a real guarded run with held items).

## Dashboard data (JSON only)

- `packages/web/public/bundles/fixture/` — FIXTURE bundles from `notary demo --fixture --publish` (never mixed with real bundles)
- `packages/web/public/content/glossary.json` — plain-language glossary from `notary export --content`
- `packages/web/public/evidence/evidence.json` — sponsor evidence from `notary export --evidence`
- `packages/web/public/certificates/` — certificates, revocations and `report.json` (real), `fixture/<scenario>/` (FIXTURE)

## Submission checklist (BUILD_PLAN)

- [ ] Repo public (currently private: github.com/parthchilwerwar/notary)
- [x] Live keys in `.env`; notarize runs recorded (Crustdata, Dodo) — queue runs still BLOCKED on the Dodo seed (12 hosted test-card checkouts)
- [x] `pnpm notary replay` reproduces the recorded notarize runs offline (3 of 4; `notarize-dodo-20261012T012315Z` is unreplayable, DECISIONS #200); exit 0, the unreplayable run is reported as SKIPPED from `packages/core/fixtures/replay/known-unreplayable.json`
- [x] `pnpm notary replay` from a fresh copy of the tracked files (no `.env`): exit 0, core tests pass (DECISIONS #210, #214)
- [x] Entire installed, `entire enable`, checkpoint refs pushed (every commit since `409fd51`; enabled late; list in `packages/web/public/evidence/entire.json`)
- [x] No secrets in repo or cassettes (`pnpm check:secrets`)
- [x] Seeded data, sample and fixture bundles, drift fixtures disclosed (README, bundle disclosures)
- [x] cfo.ai integrated: `notary cfo connect` signed in over MCP to the team workspace (Oct 12); real costs in `docs/BUSINESS.md`, `economics.json`, `export/cfo-inputs.csv`
- [ ] cfo.ai plan synced (`pnpm notary cfo sync` once the "Notary Plan" table exists in the workspace)
- [ ] Dashboard deployed with real bundles (Vercel config exists; not deployed)
- [ ] Demo video (~2.5 min) — script in `docs/DEMO_SCRIPT.md`
- [ ] Quote-tweet the neatlogs post (Mon Oct 12, 7:00 PM IST) and post in Discord
