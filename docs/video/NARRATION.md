# Narration v3 (cut to fit under 3:00) (final text for the voice) — Notary submission video

v3 = the v1 edit (commit e0f75f6) re-voiced with Lily, per the user. Changes from v1: the close says "On our test suite" (its 9 → 0 / 9 held numbers come from Notary's test suite, not the live runs; no on-screen tag), and the cfo line adds "built to deploy on AWS" (deploy/aws scripts exist; DECISIONS #203). Dodo Payments is named in the problem section. v2 text is in git history (a0c2c5c).

## intro
Notary. No certificate, no money moves.

## problem
AI agents are starting to move real money: refunds, plan changes, credits. They learn how from API docs. But docs and real APIs disagree. We pointed our agent at two real APIs, Crustdata and Dodo Payments. Crustdata's own docs say a company lookup with no match returns an empty result. In our run, it returned an error instead, and three documented claims didn't hold. An agent that trusts the docs breaks on exactly these cases.

## notary
Notary won't touch money until it has proven how its tools behave. It turns every promise in the docs into a claim, commits a hashed prediction before each test call, then calls the API and compares. A Reflector proposes explanations, and a stronger Adversary tries to refute them. In our runs, it narrowed all five beliefs. What survives becomes a certificate. No certificate, no money moves: the Guard holds anything uncovered for a person to review.


## neatlogs
neatlogs is how we looked into these incidents and checked how each one was resolved. Each run is one trace, with every probe and model call behind it. On the Crustdata run, the trace showed a disputed claim's prediction, logged with its hash before the call, and an inconclusive result. So Notary abstained, and no payment can depend on that claim. Two more mismatches stay open and uncertified, so the Guard blocks them. On the Dodo run, the trace showed the Adversary narrowing four beliefs, like wallet credits in minor units only for US dollars, so Notary certified only that narrower scope.

## entire
Entire captured how Notary was built. Seven checkpoints tie each commit to the coding-agent session that wrote it. Notary also uses Entire's code graph to prove a safety property: every call that can move money goes through a guard. Zero unguarded call sites.

## cfo
cfo.ai runs the business side. Notary measures what certainty costs, about three cents of model spend and fifteen Crustdata credits per run, exports those real costs to cfo.ai as a data source, and connects to cfo.ai's MCP server to sync the plan back. And it's built to deploy on AWS.

## close
On our test suite, the agent without Notary made nine unsafe money moves. With Notary, zero, and nine refunds held for review. Notary. No certificate, no money moves.
