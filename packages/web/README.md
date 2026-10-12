# @notary/web

The Notary web app: the landing page (`/`), the guide (`/docs`) and the Agent Control Center
dashboard (`/app/*`). React 19, Vite and react-router; one shared UI kit in `src/ui` on the tokens
in `src/design/tokens.css`. The dashboard is light only.

## Pages

| Route                   | What it shows                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `/app/run`              | One run step by step: stage stepper, transcript with its event rail, held actions, spend        |
| `/app/certificates`     | Certificates of the selected run's world (active / revoked), claims without a certificate       |
| `/app/approvals`        | Held money actions: decided on a local `notary serve` (Dodo test mode), read-only history otherwise |
| `/app/business`         | Unit economics from real runs; the cfo.ai plan once a plan is imported                          |
| `/app/incidents`        | What went wrong while the agents worked, tied to its neatlogs span and how it was resolved      |
| `/app/chat`             | Questions about runs, certificates and the checked APIs; answers cite records                   |
| `/app/report`           | Run comparison (one world at a time), cost per run, connections and receipts                    |

Every record has its own URL and the selected run is always `?run=<runId>`. Without one, the app
opens a guarded queue run if there is one, else the newest live run that recorded probes or
decisions; replays are never opened first.

## Data rules

- **Every number comes from a data file** in `public/` (run bundles, timelines, certificates,
  incidents, economics, evidence) or from a local `notary serve`. Nothing is hardcoded.
- **Verified in the browser.** Bundles are parsed with the shared zod schema
  (`packages/core/src/schema`) and their `contentHash` is recomputed with
  `packages/core/src/bundle/hash.ts`. Timelines must name their bundle's hash and agree with it
  (probe, decision and certificate counts); the incidents index carries its own `contentHash`.
  Any mismatch withholds the data with a visible error. These two core paths are the only core
  imports.
- **Fixture data is never mixed with real data.** The default view shows real runs only. The
  development view `?fixtures=1` shows fixture runs only, under the banner "Fixture data —
  simulated APIs, not a live run". Each fixture scenario is its own world: counts and tables are
  never summed across scenarios. The synthetic sample bundle (`sample-42`) is in neither view.
- **Replays are labelled.** A replay (`bundle.mode === "replay"`) carries "Replay of
  &lt;original run&gt;" everywhere it is listed, comes after the live runs, and its spend reads
  "Re-served from the recording — no new spend" with the original run linked. Its incidents are
  the original run's and are not counted again.
- **Missing is not zero.** A value nobody recorded reads "Not recorded" or "unknown", never 0.

## Live and hosted modes

- `pnpm --filter @notary/web dev` probes a local `notary serve` (default `http://localhost:8787`,
  override with `VITE_NOTARY_API`). When it answers, the app is live: starting a run (after a
  confirmation dialog), approving held actions and chat use `/api/*`, which is loopback-only and
  needs the per-session token `notary serve` prints.
- The production build (`pnpm --filter @notary/web build`) is the hosted site: it always replays
  the published files and never contacts a local API.

## Commands

From the repo root (the root `pnpm-lock.yaml` is the only lockfile):

```powershell
pnpm install --frozen-lockfile
pnpm --filter @notary/web dev
pnpm --filter @notary/web typecheck
pnpm --filter @notary/web test
pnpm --filter @notary/web build
```

### Screenshots and the visual check

Both scripts run against a production build served by `vite preview` and use the system Chrome
(Playwright channel `chrome`, no browser download):

```powershell
pnpm --filter @notary/web build
pnpm --filter @notary/web preview --port 5175 --strictPort   # in a second terminal
pnpm --filter @notary/web screenshots    # docs/screenshots/<page>-<width>.png and public/og.png
pnpm --filter @notary/web check:visual   # behavior + layout checks; artifacts in screenshots/K3 (gitignored)
```

`screenshots` captures the landing, the guide and every dashboard page at 1440 and 390 px in the
default (real runs) view, plus a `?fixtures=1` pass (`<page>-<width>-fixture.png`).
`check:visual` checks headings, navigation, deep links, the fixture banner, horizontal overflow,
browser errors and the visible rejection of a tampered bundle. `NOTARY_PREVIEW_URL` and
`NOTARY_SCREENSHOTS` override the base URL and output directory.

## Deploying (Vercel)

Config: `vercel.json`. Root Directory `packages/web`, with files outside the root directory
included in the build (it reads `packages/core/src` and the root lockfile). Install
`npx --yes pnpm@11.7.0 install --frozen-lockfile`, build
`npx --yes pnpm@11.7.0 --filter @notary/web build`, output `dist`. No environment variables are
needed. `/app/*` and `/docs` rewrite to `index.html`; data directories are served `no-cache` so
the in-browser hash checks always see the current files; hashed `/assets/*` are immutable. The
hosted site has no `/api/*`.

## Credits

Third-party components and their licenses: `docs/CREDITS.md`.
