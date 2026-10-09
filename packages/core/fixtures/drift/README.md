# Drift fixtures — deliberately altered recordings

**Every file in this directory is a DRIFT FIXTURE, not real traffic.** Each one is a copy of a real
recorded cassette from `../cassettes/` with exactly **one** response field changed on purpose, to
simulate a tool changing its behavior (TDD "Drift fixture", PRD FR-16). Replaying one must lower the
affected belief's confidence until it reaches `unlearned` and its guard retires.

How a fixture is made (never by hand):

```sh
pnpm --filter @notary/core make:drift --from <cassette name> \
  --exchange <requestHash>[:occurrence] --set '<jsonPath>=<json value>' --out <name>
```

- `--from` must name a real cassette in `fixtures/cassettes/`; the script refuses (BLOCKED, exit 3)
  when it does not exist, and refuses to copy another drift fixture.
- `--set` changes one existing field of that exchange's response: `$.items[0].amount=1234` (response
  body) or `$status=200` (HTTP status). A value equal to the recorded one is refused.
- The fixture's `contentHash` is recomputed over the altered exchanges, so the cassette loader
  verifies it like any other cassette.
- Each file carries a top-level `drift` block — `source`, `sourceContentHash`, `exchange`, `path`,
  `before`, `after` and `note: "DRIFT FIXTURE — one response deliberately altered to simulate a tool
  behavior change"` — so the alteration is always disclosed next to the data. Any bundle produced
  from a drift replay must repeat that disclosure.

Status: no fixture exists yet, because no real cassette has been recorded (no API keys in this
environment). The un-learning path is covered by `test/drift.test.ts` on a temporary, clearly
test-only cassette.
