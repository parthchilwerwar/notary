# Notary demo script (2:30)

A screen-recorded walkthrough that uses only features that work on real data today. Every number said aloud is on screen at that moment and comes from a generated file in `packages/web/public/` or `docs/EVALUATION.md`. The one optional evaluation-suite shot (simulated APIs) is marked, and is only recorded with the dashboard's fixture banner in frame.

Do not say or show:

- "a real run of the billing queue" or a real naive-vs-guarded comparison. No real queue run exists yet (BLOCKED on the Dodo seed: 12 hosted test-card checkouts). If the guarded run is recorded before the shoot, its honest framing is "the guarded run holds refunds that lack certificates", not "unsafe went from N to 0": real Dodo honored all 4 behaviors it certified, so a real naive run may make 0 unsafe moves.
- A revoked real certificate (none exists), a real approval (the real pending list is empty), or a neatlogs UI link (no UI URL recorded yet).
- The 3 Crustdata contradictions as certificates. They are checker findings; all 5 real certificates say "matches docs".

## Before recording

Run from the repo root with `.env` filled in (Crustdata, Dodo test key, LiteLLM, neatlogs). Terminal font large, browser at 1440 wide.

```sh
pnpm install
pnpm notary doctor --llm                        # all roles pass, or chat won't answer
pnpm notary guards coverage --backend entire    # takes about a minute: capture this output now, replay it in the edit
pnpm notary export --entire                     # entire.json lists the newest checkpoint
pnpm notary cfo status                          # connected or not decides the cfo.ai line in beat 6
pnpm notary serve                               # terminal 1: copy the session token it prints once
pnpm --filter @notary/web dev                   # terminal 2: http://127.0.0.1:5173, /api proxied to serve
```

Open these tabs in order:

1. `http://127.0.0.1:5173/`
2. `http://127.0.0.1:5173/app/run?run=notarize-crustdata-20261012T011404Z`
3. `http://127.0.0.1:5173/app/incidents`
4. `http://127.0.0.1:5173/app/certificates/cert-90b6704587c8abbf`
5. `http://127.0.0.1:5173/app/report` (Receipts → Review checkpoints)
6. `http://127.0.0.1:5173/app/business`
7. `http://127.0.0.1:5173/app/chat` (paste the session token once)
8. The neatlogs app, on trace `9db41ecd43406cef291c93ef8c9ab1cd` <!-- TODO(user): confirm how to open a trace by id in the neatlogs UI; once you have its URL, run `pnpm notary trace-link --example "<url>" --trace-id 9db41ecd43406cef291c93ef8c9ab1cd && pnpm notary export --evidence` so the dashboard gets "Open in neatlogs" links -->

## Beats

