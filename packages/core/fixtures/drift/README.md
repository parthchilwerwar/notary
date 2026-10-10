# Drift fixtures — deliberately rewritten recordings

**Every file in this directory is a DRIFT FIXTURE, not real traffic.** Each one is a copy of a real
recorded cassette from `../cassettes/` with responses changed on purpose, to simulate a tool changing
its behavior (TDD "Drift fixture", PRD FR-16, audit A-16).

How a fixture is made (never by hand):

```sh
# Behavior rewrite: every exchange of the op changes the same way, like a real API change.
pnpm --filter @notary/core make:drift --from <cassette name> --op <opName> \
  [--match '<jsonPath>=<json>'] --set '<jsonPath>=<json | x<k> | div<k>>' --out <name>
#   e.g. --op dodo.createRefund --set '$.amount=x100'

# One exchange (legacy; rarely un-learns anything, see below):
pnpm --filter @notary/core make:drift --from <cassette name> \
  --exchange <requestHash>[:occurrence] --set '<jsonPath>=<value>' --out <name>
```

- `--from` must name a real cassette in `fixtures/cassettes/`; the script refuses (BLOCKED, exit 3)
  when it does not exist, and refuses to copy another drift fixture.
- `--set` names a response field: `$.items[0].amount` (response body) or `$status` (HTTP status). The
  value is JSON (sets the field) or `x<k>` / `div<k>` (multiplies / divides a numeric field).
- `--match` narrows `--op` to calls where a path equals a JSON value: request body by default
  (`$.price.price` or `$request.price.price`), `$response.<path>` for the response, or `$status`.
- Matching exchanges where the field is missing, not numeric for `x`/`div`, or already equal are left
  unchanged and listed under `skipped`. A rewrite that changes zero exchanges is refused (exit 1).
- The fixture's `contentHash` is recomputed over the rewritten exchanges, so the cassette loader
  verifies it like any other cassette.
- Each file carries a top-level `drift` block — `source`, `sourceContentHash`, `op` / `match` (or
  `exchange`), `path`, `transform`, `changed` (every changed exchange as `requestHash:occurrence` with
  `before` / `after`), `skipped`, and a `note` that starts with "DRIFT FIXTURE" — so the alteration is
  always disclosed next to the data. Any bundle produced from a drift replay must repeat that
  disclosure.

`pnpm notary replay --drift <name>` re-runs the recorded probes that were served a changed exchange.
Each distinct probe design (BeliefStore's independence fingerprint) adds at most one observation;
replicates of a design are not re-counted. A belief un-learns only when enough distinct designs
disagree to cross 0.5. Otherwise the command reports "not un-learned: only N distinct designs observed
the change" and exits 1.

Status: no fixture exists yet, because no real cassette has been recorded (no API keys in this
environment). The un-learning path is covered by `test/drift.test.ts` on a temporary, clearly
test-only cassette.
