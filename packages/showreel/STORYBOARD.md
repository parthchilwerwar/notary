# Notary showreel — storyboard

15.0 s · 30 fps (450 frames) · 1920×1080 · H.264 · silent. Frame numbers live in
`src/timeline.ts`; this file is the plan they implement.

## Idea

One continuous vertical camera. The film opens in the landing's sky, dives down through the
cloud bank onto the white page where the proof plays out, then rises back into the sky for the
close. Nothing cuts: every beat hands over to the next in place, under one persistent five-step
bar. The one bold thing is the dive through the clouds and back; everything on the page is quiet
dashboard vocabulary (white cards, hairlines, status pills, the dither chart).

## Style frame

- **Color** — sky gradient `#2F62E6 → #4F84EE → #8DB8F5 → #D6E6FB → #FFFFFF` with the lilac tint
  lower left; page white, hairline `#E6EAF2`, ink `#0B0F19`, muted `#5B6475`; accent `#2F6AEB`
  (soft `#E8F0FE`); status color only for meaning (certified `#16A34A`/`#15803D`, unsafe
  `#DC2626`/`#B91C1C`, held `#D97706`/`#B45309`). Tokens mirrored in `src/theme.ts`.
- **Type** — Instrument Serif 400 (+ real italic) for display and big figures, −0.02em, 1.05
  leading, never bolded; Instrument Sans for everything else, tabular figures. Nothing under 22 px.
  Identifiers (claim ids, operations) in sans, never broken at their hyphens.
- **Shape** — cards 20 px radius (28 large), buttons 10 px, the landing's soft float shadow.
- **Motion** — one easing family: entrances `cubic-bezier(.2,.7,.1,1)`, exits a short ease-in,
  the camera a long symmetric move; springs only where something stamps (the commit stamp, the
  seal, verdict and mismatch pills), never on running text. Cards rise 40 px and fade in, lift
  48 px and fade out; a beat's cards finish leaving before the next beat's arrive (no
  half-transparent text overlaps). Everything is computed from the frame: no CSS animation,
  no wall clock.
- **Layout** — title-safe frame: hairlines at x 120/1800 and y 96/984 with hollow nodes at the
  crossings (the landing's grid framework); content on x 160–1760.

## Beats

| # | Time | Frames | What happens |
| --- | --- | --- | --- |
| 1 | 0.0–2.4 s | 0–72 | **Open on the sky.** Gradient, three cloud layers (blurred radial puffs + feTurbulence/feDisplacement edges, each drifting at its own speed), faint grid nodes, "Notary" wordmark. "No certificate, / no money *moves*." rises word by word (28 px, 2-frame stagger, 15 frames each); "moves" in the true italic; a soft darker ellipse keeps the white type AA. A slow upward drift keeps the camera alive. |
| — | 1.8–3.1 s | 54–88 | **The dive.** The sky lifts out of frame (1460 px), back and middle cloud layers at their own depth, the front cloud bank sweeping over everything at 1.5× (the camera passes through it); the white page rises into place underneath with its grid. |
| 2 | 2.3–4.4 s | 70–132 | **The problem.** "Without Notary, the agent trusts the docs." The naive run's money actions stream into a transcript card (15 rows in queue order, amounts as recorded; q05 goes out twice); red "Unsafe · wrong unit / duplicate" pills tick on as graded; the counter steps with each unsafe row and lands on the grader total (9). The dither chart grows the naive stacks per request type. Footnote: "Measured on Notary's evaluation suite". |
| 3a | 4.5–6.0 s | 134–180 | **Predict, then test.** Five-step bar enters; Read, then Test light. Reflector prediction card (probe p004, boundary sweep, `dodo.payments.page-size-max-100`, "If the docs hold, the call is rejected") is stamped "Committed 08:46:29 UTC"; the call `dodo.listPayments page_size=101` runs along a hairline; the observation card slides in (status 200, items 100) and the outcome row glows red: clamped, expected rejected → "Mismatch". |
| 3b | 6.0–7.3 s | 180–218 | **Challenge.** Reflector hypothesis card → dashed connector → Adversary counter-test card (both as recorded) → green "Survived 1 of 1 challenge". |
| 3c | 7.3–8.7 s | 218–260 | **Certify.** The featured certificate builds line by line (Dodo certificate, cert-9813c29f1f678661, `dodo.wallet.credit-amount-minor-units`, scope, 6 probes, issued Oct 10, 2026, sha256 seal) while the "NOTARIZED · NOTARY ·" seal spins in, stamps with a small overshoot and draws its check. |
| 4 | 8.7–11.4 s | 260–342 | **Enforce.** Guard rows land: plan change q12 → "Allowed" (1 required belief notarized); refund q03 · $19.99 → "Held for review" on a peach card with Approve / Reject (no certificate for `dodo.payments.page-size-max-100`). Stats: 9 unsafe without Notary (counts up) → 0 with Notary (lands on 0, no countdown) → 9 refunds held (counts up). The chart switches to "With Notary": naive stacks dissolve top-down through the dither threshold, amber held stacks rise; plan change stays allowed. |
| 5 | 11.4–13.3 s | 342–400 | **Notary Chat.** "Ask why. Get the records." The chat window glides up; question "What do the dodo certificates say?" in the accent-soft bubble; three lookups tick from spinner to blue check with their one-line results; the cited answer streams in word by word with its numbered chip; the source list settles. The landing's "Built with" credits sit on both sides, on slow orbits, dashed connectors drawing in. |
| 6 | 13.3–15.0 s | 400–450 | **Close.** The camera rises back into the sky (the page sinks, clouds sweep down). Dashed orbits draw around "Let your agent prove it first." (serif, word by word), then the "Notary" wordmark and `github.com/parthchilwerwar/notary`. Everything settles by frame 432; the last 0.6 s holds (poster frame). |

## Data

Every value on screen is in `src/data.json`, written by `scripts/props.ts` from
`packages/web/public` (bundles hash-verified, timelines tied to their bundle, certificate seals
recomputed, chat from the web's replay chat engine). The composition parses it with
`src/data-schema.ts` before rendering. Copy (headings, step sentences, labels) is the landing's.

## Commands

```
pnpm --filter @notary/showreel props    # rebuild src/data.json from the published records
pnpm --filter @notary/showreel studio   # Remotion Studio
pnpm --filter @notary/showreel still    # stills every 0.5 s → out/stills/ (or pass frame numbers)
pnpm --filter @notary/showreel render   # MP4 + poster → out/ and docs/media/
```

Rendering uses the installed Google Chrome (`CHROME_PATH` to override) in Remotion's
chrome-for-testing mode, and Remotion's own ffmpeg; no browser is ever downloaded.
