# Notary — PRD

Oct 10, 2026 · Parth

## Summary

Notary is an autonomous billing-ops agent that won't touch money until it has proven, by experiment, how its tools actually behave. It works a queue of customer requests (refunds, plan changes, credits) end to end, using Crustdata for company context and Dodo Payments (test mode) for execution.

**One-liner:** *An agent that won't touch money until it has proven how its tools actually behave.*

Before any irreversible action, Notary verifies the exact tool behaviors that action depends on, such as refund units, retry safety and pagination limits. Verified beliefs compile into guards that wrap every API call. No verified belief means no action: the request goes to a human with evidence attached.

**How these docs are organized**

- **PRD (this file):** what we build, for whom, and how we know it works.
- **TDD (`docs/TDD.md`):** architecture, data model, the notarization loop, interfaces and stack.
- **Build Plan (`docs/BUILD_PLAN.md`):** phase-by-phase itinerary for the 48 hours, split between Claude Code (agent core) and Codex (dashboard UI), with ready-to-paste prompts.

The idea builds on the pattern that won Syndicate by Maximor Track 1 (Skeptic), and pushes it into what Skeptic listed as next steps: live third-party APIs, real per-call cost, cross-tool transfer and drift detection, all inside a real end-to-end task.

## Problem and users

Agents trust tool documentation by default, and when the tool moves money that trust becomes the most expensive bug in the system. A docs page can say a refund amount is in units when it's in cents, that a failed request was not processed when it was, or that a list returns everything when it silently stops at a page cap. An agent following the docs then double-refunds, refunds 100x too much, or misses an existing refund.

These failures don't crash anything. Every call returns 200, every trace looks green, and the damage shows up later in the payments dashboard.

**Who it's for**

- **Primary:** small SaaS teams and solo founders who want an agent to handle billing ops (refunds, credits, plan changes) without a human watching every action.
- **Secondary:** any team running agents against third-party APIs they don't control, where doc drift is a standing risk.

**Why now:** agents are moving from read-only tasks into irreversible actions, and the hackathon's own theme is "agents you'd trust to run without you watching." Trust has to be earned per tool behavior, not assumed from docs.

## Goals, non-goals and success metrics

Notary succeeds if run 2 makes zero unsafe money actions that run 1 made, at lower cost, with every claim backed by a trace.

**Goals**

1. Finish a real billing-ops queue end to end: enrich, decide, execute or hold, report.
2. Verify tool behaviors by pre-registered experiment before any irreversible action depends on them.
3. Get measurably better and cheaper across runs through persisted beliefs and guards.
4. Transfer defect patterns learned on one tool (Crustdata) to speed up probing the next (Dodo).
5. Make every number reproducible offline from recorded traffic.

**Non-goals (this weekend)**

- Live-mode payments. Dodo runs in test mode only.
- Supporting any API beyond Crustdata and Dodo.
- A hosted multi-tenant backend. The dashboard reads exported run bundles.
- Formal expected-information-gain math. A greedy, cost-aware probe score is enough.

**Success metrics**

| Metric | How it's measured | Target |
| --- | --- | --- |
| Unsafe money actions | Duplicate refunds, wrong-unit amounts, missed existing refunds in the seeded queue | Run 1 baseline > 0; run 2 = 0 |
| Belief precision | Notarized beliefs that match a confirmed real behavior | ≥ 0.8, false beliefs = 0 |
| Unguarded call sites | Calls to a guarded operation not wrapped, found via entire-graph callers | 0 |
| Cost per queue run | Crustdata credits + Bedrock tokens per run, from neatlogs | Run 2 lower than run 1 |
| Probes to confirm on tool 2 | Probes needed on Dodo with vs. without Crustdata-learned priors | Fewer with priors |
| Automation rate | Requests executed safely without a human | Reported honestly, not maximized |
| Reproducibility | `notary replay` from a clean clone reproduces headline numbers | Exact match |

Negative or withdrawn results are kept and published, as the strongest Syndicate winners did.

## Core flows

There are four flows: the queue job, the notarization loop that gates it, offline replay, and viewing results in the dashboard.

**Flow A: Work the billing queue (the end-to-end task)**

1. Load a queue of customer requests (refund, partial refund, plan change, credit).
2. Enrich each customer's company via Crustdata and map it to a policy tier.
3. Decide the action from the policy (approve, partial, deny, escalate).
4. Check required beliefs for that action. All notarized: execute in Dodo test mode through the guards. Any missing: hold and escalate with evidence.
5. Write a run report: decisions, actions taken, holds, costs, trace links.

