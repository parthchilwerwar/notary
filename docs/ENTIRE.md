# Entire in Notary

[Entire](https://entire.io) records AI agent sessions next to the commits they produce. With Entire enabled, a commit made during a tracked Claude Code session gets an `Entire-Checkpoint: <id>` trailer, and Entire saves a checkpoint for it: the transcript, the prompts, the files the agent touched and the token usage. The Entire CLI also ships an official code-graph plugin, `entire graph`.

Notary uses Entire for three things:

| Use | What happens | Where |
| --- | --- | --- |
| Checkpointed adversary reviews | The adversary's `session` backend runs a headless Claude Code review in the repo and commits the verdict (`adversary: <verdict> <beliefId>`). Entire checkpoints that commit with the reviewer's session, so each review sits next to the belief it judged, with its full transcript. | [`packages/core/src/adversary/session.ts`](../packages/core/src/adversary/session.ts) |
| Checkpointed build sessions | Every Claude Code session that commits in this repo is checkpointed the same way. That is the build history Entire is meant to show. | `.claude/settings.json`, `.githooks/` |
| Guard coverage (FR-17) | `notary guards coverage --backend entire` asks Entire's code graph for every call into a raw Dodo or Crustdata client method. Anything outside the guard wrapper fails the check. | [`packages/core/src/guards/coverage.ts`](../packages/core/src/guards/coverage.ts) |

`pnpm notary export --entire` publishes the checkpoints and the coverage result to `packages/web/public/evidence/entire.json` ([schema](../packages/core/src/schema/entire.ts)). The Report page shows them under **Receipts → Review checkpoints**.

## What is installed

Checked on 2026-10-12, Windows 11:

| Component | Version | Source |
| --- | --- | --- |
| Entire CLI (`entire.exe`, `git-remote-entire.exe`) | 0.11.4 (go1.27.1, windows/amd64) | Official GitHub release [entireio/cli v0.11.4](https://github.com/entireio/cli/releases/tag/v0.11.4), `entire_windows_amd64.zip`. SHA-256 `c46e4c61b55780c3d3b8192cf8bec67c436b64a4adf181a739ec38b74d4e99c7` matches the release's `checksums.txt`. Copied to `~/.local/bin` (user-local, already on PATH). |
| entire-graph plugin | v0.4.0 | `entire plugin install graph`: the official plugin index, [entireio/entire-graph](https://github.com/entireio/entire-graph), checksum-verified by the CLI. Installed to `%LOCALAPPDATA%\entire\plugins\bin`. |

No account and no login are needed for local checkpoints or `entire graph`. `entire login` is only for entire.io features (cross-repo search, dispatch, the web viewer). It has not been run.

## Setup on a new machine

```sh
# 1. Install the CLI (pick one; the docs list all of them: https://docs.entire.io/installation)
#    Windows: download entire_windows_amd64.zip from https://github.com/entireio/cli/releases,
#             check it against checksums.txt, put entire.exe and git-remote-entire.exe on PATH
#    or:      irm https://entire.io/install.ps1 | iex
#    macOS:   brew install --cask entireio/tap/entire
#    Linux:   curl -fsSL https://entire.io/install.sh | bash
entire --version                       # Entire CLI 0.11.4

# 2. The code-graph plugin
entire plugin install graph
entire graph version --json            # {"provider":"entire-graph","version":"v0.4.0"}

# 3. In the repo. The project settings are committed, so a fresh clone only needs the local hooks:
entire enable --agent claude-code --telemetry=false --checkpoint-push-remote origin
entire status                          # ● Enabled · branch main · Agents · Claude Code
```

Step 3 is what was run in this repo. It wrote:

| File | Committed? | Contents |
| --- | --- | --- |
| `.entire/settings.json` | yes | `enabled`, `telemetry: false`, checkpoint store `git-refs`, and `commit_linking: "always"` (added by hand, see below). No secrets. |
| `.entire/.gitignore` | yes | Keeps `tmp/`, `settings.local.json`, `metadata/`, `logs/` and `redactors/local/` out of git. |
| `.entire/settings.local.json` | no (ignored) | `checkpoint_push_remote: origin` for this clone. |
| `.claude/settings.json` | yes | Nine Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, …) that call `entire hooks claude-code <event>`, and do nothing if `entire` is not on PATH. |
| `.githooks/prepare-commit-msg`, `commit-msg`, `post-commit`, `post-rewrite`, `pre-push` | yes | Entire's git hooks. This repo sets `core.hooksPath=.githooks`, so Entire wrote them there. The existing `pre-commit` secret check is untouched. Each hook is a no-op without `entire` on PATH. |

**`commit_linking: "always"`.** Entire's default is `prompt`: when a commit follows agent work, the prepare-commit-msg hook asks `[Y/n/a]` on the terminal. The adversary's verdict commit is made by Node with no terminal, so the hook waited forever (observed live). With `always`, every commit made while Entire tracks a session is linked without asking.

**Pushing.** With `checkpoint_push_remote: origin`, the pre-push hook pushes the checkpoint refs along with `git push`. Checkpoints contain session transcripts. Entire's docs say it redacts secrets before anything leaves the machine ([security](https://docs.entire.io/security)), but in this repo its redaction missed an ElevenLabs key and an AWS access key id that appeared in session transcripts. Before the repo went public, every ref was scanned for the `.env` values and the five checkpoints that contained them were deleted, locally and on GitHub (DECISIONS #221). The repo is public now, so anyone who clones it can fetch the remaining checkpoint refs. This clone now runs `entire configure --local --skip-push-sessions`, so new session logs stay local.

## How checkpoints map to agent sessions

```
Claude Code session (session_id = S)        hooks: .claude/settings.json → entire hooks claude-code …
   │  edits files; Entire snapshots them on a shadow branch (entire/<sha7>-<hash6>, local only)
   ▼
git commit  ──prepare-commit-msg──►  "…\n\nEntire-Checkpoint: 01M4PYAG60V4ZBFR9WN79VAWB1"
   │
   └─post-commit──►  checkpoint 01M4PYAG60V4ZBFR9WN79VAWB1 → refs/entire/checkpoints/B1/01M4PYAG60V4ZBFR9WN79VAWB1
                      (session S, transcript, prompts, files touched, tokens)
```

- Checkpoint ids are 26-character ULIDs (legacy: 12 hex). `entire checkpoint list --json` lists the ones on the current branch, and `entire checkpoint explain <id> --json` returns metadata only: files touched, model, token usage.
- For Claude Code, Entire's session id is the `session_id` that `claude -p --output-format json` prints. The session backend stores that id as the bundle's `adversary.sessionId`, so a review in a run bundle, its verdict commit and its Entire checkpoint share one id.
- `reviewWithSession` reads the trailer back after committing (`git log -1 --format=%H%n%(trailers:key=Entire-Checkpoint,valueonly)`) and returns `{ commit, checkpointId }` as `entire` on the outcome. `checkpointId` is null when Entire did not checkpoint the commit. The review never depends on Entire.
- `notary export --entire` publishes only **committed** checkpoints: an id carried by an `Entire-Checkpoint` trailer on the current branch. While a session is live, `entire checkpoint list` also returns its temporary shadow snapshots (40-hex ids) whose `message` is the latest prompt text. Those are never published, and the message shown is always the git commit subject.

### Verified end to end

On 2026-10-12, in a scratch clone of this repo with Entire enabled, `reviewBelief({ backend: "session" })` ran on the real belief `belief-crustdata.enrich.headcount-total-integer` from the real bundle `notarize-crustdata-20261012T011404Z`. Headless Claude Code (claude-opus-5-5) read the inbox packet and wrote the verdict `downgrade`: the cited probes never vary the claim's `fields` parameter. The verdict commit `e6cb269` got `Entire-Checkpoint: 01M4PYAG60V4ZBFR9WN79VAWB1`. `entire checkpoint explain` shows session `f5cf4a6a-…`, which is the CLI's `session_id`, with files touched `adversary/verdicts/belief-crustdata.enrich.headcount-total-integer.json`. That run found two bugs, both fixed:

1. The `--allowedTools` rules are relative to the working directory. Given an 8.3 short path (`C:\Users\PARTHC~1\…`), Claude Code denied the inbox Read and refused to invent a verdict. `reviewWithSession` now resolves the repo root with `realpath.native` first.
2. The `commit_linking: prompt` hang described above.

The clone and its checkpoint are scratch data and are not in this repo.

### Checkpoints on `main`

Entire was enabled on Oct 12, late in the build, so only the last two of the repo's ~83 commits are checkpointed; the earlier history has none.

| Checkpoint | Commit | Subject |
| --- | --- | --- |
| `01M4Q2CJDTHF76EE7QK11TEEV1` | `409fd51` | Session 12: real runs, real agents, all sponsors wired |
| `01M4Q2JS4B3N3B42W0X9MGNSS7` | `0f2406f` | Evidence after the first Entire checkpoint; cfo.ai live only with an imported plan |

Both refs are under `refs/entire/checkpoints/` and pushed to `origin` (`git ls-remote origin 'refs/entire/*'`). [`packages/web/public/evidence/entire.json`](../packages/web/public/evidence/entire.json) was generated at `409fd51`, so it lists the first one; re-run `pnpm notary export --entire` after the next commit to list both. No `--adversary session` review has run on `main` yet.

## Guard coverage with `entire graph`

```sh
pnpm notary guards coverage --backend entire     # auto picks entire when `entire graph version` works
```

The backend runs one bulk call:

```sh
entire graph edges --repo <root> --format ndjson --worktree --relation CALLS,ASYNC_CALLS,CONSTRUCTS
```

It keeps the relations whose target is a public method of `CrustdataClient` or `DodoClient` (symbol id `…:TypeScript:<file>:method:<Class>.<method>`) and whose caller is under `packages/core/src` or `packages/core/scripts`. Each one is an UNGUARDED call site. The guarded route is dynamic (`client[method]` inside `wrap`), so no static call is legitimate. For a method that does have raw callers, the exact lines come from `entire graph neighbors --symbol <Class>.<method> --direction in --format json`. A `CONSTRUCTS` relation to a client class outside `src/tools/index.ts` is a raw construction. A file Entire could not parse fails the check if it is scanned source. Other skipped files are listed and ignored: a one-line JSON adversary inbox file trips `E_MINIFIED`.

Result on this repo (2026-10-12, working tree on `0ce991d`):

```
notary guards coverage  backend: entire
  entire graph edges (entire-graph v0.4.0, working tree): 7822 call and 377 construct relations scanned, 2 reach a raw client; …
Totals: 33 sites, 26 guarded, 7 raw-by-design, 0 UNGUARDED (18 ops)
unguarded_call_sites = 0
```

The two relations that reach a raw client are `createTools()` constructing the two clients in `src/tools/index.ts`. The site list is identical to `--backend tsc`. With a deliberate raw call planted in a scratch clone (`client.createRefund(…)` and `new DodoClient(…)` in `src/entire-probe-raw.ts`), both backends report the same two UNGUARDED sites, and the entire backend gives the exact line (4) from `neighbors`. The captured output is the test fixture in `packages/core/test/fixtures/entire/`.

Cost: every `entire graph` query re-indexes a dirty working tree, about 50 s idle and up to about 5 min under load. That is why the backend makes one bulk call and not one `neighbors` call per method, which would take about 18 minutes.

## Docs vs reality

| Docs or earlier assumption | Reality (Entire CLI 0.11.4, entire-graph v0.4.0) |
| --- | --- |
| `entire graph` is part of the CLI (DECISIONS #61, #102) | It is the official plugin `graph`. Install it with `entire plugin install graph`. |
| `neighbors` has no `--format` flag (docs, #99) | `--format json\|text\|agent`. JSON is the default when piped. Text starts with `Index: cache-…`. |
| One `neighbors` call per method | Each call re-indexes the dirty tree (~50 s), so the backend uses one `entire graph edges --worktree` pass. |
| Checkpoints live on `entire/checkpoints/v1` (PRD, BUILD_PLAN "entire/* branches") | The default store is `git-refs`: one ref per checkpoint under `refs/entire/checkpoints/`. The `branch` store is legacy. `refs/heads/entire/<sha7>-<hash6>` is a live session's shadow branch, not a checkpoint. |
| `entire enable` then commit is enough | The default `commit_linking: prompt` asks on the terminal, so a commit made without a terminal hangs. Set `commit_linking: "always"`. |
| — | `entire checkpoint list --json` also returns live shadow snapshots (40-hex ids, prompt text as the message) when nothing is committed yet. |

## Showing it in the demo video (2:00–2:15)

1. Terminal: `entire status`. It shows Entire enabled for Claude Code on `main`.
2. Terminal: `git log -3 --format='%h %s%n%(trailers:key=Entire-Checkpoint)'`. The commits carry `Entire-Checkpoint` trailers.
3. Terminal: `entire checkpoint explain 01M4Q2CJDTHF76EE7QK11TEEV1`. It shows the Claude Code session behind commit `409fd51`, the model and the files it touched. Say: "Every commit since Entire was enabled is tied to the agent session that wrote it." (There is no `adversary: …` commit on `main` yet; don't show one.)
4. Terminal: `pnpm notary guards coverage --backend entire`. Show `unguarded_call_sites = 0` and the `entire graph edges` line. Say: "entire-graph proves no money call skips a guard." Pre-run it before recording, because it takes about a minute.
5. Browser: `/app/report` → **Receipts → Review checkpoints**. It shows the checkpoint rows (id, time, session, commit, files touched) and the coverage figure from `entire.json`.

Before recording, run `pnpm notary export --entire` after the last commit, so the page lists that commit's checkpoint.