| # | Time | Screen | Do | Say |
|---|------|--------|----|-----|
| 1 | 0:00–0:15 | Tab 1, landing | Scroll from the hero to the five steps. | "Agents that move money learn how from API docs. When the docs are wrong, the agent is wrong, and every call still returns green. Notary won't move money on any API behavior it hasn't certified: read, test, challenge, certify, enforce." |
| 2 | 0:15–0:45 | Tab 2, Run transcript of the live Crustdata run | Play the transcript at 4×; stop on the checker rows; expand the first anomaly. | "This is a live run against Crustdata. First a deterministic checker, no model involved, compares each response with what the docs promise. Three times the real API disagreed: enrich with a no-match domain returns 400 where the docs say 200 with an empty result; identify does the same; and identify with invalid fields returns 403, not 400. Those are findings, not certificates yet: one was probed and came back inconclusive, two weren't probed." |
| 3 | 0:45–1:05 | Tab 2, a probe row → tab 8, neatlogs → tab 3, Incidents | Expand probe `p002`: show the prediction hash and its commit time, then the call time after it. Cut to the neatlogs trace: the probe span carrying `notary.prediction`, then the TOOL span. Cut to Incidents. | "Before every probe, Notary writes down its prediction and hashes it, then calls the API. All 19 live probes committed first. neatlogs traces every agent: agent, LLM, tool, guardrail and evaluator spans. Anything that goes wrong becomes an incident, derived by code, with the same id in neatlogs and here." |
| 4 | 1:05–1:25 | Tab 4, certificate `cert-90b6704587c8abbf` (Dodo wallet credit in minor units) | Point at the verdict "matches docs", the three cited probes, the scope line and the Adversary badge (`claude-opus-4.6`, narrowed). | "Beliefs become certificates only after a stronger model, the Adversary, tries to knock them down from the raw probe records. Here it narrowed the claim: every probe used US dollars, so the certificate covers USD only. On the real runs it narrowed all five certificates. Twenty-one of twenty-six doc claims are still unproven, and Notary says so." |
| 5 | 1:25–1:45 | Terminal, then tab 5 | Run `entire status`, then `git log -2 --format='%h %s%n  %(trailers:key=Entire-Checkpoint,valueonly)'`, then `entire checkpoint explain 01M4Q2CJDTHF76EE7QK11TEEV1`. Show the captured `guards coverage --backend entire` output ending in `unguarded_call_sites = 0`. Then the Report page receipts. | "Entire ties each commit to the Claude Code session that wrote it. We enabled it late, so only our last two commits are checkpointed, and we'd rather say that than hide it. Entire's code graph also checks every call into Dodo or Crustdata: 33 call sites, zero outside the guard." |
| 6 | 1:45–2:00 | Tab 6, Business | Hover the cost-per-run figure. If `cfo status` said connected, run `pnpm notary cfo sync` in the terminal and reload. | Connected: "Costs come only from real runs: about three cents of model calls and fifteen and a half Crustdata credits per live run. The business plan is modelled in cfo.ai and synced in over its MCP server." Not connected: "Costs come only from real runs: about three cents and fifteen and a half Crustdata credits per live run. The cfo.ai plan isn't imported yet, so the page says exactly that." |
| 7 | 2:00–2:15 | Tab 7, Chat | Ask: "Why does crustdata.identify.invalid-fields-400 have no certificate?" Let it cite the record. Then ask: "Refund the last Dodo payment in full." | "Notary Chat is a tool-calling agent over the same records. Its answers cite the exact record, checked by code. And it can explain anything, but it has no tool that moves money, so a refund request is refused." <!-- TODO(user): rehearse both questions on the live chat and keep the take where the citation and the refusal are on screen --> |
| 8 | 2:15–2:30 | Terminal | Run `pnpm notary replay; echo "exit $?"`. Show the replays matching and the one skipped run named. | "Every live run is recorded. Replay re-runs them offline, no keys, and matches every metric exactly. The one run that can't replay is named, not hidden. Notary: let your agent prove it first." <!-- TODO(orchestrator): confirm the replay output and `exit 0` after core-fix lands; if replay fails, cut this beat --> |

### Optional evaluation-suite insert (5 s, only with the banner)

If there is time, after beat 4: open `http://127.0.0.1:5173/app/report?fixtures=1`, keep the "Fixture data — simulated APIs, not a live run" banner in frame, and show the naive vs guarded comparison. Say: "On our evaluation suite, with simulated APIs and planted quirks, the agent without Notary made nine unsafe money moves; with Notary, zero, and nine refunds held for review." Source: `docs/EVALUATION.md` → Evaluation suite → Scenario `default`. Never cut this footage into a real-run shot. <!-- TODO(user): check that the Report page shows the naive vs guarded comparison with ?fixtures=1 before planning on this shot -->

## Numbers used, and where they come from

| Said | Source |
| --- | --- |
| 3 Crustdata contradictions (400 vs 200, 400 vs 200, 403 vs 400) | `anomalies` in `packages/web/public/bundles/notarize-crustdata-20261012T011404Z.json`; `docs/EVALUATION.md` (`anomalies` = 3) |
| 19 live probes, each committed before its call | `probes[].committedAt` < `ranAt` in the Crustdata (4) and Dodo `notarize-dodo-20261012T012315Z` (15) bundles |
| 5 certificates, all narrowed; 21 of 26 unproven | `packages/web/public/certificates/report.json`; `adversary.verdict` in `certificates/crustdata.json` and `dodo.json` |
| USD-only scope on wallet credits | `scope` and `adversary.reason` of `cert-90b6704587c8abbf` in `certificates/dodo.json` |
| 33 call sites, 0 unguarded | `packages/web/public/evidence/entire.json` → `coverage`; `docs/EVALUATION.md` → Checks that don't need API keys |
| 2 checkpointed commits | `refs/entire/checkpoints/` (`01M4Q2CJDTHF76EE7QK11TEEV1` on `409fd51`, `01M4Q2JS4B3N3B42W0X9MGNSS7` on `0f2406f`) |
| $0.0316 + 15.5 credits per live run | `packages/web/public/economics.json` → `computed.costPerRun` |
| Replays match exactly | `docs/EVALUATION.md` → Reproducibility; the `-replay` bundles in `packages/web/public/bundles/` |
| 9 → 0, 9 refunds held (evaluation suite only) | `docs/EVALUATION.md` → Evaluation suite → Scenario `default` |
