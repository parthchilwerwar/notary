# Notary showreel v2 — storyboard and cue sheet

15.0 s · 30 fps (450 frames) · 1920×1080 · H.264 + AAC. Frames live in `src/v2/timeline.ts`
(120 BPM grid: one beat = 15 frames), sounds in `src/v2/cues.ts`. v1 (no sound, lookalike cards)
is kept as `docs/media/notary-showreel-v1.mp4`.

## Idea

The product shows itself. A pointer clicks "Open dashboard" in the landing hero, the camera dives
through the clouds into the real dashboard (the web app's own components, rendered read-only from
`packages/web/src`), plays the proof with the landing's How it works pieces, returns to the
dashboard for the run with Notary, opens Notary Chat and types a question, then rises back into the
sky. Every number and record is from `src/data.json` (scripts/props.ts, hash-verified records).

## Components (real, imported read-only)

BrowserFrame, SkyBand (+ its Clouds), Page/PageBody, StatRow/Stat, Card, WashCard, Button,
StatusPill, AgentBadge, CertificateCard, Seal, DitherCanvas/DitherSwatch + ActionsChart FILLS, the
Run page's TranscriptRow and .run-held card styling, Notary Chat's UserMessage + MessageView with
reduceChatEvents, navRoutes() for the sidebar, the shell/run/chat/landing/kit CSS. The film draws
only what has no exported component: the sidebar markup (shell.css classes), the Run stage bar
(RunPage markup), the chat composer (chat.css classes), the How it works layout (landing .h-*
classes) and the pointer.

## Beats

| Time | Frames | Picture | Pointer |
| --- | --- | --- | --- |
| 0.0–1.7 s | 0–50 | Sky, three drifting cloud layers, "No certificate, / no money *moves*." word by word, hero actions | Enters (20), glides to "Open dashboard", hover, click (46) |
| 1.7–2.9 s | 50–88 | Dive through the clouds; the browser frame rises from depth (rotateX 32° → 0) | — |
| 2.9–4.9 s | 88–146 | Run page, agent without Notary: 20 transcript rows stream (unsafe ones red), Actions processed / Unsafe actions count with them, camera pushes in to 1.5× | — |
| 4.9–6.5 s | 146–196 | Page recedes; five-step bar; Predict, then test: Reflector prediction stamped "Committed 08:46:29 UTC", `dodo.listPayments page_size=101`, observation slides in, outcome glows → Mismatch | — |
| 6.5–7.6 s | 196–228 | Challenge: Reflector hypothesis → Adversary counter-test → "Survived 1 of 1 challenge" | — |
| 7.6–8.7 s | 228–262 | Certify: CertificateCard for `dodo.subscription.change-plan-pending-409` + the seal spinning in and stamping | — |
| 8.7–9.7 s | 262–292 | The certificate flies (arc, shrink, shadow) onto the row it covers in the run with Notary: plan change q12, "Covered by certificate …" | — |
| 9.7–10.5 s | 292–314 | Transcript scrolls up to refund q03, held — no certificate for `dodo.payments.page-size-max-100` (the claim the prediction broke) | Glides to the row, click (306): card lifts and focuses; hovers "Approve…" (312) |
| 10.5–11.5 s | 314–344 | Camera steps back; chart card in front, labelled "Without Notary" while the red stacks un-reveal row by row (318–328); only once no red row is left does it switch to "With Notary" as the amber held stacks rise (328–338). Unsafe 0 / Refunds held 9 | Leaves for the sidebar |
| 11.5–13.5 s | 344–404 | Click "Chat" (348) → Notary Chat page; question typed char by char (358–376); send (380); three lookups tick to checks, cited answer streams | Click Chat, click composer (356), click send (380), drifts off |
| 13.5–15.0 s | 404–450 | Camera rises into the sky; dashed orbits draw; "Let your agent prove it first."; "Notary"; GitHub URL; still from 434 | — |

## Audio

All synthesized by `scripts/audio.ts` (no samples): music bed at 120 BPM in D major — pads
(Dmaj9 · Bm9 · Gmaj7 · Asus2 · Bm11 · Gmaj9 · Asus4 → Dmaj9), Karplus–Strong arpeggio with a
ping-pong delay, sine bass, hats from beat 12, a noise riser into the payoff, kick from beat 18
(frame 270 = Enforce), everything resolving at beat 27 (frame 405 = the close) with the last tail
fading to 0 at 15.0 s; Schroeder reverb; −14 LUFS-ish, peak ≤ −1 dBFS. The music ducks 2.5 dB
under each cue. Effects: click (press + release), move, type, pop, tick, blip, whoosh, dive,
stamp, two-note chime, confirm.

### Cue sheet (frame → sound)

| Frame | Sound | Moment |
| --- | --- | --- |
| 20 | move | pointer enters |
| 46 | click | Open dashboard |
| 48 | dive | camera dives through the clouds |
| 96–134 | tick ×11 / blip ×9 | each transcript row; blip on every graded-unsafe one |
| 144 | whoosh | page recedes into the proof |
| 160 / 161 | stamp / pop | prediction committed |
| 176 | blip | Mismatch |
| 194, 226 | whoosh | to Challenge, to Certify |
| 210 | chime | Survived 1 of 1 challenge |
| 238 | stamp | seal stamps |
| 262 | whoosh | certificate flies |
| 276 | pop | Refunds held counter |
| 290 | chime | certificate lands: covered, allowed |
| 292 / 306 / 307 | move / click / confirm | to the held refund, click, card focused |
| 312 | pop | hover Approve… |
| 314 / 328 | whoosh / pop | chart card in / held stacks rise |
| 322 / 348 | move / click | to the sidebar, click Chat |
| 350 | whoosh | Chat page |
| 356 | click | composer |
| 359–376 | type ×18 | the question, character by character |
| 380 | click | Send |
| 385, 389, 393 | tick | each lookup done |
| 409 | chime | cited answer (as the camera rises) |
| 402 | dive | camera rises to the sky |
| 414 | pop | wordmark |

## Commands

```
pnpm --filter @notary/showreel props          # src/data.json from the published records
pnpm --filter @notary/showreel audio          # public/audio/*.wav + offline mix loudness
pnpm --filter @notary/showreel still [frames] # stills → out/stills/
pnpm --filter @notary/showreel still --check-chart # every morph frame: fails if "With Notary" shows next to red pixels
pnpm --filter @notary/showreel render         # audio + MP4 (H.264/AAC) + poster → docs/media/
pnpm --filter @notary/showreel verify-audio   # streams + loudness of docs/media/notary-showreel.mp4
```
