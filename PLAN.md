# Notary — Plan

Phase checklist from `docs/BUILD_PLAN.md`. One phase per session; each ends with tests passing and one commit.

## Claude Code — `packages/core`

- [x] **P0 · Scaffold** — pnpm monorepo, schema stubs, CLI skeleton, neatlogs smoke span, Entire enabled
- [x] **P1 · Tool clients, recorder, schema freeze** — Crustdata + Dodo raw clients, cassette recorder with redaction, credit ledger, Dodo test-mode lock, final bundle schema, sample bundle
- [x] **P2 · Contracts and deterministic checker** — claims from real docs, checker, recon sweep
- [x] **P3 · Seeded world and naive run** — Dodo seed script, seeded queue + expected outcomes, policy table, naive executor, grader, first bundle
- [x] **P4 · Reflector and probes** — Bedrock client with roles, batched hypotheses, probe templates, cost-aware scoring, commit-then-run, verdict rules
- [x] **P5 · Beliefs and adversary** — beta-binomial store, lifecycle incl. `unlearned`, adversary (`bedrock` + `session`), evidence-validity check
- [x] **P6 · Guards, gated queue, recovery** — guard compiler, `guarded()` clients, required-beliefs gating, evidence packs, `--resume`, local API + SSE
- [x] **P7 · Transfer, drift, coverage** — `--priors-from`, drift fixture, `notary guards coverage`
- [x] **P8 · Replay and evaluation** — `notary replay`, noise floor, metrics, `docs/EVALUATION.md`, `export/TOOLS.md`
- [x] **P9 · Self-audit and README** — `docs/AUDIT.md`, `README.md`, `docs/ARCHITECTURE.md`
- [ ] **P10 · Business plan, final runs, recording** — `docs/BUSINESS.md`, final bundles, demo footage

## Codex — `packages/web`

- [ ] **U1 · Dashboard shell** — layout, run picker, Queue and Beliefs screens
- [ ] **U2 · Probe log, runs comparison, live mode**
- [ ] **U3 · Economics screen, polish, deploy**

## Gates

- [x] Schema freeze (end of P1) — `packages/core/src/schema/bundle.ts`; changes now need user approval
- [ ] Feature freeze (Mon 12:00 IST)

## Notes

**P0 (Oct 10).** Workspace, schema stubs, CLI skeleton (all commands stubbed), `src/trace/` + `notary doctor`, `.env.example`, `CLAUDE.md`, `docs/DECISIONS.md`. 25 tests pass, typecheck clean. Two "done when" items are still open and must close before P1 work starts:
- [ ] Live test span in neatlogs: `notary doctor` currently reports `NEATLOGS_API_KEY not set; no span sent`. Add the key to `.env` and re-run `pnpm notary doctor`.
- [ ] Entire checkpoint: the Entire CLI isn't installed, so this commit has none. Install it and run `entire enable`.

**P1 (Oct 10).** Recorder (live/replay, redaction, occurrence-keyed replay), Crustdata + Dodo raw clients behind `createTools({wrap})`, credit ledger, Dodo test-mode lock, frozen bundle schema + content hash, `notary export --sample` → `packages/web/public/bundles/sample-42.json` (validates, hash matches). `pnpm check:secrets` + pre-commit hook. 63 tests pass. Endpoints in `docs/ENDPOINTS.md`.
- [ ] BLOCKED: one live recorded call per API — `CRUSTDATA_API_KEY` and `DODO_PAYMENTS_API_KEY` not set (attempt returned `MissingCredentialError`, no network call). No cassettes exist yet.

**P2 (Oct 10).** 26 claims from real docs (`src/contracts/`), deterministic checker for all 8 expect rules (`src/checker/`), recon runner with budget/repeat/delay caps, `notarize --recon-only [--replay]`. Determinism verified in unit tests (checkAll twice → identical JSON; replay recon over a test cassette twice → identical anomalies). 116 tests pass.
- [ ] BLOCKED: recon on real recorded traffic — `notarize --recon-only` prints `BLOCKED: CRUSTDATA_API_KEY not set` / `DODO_PAYMENTS_API_KEY not set` (exit 3). Once keys exist: run live once, then `--replay` twice and diff.
- [ ] BLOCKED: `entire graph` raw-client check (Entire CLI not installed); static-scan test passes instead.

