// `notary export` (P8). Every bundle here is TEST DATA built in this file with finalizeBundle and
// written to a temp dir; none of it is a Notary result.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSampleBundle, finalizeBundle, writeBundle } from "../src/bundle/index.js";
import { crustdataContract, dodoContract } from "../src/contracts/index.js";
import { collectBundles, commandFor, runExport, UNVERIFIED } from "../src/export/index.js";
import type { CheckResult } from "../src/export/index.js";
import { BundleIndexSchema } from "../src/schema/bundle.js";
import type { Belief, Guard, RunBundle } from "../src/schema/index.js";

const ZERO = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
const TEST = "TEST bundle built in test/export.test.ts — not a Notary result";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "notary-export-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Over = Partial<Omit<RunBundle, "contentHash">>;

function testBundle(runId: string, over: Over): RunBundle {
  return finalizeBundle({
    runId,
    kind: "run",
    variant: "guarded",
    mode: "live",
    sample: false,
    disclosure: [TEST],
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: "2026-10-11T10:05:00.000Z",
    status: "completed",
    seed: 0,
    queue: [],
    decisions: [],
    claims: [],
    anomalies: [],
    hypotheses: [],
    probes: [],
    beliefs: { before: [], after: [] },
    beliefEvents: [],
    guards: [],
    usageByRole: { executor: ZERO, reflector: ZERO, adversary: ZERO },
    credits: { byEndpoint: {}, total: 0, budget: 0 },
    metrics: {},
    traceLinks: {},
    cassettes: [],
    ...over,
  });
}

const notarizedClaim = dodoContract[0]!.claim;
const otherDodoClaim = dodoContract[1]!.claim;

const notarizedBelief: Belief = {
  id: `belief-${notarizedClaim.id}`,
  claimId: notarizedClaim.id,
  tool: "dodo",
  class: "silent_truncation",
  statement: `Doc claim violated (silent_truncation): ${notarizedClaim.operation} — test statement`,
  alpha: 1,
  beta: 4,
  confidence: 0.0625,
  status: "notarized",
  evidence: [
    { probeId: "probe-test-a", traceId: "trace-test-a", valid: true },
    { probeId: "probe-test-b", traceId: "trace-test-b", valid: true },
  ],
  adversary: { verdict: "narrow", reason: "test reason", model: "test-model", backend: "bedrock", scope: "test scope" },
  updatedAt: "2026-10-11T09:00:00.000Z",
};

const candidateBelief: Belief = {
  ...notarizedBelief,
  id: `belief-${otherDodoClaim.id}`,
  claimId: otherDodoClaim.id,
  statement: "Doc claim holds: test",
  alpha: 4,
  beta: 1,
  confidence: 0.9375,
  status: "candidate",
  evidence: [],
  adversary: undefined,
};
delete (candidateBelief as Partial<Belief>).adversary;

const guards: Guard[] = [
  {
    id: "guard-test-retired",
    beliefId: notarizedBelief.id,
    operation: notarizedClaim.operation,
    kind: "paginate_fully",
    class: "silent_truncation",
    rule: {},
    reason: "test retired guard",
    active: false,
    compiledAt: "2026-10-11T08:00:00.000Z",
    retiredAt: "2026-10-11T08:30:00.000Z",
  },
  {
    id: "guard-test-active",
    beliefId: notarizedBelief.id,
    operation: notarizedClaim.operation,
    kind: "paginate_fully",
    class: "silent_truncation",
    rule: {},
    reason: "test active guard",
    active: true,
    compiledAt: "2026-10-11T09:00:00.000Z",
  },
];

function fixtures() {
  const naive = testBundle("test-naive-1", {
    variant: "naive",
    startedAt: "2026-10-11T10:00:00.000Z",
    disclosure: [TEST, "Seeded queue: fixtures/queue/seeded.json (SEEDED FIXTURE)"],
    metrics: { unsafe_actions_total: 3, decision_accuracy: 0.65, automation_rate: 0.55, holds: null },
    credits: { byEndpoint: { "GET /x": 37 }, total: 37, budget: 500 },
    usageByRole: { executor: { ...ZERO, usd: 0.0123 }, reflector: ZERO, adversary: ZERO },
  });
  const guarded = testBundle("test-guarded-1", {
    startedAt: "2026-10-11T11:00:00.000Z",
    disclosure: [TEST, "Seeded queue: fixtures/queue/seeded.json (SEEDED FIXTURE)"],
    metrics: { unsafe_actions_total: 0, decision_accuracy: 0.6, automation_rate: 0.45, holds: 4 },
    noiseFloor: { decision_accuracy: 0.01, automation_rate: 0.2 },
    credits: { byEndpoint: { "GET /x": 29 }, total: 29, budget: 500 },
  });
  const notarize = testBundle("notarize-dodo-test", {
    kind: "notarize",
    variant: "notarize",
    tool: "dodo",
    startedAt: "2026-10-11T09:00:00.000Z",
    claims: [notarizedClaim, otherDodoClaim],
    beliefs: { before: [], after: [notarizedBelief, candidateBelief] },
    guards,
    metrics: { claims: 2, "beliefs.notarized": 1, probes_to_candidate_mean: null },
  });
  const compare = testBundle("compare-priors-dodo-test", {
    kind: "notarize",
    variant: "notarize",
    mode: "replay",
    tool: "dodo",
    priorsFrom: "crustdata",
    // compare-priors bundles set replayOf (the recording run); they are measurements, not reproductions.
    replayOf: "notarize-dodo-test",
    startedAt: "2026-10-11T09:30:00.000Z",
    metrics: { probes_to_candidate_without_priors: 4, probes_to_candidate_with_priors: 5 },
  });
  return { naive, guarded, notarize, compare };
}

