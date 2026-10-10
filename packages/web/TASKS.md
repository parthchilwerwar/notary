# Dashboard phases

One phase per Codex session, per the root AGENTS.md. U6 is the current phase, as requested by the user. U2 live mode and U3 deployment remain scheduled separately.

## U1 — Shell, Queue and Beliefs

- [x] React, Vite and Tailwind shell with responsive navigation and theme toggle.
- [x] Load the static bundle index and selected bundle using the shared schema and browser hash function; visible errors with data withheld.
- [x] Persistent fixture disclosure; provenance and trace receipts.
- [x] Queue status filters, request details, guards, evidence packs and API effects.
- [x] Beliefs snapshots, documented claims, confidence, citations, supporting probes and adversary reviews.
- [x] Build, fixture checks, browser inspection and `U1: <summary>` commit.

Validation: production build and TypeScript pass; eight integrity tests pass,
including the sample and available published fixture bundles. Chrome checks
covered Queue filters and evidence expansion, Beliefs filtering and review
expansion, light/dark themes, and phone/tablet/desktop widths. No horizontal
overflow was observed at phone or tablet widths. Later screens are placeholders;
no live subscription or deployment has been implemented in U1.

## U2 — Probe log, comparison and live mode

- [ ] Hero timeline: committed predictions by hypothesis, observed treatment, control, winner, verdict and credits; prediction before call obvious.
- [ ] Select any two fixture bundles or any two live bundles; never mix them.
- [ ] Recharts bars for unsafe actions, accuracy, automation, credits and USD by role.
- [ ] Trace links from the bundle, span ids when absent.
- [ ] VITE_NOTARY_API bundle loading and /api/stream subscription: decision, probe.committed, probe.verdict, belief.changed and run.finished.
- [ ] Honor x-notary-hash-mismatch; verify new bundle snapshots before display.
- [ ] Build, fixture checks and `U2: <summary>` commit.

## U3 — Economics, Evidence and deployment

- [ ] Economics: cost per run, cost per notarized belief, endpoint credits, role USD and unsafe actions prevented.
- [ ] cfo.ai summary from public/economics.json; missing file shows "cfo.ai plan pending".
- [ ] Resolve numeric plan provenance against the root rule restricting on-screen numbers to bundles or public/evidence/evidence.json before displaying plan figures.
- [ ] Required tools cards: neatlogs, Entire and cfo.ai, purpose/status/links from public/evidence/evidence.json; missing entries are Pending.
- [ ] Separate fixture demo: naive versus guarded comparison with persistent fixture banner.
- [ ] Demo polish, consistent status colors, phone layout and empty/error states.
- [ ] Static Vercel configuration serving public/bundles and public/evidence.
- [ ] Build, deployment verification and `U3: <summary>` commit.

## U4 — Design system and Overview

- [x] Warm gray/white surfaces, pill navigation, Geist light/regular typography, large tabular KPIs, blue accent and a blue-to-warm insight card.
- [x] shadcn/ui Button/Card primitives, Tailwind Vite integration and local aliases.
- [x] Overview: safety comparison, queue flow tooltips, disjoint belief breakdown, dot-matrix probes, role USD, endpoint credits and a generated takeaway.
- [x] Recharts custom SVG hatching and recorded step-line trends.
- [x] Restyle Queue and Beliefs, implement bundle-backed Probe log, comparison, Economics and separate Evidence sections.
- [x] Verify the full catalog in the browser, fixture disclosure and same-cohort comparison restrictions.
- [x] Production build, 13 unit tests, and 28 Playwright page/theme/width combinations with screenshot review and tamper-rejection check.
- [x] Commit `U4: design system and overview`.

This phase supplies static content for the previously scheduled screens. It does
not complete U2's live API/SSE work or U3's deployment. The user explicitly
allows JSON-backed economics content in U4; the absent plan remains pending.
Visual artifacts are in ignored `screenshots/U4` and can be regenerated with
`npm run check:visual`. Only web changes are included in the U4 commit.

## U5 — Landing page

- [x] Landing at `/`; React Router dashboard and deep links at `/app`.
- [x] Vercel SPA rewrite for dashboard paths, preserving public assets.
- [x] Browse 21st.dev, inspect and install six UIAble components using the pinned shadcn CLI and registry URLs.
- [x] Adapt hero, bento, process steps, results strip, CTA and footer to Notary's shared design system.
- [x] Tool role/status from public evidence; verified fixture/live results with strict cohort separation and fixture disclosure.
- [x] Publisher MIT notice, registry source URLs and adaptation credits in docs/CREDITS.md within packages/web.
- [x] New runtime and development dependencies pinned to exact versions.
- [x] Production build, 19 tests, 32 screenshot combinations, tamper rejection, live precedence, pending tools and route refresh checks.
- [x] Commit `U5: landing page`.

## U6 — Dither charts and control polish

- [x] Install actual Dither Kit bar, line and gradient sources from the publisher registry.
- [x] Replace Recharts, preserve missing metrics, render explicit data receipts and recorded step transitions.
- [x] Remove decorative stars and pin new chart dependencies exactly.
- [x] Refine dashboard insight and landing CTA cards with a blue dither wash and readable contrast.
- [x] Native selectors with Phosphor chevrons and run/comparison/status/template icons.
- [x] Build, 21 tests and 32 responsive/theme screenshot combinations; check queue hover, integrity and fixture/live separation.
- [x] Commit `U6: dither charts and control polish`.
