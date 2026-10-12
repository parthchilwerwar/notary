# packages/web — status

The project plan and the current phase live in the root `PLAN.md`; decisions and docs-vs-reality
differences in `docs/DECISIONS.md`. This file only summarizes the web app's state.

## Built

- Landing (`/`), guide (`/docs`) and the dashboard: Run, Certificates, Approvals, Business,
  Incidents, Chat and Report (see `README.md`).
- Data layer (`src/data`): live (`notary serve`) or replay (published files) selection, browser
  hash verification of bundles, timelines, certificates, incidents and economics, visible errors
  with data withheld.
- Real and fixture worlds kept apart (`?fixtures=1`), replays labelled and never counted as new
  spend, distinct incident counting.
- Start run behind a confirmation dialog; approvals only on a local `notary serve` in Dodo test
  mode; the hosted build is read-only.
- Screenshots (`pnpm --filter @notary/web screenshots` → `docs/screenshots/`, `public/og.png`) and
  the visual check (`pnpm --filter @notary/web check:visual`).

## Blocked or open

Anything that needs keys or a running service is tracked as BLOCKED in the root `PLAN.md`.