**Flow B: Notarize a tool behavior**

1. Recon turns doc claims into a machine-checkable contract.
2. The contract checker compares each live response to the contract and flags anomalies, with no LLM.
3. The reflector proposes two or three rival explanations per anomaly, in one batched call.
4. The probe designer picks the experiment that best separates rivals per credit spent.
5. The prediction is committed and logged before the probe runs.
6. The verdict updates the belief's confidence. Uninformative observations confirm nothing.
7. The adversary, on a stronger model, tries to refute the belief. Only survivors are notarized.
8. Notarized beliefs compile into guards and a corrected tool spec.

**Flow C: Replay offline**

1. A judge clones the repo and runs `notary replay`.
2. Recorded traffic stands in for live APIs. No keys, no credits.
3. Headline numbers reproduce exactly, and a drift fixture shows a belief being un-learned.

**Flow D: Watch it in the dashboard**

1. Open the hosted dashboard, or the local one during a live run.
2. Browse the queue, beliefs board, probe log, runs comparison and economics.
3. Click any belief or decision through to its neatlogs trace.

## Functional requirements

P0 items are required for the demo; P1 items land only if P0 is done by Sunday night.

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1 | CLI `notary run --queue <file>` works the whole queue unattended and exits with a run bundle | P0 |
| FR-2 | Contract checker flags doc-vs-wire anomalies deterministically; same input gives same anomalies | P0 |
| FR-3 | Reflector proposes 2–3 rival hypotheses per anomaly in one batched model call | P0 |
| FR-4 | Every probe logs its committed prediction before the call, as a neatlogs span | P0 |
| FR-5 | Beliefs carry a confidence (beta-binomial) that later evidence can raise or lower, including auto-unlearn | P0 |
| FR-6 | Uninformative observations (empty result, no-signal sweep) cannot confirm or refute a belief | P0 |
| FR-7 | Adversary on a stronger model reviews each candidate belief; refuted beliefs revert to hypotheses | P0 |
| FR-8 | Notarized beliefs compile into guards that wrap Dodo and Crustdata client calls | P0 |
| FR-9 | Irreversible actions require all their declared beliefs notarized; otherwise hold and escalate with evidence | P0 |
| FR-10 | Every belief cites trace ids, and a deterministic check verifies each cited span actually tested that parameter | P0 |
| FR-11 | Recorded-traffic replay: `notary replay` reproduces headline numbers with no keys | P0 |
| FR-12 | Run bundle JSON: beliefs, probes, predictions, guards, decisions, costs by role, trace links, content hash | P0 |
| FR-13 | Dashboard screens: Queue, Beliefs, Probe log, Runs comparison, Economics | P0 |
| FR-14 | Probe selection weighs real per-endpoint credit cost | P1 |
| FR-15 | Crustdata-learned defect classes become priors for Dodo probing; measured with vs. without | P1 |
| FR-16 | Drift fixture: an altered recorded response lowers a belief's confidence until it un-learns and its guard tightens | P1 |
| FR-17 | Guard coverage check via entire-graph callers: unguarded call sites = 0 | P1 |
| FR-18 | Dashboard live mode streams a run in progress over SSE | P1 |
| FR-19 | Corrected tool spec exported as `export/TOOLS.md` | P1 |

**Safety rules (non-negotiable)**

- Dodo runs in test mode only; the client refuses a live key.
- Rate-limit and burst probes are capped per run to stay polite to live services.
- A hard Crustdata credit budget per run; the run stops cleanly when it's hit.

## Sponsor integration requirements

Each sponsor does a job the product actually needs; none is bolted on for points. neatlogs, Entire and cfo.ai are mandatory for submission.

