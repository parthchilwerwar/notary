# Notary — Build Plan

Oct 10, 2026 · Parth

## Overview and tool split

Claude Code builds the agent core (`packages/core`) in 10 phases; Codex builds the dashboard (`packages/web`) in 3 phases against a frozen bundle schema. Each phase is one fresh coding session, ending in a commit.

| Tool | Owns | Never touches |
| --- | --- | --- |
| Claude Code | `packages/core`, schema, fixtures, CLI, evaluation, README, docs | `packages/web` UI code |
| Codex | `packages/web` screens, styling, static deploy | `packages/core` logic, schema changes |

**Working rules**

1. Nothing on the project repo before 12:30 PM IST, Saturday, October 10. Then `git init`, `entire enable`, neatlogs hooks for both agents.
2. One phase per session. Start each session by pasting that phase's prompt; end with tests passing and a commit. Entire checkpoints each commit.
3. Keep `docs/PRD.md`, `docs/TDD.md` and `docs/BUILD_PLAN.md` in the repo so both agents read them. Every prompt points at them.
4. The bundle schema freezes at the end of P1. After that, schema changes go through Claude Code, and Codex regenerates its sample bundle.
5. Use Entire inside sessions: ask the agent to run `entire graph` for code search and impact before refactors. It's both useful and scored.
6. If a coding agent warns that a result looks fake or hardcoded, stop and fix it. The integrity lens checks for ignored warnings.
7. Review the diff after every phase before the next one starts.
8. If you fall behind, cut P1-priority requirements first (FR-14 to FR-19), never the replay or evaluation.

## Timeline

Core work lands by Sunday midnight; submission at 7 PM Monday. All times IST. Nights are planned sleep; if a phase slips, it eats P1-priority requirements, not sleep or the Monday buffer.

| When (IST) | Phase | Tool |
| --- | --- | --- |
| Sat 12:30–13:30 | P0 Scaffold | Claude Code |
| Sat 13:30–16:00 | P1 Clients, recorder, schema | Claude Code |
| Sat 16:00 | **Gate: schema freeze** | — |
| Sat 16:00–18:30 | U1 Dashboard shell | Codex (parallel) |
| Sat 16:00–19:00 | P2 Contracts, checker | Claude Code |
| Sat 19:00–23:00 | P3 Seeded world, naive run | Claude Code |
| Sat 23:00–Sun 08:00 | Sleep | — |
| Sun 08:00–11:00 | P4 Reflector, probes | Claude Code |
| Sun 11:00–14:00 | P5 Beliefs, adversary | Claude Code |
| Sun 12:00–15:00 | U2 Probe log, comparison, live mode | Codex (parallel) |
| Sun 14:00–18:00 | P6 Guards, gated queue, recovery | Claude Code |
| Sun 18:00–21:00 | P7 Transfer, drift, coverage | Claude Code |
| Sun 21:00–24:00 | P8 Replay, evaluation | Claude Code |
| Mon 00:00–09:00 | Sleep | — |
| Mon 09:00–12:00 | P9 Self-audit, README | Claude Code |
| Mon 10:00–13:00 | U3 Economics, polish, deploy | Codex (parallel) |
| Mon 12:00 | **Gate: feature freeze** | — |
| Mon 13:00–17:00 | P10 Business plan, final runs, record | You + Claude Code |
| Mon 17:00–19:00 | Closing call, edit video | You |
| Mon 19:00 | **Submit on X** | You |

## Day 1 — Saturday, October 10

Day 1 ends with a naive agent working a real seeded queue and making real mistakes, plus a dashboard shell. That's the "before" half of the demo.

### P0 · Scaffold · Claude Code · 12:30–13:30 IST

**Deliverables:** pnpm monorepo, `docs/PRD.md` + `docs/TDD.md`, `PLAN.md`, schema stubs, CLI skeleton, neatlogs smoke span, Entire enabled.

**Done when:** `pnpm notary --help` works, a test span shows in neatlogs, the first commit carries an Entire checkpoint.

```text
Read docs/PRD.md and docs/TDD.md fully before doing anything. We are building Notary, phase P0 only.
Create a pnpm workspace on Node 22 with packages/core (TypeScript, vitest, commander) and packages/web (empty placeholder).
In core, create src/cli.ts with subcommands notarize, run, replay, export, serve, guards coverage, all stubbed with clear "not implemented" errors.
Create src/schema/ with zod stubs for Claim, Anomaly, Hypothesis, Probe, Belief, Guard, Decision and RunBundle exactly as named in TDD "Data model". Export inferred types.
Create src/trace/ that initializes the neatlogs TS SDK from NEATLOGS_API_KEY and exposes a span helper; add a `notary doctor` command that emits one test span and flushes. Check the SDK README for the exact metadata API and note it in a comment.
Add .env.example with every variable named in the TDD, a .gitignore that excludes .env, and PLAN.md listing phases P0–P10 and U1–U3 as unchecked tasks.
Run the tests and the doctor command, then commit. Do not implement anything beyond P0.
```

