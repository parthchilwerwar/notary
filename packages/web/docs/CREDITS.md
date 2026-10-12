# Credits

Third-party code and assets shipped by `packages/web`. Versions are the pins in
`packages/web/package.json`; licenses are the `license` field of each installed package.

## Hook Sidebar (Rare UI)

The guide's table of contents (`/docs`), the dashboard's left navigation and the Run page's
transcript event rail use Rare UI's [Hook Sidebar](https://www.rareui.com/components/hooksidebar),
ported from its source.

| Component    | Source URL                                                                                                                  | Adapted file                       | License                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| Hook Sidebar | [rare-ui/components/ui/hook-sidebar.tsx](https://github.com/swamimalode07/rare-ui/blob/main/components/ui/hook-sidebar.tsx) | src/components/ui/hook-sidebar.tsx | MIT + Commons Clause License Condition v1.0 + Attribution |

Where it is used: `src/docs/DocsPage.tsx` (one group per guide section, plus the phone
"Contents" copy), `src/components/shell/Sidebar.tsx` (the six pages and the Report link) and
`src/pages/run/Transcript.tsx` (one rail per stage).

Copyright (c) 2026 Swami Malode. The copyright and permission notice are kept in the header of the
adapted file. The required visible credit links [rareui.com](https://rareui.com): "Sidebar
component by Rare UI" at the bottom of the `/docs` sidebar and content column, and "Event rail:
Hook Sidebar by Rare UI" under the Run transcript. The Commons Clause forbids selling or
redistributing the component itself; Notary only ships it as part of the app. Adaptations:
react-router instead of `next/link`/`usePathname`, in-page `#id` items driven by the page's
controlled `value`/`onChange`, an `as="div"` group mode, item badges, `useId()`-based label ids (so
several sidebars on one page never share an id), and Notary token colors (muted inactive rows, ink
active rows, accent rail). The motion springs and reduced-motion handling are unchanged. It needs
`motion` **13.4.6**, pinned exactly.

## Reasoning Steps

`src/components/ui/reasoning-steps.tsx` is an original Notary component. Its public API mirrors
Kobra's "Reasoning Steps", whose source is paid and was never read or copied (DECISIONS #196). It is
built on `motion`.

## Runtime libraries

| Package                                                     | Version  | License                                                                    | Used for                                                    |
| ----------------------------------------------------------- | -------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [react](https://react.dev), react-dom                       | ^19.3.0  | MIT                                                                        | UI                                                          |
| [react-router](https://reactrouter.com)                     | 8.4.0    | MIT                                                                        | Routing                                                     |
| [gsap](https://gsap.com)                                    | 3.15.0   | GSAP Standard "no charge" license (https://gsap.com/standard-license)      | Landing motion (SplitText hero, scroll reveals)             |
| [@gsap/react](https://gsap.com/resources/React)             | 2.1.2    | GSAP Standard license (https://gsap.com/standard-license)                  | `useGSAP` cleanup                                           |
| [motion](https://motion.dev)                                | 13.4.6   | MIT                                                                        | Hook Sidebar rail springs, Reasoning Steps                  |
| [@phosphor-icons/react](https://phosphoricons.com)          | ^2.1.10  | MIT                                                                        | Icons                                                       |
| [cmdk](https://cmdk.paco.me)                                | 1.1.1    | MIT                                                                        | Command palette                                             |
| [sonner](https://sonner.emilkowal.ski)                      | 2.0.8    | MIT                                                                        | Toasts                                                      |
| [@radix-ui/react-slot](https://www.radix-ui.com)            | ^1.4.0   | MIT                                                                        | `asChild` on Button                                         |
| [clsx](https://github.com/lukeed/clsx), [tailwind-merge](https://github.com/dcastil/tailwind-merge) | ^2.1.1, ^3.7.0 | MIT                                       | Class names (`cn`)                                          |
| [zod](https://zod.dev)                                      | ^4.6.5   | MIT                                                                        | Bundle schema validation (shared with `packages/core`)      |
| [@fontsource/instrument-serif](https://fontsource.org/fonts/instrument-serif) | 5.3.0 | OFL-1.1                                                      | Display type                                                |
| [@fontsource-variable/instrument-sans](https://fontsource.org/fonts/instrument-sans) | 5.3.0 | OFL-1.1                                               | Body type                                                   |

Development only: `tsx` **4.23.15** (pinned exactly) lets the visual checks reuse the shared
TypeScript hash function; `@playwright/test` drives the visual check and screenshot scripts with the
system Chrome.

The dither charts on the landing (`src/components/brand/dither.ts`, `DitherCanvas.tsx`) are an
original Bayer-matrix renderer, not third-party code.

## Removed

Earlier iterations credited six [UIAble](https://github.com/codedthemes/uiable) landing blocks
(MIT, CodedThemes) and [Dither Kit](https://www.tripwire.sh/dither-kit) chart source (MIT) together
with `d3-scale`, `d3-shape` and `recharts`. The landing was rewritten from scratch in R4 and that
code and those dependencies were removed then, so none of it ships today. `docs/LICENSE-uiable.txt`
and `docs/registry-sources.json` are kept only as the historical record of that installation.