| Sponsor | Required? | What Notary uses it for | Evidence for judges |
| --- | --- | --- | --- |
| neatlogs | Yes | TS SDK traces every queue step and probe; probe spans carry the committed prediction; beliefs cite trace ids; run comparisons prove run 1 vs run 2; `@neatlogs/codex` (and Claude Code hooks, if available) trace the build sessions; `neatlogs-cli` reads traces back for evidence checks | Trace links in the dashboard and README; run comparison screenshots |
| Entire | Yes | CLI enabled for the whole build; Entire skills and `entire graph` used inside coding sessions; the adversary runs as a headless coding-agent session so each review is checkpointed next to the belief commit; entire-graph callers prove guard coverage | Checkpoint history on the public repo; guard-coverage report |
| cfo.ai | Yes | Business plan: pricing per monitored API contract, COGS from neatlogs cost data (credits + tokens), cost of incidents prevented, runway | Plan included in the submission and the Economics screen |
| Crustdata | Optional | Company enrichment for policy tiers; first tool to notarize; real per-call credit cost | Beliefs about Crustdata fields and filters |
| Dodo Payments | Optional | Where refunds, credits and plan changes execute (test mode); second tool to notarize; Notary's own billing page | Dodo test dashboard before/after; beliefs about refunds and retries |
| AWS Bedrock | Optional | Cheap executor model and a stronger reflector/adversary model, with cost accounted per role | Per-role cost in the run bundle |

**Setup checklist (before or at kickoff)**

- [ ] neatlogs account, project ingest key and a service-account token for `neatlogs-cli`
- [ ] Entire CLI installed and logged in; `entireio/skills` added; entire-graph plugin installed
- [ ] cfo.ai signup at cfo.ai/neathacks, then cancel the subscription immediately in Settings → Billing
- [ ] Crustdata API key (5,000 credits)
- [ ] Dodo Payments test-mode API key
- [ ] AWS web check-in done at 8:00 AM IST for credits; Bedrock model access enabled

## Hackathon constraints and judging alignment

The build starts at 12:30 PM IST on October 10 and submission closes at 11:55 PM IST on October 12; nothing on the project repo may predate the start.

**Authenticity rules (from Entire's open-source `entire-judge` plugin)**

- Session history that predates the event start is a hard gate: excluded from ranking. Create the repo and run `entire enable` only after 12:30 PM IST.
- No code copied from Skeptic, Reify or any earlier project. Ideas yes, code no.
- Many sessions beat one burst (effort consistency). One phase per session fits this.
- Prompt quality is scored from the prompts actually typed to the coding agent. Use the prompts in the Build Plan.
- Using `entire graph`, `entire brain` and Entire skills inside sessions raises the CLI-awareness score.
- If a coding agent warns about fake or hardcoded results and we ignore it, the integrity lens flags it. Seeded fixtures are disclosed in the README.

**How the judging weights map to the build**

| Criterion | Weight | What earns it |
| --- | --- | --- |
| The agent | 30% | Unattended queue run end to end; recovery and escalation; verified outcomes |
| Use of neatlogs, Entire, cfo.ai | 25% | Each used for its core purpose (see sponsor table) |
| Demo video | 20% | Naive run fails, notarization, adversary refutes one belief, guarded rerun is clean |
| Building in public | 15% | X posts at each milestone with real screenshots |
| Usefulness and originality | 10% | Live APIs, real cost, transfer and drift beyond prior work |

**Submission (Monday, October 12, 7:00–11:55 PM IST):** quote-tweet the official neatlogs post with team, name, project, public repo and demo video. Aim to post right at 7:00 PM to land in the first 50.

## Risks and open questions

The biggest risk is that live APIs show few real doc mismatches in 48 hours; the plan treats confirmed "tool honors this claim" results and abstentions as first-class findings, plus a drift fixture.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Few real mismatches on Crustdata/Dodo | Thin demo | Controls and abstentions count; drift replay shows un-learning; naive-agent failures come from real behaviors that are merely undocumented |
| `neatlogs-cli` is a team-test release | Can't read traces back | Dual-export OTel spans to a local JSONL file; evidence checks read that instead |
| Bedrock access or credits delayed | No models | Check in at 8:00 AM; ask in Discord whether another provider is allowed; keep a model-client interface |
| Crustdata credits run out | Runs stop | Record once, replay from cassettes; hard per-run budget |
| LLM nondeterminism skews run comparisons | Unclear improvement | Temperature 0, three baseline runs for a noise floor, decisions graded deterministically |
| Scope creep in the dashboard | Core late | Dashboard reads static bundles; Codex builds it in parallel against a fixed schema |
| Probing a live service too hard | ToS or rate-limit problems | Capped burst probes; polite delays; test mode only on Dodo |

**Open questions**

- [ ] Is Orchestrator.inc worth integrating? Decide after the 9 AM kickoff.
- [ ] Does Dodo test mode support every action in the queue (partial refunds, plan changes, credits)? Confirm in P1.
- [ ] Which Crustdata endpoints give the most useful enrichment per credit? Confirm in P1.
- [ ] Solo or team? Changes whether the dashboard runs in parallel from Saturday.