### P1 · Tool clients, recorder, schema freeze · Claude Code · 13:30–16:00

**Deliverables:** Crustdata and Dodo clients (raw, unexported), cassette recorder with redaction, credit ledger, Dodo test-mode lock, final bundle schema, sample bundle generator.

**Done when:** one live call to each API is recorded and redacted; `pnpm notary export --sample` writes a schema-valid sample bundle; Dodo refuses to start without test mode.

```text
Phase P1 of PLAN.md. Re-read TDD sections "Integrations and interfaces", "Replay" and "Security".
Implement src/tools/recorder.ts: record method, URL, redacted headers, body, response, status, latency and credits, keyed by a stable request hash; replay mode serves from cassettes and throws on a miss.
Implement src/tools/crustdata.ts and src/tools/dodo.ts as raw clients over the recorder. Read their official API docs first and list the endpoints we need for company enrichment (Crustdata) and customers, payments, refunds, subscriptions (Dodo test mode). Write that list into docs/ENDPOINTS.md with doc links. Do not export the raw clients outside src/tools.
Add the Dodo test-mode lock (NOTARY_MODE=test and test base URL, otherwise throw) and a per-run Crustdata credit budget.
Finalize src/schema/bundle.ts per TDD and add `notary export --sample` that writes a realistic, schema-valid sample bundle to packages/web/public/bundles/. Mark it clearly as sample data.
Make one live call to each API, check the cassette is redacted, add tests, commit.
```

### U1 · Dashboard shell · Codex · 16:00–18:30 (in parallel)

**Deliverables:** Vite + React + Tailwind app reading the sample bundle; layout, run picker, Queue and Beliefs screens.

**Done when:** both screens render every field from the sample bundle with no hardcoded values.

```text
Read docs/TDD.md section "Dashboard contract". Work only in packages/web.
Build a React + Vite + Tailwind static app that loads public/bundles/index.json and a selected bundle, validating with the zod schema imported from packages/core/src/schema/bundle.ts (do not redefine types).
Create a dense, legible, dark-mode-aware layout with a sidebar for: Queue, Beliefs, Probe log, Runs comparison, Economics. Implement Queue and Beliefs fully per the contract table; leave the others as placeholders.
Every number must come from the bundle. Show span ids as text when trace links are missing. Run the build and commit.
```

### P2 · Contracts and deterministic checker · Claude Code · 16:00–19:00

**Deliverables:** claims for Crustdata and Dodo written from the real docs, the checker, a recon sweep.

**Done when:** recon on recorded traffic lists the same anomalies on two consecutive runs; unit tests cover each `expect` rule.

```text
Phase P2. Re-read TDD "The notarization loop" steps 1 and 3.
In src/contracts/, write Claim records for Crustdata and Dodo from their official docs: one claim per concrete promise (limits, units, types, error behavior, retry semantics, pagination, consistency). Quote the doc text and link the doc URL in each claim. Do not invent promises the docs don't make.
Implement src/checker/ to evaluate each claim's expect rule against recorded exchanges and emit Anomalies. No LLM calls anywhere in this phase.
Implement a recon sweep that exercises each claim cheaply (respect the credit budget and burst caps), recording everything.
Add `notary notarize --tool <name> --recon-only`. Run it twice and confirm identical anomalies. Use `entire graph` to check nothing outside src/tools imports the raw clients. Test, commit.
```

### P3 · Seeded world and naive run · Claude Code · 19:00–23:00

**Deliverables:** Dodo test-mode seed script, seeded queue of about 20 requests, hand-written expected outcomes, policy table, naive executor, deterministic grader, first real bundle.

**Done when:** `notary run --naive` finishes the queue and the bundle reports decision accuracy and unsafe actions from the grader.

```text
Phase P3. Re-read PRD "Core flows" Flow A and TDD "Queue execution" and "Replay, seeded queue and evaluation".
Write scripts/seed-dodo.ts to create test-mode customers, products and payments, including: a customer with more payments than one page returns, a payment where amount units matter, and one whose refund we will retry. Record everything.
Write fixtures/queue/seeded.json (about 20 requests) and fixtures/queue/expected.json with the correct outcome for each, derived from a policy table in src/queue/policy.ts (tier x plan x request type). Use real company domains for Crustdata enrichment.
Implement the naive executor: enrich, decide, execute directly through the clients, no gating. Implement the deterministic grader that counts unsafe money actions (duplicates, wrong unit, missed existing refund) and decision accuracy.
Run `notary run --naive`, write the bundle, copy it to packages/web/public/bundles/. If the naive run makes no unsafe actions, report that honestly in PLAN.md rather than forcing one. Test, commit.
```

