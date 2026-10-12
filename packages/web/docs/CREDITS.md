# Component credits

All files below were selected by browsing the UIAble collection on
[21st.dev](https://preview.21st.dev/@uiable/library/uiable), inspected, and installed
with the **shadcn CLI 4.21.4** using their public registry URLs. Installation ran in
`packages/web/registry-stage` to preserve the existing dashboard primitives.
The registry files remain there as ignored local review material. The adapted
components are committed under `src/components/landing`.

Each selected item belongs to [CodedThemes/UIAble](https://github.com/codedthemes/uiable).
The publisher's [MIT license](https://github.com/codedthemes/uiable/blob/master/LICENSE)
was checked for each item against its source paths. Copyright (c) 2026 CodedThemes.
The full required notice is preserved in [LICENSE-uiable.txt](LICENSE-uiable.txt).
Source paths, registry dependencies and registry URLs are recorded in
[registry-sources.json](registry-sources.json).

| Section          | Installed component / source URL                                                                                                           | Adapted file      | License |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------- |
| Hero             | [Hero 3](https://uiable.com/r/block-hero-3.json)                                                                                           | Hero.tsx          | MIT     |
| Problem bento    | [Financial Bento Grid](https://uiable.com/r/block-bento-5.json), [21st.dev listing](https://mcp.21st.dev/@uiable/components/block-bento-5) | ProblemBento.tsx  | MIT     |
| Numbered process | [Process 1](https://uiable.com/r/block-process-1.json)                                                                                     | ProcessSteps.tsx  | MIT     |
| Results strip    | [Statistics 1](https://uiable.com/r/block-statistics-1.json)                                                                               | ResultsStrip.tsx  | MIT     |
| CTA              | [CTA 1](https://uiable.com/r/block-cta-1.json)                                                                                             | FinalCTA.tsx      | MIT     |
| Footer           | [Footer 2](https://uiable.com/r/block-footer-2.json)                                                                                       | LandingFooter.tsx | MIT     |

These are substantial adaptations, not unchanged drop-ins. Responsive section
composition, card groupings, process connectors, statistic columns, CTA and footer
organization informed the final components. Sample business figures, unrelated
images, sponsor marks, contact forms, carousel/counting animations and decorative
icons were removed. Notary's Geist type, warm neutral tokens, blue accent, rounded
cards, shadcn Button/Card and real bundle/evidence data replace the defaults.
No borrowed image assets are shipped. No unverified live claims are added.

The only new runtime dependency retained is `react-router` **8.4.0**, pinned
exactly. The development runner `tsx` **4.23.15** is also pinned exactly and lets the visual checks reuse the shared TypeScript hash function. Registry-only dependencies are confined to the ignored installation
staging directory and are not shipped. Existing dependency ranges are unchanged.

Installation command (from packages/web):

```powershell
npm exec --yes --package=shadcn@4.21.4 -- shadcn add https://uiable.com/r/block-hero-3.json https://uiable.com/r/block-bento-5.json https://uiable.com/r/block-process-1.json https://uiable.com/r/block-statistics-1.json https://uiable.com/r/block-cta-1.json https://uiable.com/r/block-footer-2.json --cwd registry-stage --yes
```

The numbered process markers are structural step positions requested by the user,
not product statistics. The supplied hero anecdote includes its requested HTTP
status. All measured result values come from verified bundles, and tool copy and
status come from public/evidence/evidence.json. Fixture results include both the
persistent AGENTS.md disclosure and the requested planted-quirks label.

## U6 — Dither Kit

Graphs and the blue card wash use actual [Dither Kit](https://www.tripwire.sh/dither-kit)
source, installed with shadcn CLI 4.21.4 from these publisher registry URLs:

- https://www.tripwire.sh/r/core.json
- https://www.tripwire.sh/r/bar-chart.json
- https://www.tripwire.sh/r/area-chart.json
- https://www.tripwire.sh/r/gradient.json

Publisher: Boring Software, Inc. / ripgrim. License: **MIT**, declared in the
publisher's [registry-core package metadata](https://github.com/Boring-Software-Inc/dither-kit/blob/main/packages/registry-core/package.json)
and [published core package](https://www.npmjs.com/package/@dither-kit/core).
The registry's original source and comments are retained under
`src/components/dither-kit`. These source files were adapted to Notary: blue
palette, explicit observed axis ticks, step sampling for recorded line trends,
no decorative stars, and data receipts with unknown values preserved. Canvas
fills are decorative; measured values remain available as text and accessible
chart descriptions. Gradients use a static blue wash over a dark blue surface.
The Dither Kit docs credit Evil Charts as the original visual inspiration.

New dependencies are exact: motion 14.1.0, d3-scale 4.0.2, d3-shape 3.2.0,
@types/d3-scale 4.0.9 and @types/d3-shape 3.2.0. Recharts was removed after the
chart replacement. Select controls retain native keyboard/touch behavior and use
the existing Phosphor icon library; no additional icon dependency was added.

## Hook Sidebar (Rare UI)

The guide's table of contents (`/docs`) and the dashboard's left navigation use Rare UI's
[Hook Sidebar](https://www.rareui.com/components/hooksidebar), ported from its source.

| Component    | Source URL                                                                                                                            | Adapted file                         | License                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| Hook Sidebar | [rare-ui/components/ui/hook-sidebar.tsx](https://github.com/swamimalode07/rare-ui/blob/main/components/ui/hook-sidebar.tsx) | src/components/ui/hook-sidebar.tsx   | MIT + Commons Clause License Condition v1.0 + Attribution |
| Hook Sidebar (Run transcript event rail) | [rareui.com/components/hooksidebar](https://www.rareui.com/components/hooksidebar) | used unmodified by src/pages/run/Transcript.tsx (one rail per stage; visible "Event rail: Hook Sidebar by Rare UI" credit linking rareui.com under the transcript) | MIT + Commons Clause License Condition v1.0 + Attribution |

Copyright (c) 2026 Swami Malode. The copyright and permission notice are kept in the header of the
adapted file, and the required visible credit ("Sidebar component by Rare UI", linking to
[rareui.com](https://rareui.com)) is shown at the bottom of the `/docs` sidebar and content
column. The Commons Clause forbids selling or redistributing the component itself; Notary only
ships it as part of the app. Adaptations: react-router instead of `next/link`/`usePathname`,
in-page `#id` items driven by the page's controlled `value`/`onChange`, an `as="div"` group mode,
item badges, and Notary token colors (muted inactive rows, ink active rows, accent rail). The
motion springs and reduced-motion handling are unchanged. New dependency: `motion` **13.4.6**,
pinned exactly.
