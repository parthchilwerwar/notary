# Notary — Plan

Phase checklist from `docs/BUILD_PLAN.md`. One phase per session; each ends with tests passing and one commit.

## Claude Code — `packages/core`

- [x] **P0 · Scaffold** — pnpm monorepo, schema stubs, CLI skeleton, neatlogs smoke span, Entire enabled
- [ ] **P1 · Tool clients, recorder, schema freeze** — Crustdata + Dodo raw clients, cassette recorder with redaction, credit ledger, Dodo test-mode lock, final bundle schema, sample bundle
- [ ] **P2 · Contracts and deterministic checker** — claims from real docs, checker, recon sweep
- [ ] **P3 · Seeded world and naive run** — Dodo seed script, seeded queue + expected outcomes, policy table, naive executor, grader, first bundle
- [ ] **P4 · Reflector and probes** — Bedrock client with roles, batched hypotheses, probe templates, cost-aware scoring, commit-then-run, verdict rules
- [ ] **P5 · Beliefs and adversary** — beta-binomial store, lifecycle incl. `unlearned`, adversary (`bedrock` + `session`), evidence-validity check
- [ ] **P6 · Guards, gated queue, recovery** — guard compiler, `guarded()` clients, required-beliefs gating, evidence packs, `--resume`, local API + SSE
- [ ] **P7 · Transfer, drift, coverage** — `--priors-from`, drift fixture, `notary guards coverage`
- [ ] **P8 · Replay and evaluation** — `notary replay`, noise floor, metrics, `docs/EVALUATION.md`, `export/TOOLS.md`
- [ ] **P9 · Self-audit and README** — `docs/AUDIT.md`, `README.md`, `docs/ARCHITECTURE.md`
- [ ] **P10 · Business plan, final runs, recording** — `docs/BUSINESS.md`, final bundles, demo footage

## Codex — `packages/web`

- [ ] **U1 · Dashboard shell** — layout, run picker, Queue and Beliefs screens
- [ ] **U2 · Probe log, runs comparison, live mode**
- [ ] **U3 · Economics screen, polish, deploy**

## Gates

- [ ] Schema freeze (end of P1)
- [ ] Feature freeze (Mon 12:00 IST)

## Notes

**P0 (Oct 10).** Workspace, schema stubs, CLI skeleton (all commands stubbed), `src/trace/` + `notary doctor`, `.env.example`, `CLAUDE.md`, `docs/DECISIONS.md`. 25 tests pass, typecheck clean. Two "done when" items are still open and must close before P1 work starts:
- [ ] Live test span in neatlogs: `notary doctor` currently reports `NEATLOGS_API_KEY not set; no span sent`. Add the key to `.env` and re-run `pnpm notary doctor`.
- [ ] Entire checkpoint: the Entire CLI isn't installed, so this commit has none. Install it and run `entire enable`.
