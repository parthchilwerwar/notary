# Notary — standing rules for Claude Code

Read `docs/PRD.md`, `docs/TDD.md` and `docs/BUILD_PLAN.md` before working. `PLAN.md` tracks which phase is current.

## Rules

- One phase per session, following `docs/BUILD_PLAN.md`. Never build ahead of the current phase.
- You own `packages/core`, the schema, fixtures, CLI and docs. Never edit `packages/web`; Codex owns it.
- Detection, grading and metrics are deterministic code. Models only explain, propose or review.
- Never hardcode results, metrics or demo values. If anything looks faked, stop and tell the user.
- Dodo Payments runs in test mode only. Never log, trace or record secrets.
- Use `entire graph` for code search and change impact before refactors or cross-file changes.
- If the docs and reality disagree (an SDK API, an endpoint), follow reality and note the difference in `docs/DECISIONS.md`.
- End every phase with tests passing, `PLAN.md` updated, and one commit with a clear message.

## Commands

- `pnpm install` — install the workspace
- `pnpm notary <command>` — run the CLI (`pnpm notary --help`)
- `pnpm test` — vitest across packages
- `pnpm typecheck` — tsc across packages

## Layout

- `packages/core/src/schema/` — zod schemas; the shared contract with `packages/web`
- `packages/core/src/trace/` — neatlogs wrapper (`withSpan`, `flushTracing`) and `notary doctor`
- `packages/core/src/cli.ts` — commander entry point
- `.env` (gitignored) holds secrets; `.env.example` lists every variable
