# @notary/web

Read-only Notary dashboard built with React, Vite, Tailwind, shadcn/ui primitives
and Dither Kit. The home page is Overview; Queue, Beliefs, Probe log, Runs
comparison, Economics and Evidence share its visual system. Geist uses light and
regular weights. Warm neutral surfaces, a blue accent and SVG diagonal hatching
separate focus and baseline series. Green/red are reserved for safety deltas.

## Local development

The web app is part of the pnpm workspace; the root `pnpm-lock.yaml` is the only
lockfile. From the repo root:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @notary/web dev
pnpm --filter @notary/web typecheck
pnpm --filter @notary/web test
pnpm --filter @notary/web build
```

`dist` is the static output; Vite serves `public` assets unchanged. The app imports
`packages/core/src/schema` and `packages/core/src/bundle/hash.ts` from source, so the
whole workspace (including `packages/core` and its `zod`) must be installed to build.

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

## U5 landing and routing

The landing page is `/`; the dashboard is `/app`. Screens use real React Router
paths such as `/app/beliefs` and `/app/comparison`, including direct loads and
refreshes. Theme preference persists across page navigation. Deployment: see
"Deploying to Vercel" below.

The landing contains the requested hero, problem bento, numbered process,
required tools, results, CTA and footer. Its stats are verified bundle values.
Any live bundle switches result selection to the live cohort; missing live queue
sides remain pending. Fixture results carry the persistent AGENTS.md banner and
the planted-quirks disclosure. Tool status and purpose are read from the evidence
file. License notices, original registry URLs and adaptation details are in
`docs/CREDITS.md`.

`npm run check:visual` now saves U5 captures to `screenshots/U5`. It includes
landing plus all dashboard pages at both widths and themes, and checks navigation,
deep-link refreshes, theme persistence, missing tool receipts, live result
precedence and visible tamper rejection. The first visual review corrected filled
CTA foreground contrast in both themes. The numbered process and hero anecdote
are user-requested structural/content numbers; measured statistics stay file-backed.

## U6 chart polish

The dashboard now uses Dither Kit's canvas bar and line charts. The line fill uses
step sampling and recorded SVG step connectors, so no intermediate observations
are invented. Unknown values are labelled and withheld from bar painting; zeros
remain explicit. Axis labels use observed values, with fewer ticks when counts
are close. Queue tooltip drops remain signed differences between adjacent counts.
The source and MIT declaration are recorded in docs/CREDITS.md.

Insight and landing CTA cards use the kit's static blue dither gradient over a
dark blue surface. The same Phosphor family supplies chevrons and context icons
for native selects, retaining keyboard/touch behavior. The current visual check
writes artifacts to ignored screenshots/U6 and verifies the queue hover tooltip.

## V2 — Agent Control Center shell

- Routes: `src/routes.tsx` is the single table (path, title, sidebar group, icon, badge,
  parent, element). `/` is the landing page; everything else lives under `/app`. Every
  record has its own URL (`/app/queue/:decisionId`, `/app/probes/:probeId`,
  `/app/beliefs/:beliefId`, `/app/certificates/:certificateId`, `/app/runs/:runId`,
  `/app/reports/:tool`); the selected run is always `?run=<runId>`.
- Data: `src/state/DataProvider.tsx` (`useData()`) loads a local `notary serve`
  (`/api/bundles`, proxied by the dev server to 127.0.0.1:8787) or else the static
  indexes, hash-verifies every bundle, and exposes `{mode, source, runs, runGroups,
  bundles, bundle, baseline, certificates, evidence, loading, error}`. Certificate files are
  validated with the core schema and every seal is recomputed in the browser.
- Primitives: `@/components/ui` (`PageHeader`, `Card`, `KpiCard`, `DeltaPill`,
  `StatusPill`, `FixtureBanner`, `EmptyState`, `LoadingState`, `ErrorState`, `HatchDefs`,
  `HatchSwatch`, sidebar). Shell: `@/components/shell` (`AppShell`, `RunPicker`,
  `CommandPalette` on Ctrl/Cmd+K, `notify` toasts). Tokens: `src/styles.css`.
- `npm run check:visual` iterates every route (`NOTARY_VISUAL=quick` for a short pass).

## V5 — landing page (`/`)

Sections, each number from a data file:

- **Hero** — "Notary issues certificates for API behavior. No certificate, no money moves.",
  dashboard (`/app`) and GitHub buttons.
- **The double-refund problem** (fixture, labelled) — `landing-data.ts` `findIncident` picks the
  first naive decision the grader marked `duplicate` (two write attempts, first timed out) and the
  first marked `wrong_unit` (items[].amount sent vs amount refunded), each with the same request in
  the guarded run (held, missing certificate). Totals are `metrics.unsafe_*`, `executed`, `holds`
  of the fixture naive/guarded bundles.
- **Read → Test → Challenge → Certify → Enforce** — copy mapped to the real modules/commands.
- **Mission control replay** — "Fixture replay — simulated APIs, not a live run". Plays the
  published fixture timelines of one world (its notarize runs, then the guarded run) in a loop,
  each timeline tied to its hash-verified bundle by `bundleHash`. It reuses Mission control's
  `StageGraph`, `stageStats`, `nodeStates` and `edgesForNewEvents` unchanged; the landing adds
  only a looping clock. It pauses off-screen, has a Pause/Play button, and under
  `prefers-reduced-motion` opens paused on the finished state.
- **Required tools** — neatlogs, Entire, cfo.ai with status/purpose/notes/links exactly as in
  `public/evidence/evidence.json` (generated by `pnpm notary export --evidence`).
- **Results** — real results from non-sample bundles and `certificates/report.json` ("Not
  measured yet" while there are none); fixture results (labelled) from the fixture bundles and
  `certificates/fixture/<scenario>/report.json`. Never in one table.

## Deploying to Vercel

Config: `packages/web/vercel.json`. Nothing here deploys automatically.

1. Import the GitHub repo in Vercel. **Root Directory: `packages/web`**. Keep "Include files
   outside the Root Directory in the Build Step" **enabled** (the default): the build reads
   `packages/core/src` and the root `pnpm-lock.yaml` / `pnpm-workspace.yaml`.
2. Framework preset: **Vite** (vercel.json sets it; its commands override the preset's).
   - Install: `npx --yes pnpm@11.7.0 install --frozen-lockfile` — the root lockfile, the pinned
     pnpm from the root `packageManager` field (no Corepack setting needed); pnpm 11 honours
     `allowBuilds` in `pnpm-workspace.yaml`, so only esbuild runs a build script.
   - Build: `npx --yes pnpm@11.7.0 --filter @notary/web build` (`tsc --noEmit && vite build`).
   - Output: `dist`.
3. Environment variables: **none required**. Leave `VITE_NOTARY_API` unset on the hosted site.
4. Routing: `/` and `/index.html` are static; `/app` and every `/app/*` deep link rewrite to
   `/index.html`. Everything else is a plain file or a 404.
5. Read-only: there is no `/api/*` on the hosted site (no rewrite, no functions), so
   `GET /api/bundles` is a 404 and the data layer falls back to the static indexes ("static"
   mode). `POST /api/ask` and `/api/approvals` exist only on a local `notary serve`.
6. Caching: `/bundles/*`, `/content/*`, `/certificates/*`, `/evidence/*` are `no-cache` (always
   revalidated, so the in-browser hash checks see the current files); hashed `/assets/*` are
   immutable.

Verified locally (V5) on a clean copy of the working tree (git-tracked + untracked, no
`node_modules`): the install and build commands above succeeded from `packages/web`, and
`vite preview` served `/`, `/app`, `/app/queue/<decisionId>` and `/app/certificates/<id>`
deep links with no page errors. `vercel deploy` itself was not run.

The standalone `packages/web/pnpm-lock.yaml` was removed: nothing used it (the workspace
install ignores it) and it was stale (no @xyflow/react, cmdk or sonner).