**End of Day 1 post:** screenshot of the naive run's unsafe actions in the Dodo test dashboard.

## Day 2 — Sunday, October 11

Day 2 ends with the guarded run at zero unsafe actions, beliefs that survived the adversary, and every number reproducible offline. Attend office hours with neatlogs and Entire if a blocker appears.

### P4 · Reflector and probes · Claude Code · 08:00–11:00 IST

**Deliverables:** Bedrock client with three roles and per-role usage, batched hypotheses, probe templates, cost-aware scoring, commit-then-run, verdict rules.

**Done when:** for each anomaly from P2, the loop designs a probe, commits predictions (visible in the neatlogs span before the call), runs it, and records a verdict.

```text
Phase P4. Re-read TDD "The notarization loop" steps 2 to 6.
Implement src/llm/ with a Bedrock client and roles executor, reflector, adversary from env, temperature 0, a neatlogs span per call with role, model id, tokens and USD, and usage accumulated per role.
Implement src/reflect/: one batched reflector call for all open anomalies returning zod-validated JSON (2-3 rival hypotheses per anomaly, defect class from the taxonomy, distinguishing test from the template list). Malformed output must fail safe.
Implement the probe templates listed in the TDD, each with a control variant, and the greedy cost-aware score using real credits from the ledger.
Enforce commit-then-run: write predictions to SQLite and the span metadata before the HTTP call, immutable after.
Implement the verdict rules exactly as written, including the uninformative-observation rule and the instrument check. Unit-test every verdict rule with hand-built observations. Commit.
```

### P5 · Beliefs and adversary · Claude Code · 11:00–14:00

**Deliverables:** Beta-binomial belief store with event log, status lifecycle including `unlearned`, adversary with `bedrock` and `session` backends, evidence-validity check against traces.

**Done when:** `notary notarize --tool crustdata` ends with beliefs in clear states, at least one adversary verdict recorded, and every cited trace verified to test its parameter.

```text
Phase P5. Re-read TDD "The notarization loop" steps 7 and 8, and FR-5, FR-7, FR-10.
Implement src/beliefs/: Beta(alpha, beta) per claim, thresholds exactly as in the TDD, a belief_events append-only log, and the unlearn transition when later evidence crosses back over 0.5.
Implement src/adversary/ with two backends. bedrock: send the belief plus raw probe records (never reflector prose) to the adversary role, returning uphold, narrow, or downgrade with a reason. session: write the belief and evidence to adversary/inbox/<beliefId>.json, run headless Claude Code with a fixed reviewer prompt that writes adversary/verdicts/<beliefId>.json, then read and commit it.
Implement the evidence-validity check: for each cited probe, confirm via neatlogs-cli (or runs/<runId>/spans.jsonl as fallback) that the span actually varied the claim's parameter. Invalid evidence reverts the belief to hypothesis.
Run notarize on Crustdata end to end, inspect the beliefs, add tests, commit.
```

### U2 · Probe log, runs comparison, live mode · Codex · 12:00–15:00 (in parallel)

**Deliverables:** Probe log (hero screen), Runs comparison, live mode via SSE.

**Done when:** both screens render from the real naive bundle and a fresh sample; live mode updates as events arrive.

```text
Read docs/TDD.md "Dashboard contract" and "Integrations and interfaces" (Local API). Work only in packages/web.
Implement the Probe log: timeline of probes, each showing template, committed predictions per hypothesis side by side with the observed result, the winning hypothesis highlighted, credits spent. This is the hero screen of the demo video, so make it clear at a glance.
Implement Runs comparison: choose any two bundles and compare unsafe actions, decision accuracy, automation rate, credits and USD by role, with trace links.
Add live mode: when VITE_NOTARY_API is set, load bundles from the API and subscribe to /api/stream events (decision, probe.committed, probe.verdict, belief.changed, run.finished). Build and commit.
```

### P6 · Guards, gated queue, recovery · Claude Code · 14:00–18:00

**Deliverables:** guard compiler and registry, `guarded()` clients, required-beliefs gating, escalation evidence packs, `--resume`, the local API with SSE.

