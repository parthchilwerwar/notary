# Narration v2 (final text for the voice) — Notary submission video

v2 changes: female calm narrator; only results from Notary's real runs are shown (no evaluation-suite scenes, so no data-source labels are needed); new `stack` section on Dodo Payments and AWS. Every line is checked against the repo (`packages/web/public/{bundles,certificates,incidents,economics.json,evidence}`, README "How each sponsor is used", DECISIONS #198, #203, #204, #220). One section per audio file; the section id is the file name.

## intro
Notary. No certificate, no money moves.

## problem
AI agents are starting to move real money: refunds, plan changes, credits. They learn how from API docs. But docs and real APIs disagree. We pointed our agent at two real APIs, Crustdata and Dodo Payments. Crustdata's own docs say a company lookup with no match returns an empty result. In our run, it returned an error instead, and three documented claims didn't hold. An agent that trusts the docs breaks on exactly these cases.

## notary
Notary is an agent that won't touch money until it has proven how its tools behave. It reads the docs and turns every promise into a claim. Before each test call, it commits a prediction, hashed, so it can't change afterwards. Then it calls the API and compares. A Reflector proposes explanations. A stronger Adversary, running on a different model, tries to refute them. In our runs, it narrowed all five beliefs instead of rubber-stamping them. What survives becomes a certificate, valid only where it was tested. And the rule is simple. No certificate, no money moves. The Guard holds anything uncovered for a person to review.

## stack
Dodo Payments is where the money moves: refunds, credits and plan changes, run in test mode. Notary certified four Dodo behaviors before trusting them, from page limits to wallet credit units and idempotency keys. Crustdata tells the agent who each customer is, so the right policy applies. The models run through a LiteLLM gateway, with Claude as the Reflector and Adversary. And Notary is built to run on AWS: deploy scripts for a read-only hosted API on ECS, and Amazon Bedrock as a drop-in model provider, so the agents and their models can run inside a team's own AWS account.

## neatlogs
We used neatlogs to look inside every run. Each run is one trace: every probe, every model call, every guard decision, labelled by agent. On the Crustdata run, the trace shows the probe for one disputed claim. Its prediction is logged, with its hash, before the call is made. The result came back inconclusive, so Notary resolved it the safe way: it abstained, and no payment can depend on that claim. Two more mismatches, lookups that error where the docs promise an empty result, are still open. Notary hasn't certified them, so the Guard won't let money depend on them either. On the Dodo run, the trace shows the Adversary narrowing four beliefs instead of upholding them as written. Wallet credits, for example, are in minor units only for US dollars. Notary resolved those by certifying only the narrower scope it had proven.

## entire
Entire captured how Notary was built. Seven checkpoints tie each commit to the coding-agent session that wrote it. Notary also uses Entire's code graph to prove a safety property: every call that can move money goes through a guard. Zero unguarded call sites.

## cfo
And Notary measures what certainty costs: about three cents of model spend and fifteen Crustdata credits per run. It exports those numbers for cfo.ai to build the business plan on.

## close
So here is what Notary proved. Three documented claims that didn't hold. Five certificates, each one narrowed by the Adversary. Zero unguarded money calls, at about three cents a run. Notary. No certificate, no money moves.
