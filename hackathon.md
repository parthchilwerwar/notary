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
| neatlogs | **live** (SDK export) — trace links pending one real URL from the neatlogs UI (`notary trace-link`) | `notary doctor` flushed a real span on Oct 10: trace `8e4a01d2811652fa2e8c4e4334642137`, span `1518e64a727d8bac`. Every CLI entry point roots a WORKFLOW span; Bedrock calls via `wrapBedrock`. No notarize/run spans yet (no live runs); `neatlogs-cli` not installed, so traces aren't read back |
| Entire | pending | CLI not installed; no `entire enable`, no checkpoints. Coverage runs on the tsc backend (0 unguarded call sites). The `entire` backend now uses the documented `neighbors --relation CALLS` flags but is UNVERIFIED until Entire runs locally (DECISIONS #102) |
| cfo.ai | pending | Business plan is P10 (manual): `docs/BUSINESS.md`, `packages/web/public/economics.json` not created yet |
| Crustdata | blocked (no key) | Client, 26-claim contracts, 15 req/min throttle, credit budget built; no live calls recorded |
| Dodo Payments | blocked (no key) | Test-mode-locked client built; seeding needs 12 hosted test-card checkouts |
| AWS Bedrock | blocked (no creds/model ids) | Converse client with three roles; no live calls |

## What exists now (keyless)

- `pnpm test`: 673 tests pass; typecheck clean; `pnpm check:secrets` clean; `notary guards coverage`: 0 unguarded call sites.
- `notary demo --fixture`: the whole pipeline on a simulated, clearly labelled fixture world — naive run 9 unsafe actions, guarded run 0 (executes 2 plan changes, holds 12 with evidence packs); Stage 11 shows a drift replay un-learning a mixed-evidence belief and retiring its guard. Published for the dashboard under `packages/web/public/bundles/fixture/` (sample: true, never mixed with real bundles).
- `notary demo --fixture --scenario change-api`: the simulated Dodo switches the refund amount unit mid-run; the re-verification sentinel un-learns the belief, the certificate is revoked, its guard retires and the refund that would have gone out 100× short is held.
- Certificates: `notary export --certificates` → `export/REPORT.md` (real: 0 bundles, all claims "not tested"); fixture reports under `packages/web/public/certificates/fixture/<scenario>/`.
- `docs/EVALUATION.md` is generated from real bundles only: **0 real bundles today**, so every PRD headline metric is "not measured yet".

## v2 — Agent Control Center (in progress)

- V1 core support shipped: run timelines, deterministic explain engine (`explain.json`), local `POST /api/ask` and `GET/POST /api/approvals` (localhost + per-session token, Dodo test mode only), browser-safe certificate schemas. 780 core tests pass.
- V2–V4 dashboard shipped (Claude Code now owns `packages/web`): app shell with ⌘K palette and record URLs, Mission control (five-stage graph, event feed, budget meters, live SSE / fixture replay), decision trail with "Model said" / "Verified" tags, Ask Notary (⌘J, cited answers), Approval desk (typed-amount confirm, local test mode only). 138 web tests.
- Blocked on keys: Ask answers (Bedrock executor model), live approvals (Dodo test key + real held items).

## Dashboard data (JSON only)

- `packages/web/public/bundles/fixture/` — FIXTURE bundles from `notary demo --fixture --publish` (never mixed with real bundles)
- `packages/web/public/content/glossary.json` — plain-language glossary from `notary export --content`
- `packages/web/public/evidence/evidence.json` — sponsor evidence from `notary export --evidence`
- `packages/web/public/certificates/` — certificates, revocations and `report.json` (real), `fixture/<scenario>/` (FIXTURE)

## Submission checklist (BUILD_PLAN)

- [ ] Repo public (currently private: github.com/parthchilwerwar/notary)
- [ ] Live keys in `.env`; record runs (README "Recording real runs")
- [ ] `pnpm notary replay` reproduces headline numbers from a fresh clone (today: BLOCKED, exit 3 — nothing recorded)
- [ ] Entire installed, `entire enable`, checkpoint branches pushed
- [x] No secrets in repo or cassettes (`pnpm check:secrets`)
- [x] Seeded data, sample and fixture bundles, drift fixtures disclosed (README, bundle disclosures)
- [ ] `docs/BUSINESS.md` with the cfo.ai plan
- [ ] Dashboard (Codex, `packages/web`) deployed with real bundles
- [ ] Demo video (~2.5 min)
- [ ] Quote-tweet the neatlogs post (Mon Oct 12, 7:00 PM IST) and post in Discord