**Done when:** `notary run` (guarded) on the seeded queue has zero unsafe actions, held items carry evidence packs, and a run killed mid-queue resumes correctly.

```text
Phase P6. Re-read TDD "Queue execution and guards" fully, and FR-8, FR-9.
Implement src/guards/: compile notarized beliefs into guards of kinds transform, require_param, precheck, retry_policy, paginate_fully, block. Implement guarded(op, fn) and route every Dodo and Crustdata method through it; the raw clients stay private.
Implement the required-beliefs map per action from the TDD table, adjusted to the real endpoints in docs/ENDPOINTS.md. An action with any missing belief is held with an evidence pack.
Persist per-item run state; implement `notary run --resume` with read-back before any write retry.
Implement `notary serve` (Hono) with the bundle endpoints and SSE events.
Run the guarded queue, compare with the naive bundle, then kill a run mid-queue and resume it. Use `entire graph` to check every call site of the raw clients. Test, commit.
```

### P7 · Transfer, drift, coverage · Claude Code · 18:00–21:00

**Deliverables:** transfer priors from Crustdata to Dodo, the drift fixture, `notary guards coverage`.

**Done when:** Dodo notarization reports probes-to-candidate with and without priors; drift replay un-learns a belief and retires its guard; coverage exits 0.

```text
Phase P7. Re-read TDD steps 9 (transfer) and "Drift fixture", and FR-15 to FR-17.
Implement --priors-from <tool>: per-claim Beta priors from the base rate of each defect class on the source tool. Run Dodo notarization with and without priors and record probes-to-candidate for both in the bundle metrics.
Create fixtures/drift/: a copy of one cassette with a single changed response. Replaying it must lower the belief until it reaches unlearned and its guard retires; add a test asserting that.
Implement `notary guards coverage` by asking entire-graph for callers of the raw client methods; any caller other than guarded() is a failure with file:line output. Commit.
```

### P8 · Replay and evaluation · Claude Code · 21:00–24:00

**Deliverables:** `notary replay`, three-run noise floor, all metrics, `docs/EVALUATION.md`, `export/TOOLS.md`.

**Done when:** a fresh clone with no `.env` runs `pnpm notary replay` and reproduces the headline numbers exactly.

```text
Phase P8. Re-read TDD "Replay, seeded queue and evaluation" and FR-11, FR-12, FR-19.
Implement `notary replay` over cassettes with no keys; it must fail loudly on any cache miss. Recompute bundle content hashes on load.
Run the guarded queue three times to measure a noise floor per metric; treat changes below it as no change.
Compute every metric in the TDD into bundle.metrics and write docs/EVALUATION.md listing each number with the exact command that produced it, including any results that went the wrong way.
Implement `notary export` for TOOLS.md (the corrected tool spec), guards.json and the latest bundles into packages/web/public/bundles/.
Clone the repo into a temp dir, run replay with no .env, confirm identical numbers. Commit.
```

**End of Day 2 post:** the Probe log screenshot showing a prediction committed before a live call, plus the runs comparison.

## Day 3 — Monday, October 12

Day 3 is for trust, not features: audit the evidence, publish honest numbers, finish the business plan, and submit at 7:00 PM sharp. No new features after 12:00 PM.

### P9 · Self-audit and README · Claude Code · 09:00–12:00 IST

**Deliverables:** `docs/AUDIT.md` with findings and fixes, `README.md` with receipts, `docs/ARCHITECTURE.md`.

**Done when:** every README number links to the command that produced it, and every audit finding is either fixed or listed as a known limit.

```text
Phase P9. Act as a hostile reviewer of this repo before judges do.
Audit: for every notarized belief, check that its cited probes actually varied the claim's parameter, that controls behaved, and that no belief rests on an uninformative observation. Check that no metric is hardcoded, that replay matches live, and that the grader never reads model output. Write docs/AUDIT.md with each finding and its resolution. Fix what you can; downgrade any belief or number you cannot defend, and record that.
Write README.md: the one-liner, the problem in three sentences, a results table where every number links to its command in docs/EVALUATION.md, a 5-minute offline quickstart (`pnpm i && pnpm notary replay`), how each sponsor is used, honest limits, and disclosure of seeded data.
Write docs/ARCHITECTURE.md from the TDD, updated to match the code as built. Commit.
```

### U3 · Economics screen, polish, deploy · Codex · 10:00–13:00

**Deliverables:** Economics screen, visual polish, Vercel deploy loaded with real bundles.

**Done when:** the public URL works on desktop and phone with no keys, and every screen shows real run data.

