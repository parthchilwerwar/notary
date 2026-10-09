import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSampleBundle,
  canonicalJson,
  computeContentHash,
  finalizeBundle,
  sha256Hex,
  verifyBundle,
  writeBundle,
} from "../src/bundle/index.js";
import { SAMPLE_DISCLOSURE } from "../src/bundle/sample.js";
import { buildProgram } from "../src/cli.js";
import {
  AdversaryVerdictSchema,
  BeliefStatusSchema,
  BundleIndexSchema,
  DecisionStatusSchema,
  DefectClassSchema,
  ExpectRuleSchema,
  GuardKindSchema,
  PolicyOutcomeSchema,
  ProbeTemplateSchema,
  ProbeVerdictSchema,
  RequestTypeSchema,
  RunBundleSchema,
  TierSchema,
  UnsafeActionSchema,
  type RunBundle,
} from "../src/schema/index.js";

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "notary-bundle-"));
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  while (tmpDirs.length) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

const clone = (b: RunBundle): RunBundle => JSON.parse(JSON.stringify(b)) as RunBundle;

describe("sha256Hex (pure TS, browser-safe)", () => {
  it("matches node:crypto across padding boundaries and unicode", () => {
    const inputs = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "SAMPLE — ünïcødé 🧾"];
    for (const s of inputs) expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(i * 7);
      expect(sha256Hex(new Uint8Array(bytes))).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });
});

