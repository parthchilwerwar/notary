# @notary/web

Read-only Notary dashboard built with React, Vite, Tailwind, shadcn/ui primitives
and Recharts. The home page is Overview; Queue, Beliefs, Probe log, Runs
comparison, Economics and Evidence share its visual system. Geist uses light and
regular weights. Warm neutral surfaces, a blue accent and SVG diagonal hatching
separate focus and baseline series. Green/red are reserved for safety deltas.

## Local development

Run from `packages/web`:

```powershell
pnpm --ignore-workspace --store-dir .pnpm-store install --frozen-lockfile --ignore-scripts
npm run dev
npm run typecheck
npm test
npm run build
```

The web package has its own lockfile and dependency store. Use npm for run
commands to avoid pnpm's automatic root workspace installation check. `dist`
is the static output; Vite serves `public` assets unchanged.

## Integrity and data sources

The catalog reads `public/bundles/index.json` and the optional
`public/bundles/fixture/index.json`. Every listed bundle must pass the shared core
schema, a browser-recomputed content hash and index metadata checks before any
catalog data is rendered. A corrupt bundle, mislabeled fixture or
`x-notary-hash-mismatch: 1` withholds the catalog and displays a visible error.
The fixture directory rejects bundles whose `sample` flag is false.

Run selection defaults to a guarded queue run when available. The baseline
picker permits only the same fixture/live cohort. Charts never combine those
cohorts. Navigating to Probe log chooses a bundle with probes if the current run
has none; returning to a queue screen chooses a guarded queue run. The selected
run is always identified in the picker. Overview's experimental coverage can
use a same-cohort notarization bundle and explicitly names that source.

The fixture banner stays visible while scrolling. Evidence keeps integration
receipts and the fixture comparison in separate sections, including when a live
run is selected. Required tool content comes from
`public/evidence/evidence.json`; omitted tools show Pending. Optional
`public/economics.json` is shown as the cfo.ai plan; otherwise the screen shows
"cfo.ai plan pending".

Numbers are bundle fields, JSON fields or computations over them. Missing
metrics remain unknown, rather than becoming zero. Model USD is summed from
`usageByRole`; API credits are never given an invented USD exchange rate.
Zero-cost roles are listed explicitly. A cost per belief with no notarized
beliefs is undefined. The safety takeaway describes recorded differences and
held refunds without claiming live causation.

Queue flow counts requests, distinct decided request IDs and individual terminal
outcomes. Executed/held/escalated are sibling branches, not successive funnel
conversions; tooltips show signed differences between adjacent counts. Belief
categories are disjoint: notarized above/below neutral confidence, abstained,
adversary-downgraded and unresolved. Confidence means P(documentation holds).

Trace links come exclusively from bundle receipts; absent links show recorded
IDs. Local JSONL receipt links require the run files to be hosted separately.
Fixtures and example URLs do not demonstrate live tracing. Live API/SSE and a
Vercel deployment remain separate scheduled work in TASKS.md.

## Visual quality checks

With the local dev server running and Chrome installed:

```powershell
$env:NOTARY_PREVIEW_URL = 'http://127.0.0.1:5173'
npm run check:visual
```

Playwright captures all seven pages in light/dark mode at desktop and phone
widths, plus detail views. Artifacts go to ignored `screenshots/U4`; set
`NOTARY_SCREENSHOTS` to change the output directory. The script checks page
headings, theme, persistent fixture disclosure, horizontal overflow, browser
errors and visible rejection of a tampered bundle. Probe screenshots use the
type-edge filter for readable experimental records. Unit tests verify published
bundle integrity, unsafe links, malformed indexes and derived overview metrics.

U4 review fixed insight footer contrast, blank zero-value plots and responsive
card/control spacing. Full-page screenshots and detail views were reviewed at
both widths and themes; the overview, queue and experiment cards were also
inspected at readable scale.
