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
