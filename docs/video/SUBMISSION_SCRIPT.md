# Notary — neatHack submission video script (faceless, ~3:15)

What the organizers asked for, in ONE video:
1. **The problem your agent solves**
2. **How cfo.ai and Entire were part of the project**
3. **How neatlogs was used to identify and resolve the incidents your agent ran into** (show neatlogs' critical-incidents feature)

Format: no face. Voice = AI narrator (ElevenLabs) or your own voice off camera. Picture = screen recordings of the real dashboard, neatlogs, Entire and cfo.ai, plus short motion-graphic bridges from the showreel.

Every fact below is taken from the repo as of Oct 12 (`packages/web/public/{bundles,incidents,economics.json,evidence}`). Lines marked **⚠ VERIFY** depend on what *your* neatlogs / cfo.ai screen actually shows — check before recording and change the words to match the screen, never the other way round.

---

## Before you record (checklist)

- [ ] `pnpm notary serve` running, dashboard at `http://127.0.0.1:5173/app` (live mode shows the real runs).
- [ ] neatlogs open, logged in, project **notary**; find the critical-incidents view (see the organizers' demo video). Note which incidents it lists and on which traces. Our real traces with incidents:
  - `9db41ecd43406cef291c93ef8c9ab1cd` — Crustdata notarize run `notarize-crustdata-20261012T011404Z`
  - `a0e6fda50d71…` — Dodo notarize run `notarize-dodo-20261012T012315Z`
- [ ] Entire: `entire` CLI on PATH; the repo's checkpoints (7) visible (`entire` UI or `refs/entire/checkpoints`); `pnpm notary guards coverage --backend entire` pre-run (takes ~1 min).
- [ ] cfo.ai: either import your plan first (`pnpm notary economics --cfo-import <file>`) and use **cfo.ai version A**, or use **version B** (honest: costs exported, plan pending).
- [ ] Browser zoom 110–125 %, close other tabs, hide bookmarks bar, notifications off.

---

## Part 1 — The problem (0:00–0:35)

| Time | Narration | On screen |
|---|---|---|
| 0:00 | AI agents are starting to move real money: refunds, plan changes, credits. They learn how to do it from API docs. But docs and real APIs disagree — and when they do, the agent pays the wrong amount, or pays twice. | Showreel open (sky, "No certificate, no money *moves*."). |
| 0:15 | We pointed Notary at two real APIs, Crustdata and Dodo Payments, and checked their docs against what they actually do. Crustdata's own docs say a company lookup with no match returns 200 with an empty result. Live, it returned 400 — three times, on three documented claims. | Dashboard → Run `notarize-crustdata-20261012T011404Z` → the three checker anomalies (enrich no-match 400 vs 200, identify no-match 400 vs 200, identify invalid fields 403 vs 400). |
| 0:28 | An agent that trusts the docs breaks on exactly these cases. Notary is built so it can't. | Cut to "No certificate, no money moves." title card. |

## Part 2 — What Notary does (0:35–1:20)

| Time | Narration | On screen |
|---|---|---|
| 0:35 | Notary is an agent that won't touch money until it has proven how its tools behave. Read, test, challenge, certify, enforce. | Five-step bar (Run page header). |
| 0:45 | It reads the docs and turns every promise into a claim. Before each test call it commits a prediction — hashed, so it can't change afterwards — then calls the live API and compares. | Run transcript row expanded: committed prediction + hash + time → observation. |
| 0:58 | A Reflector model proposes explanations. A stronger Adversary — Claude Opus, a different model from the Reflector — tries to refute them. On our real runs the Adversary narrowed all five beliefs instead of rubber-stamping them. | Certificate detail: Adversary review, model `claude-opus-4.6`, verdict "narrowed". |
| 1:10 | What survives becomes a certificate, valid only in the scope it was tested. Five real certificates so far: one for Crustdata, four for Dodo. No certificate, no money moves — the Guard holds anything uncovered for a person. | Certificates page (real world): 5 certificates, seal; Approvals page held card. |

## Part 3 — neatlogs: identifying and resolving incidents (1:20–2:20)

| Time | Narration | On screen |
|---|---|---|
| 1:20 | Every step Notary takes is traced in neatlogs: each probe, each model call, each guard decision — and every agent is labelled, Executor, Reflector, Adversary, Guard. | neatlogs project → trace list. |
| 1:30 | neatlogs' critical-incidents view flagged our runs. **⚠ VERIFY: say what it actually flagged, e.g.** "It flagged the Crustdata run, where the checker saw the API disagree with its own docs." | neatlogs critical incidents → open the incident on trace `9db41ecd43406cef291c93ef8c9ab1cd`. |
| 1:42 | Opening the trace shows why. The prediction span is recorded *before* the call — the docs promised 200; the tool span shows Crustdata returned 400. That's the incident: the doc claim is false for this API. | neatlogs span view: probe span with `notary.prediction`, then the TOOL span with the 400. |
| 1:55 | Resolution: Notary doesn't patch around it. The belief is not notarized — Notary abstained — so no guard will ever let money depend on that claim. The incident stays open in Notary until new evidence arrives. | Dashboard Incidents for this run: status open, action "belief abstained". |
| 2:05 | The Dodo run shows the other kind of incident. **⚠ VERIFY: only if neatlogs lists it.** The Adversary refused to uphold four Dodo beliefs as written — for example, wallet credits are in minor units only in USD. The resolution was to certify them only in that narrower scope. | neatlogs: trace `a0e6fda50d71…` adversary spans → dashboard: certificate `cert-90b6704587c8abbf`, scope narrowed to USD, status "resolved — certified". |

> If neatlogs' incidents view shows *different* incidents (e.g. failed model calls or errors from the build sessions), replace 1:30–2:20 with those: show the incident, open its trace, name the cause in one sentence, then show the commit or setting that fixed it (the Entire checkpoint for that commit is a good proof shot). Only describe incidents you can show on screen.

## Part 4 — Entire and cfo.ai (2:20–2:55)

| Time | Narration | On screen |
|---|---|---|
| 2:20 | Entire captured the build itself. Seven checkpoints tie each commit to the coding-agent session that wrote it. | Entire checkpoints list (7), one opened: session, model, commit "Hackathon audit fixes…". |
| 2:30 | And Notary uses Entire's code graph to prove a safety property: every call that can move money goes through a guard. Zero unguarded call sites. | Terminal: `pnpm notary guards coverage --backend entire` → `unguarded_call_sites = 0`. |
| 2:40 | **cfo.ai — version A (plan imported):** Notary measures what certainty costs: about three cents of model spend and fifteen Crustdata credits per live run, two and a half cents per certificate. We built the business plan on those numbers in cfo.ai. **⚠ VERIFY plan figures on screen.** | `/app/business` (real numbers from `economics.json`) → cfo.ai plan. |
| 2:40 | **cfo.ai — version B (no plan yet, honest):** Notary measures what certainty costs: about three cents of model spend and fifteen Crustdata credits per live run, two and a half cents per certificate — and exports those real numbers to cfo.ai, where the business plan is built. | `/app/business` + `export/cfo-inputs.csv` + cfo.ai workspace. Don't show plan numbers that don't exist. |

## Part 5 — Close (2:55–3:15)

| Time | Narration | On screen |
|---|---|---|
| 2:55 | On our evaluation suite — simulated payment APIs with planted quirks — the agent without Notary made nine unsafe money moves. With Notary: zero, and nine refunds held for review. | Stats 9 → 0, 9 held, label "Evaluation suite — simulated APIs, not a live run". |
| 3:05 | Notary. No certificate, no money moves. | Closing sky, wordmark, github.com/parthchilwerwar/notary. |

---

## Facts used (source of truth)

| Claim | Source |
|---|---|
| Crustdata 400 vs documented 200 (×2), 403 vs 400 | `public/incidents/notarize-crustdata-20261012T011404Z.json` (3 checker anomalies) |
| Adversary narrowed 5 beliefs, model claude-opus-4.6, resolved by certifying in narrowed scope | same file + `incidents/notarize-dodo-20261012T012315Z.json` (traces `9db41ecd…`, `a0e6fda5…`) |
| 5 real certificates (1 Crustdata, 4 Dodo) | `economics.json` `computed.tools[].certified` |
| $0.0316 + 15.5 credits per live run; $0.0253 / 12.4 credits per certificate | `economics.json` `computed.costPerRun`, `costPerCertificate` |
| cfo.ai plan not imported yet | `economics.json` `planReason`; evidence.json cfo.ai = pending |
| 7 Entire checkpoints, 0 unguarded call sites | `public/evidence/entire.json`; commit `8e4ca8a` |
| 9 → 0 unsafe, 9 refunds held | evaluation suite (simulated APIs), `docs/EVALUATION.md#evaluation-suite` |
| No live queue run yet (so no real "money prevented" number) | `economics.json` `unsafeActionsPrevented.reason` |
