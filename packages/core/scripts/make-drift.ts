/**
 * Make a drift fixture (TDD "Drift fixture", PRD FR-16) from a REAL recorded cassette:
 *
 *   pnpm --filter @notary/core make:drift --from <cassette name> \
 *     --exchange <requestHash>[:occurrence] --set '<jsonPath>=<json value>' --out <name> [--force]
 *
 * Copies packages/core/fixtures/cassettes/<from>.json to packages/core/fixtures/drift/<out>.json
 * with exactly one response field changed, the content hash recomputed, and a top-level `drift`
 * disclosure (source, exchange, path, before, after, note). Paths: "$.items[0].amount" into the
 * response body, or "$status" for the HTTP status. Refuses when the source cassette does not exist
 * (exit 3, BLOCKED): a drift fixture is never made from anything but real recorded traffic.
 * Optional --cassette-dir / --drift-dir override the default directories.
 */
import { parseArgs } from "node:util";
import { DriftFixtureError, makeDriftFixture, parseAssignment } from "../src/tools/drift-fixture.js";

function main(): number {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      exchange: { type: "string" },
      set: { type: "string" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      "cassette-dir": { type: "string" },
      "drift-dir": { type: "string" },
    },
    allowPositionals: false,
  });
  const missing = (["from", "exchange", "set", "out"] as const).filter((k) => !values[k]);
  if (missing.length) {
    console.error(`make:drift needs ${missing.map((m) => `--${m}`).join(", ")}`);
    console.error("usage: make:drift --from <cassette> --exchange <requestHash>[:occurrence] --set <jsonPath>=<json> --out <name>");
    return 1;
  }
  try {
    const { path, value } = parseAssignment(values.set!);
    const res = makeDriftFixture({
      from: values.from!,
      exchange: values.exchange!,
      path,
      value,
      out: values.out!,
      force: values.force === true,
      ...(values["cassette-dir"] ? { cassetteDir: values["cassette-dir"] } : {}),
      ...(values["drift-dir"] ? { driftDir: values["drift-dir"] } : {}),
    });
    const d = res.fixture.drift;
    console.log(`drift fixture written: ${res.path}`);
    console.log(`  source ${d.source} (sha ${d.sourceContentHash.slice(0, 12)}), exchange ${d.exchange}`);
    console.log(`  ${d.path}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
    console.log(`  contentHash ${res.fixture.contentHash}`);
    console.log(`  ${d.note}`);
    return 0;
  } catch (err) {
    if (err instanceof DriftFixtureError) {
      console.error(err.message);
      return err.blocked ? 3 : 1;
    }
    throw err;
  }
}

process.exitCode = main();