function put(runsDir: string, b: unknown, runId: string): void {
  mkdirSync(join(runsDir, runId), { recursive: true });
  writeFileSync(join(runsDir, runId, `${runId}.json`), JSON.stringify(b, null, 2));
}

async function setup(opts: { empty?: boolean; checks?: CheckResult[] | null } = {}) {
  const root = tempDir();
  const runsDir = join(root, "runs");
  const web = join(root, "web");
  mkdirSync(runsDir, { recursive: true });
  // The dashboard already has the SAMPLE bundle; export must never remove it.
  await writeBundle(buildSampleBundle(42), web);
  const f = fixtures();
  if (!opts.empty) {
    for (const b of Object.values(f)) put(runsDir, b, b.runId);
    // A sample bundle in runs/ (schema- and hash-valid) must be excluded, never used.
    const sample = buildSampleBundle(7);
    put(runsDir, sample, sample.runId);
    // A tampered bundle: a metric edited after the hash was taken.
    const tampered = { ...testBundle("test-tampered", { metrics: { unsafe_actions_total: 0 } }) };
    tampered.metrics = { unsafe_actions_total: 4242.4242 };
    put(runsDir, tampered, "test-tampered");
  }
  const checks = opts.checks === undefined ? null : opts.checks;
  const result = await runExport({
    runsDir,
    exportDir: join(root, "export"),
    docsDir: join(root, "docs"),
    webBundlesDir: web,
    driftDir: join(root, "drift"),
    checks: checks === null ? null : async () => checks,
    now: () => new Date("2026-10-11T12:00:00.000Z"),
  });
  const read = (p: string): string => readFileSync(join(root, p), "utf8");
  return { root, runsDir, web, f, result, read };
}

/** Every number a bundle carries in metrics, noiseFloor, credits or usageByRole. */
function bundleNumbers(bundles: RunBundle[]): Set<number> {
  const out = new Set<number>();
  const walk = (v: unknown): void => {
    if (typeof v === "number") out.add(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  for (const b of bundles) for (const part of [b.metrics, b.noiseFloor ?? {}, b.credits, b.usageByRole]) walk(part);
  return out;
}

/** Numbers in the Value / Noise floor / Comparison cells of every metrics table (code spans removed). */
function tableNumbers(md: string): number[] {
  const lines = md.split("\n");
  const nums: number[] = [];
  let cols: number[] | null = null;
  const split = (l: string): string[] => l.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.startsWith("|")) {
      cols = null;
      continue;
    }
    const cells = split(l);
    if (cols === null) {
      cols = ["Value", "Noise floor", "Comparison"].map((h) => cells.indexOf(h)).filter((x) => x >= 0);
      i++; // separator row
      continue;
    }
    for (const c of cols) {
      const text = (cells[c] ?? "").replace(/`[^`]*`/g, "");
      for (const m of text.matchAll(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)) nums.push(Number(m[0]));
    }
  }
  return nums;
}

/** The row for `key` whose Source bundle cell is `runId`. */
function metricRow(md: string, key: string, runId: string): string | undefined {
  return md.split("\n").find((l) => {
    const cells = l.split(/(?<!\\)\|/).map((c) => c.trim());
    return cells[1] === `\`${key}\`` && cells[3] === `\`${runId}\``;
  });
}

describe("collectBundles", () => {
  it("uses real verified bundles only: sample excluded, tampered skipped and listed", async () => {
    const { runsDir, f } = await setup();
    const c = collectBundles(runsDir);
    expect(c.bundles.map((b) => b.bundle.runId).sort()).toEqual([f.compare.runId, f.guarded.runId, f.naive.runId, f.notarize.runId].sort());
    expect(c.excluded.map((e) => e.file)).toEqual(["sample-7/sample-7.json"]);
    expect(c.skipped).toEqual([{ file: "test-tampered/test-tampered.json", reason: expect.stringMatching(/content hash mismatch/) }]);
  });

  it("a missing runs dir is simply empty", () => {
    expect(collectBundles(join(tempDir(), "nope"))).toEqual({ bundles: [], skipped: [], excluded: [] });
  });
});