```text
Read docs/TDD.md "Dashboard contract". Work only in packages/web.
Implement the Economics screen: cost per run, cost per notarized belief, credits by endpoint, USD by role, unsafe actions prevented, and a summary block of the cfo.ai plan figures read from public/economics.json.
Polish all screens for the demo video: clear hierarchy, readable at 1080p, consistent status colors, empty and error states. Make the layout work on a phone.
Configure a static Vercel deploy that serves the real bundles in public/bundles. Build, deploy, commit.
```

### P10 · Business plan, final runs, recording · You + Claude Code · 13:00–17:00

**Deliverables:** cfo.ai plan exported into the repo, final live runs and bundles, raw demo footage.

**Done when:** the plan is in `docs/BUSINESS.md`, the final bundles are deployed, and the footage covers every beat in the demo script.

1. In cfo.ai, model pricing per monitored API contract, COGS from the bundles' credits and tokens, the cost of incidents prevented, and runway. Export it and summarize in `docs/BUSINESS.md` and `packages/web/public/economics.json`.
2. Run the final naive and guarded runs live once more, export, redeploy.
3. Record the demo following the script below.

### Closing stretch · 17:00–19:00

- 17:00–18:00: neatHack closing call.
- 17:00–18:45: edit the video to about 2.5 minutes; final README check; repo public.
- 19:00: submit (see checklist).

## Building in public

Building in public is 15% of the score, more than originality; post six times with a real artifact each time, tagging neatlogs and the relevant sponsor.

| When (IST) | Post | Attach |
| --- | --- | --- |
| Sat 13:00 | Kickoff: what Notary is and why agents shouldn't trust tool docs | The one-liner + PLAN.md screenshot |
| Sat 23:00 | "My naive agent just double-refunded a customer" | Dodo test dashboard + naive bundle numbers |
| Sun 11:00 | Commit-then-run: the agent predicts before it calls | neatlogs span showing the prediction, then the response |
| Sun 15:00 | The adversary refuted a belief my agent was sure of | Beliefs screen with the adversary's reason |
| Sun 23:00 | Guarded run: zero unsafe actions, lower cost | Runs comparison + neatlogs run comparison |
| Mon 19:00 | Submission quote-tweet | Demo video, repo, live dashboard |

Reply to other builders' posts in the Discord and on X between posts; the community award rewards that too.

## Demo video script

The video is 20% of the score and must explain the agent and all three required tools in about 2.5 minutes.

| Time | On screen | Voiceover (short) |
| --- | --- | --- |
| 0:00–0:15 | Dodo test dashboard: a duplicate refund from the naive run | "My agent refunded the same customer twice. Every call returned 200." |
| 0:15–0:30 | Title card, one-liner | "Notary won't touch money until it has proven how its tools actually behave." |
| 0:30–0:55 | Terminal `notary notarize`, then Probe log | "It reads the docs, flags where reality disagrees, and commits a prediction before every call." |
| 0:55–1:10 | neatlogs span with the prediction, then the response | "Every probe is a neatlogs trace, so every belief has receipts." |
| 1:10–1:25 | Beliefs screen: adversary downgrades one belief | "A stronger model tries to refute each belief. This one didn't survive." |
| 1:25–1:45 | `notary run` guarded; Queue screen with executed vs held | "Guards wrap every money call. What it can't verify, it holds for a human." |
| 1:45–2:00 | Runs comparison + neatlogs run comparison | "Naive run: unsafe actions. Guarded run: zero, at lower cost." |
| 2:00–2:15 | Entire checkpoint history + `notary guards coverage` | "Built with Entire. Every review is checkpointed, and entire-graph proves no money call skips a guard." |
| 2:15–2:30 | Economics screen + cfo.ai plan | "cfo.ai models the business: cost per protected contract versus incidents prevented." |
| 2:30–2:40 | Repo + `notary replay` | "Every number reproduces offline. Link below." |

## Submission checklist

Submit at 7:00 PM IST on Monday to land in the first 50 quote tweets; the window closes at 11:55 PM.

- [ ] Repo is public; README results table links every number to its command
- [ ] `pnpm notary replay` works from a fresh clone with no `.env`
- [ ] Entire checkpoint branches (`entire/*`) are pushed to the remote
- [ ] No secrets in the repo or cassettes (run the key-pattern check)
- [ ] Seeded data and the drift fixture are disclosed in README and dashboard
- [ ] `docs/BUSINESS.md` contains the cfo.ai plan
- [ ] Dashboard deployed with real bundles; link works on a phone
- [ ] Demo video about 2.5 minutes, covers the agent and all three required tools
- [ ] Quote-tweet the official neatlogs post with team, name, project, public repo and demo
- [ ] Post the link in the neatHack Discord