describe("canonicalJson", () => {
  it("is independent of key order, at every depth", () => {
    const a = { b: 1, a: { y: [1, { q: 2, p: 1 }], x: "s" } };
    const b = { a: { x: "s", y: [1, { p: 1, q: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":"s","y":[1,{"p":1,"q":2}]},"b":1}');
  });

  it("keeps array order, omits undefined members, rejects non-finite numbers", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson([undefined])).toBe("[null]");
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
  });
});

describe("sample bundle", () => {
  const sample = buildSampleBundle();

  it("parses with RunBundleSchema and verifies its own hash", () => {
    expect(RunBundleSchema.safeParse(sample).success).toBe(true);
    expect(verifyBundle(sample).ok).toBe(true);
    expect(verifyBundle(JSON.parse(JSON.stringify(sample))).ok).toBe(true);
  });

  it("is deterministic: same seed, same bytes and hash; different seed, different hash", () => {
    const again = buildSampleBundle(42);
    expect(again.contentHash).toBe(sample.contentHash);
    expect(JSON.stringify(again)).toBe(JSON.stringify(sample));
    expect(buildSampleBundle(7).contentHash).not.toBe(sample.contentHash);
  });

  it("is clearly labelled as sample data", () => {
    expect(sample.kind).toBe("sample");
    expect(sample.variant).toBe("sample");
    expect(sample.sample).toBe(true);
    expect(sample.runId.startsWith("sample-")).toBe(true);
    expect(sample.disclosure).toContain(SAMPLE_DISCLOSURE);
    expect(SAMPLE_DISCLOSURE).toBe("SAMPLE DATA — synthetic, not from any real run");
    for (const c of sample.claims) expect(c.docText.startsWith("[sample]")).toBe(true);
  });

  it("uses only fictional example.com customers", () => {
    for (const q of sample.queue) {
      expect(q.companyDomain.endsWith(".example.com")).toBe(true);
      if (q.customerEmail) expect(q.customerEmail.endsWith(".example.com")).toBe(true);
    }
    for (const url of Object.values(sample.traceLinks)) expect(new URL(url).hostname.endsWith("example.com")).toBe(true);
  });

  it("exercises every enum value", () => {
    const has = <T extends string>(options: readonly T[], seen: Iterable<T>) => {
      const s = new Set(seen);
      expect(options.filter((o) => !s.has(o))).toEqual([]);
    };
    has(DecisionStatusSchema.options, sample.decisions.map((d) => d.status));
    has(PolicyOutcomeSchema.options, sample.decisions.map((d) => d.policyOutcome));
    has(TierSchema.options, sample.decisions.map((d) => d.tier));
    has(RequestTypeSchema.options, sample.queue.map((q) => q.type));
    has(BeliefStatusSchema.options, sample.beliefs.after.map((b) => b.status));
    has(GuardKindSchema.options, sample.guards.map((g) => g.kind));
    has(ProbeVerdictSchema.options, sample.probes.flatMap((p) => (p.verdict ? [p.verdict] : [])));
    has(ProbeTemplateSchema.options, sample.probes.map((p) => p.template));
    has(DefectClassSchema.options, sample.hypotheses.map((h) => h.class));
    has(AdversaryVerdictSchema.options, sample.beliefs.after.flatMap((b) => (b.adversary ? [b.adversary.verdict] : [])));
    has(
      ExpectRuleSchema.options.map((o) => o.shape.kind.value),
      sample.claims.map((c) => c.expect.kind),
    );
    has(UnsafeActionSchema.options.slice(0, 1), sample.decisions.flatMap((d) => d.grade?.unsafe ?? []));
  });

  it("covers the edge cases the dashboard must render", () => {
    expect(sample.guards.some((g) => g.active)).toBe(true);
    expect(sample.guards.some((g) => !g.active && g.retiredAt)).toBe(true);
    expect(sample.decisions.some((d) => d.status === "held" && d.evidencePack)).toBe(true);
    expect(Object.values(sample.metrics)).toContain(null);
    expect(sample.decisions.some((d) => d.traceId === "")).toBe(true);
    expect(sample.decisions.some((d) => d.effects.some((e) => e.status === null))).toBe(true);
    expect(sample.decisions.some((d) => d.error)).toBe(true);
    expect(sample.beliefEvents.some((e) => e.from === null)).toBe(true);
    expect(sample.probes.some((p) => !(p.traceId in sample.traceLinks))).toBe(true);
    expect(sample.credits.total).toBe(Object.values(sample.credits.byEndpoint).reduce((s, n) => s + n, 0));
  });

  it("stamps predictionHash = sha256(canonicalJson(prediction)) on every probe", () => {
    for (const p of sample.probes) expect(p.predictionHash).toBe(sha256Hex(canonicalJson(p.prediction)));
  });

  it("only compiles guards from beliefs that were notarized", () => {
    const notarizedAtSomePoint = new Set(sample.beliefEvents.filter((e) => e.to === "notarized").map((e) => e.beliefId));
    for (const g of sample.guards) expect(notarizedAtSomePoint.has(g.beliefId)).toBe(true);
  });
});

describe("verifyBundle", () => {
  it("fails visibly with a hash mismatch when one field is tampered", () => {
    const tampered = clone(buildSampleBundle());
    tampered.decisions[0]!.status = "denied";
    const r = verifyBundle(tampered);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("hash");
    expect(r.error).toMatch(/content hash mismatch/);
  });

  it("fails on a nested numeric tamper too", () => {
    const tampered = clone(buildSampleBundle());
    tampered.usageByRole.adversary.usd += 0.01;
    expect(verifyBundle(tampered).ok).toBe(false);
  });

  it("reports schema errors separately from hash errors", () => {
    const r = verifyBundle({ runId: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema");
  });

  it("finalizeBundle recomputes the hash after an edit", () => {
    const edited = clone(buildSampleBundle());
    edited.stopReason = "edited";
    const fixed = finalizeBundle(edited);
    expect(fixed.contentHash).toBe(computeContentHash(fixed));
    expect(verifyBundle(fixed).ok).toBe(true);
  });
});

describe("writeBundle", () => {
  it("writes <runId>.json and a sorted, de-duplicated index.json", async () => {
    const dir = await tmp();
    const sample = buildSampleBundle();
    const earlier = finalizeBundle({ ...clone(sample), runId: "sample-early", startedAt: "2026-10-09T08:00:00.000Z" });

    const first = await writeBundle(sample, dir);
    await writeBundle(earlier, dir);
    await writeBundle(sample, dir); // rewrite: must not duplicate the index entry

    const roundTrip = verifyBundle(JSON.parse(await readFile(first.bundlePath, "utf8")));
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) expect(roundTrip.bundle).toEqual(sample);

    const index = BundleIndexSchema.parse(JSON.parse(await readFile(join(dir, "index.json"), "utf8")));
    expect(index.map((e) => e.runId)).toEqual(["sample-early", sample.runId]);
    expect(index[1]).toEqual({
      runId: sample.runId,
      kind: "sample",
      variant: "sample",
      mode: sample.mode,
      sample: true,
      startedAt: sample.startedAt,
      status: sample.status,
      contentHash: sample.contentHash,
    });
  });

  it("refuses tampered bundles and unsafe run ids", async () => {
    const dir = await tmp();
    const tampered = clone(buildSampleBundle());
    tampered.seed = 1;
    await expect(writeBundle(tampered, dir)).rejects.toThrow(/hash mismatch/);
    const evil = finalizeBundle({ ...clone(buildSampleBundle()), runId: "../escape" });
    await expect(writeBundle(evil, dir)).rejects.toThrow(/unsafe runId/);
  });
});

describe("notary export --sample", () => {
  it("writes a valid sample bundle to --out", async () => {
    const dir = await tmp();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await buildProgram().parseAsync(["node", "notary", "export", "--sample", "--out", dir]);
    } finally {
      log.mockRestore();
    }
    const written = verifyBundle(JSON.parse(await readFile(join(dir, "sample-42.json"), "utf8")));
    expect(written.ok).toBe(true);
  });
});