**P3 (Oct 10).** Policy table + `tierFromCompany`/`decidePolicy`, seed plan + `scripts/seed-dodo.ts` (`seed:dodo --plan` verified: 6 products, 11 customers, 119 payments, 142 writes, 11 human checkouts), seeded queue (20) + hand-written expected outcomes, naive executor, deterministic grader (duplicates / wrong unit / missed existing refund, accuracy, automation; null when not computable), `notary run --naive`. 166 tests pass.
- [ ] BLOCKED: live seed + naive run — `BLOCKED: DODO_PAYMENTS_API_KEY not set` (exit 3). Seeding also needs 11 hosted test-card checkouts by a human (see DECISIONS #28). Then: `pnpm --filter @notary/core seed:dodo`, `pnpm notary run --queue packages/core/fixtures/queue/seeded.json --naive`.

**P4 (Oct 10).** Bedrock client (3 roles, temp 0, per-role usage + USD, span per call), one batched fail-safe reflector call, 8 probe templates with control variants, cost-aware score, SQLite commit-then-run with immutable predictions, verdict rules exactly per TDD (each unit-tested), `notarize --tool` runs recon → checker → probe loop. 254 tests pass.
- [ ] BLOCKED: live probe loop — `notarize --tool dodo` prints `BLOCKED: DODO_PAYMENTS_API_KEY not set` and `BLOCKED: NOTARY_MODEL_REFLECTOR not set`. Needs Crustdata/Dodo keys, Bedrock model ids + AWS credentials, and a neatlogs key to show the prediction span before the call.

**P5 (Oct 10).** Beta-binomial belief store (P(θ>0.5) confidence, append-only events, unlearn on crossing 0.5), probe-until-settled loop (cap 5/claim), local span sink + FR-10 evidence-validity check, adversary with `bedrock` and `session` (headless Claude Code, verdict committed) backends, `notarize --adversary`. 340 tests pass.
- [ ] BLOCKED: `notarize --tool crustdata` end to end (no Crustdata key, no reflector/adversary model ids or AWS credentials). No real belief or adversary verdict exists yet.

**P6 (Oct 10).** Guard compiler (6 kinds) + registry + `guarded()` passed as createTools' wrap, retire-on-unlearn, required-beliefs gate with evidence packs, guarded `notary run`, per-item SQLite run state + `run --resume` with read-back before retry (crash-and-resume tested with doubles), `notary serve` (Hono, `/api/bundles`, `/api/bundles/:id`, SSE `/api/stream`; checked live with curl). 397 tests pass.
- [ ] BLOCKED: guarded run on the seeded queue (zero-unsafe check) and a real kill-and-resume — `BLOCKED: DODO_PAYMENTS_API_KEY not set`; also needs notarized beliefs from a live P5 run.

**P7 (Oct 10).** Transfer priors (`--priors-from`, `--compare-priors`), probes-to-candidate metrics, `make:drift` tool + `replayDrift` (un-learning + guard retirement tested on a temp test cassette), `notary guards coverage` — run for real on this repo: **27 sites, 21 guarded, 6 raw-by-design, 0 unguarded, exit 0** (tsc backend). 428 tests pass.
- [ ] BLOCKED: Dodo notarize with vs without priors — needs a Crustdata notarize bundle and live keys (`BLOCKED: no notarize bundle for crustdata`).
- [ ] BLOCKED: real drift fixture — no real cassette to derive it from.
- [ ] Unverified: `entire` coverage backend (Entire not installed).
- [x] Carry to P8: replay identity fixed (probe tags derive from the recorded runId).

**P8 (Oct 10).** `notary replay` (keyless, loud on miss/tamper, exact metric comparison; reproduces probes/verdicts/beliefs/metrics on test cassettes), consolidated metrics (null when not computable), `eval noise-floor`, `notary export` → `export/TOOLS.md`, `export/guards.json`, generated `docs/EVALUATION.md`. Today export finds 0 real bundles; its only numbers are keyless checks it ran: 468 tests passed, 0 unguarded call sites. `replay` today: `BLOCKED: no recorded live runs to replay`, exit 3. 468 tests pass.
- [ ] BLOCKED: headline numbers, noise floor and fresh-clone replay match — no recorded live runs (needs all API keys). Fresh-clone install + tests: see `scripts/fresh-clone-check.mjs`.

**P9 (Oct 10).** Hostile audit → `docs/AUDIT.md` (26 findings; 9 fixed with tests), `README.md` (results table links only to generated EVALUATION.md rows), `docs/ARCHITECTURE.md` (as built). Verified: 481+ tests, typecheck, check:secrets, guards coverage 0 unguarded, replay BLOCKED exit 3, export regenerated.
- [ ] OPEN (critical, user decision): commits predate the 12:30 IST start — see AUDIT.md / DECISIONS #72.
- [ ] Tell Codex: `sample-42.json` was regenerated (metric keys now match real bundles).

## Resume here (next session)
1. Fill `.env` (Crustdata, Dodo test key, neatlogs key + service token, AWS creds/SSO + 3 model ids); install Entire CLI and `entire enable`.
2. `pnpm notary doctor` → real span in neatlogs.
3. Follow README "Recording real runs" in order (seed with 11 hosted checkouts → notarize crustdata → notarize dodo --priors-from crustdata → run --naive → run → eval noise-floor → make:drift + replay --drift → export).
4. Re-check every BLOCKED line above; update EVALUATION via `pnpm notary export`.

## Session 3 — keyless hardening (Oct 10)
- [x] Step 1 keyless health check run for real (fresh-clone install, typecheck, 481 tests, check:secrets, coverage 0 unguarded; every CLI command with --help and with no keys; `serve` curl incl. tampered bundle → `x-notary-hash-mismatch: 1`). Two failures found: `doctor` exit 1 not BLOCKED/3 (DECISIONS #73), SSE not cross-process (#74) — both fixed with tests (`test/health-fixes.test.ts`).
- [ ] Step 2 `notary demo --fixture` walkthrough
- [ ] Step 4 open audit findings
