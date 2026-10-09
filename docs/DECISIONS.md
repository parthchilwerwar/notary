# Decisions

Where the docs and reality disagree, or a choice the docs leave open. Newest phase last.

## P0 · Scaffold

| # | Docs say | Reality / decision | Why |
| --- | --- | --- | --- |
| 1 | Node 22 LTS (TDD "Stack") | Built and tested on Node 24.14.1; `engines.node` is `>=22` | The machine has Node 24. The TDD's reason for 22 is `neatlogs-cli`, which supports 22 and 24. |
| 2 | — | No `dotenv`; the CLI loads `.env` with Node's built-in `process.loadEnvFile()` | `dotenv@18` was younger than pnpm's minimum release age; the built-in does the same job with no dependency. |
| 3 | — | TypeScript pinned to `~5.9.3` | npm `latest` is TS 7 (native port); 5.9 is the stable line the rest of the toolchain targets. |
| 4 | Guard `kind`: block, transform, require-param, retry-policy (TDD "Data model") | Schema uses `transform, require_param, precheck, retry_policy, paginate_fully, block` | TDD "Queue execution and guards" lists the fuller set; the data-model table is a subset with different casing. |
| 5 | `entire enable` at P0 | Entire CLI was not installed on the build machine at P0, so no Entire checkpoint on the P0 commit | Must be installed and enabled before P1 (`entire enable`). |
| 6 | neatlogs `init`, `span`, `trace`, `log` (TDD "Integrations") | All exist in `neatlogs` 1.1.26, but per-span metadata only works through `trace({ attributes })`; `span()` ignores `metadata`/`tags`; `init({ metadata })` never reaches spans, so `withSpan` stamps `notary.runId` itself; `log()` needs `init({ captureLogs: true })`; flushing is `flush()` / `shutdown()` | Read from the SDK's README and shipped code; full notes in `packages/core/src/trace/index.ts` |
| 7 | — | `neatlogs` resolved to 1.1.26, not 1.1.28 | 1.1.27/1.1.28 were under a day old and held back by pnpm's minimum release age |
| 8 | — | `protobufjs` build scripts disabled in `pnpm-workspace.yaml` | Its postinstall only prints a version warning; nothing depends on it |