describe("commandFor", () => {
  it("reconstructs the CLI invocation from bundle fields", () => {
    const f = fixtures();
    expect(commandFor(f.naive)).toBe("pnpm notary run --queue packages/core/fixtures/queue/seeded.json --naive");
    expect(commandFor(f.guarded)).toBe("pnpm notary run --queue packages/core/fixtures/queue/seeded.json");
    expect(commandFor(f.notarize)).toBe("pnpm notary notarize --tool dodo");
    expect(commandFor(f.compare)).toBe("pnpm notary notarize --tool dodo --compare-priors --priors-from crustdata");
  });
});

describe("runExport", () => {
  it("TOOLS.md: verified claim shows belief, adversary, evidence, guard; every other claim says unverified", async () => {
    const { read, f } = await setup();
    const md = read("export/TOOLS.md");
    expect(md).toMatch(/do not edit by hand/);
    expect(md).toContain(`dodo: \`${f.notarize.runId}\` (contentHash \`${f.notarize.contentHash}\`)`);
    expect(md).toContain("crustdata: no notarize bundle — every crustdata claim is unverified");

    const section = (id: string): string => md.split(`### \`${id}\``)[1]!.split("\n### ")[0]!;
    const verified = section(notarizedClaim.id);
    expect(verified).toContain("**Notarized: the doc is WRONG here (silent_truncation).**");
    expect(verified).toContain(notarizedClaim.docUrl);
    expect(verified).toContain("confidence 0.0625");
    expect(verified).toContain("α/β = 1/4");
    expect(verified).toContain("Adversary: **narrow**, scope: test scope");
    expect(verified).toContain("`probe-test-a` (trace `trace-test-a`, valid)");
    expect(verified).toContain("Active guard: `guard-test-active`");
    expect(verified).toContain("Retired guard: `guard-test-retired`");
    expect(verified).not.toContain(UNVERIFIED);

    const candidate = section(otherDodoClaim.id);
    expect(candidate).toContain(`**${UNVERIFIED}.**`);
    expect(candidate).toContain("Latest state (not notarized");
    for (const e of crustdataContract) expect(section(e.claim.id)).toContain(`**${UNVERIFIED}.**`);
    // Every contract claim is listed.
    for (const e of [...crustdataContract, ...dodoContract]) expect(md).toContain(`### \`${e.claim.id}\``);
  });

  it("guards.json: active + retired guards from the newest notarize bundle, with provenance", async () => {
    const { read, f } = await setup();
    const g = JSON.parse(read("export/guards.json"));
    expect(g.generatedFrom).toEqual([{ runId: f.notarize.runId, contentHash: f.notarize.contentHash, tool: "dodo" }]);
    expect(g.guards.map((x: Guard) => [x.id, x.active])).toEqual([
      ["guard-test-active", true],
      ["guard-test-retired", false],
    ]);
  });

  it("copies the newest real bundles to the dashboard; keeps the sample; never copies sample or tampered", async () => {
    const { web, f, result } = await setup();
    const index = BundleIndexSchema.parse(JSON.parse(readFileSync(join(web, "index.json"), "utf8")));
    expect(index.map((e) => e.runId).sort()).toEqual(["sample-42", f.naive.runId, f.guarded.runId, f.notarize.runId, f.compare.runId].sort());
    expect(existsSync(join(web, "sample-42.json"))).toBe(true);
    expect(existsSync(join(web, "sample-7.json"))).toBe(false);
    expect(existsSync(join(web, "test-tampered.json"))).toBe(false);
    expect(result.copied.sort()).toEqual([f.naive.runId, f.guarded.runId, f.notarize.runId, f.compare.runId].sort());
  });

  it("EVALUATION.md: every metric with its command; wrong-way and null results kept; no number that is not in a bundle", async () => {
    const checks: CheckResult[] = [
      { command: "pnpm test", ranAs: "test runner (fake)", ok: true, exitCode: 0, summary: "fake check result" },
    ];
    const { read, f } = await setup({ checks });
    const md = read("docs/EVALUATION.md");
    expect(md.split("\n")[2]).toBe("> Generated by `pnpm notary export` at 2026-10-11T12:00:00.000Z from 4 bundles — do not edit by hand.");

    // Every metric key of every bundle has a row with the bundle's runId and its command.
    for (const b of Object.values(f)) {
      for (const k of Object.keys(b.metrics)) {
        const r = metricRow(md, k, b.runId);
        expect(r, `${b.runId} ${k}`).toBeDefined();
        expect(r).toContain(`\`${commandFor(b)}\``);
      }
    }
    // PRD success metrics are all present.
    for (const m of ["Unsafe money actions", "Belief precision", "Unguarded call sites", "Cost per queue run", "Probes to confirm on Dodo", "Automation rate", "Reproducibility"]) {
      expect(md).toContain(`| ${m}`);
    }
    // Results that went the wrong way are kept and marked.
    const row = (key: string, runId: string): string => metricRow(md, key, runId)!;
    expect(row("decision_accuracy", f.guarded.runId)).toMatch(/guarded lower than naive \(naive 0\.65 → guarded 0\.6\) — WENT THE WRONG WAY/);
    expect(row("probes_to_candidate_with_priors", f.compare.runId)).toMatch(/WENT THE WRONG WAY/);
    expect(row("automation_rate", f.guarded.runId)).toMatch(/no change \(naive 0\.55 → guarded 0\.45; within noise floor 0\.2\)/);
    expect(row("unsafe_actions_total", f.guarded.runId)).toMatch(/— better/);
    expect(md).toMatch(/Unsafe money actions — guarded \|[^\n]*target met/);
    // Null metrics are "not computable (reason)".
    expect(row("holds", f.naive.runId)).toMatch(/\| not computable \(the bundle reports null/);
    expect(row("probes_to_candidate_mean", f.notarize.runId)).toMatch(/not computable \(no claim reached candidate\)/);
    // Skipped and excluded bundles are listed.
    expect(md).toMatch(/`test-tampered\/test-tampered.json`: content hash mismatch/);
    expect(md).toMatch(/`sample-7\/sample-7.json`: SAMPLE bundle/);
    // Checks section shows what the runner produced.
    expect(md).toMatch(/\| `pnpm test` \| PASS: fake check result \| 0 \|/);
    // Not-yet-measured lists only what is missing.
    const blocked = md.split("## Not yet measured (blocked)")[1]!;
    expect(blocked).toContain("no notarize bundle for crustdata");
    expect(blocked).not.toContain("no naive run bundle");
    expect(blocked).toContain("no replay bundle");
    expect(md).toContain("| Reproducibility | Exact match | not computable (no replay bundle");
    expect(blocked).toContain("no drift fixture exists");

    // The scan itself must see the values (guards against a parser that finds nothing).
    const nums = tableNumbers(md);
    expect(nums).toEqual(expect.arrayContaining([3, 0, 0.65, 0.6, 0.2, 37, 29, 500, 0.0123, 4, 5]));
    const allowed = bundleNumbers(Object.values(f));
    for (const n of nums) expect(allowed.has(n), `number ${n} is not in any bundle`).toBe(true);
    // 4242.4242 lives only in the tampered bundle, which must never be read (a "." never occurs in a hash).
    expect(md).not.toContain("4242.4242");
  });

  it("empty case: no real runs → every claim unverified, empty guards, 'no real runs' and blocked sections", async () => {
    const { read, result } = await setup({ empty: true });
    expect(result.bundles).toEqual([]);
    expect(result.copied).toEqual([]);
    const tools = read("export/TOOLS.md");
    expect(tools).toContain("**No real notarize bundles exist yet**");
    expect(tools.match(new RegExp(`\\*\\*${UNVERIFIED}\\.\\*\\*`, "g"))?.length).toBe(crustdataContract.length + dodoContract.length);
    expect(JSON.parse(read("export/guards.json"))).toEqual({ generatedFrom: [], guards: [] });
    const md = read("docs/EVALUATION.md");
    expect(md).toContain("from 0 bundles — do not edit by hand");
    expect(md).toContain("**No real runs yet.**");
    expect(md).toContain("No real runs yet, so there are no `bundle.metrics` to report.");
    expect(md).toContain("Not run for this export (`--no-checks`).");
    const blocked = md.split("## Not yet measured (blocked)")[1]!;
    for (const s of [
      "no naive run bundle",
      "no guarded run bundle",
      "no notarize bundle for crustdata",
      "no notarize bundle for dodo",
      "no compare-priors bundle for dodo",
      "no bundle carries a noiseFloor",
      "no replay bundle",
      "no drift fixture exists",
    ]) {
      expect(blocked).toContain(s);
    }
    expect(blocked).toContain("`pnpm notary run --queue packages/core/fixtures/queue/seeded.json --naive`");
    // PRD rows exist, all not computable, with no numbers at all in the value columns.
    expect(md).toMatch(/\| Unsafe money actions \| [^|]+ \| not computable \(no naive or guarded run bundle\)/);
    expect(tableNumbers(md)).toEqual([]);
    // The sample bundle stays in the dashboard.
    const index = BundleIndexSchema.parse(JSON.parse(readFileSync(join(result.files.toolsMd, "..", "..", "web", "index.json"), "utf8")));
    expect(index.map((e) => e.runId)).toEqual(["sample-42"]);
  });
});
