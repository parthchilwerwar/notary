# Notary — standing rules for Claude Code

Read `docs/PRD.md`, `docs/TDD.md` and `docs/BUILD_PLAN.md` before working. `PLAN.md` tracks which phase is current.

## Rules

- One phase per session, following `docs/BUILD_PLAN.md`. Never build ahead of the current phase.
- You own `packages/core`, the schema, fixtures, CLI, docs **and `packages/web`** (Codex is out of quota; v2 "Agent Control Center" is yours end to end).
- Detection, grading and metrics are deterministic code. Models only explain, propose or review.
- Never hardcode results, metrics or demo values. If anything looks faked, stop and tell the user.
- Dodo Payments runs in test mode only. Never log, trace or record secrets.
- Use `entire graph` for code search and change impact before refactors or cross-file changes.
- If the docs and reality disagree (an SDK API, an endpoint), follow reality and note the difference in `docs/DECISIONS.md`.
- End every phase with tests passing, `PLAN.md` updated, and one commit with a clear message.

## Web rules (`packages/web`)

- The run bundle schema (`packages/core/src/schema/bundle.ts`) stays frozen. Everything new is new files, schemas and endpoints.
- The web app imports only from `packages/core/src/schema` and `packages/core/src/bundle/hash.ts`.
- Every number on screen comes from data files. No hardcoded or invented values, no placeholder data committed.
- Fixture data always shows a visible "Fixture data — simulated APIs, not a live run" banner and is never mixed with live data in one chart or table.
- Recompute bundle hashes in the browser; show a visible error on mismatch.
- Local-only endpoints (`/api/ask`, `/api/approvals`) are localhost-only with a per-session token; the hosted site is read-only.
- Pin exact versions for new dependencies; record docs-vs-reality differences in `docs/DECISIONS.md`.
- If something needs keys or can't work yet, build the rest, mark it BLOCKED in `PLAN.md` with the reason. Never fake it.

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
