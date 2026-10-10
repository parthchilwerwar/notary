# Codex dashboard session rules

- Work only in `packages/web`. Never edit `packages/core`.
- Import types from `packages/core/src/schema` and the hash function from `packages/core/src/bundle/hash.ts`; never redefine them, and import nothing else from core.
- Every number on screen comes from a bundle or `public/evidence/evidence.json`. No hardcoded values.
- Bundles with `sample: true` are fixture data. They always show a visible **Fixture data — simulated APIs, not a live run** banner and are never mixed with live bundles in one chart or table.
- Recompute each bundle's content hash in the browser; on a mismatch, show a visible error instead of the data.
- One phase per session; commit at the end of each phase with the message `U<n>: <summary>`.
