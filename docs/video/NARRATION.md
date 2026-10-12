# Narration (final text for the voice) — Notary submission video

Source: `docs/video/SUBMISSION_SCRIPT.md` (cfo.ai version B — no plan imported; neatlogs lines limited to what the real traces show). One section per audio file; the section id is the file name.

## intro
Notary. No certificate, no money moves.

## problem
AI agents are starting to move real money: refunds, plan changes, credits. They learn how from API docs. But docs and real APIs disagree. We pointed our agent at two real APIs, Crustdata and Dodo Payments. Crustdata's own docs say a company lookup with no match returns an empty result. Live, it returned an error, on three separate documented claims. An agent that trusts the docs breaks on exactly these cases.

## notary
Notary is an agent that won't touch money until it has proven how its tools behave. It reads the docs and turns every promise into a claim. Before each test call, it commits a prediction, hashed, so it can't change afterwards. Then it calls the live API and compares. A Reflector proposes explanations. A stronger Adversary, running on a different model, tries to refute them. On our live runs, it narrowed all five beliefs instead of rubber-stamping them. What survives becomes a certificate, valid only where it was tested. No certificate, no money moves: the Guard holds anything uncovered for a person to review.

## neatlogs
We used neatlogs to look inside every run. Each run is one trace: every probe, every model call, every guard decision, labelled by agent. On the Crustdata run, the trace shows the probe for one disputed claim. Its prediction is logged, with its hash, before the call is made. The result came back inconclusive, so Notary resolved it the safe way: it abstained, and no payment can depend on that claim. Two more mismatches, lookups that error where the docs promise an empty result, are still open. Notary hasn't certified them, so the Guard won't let money depend on them either. On the Dodo run, the trace shows the Adversary narrowing four beliefs instead of upholding them as written. Wallet credits, for example, are in minor units only for US dollars. Notary resolved those by certifying only the narrower scope it had proven.

## entire
Entire captured how Notary was built. Seven checkpoints tie each commit to the coding-agent session that wrote it. Notary also uses Entire's code graph to prove a safety property: every call that can move money goes through a guard. Zero unguarded call sites.

## cfo
And Notary measures what certainty costs: about three cents of model spend and fifteen Crustdata credits per live run. It exports those real numbers for cfo.ai to build the business plan on.

## close
On our evaluation suite, with simulated payment APIs, the agent without Notary made nine unsafe money moves. With Notary, zero, and nine refunds held for review. Notary. No certificate, no money moves.
