/**
 * Make a drift fixture (TDD "Drift fixture", PRD FR-16, audit A-16) from a REAL recorded cassette.
 *
 * Behavior rewrite (every exchange of the op changes the same way, like a real API change):
 *   pnpm --filter @notary/core make:drift --from <cassette name> --op <opName> \
 *     [--match '<jsonPath>=<json>'] --set '<jsonPath>=<json | x<k> | div<k>>' --out <name> [--force]
 *   e.g. --op dodo.createRefund --set '$.amount=x100'   (every createRefund echo is now x100)
 *
 * One exchange (legacy; rarely un-learns anything, since replicates count once):
 *   ... --exchange <requestHash>[:occurrence] --set '<jsonPath>=<value>' --out <name>
 *
 * Copies packages/core/fixtures/cassettes/<from>.json to packages/core/fixtures/drift/<out>.json
 * with the response field rewritten, the content hash recomputed, and a top-level `drift`
 * disclosure (source, op, match, path, transform, every changed exchange with before/after, skipped
 * exchanges with the reason, note). `--set` paths go into the response body ("$.items[0].amount")
 * or "$status"; `--match` paths go into the request body by default, "$response.<path>" into the
 * response. Refuses when the source cassette does not exist (exit 3, BLOCKED): a drift fixture is
 * never made from anything but real recorded traffic. Refuses (exit 1) a rewrite that changes zero
 * exchanges. Optional --cassette-dir / --drift-dir override the default directories.
 */
import { parseArgs } from "node:util";
import { DriftFixtureError, makeDriftFixture, parseMatchArg, parseSetArg } from "../src/tools/drift-fixture.js";

const USAGE = [
  "usage: make:drift --from <cassette> --op <opName> [--match <jsonPath>=<json>] --set <jsonPath>=<json|x100|div100> --out <name>",
  "       make:drift --from <cassette> --exchange <requestHash>[:occurrence] --set <jsonPath>=<json|x100|div100> --out <name>",
];

function main(): number {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      op: { type: "string" },
      match: { type: "string" },
      exchange: { type: "string" },
      set: { type: "string" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      "cassette-dir": { type: "string" },
      "drift-dir": { type: "string" },
    },
    allowPositionals: false,
  });
  const missing = (["from", "set", "out"] as const).filter((k) => !values[k]);
  if (missing.length || (!values.op && !values.exchange)) {
    console.error(`make:drift needs ${[...missing.map((m) => `--${m}`), ...(!values.op && !values.exchange ? ["--op or --exchange"] : [])].join(", ")}`);
    for (const u of USAGE) console.error(u);
    return 1;
  }
  try {
    const { path, transform } = parseSetArg(values.set!);
    const res = makeDriftFixture({
      from: values.from!,
      ...(values.op ? { op: values.op } : {}),
      ...(values.match ? { match: parseMatchArg(values.match) } : {}),
      ...(values.exchange ? { exchange: values.exchange } : {}),
      path,
      transform,
      out: values.out!,
      force: values.force === true,
      ...(values["cassette-dir"] ? { cassetteDir: values["cassette-dir"] } : {}),
      ...(values["drift-dir"] ? { driftDir: values["drift-dir"] } : {}),
    });
    const d = res.fixture.drift;
    console.log(`drift fixture written: ${res.path}`);
    console.log(`  source ${d.source} (sha ${d.sourceContentHash.slice(0, 12)})`);
    console.log(`  ${d.op ? `op ${d.op}${d.match ? ` where ${d.match.path} = ${JSON.stringify(d.match.value)}` : ""}` : `exchange ${d.exchange}`}: ${d.path} ${d.transform}`);
    for (const c of d.changed) console.log(`  changed ${c.exchange.slice(0, 12)}…:${c.exchange.split(":")[1]} ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`);
    for (const s of d.skipped) console.log(`  skipped ${s.exchange.slice(0, 12)}…:${s.exchange.split(":")[1]} (${s.reason})`);
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
