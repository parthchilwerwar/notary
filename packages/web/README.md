# @notary/web

Read-only React + Vite + Tailwind dashboard. U1 implements Queue and Beliefs;
the later screens remain explicitly scheduled placeholders. See `TASKS.md` for
the complete U1–U3 checklist.

## Local development

From `packages/web`:

```powershell
pnpm --ignore-workspace --store-dir .pnpm-store install --frozen-lockfile --ignore-scripts
npm run dev
npm run typecheck
npm test
npm run build
```

The web package has its own lockfile and dependency store so dashboard sessions
do not need to change the root workspace files. `dist` is the static production
output. Vite serves `public` assets unchanged.
The run commands use npm to avoid pnpm's automatic root-workspace install check.
Dependency install scripts are disabled; Vite uses the platform binary shipped
in the esbuild optional dependency.

## Bundle integrity and provenance

The run picker reads `public/bundles/index.json` and fetches
`public/bundles/<runId>.json`. Both are validated using the core's shared zod
schemas. Before any bundle data appears, the browser recomputes its content hash
with the core's browser-compatible hash function and checks index consistency.
Schema errors, a mismatched hash, or `x-notary-hash-mismatch: 1` withhold all data
and show a visible error. Requests are cancelled when switching bundles; a failed
load never leaves the previous run's data on screen.

All screen metrics come from bundle fields or array counts. Missing metrics show
"Not computable". Confidence means P(documentation holds), not confidence that
the discovered violation is true. Amounts remain in recorded minor units.

Every `sample: true` bundle carries the visible fixture banner regardless of its
`mode` or `kind`. Only the selected bundle is displayed. All bundle disclosures
and provenance are available above the screens. Trace links come exclusively
from the bundle (including local JSONL receipt paths); missing links show span
or trace identifiers as text. Local receipt files must be hosted separately to
resolve on a static deployment. The synthetic sample includes example trace
URLs, which are not evidence of live tracing.

Queue rows expand into request fields, policy/grade/enrichment, guard definitions,
evidence packs and recorded API effects. Beliefs support before/after snapshots
and status filters, with claims, citations, probe records, adversary reviews and
the append-only belief history in expandable detail.

Tests cover published fixtures (including a fixture subdirectory if present),
tampering, schema failures, index relabeling, mismatch headers, missing bundles,
duplicate run identifiers and unsafe trace URLs.
