// `notary demo --fixture --publish` separation and the sponsor evidence file. Bundles here are TEST
// DATA built in this file (finalizeBundle / buildSampleBundle) and written to temp dirs; the only
// real-directory reads are the committed packages/web/public/{bundles,evidence} files (read-only).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/server.js";
import { FIXTURE_BUNDLES_SUBDIR, buildSampleBundle, finalizeBundle, verifyBundle, writeBundle } from "../src/bundle/index.js";
import { FIXTURE_DISCLOSURE } from "../src/demo/index.js";
import { fixturePublishRefusal, publishFixtureBundles } from "../src/demo/publish.js";
import { EVIDENCE_PATH, EvidenceSchema, PLACEHOLDER_URL, PRIVATE_REPO_URL, SPONSOR_NAMES, buildEvidence, exportedRunTraceIds, gatherEvidenceFacts, loadEvidence } from "../src/export/evidence.js";
import { resolveTraceLinkTemplate, traceLinkFor } from "../src/trace/links.js";
import { runExport } from "../src/export/index.js";
import { BundleIndexSchema } from "../src/schema/bundle.js";
import type { RunBundle } from "../src/schema/index.js";

const ZERO = { inputTokens: 0, outputTokens: 0, usd: 0, calls: 0 };
const TEST = "TEST bundle built in test/publish.test.ts — not a Notary result";
const WEB_BUNDLES = fileURLToPath(new URL("../../web/public/bundles/", import.meta.url));

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "notary-publish-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function realBundle(runId: string, startedAt = "2026-10-11T10:00:00.000Z"): RunBundle {
  return finalizeBundle({
    runId,
    kind: "run",
    variant: "guarded",
    mode: "live",
    sample: false,
    disclosure: [TEST],
    startedAt,
    finishedAt: startedAt,
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
  });
}

/** A fixture-demo-shaped bundle: demo-* runId, sample: true, FIXTURE disclosure, re-hashed. */
function fixtureBundle(runId: string, seed = 42): RunBundle {
  const s = buildSampleBundle(seed);
  return finalizeBundle({ ...s, runId, sample: true, disclosure: [FIXTURE_DISCLOSURE, TEST] });
}

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** name -> sha256 of every top-level file in dir (directories listed as "dir"). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    out[name] = statSync(p).isDirectory() ? "dir" : sha(p);
  }
  return out;
}

async function dashboard(): Promise<{ web: string; real: RunBundle }> {
  const web = join(tempDir(), "bundles");
  await writeBundle(buildSampleBundle(42), web);
  const real = realBundle("test-real-run");
  await writeBundle(real, web);
  return { web, real };
}

describe("notary demo --fixture --publish", () => {
  it("writes only into bundles/fixture/ with its own index; bundles stay unchanged and hash-valid", async () => {
    const { web } = await dashboard();
    const before = snapshot(web);
    const bundles = [fixtureBundle("demo-run-naive", 1), fixtureBundle("demo-run-guarded", 2)];
    const r = await publishFixtureBundles(bundles, { webBundlesDir: web });

    const fixtureDir = join(web, FIXTURE_BUNDLES_SUBDIR);
    expect(r.dir).toBe(fixtureDir);
    expect(readdirSync(fixtureDir).sort()).toEqual([
      "demo-run-guarded.json",
      "demo-run-guarded.timeline.json",
      "demo-run-naive.json",
      "demo-run-naive.timeline.json",
      "index.json",
    ]);
    const index = BundleIndexSchema.parse(JSON.parse(readFileSync(join(fixtureDir, "index.json"), "utf8")));
    expect(index.map((e) => e.runId).sort()).toEqual(["demo-run-guarded", "demo-run-naive"]);
    expect(index.every((e) => e.sample)).toBe(true);
    for (const b of bundles) {
      const onDisk = JSON.parse(readFileSync(join(fixtureDir, `${b.runId}.json`), "utf8"));
      expect(onDisk).toEqual(b); // unchanged
      const v = verifyBundle(onDisk);
      expect(v.ok).toBe(true);
      expect(onDisk.sample).toBe(true);
      expect(onDisk.disclosure).toContain(FIXTURE_DISCLOSURE);
    }
    // The real index and every non-fixture file are byte-identical.
    const after = snapshot(web);
    delete after[FIXTURE_BUNDLES_SUBDIR];
    expect(after).toEqual(before);
  });

  it("replaces the fixture dir's previous demo-* files on each publish and leaves other files alone", async () => {
    const { web } = await dashboard();
    const fixtureDir = join(web, FIXTURE_BUNDLES_SUBDIR);
    await publishFixtureBundles([fixtureBundle("demo-old"), fixtureBundle("demo-run-naive")], { webBundlesDir: web });
    writeFileSync(join(fixtureDir, "README.txt"), "not ours");
    const r = await publishFixtureBundles([fixtureBundle("demo-run-naive", 3)], { webBundlesDir: web });
    expect(r.removed.sort()).toEqual(["demo-old.json", "demo-run-naive.json", "index.json"]);
    expect(readdirSync(fixtureDir).sort()).toEqual(["README.txt", "demo-run-naive.json", "demo-run-naive.timeline.json", "index.json"]);
    const index = BundleIndexSchema.parse(JSON.parse(readFileSync(join(fixtureDir, "index.json"), "utf8")));
    expect(index.map((e) => e.runId)).toEqual(["demo-run-naive"]);
  });

  it("refuses non-sample, undisclosed, non-demo or tampered bundles and writes nothing", async () => {
    const { web } = await dashboard();
    const before = snapshot(web);
    const notSample = finalizeBundle({ ...fixtureBundle("demo-x"), sample: false });
    const noDisclosure = finalizeBundle({ ...fixtureBundle("demo-y"), disclosure: [TEST] });
    const notDemo = fixtureBundle("sample-like-run");
    const tampered = { ...fixtureBundle("demo-z"), metrics: { unsafe_actions_total: 99 } };
    expect(fixturePublishRefusal(realBundle("test-real"))).toMatch(/not sample: true/);
    expect(fixturePublishRefusal(notSample)).toMatch(/not sample: true/);
    expect(fixturePublishRefusal(noDisclosure)).toMatch(/FIXTURE disclosure/);
    expect(fixturePublishRefusal(notDemo)).toMatch(/not a demo-\* bundle/);
    expect(fixturePublishRefusal(tampered)).toMatch(/fails verification/);
    for (const bad of [realBundle("demo-real"), notSample, noDisclosure, notDemo, tampered as RunBundle]) {
      await expect(publishFixtureBundles([fixtureBundle("demo-ok"), bad], { webBundlesDir: web })).rejects.toThrow(/refusing to publish/);
    }
    expect(existsSync(join(web, FIXTURE_BUNDLES_SUBDIR))).toBe(false);
    expect(snapshot(web)).toEqual(before);
  });

  it("notary export never writes into bundles/fixture/ nor lists fixture bundles in the real index", async () => {
    const root = tempDir();
    const runsDir = join(root, "runs");
    const { web } = await dashboard();
    await publishFixtureBundles([fixtureBundle("demo-run-naive")], { webBundlesDir: web });
    const fixtureDir = join(web, FIXTURE_BUNDLES_SUBDIR);
    const fixtureBefore = snapshot(fixtureDir);
    // runs/ holds one real bundle and one fixture-demo bundle.
    const real = realBundle("test-real-export", "2026-10-11T11:00:00.000Z");
    for (const b of [real, fixtureBundle("demo-run-guarded")]) {
      mkdirSync(join(runsDir, b.runId), { recursive: true });
      writeFileSync(join(runsDir, b.runId, `${b.runId}.json`), JSON.stringify(b, null, 2));
    }
    const common = { runsDir, exportDir: join(root, "export"), docsDir: join(root, "docs"), driftDir: join(root, "drift"), checks: null, now: () => new Date("2026-10-11T12:00:00.000Z") };
    const r = await runExport({ ...common, webBundlesDir: web });
    expect(r.copied).toEqual(["test-real-export"]);
    expect(snapshot(fixtureDir)).toEqual(fixtureBefore);
    const realIndex = BundleIndexSchema.parse(JSON.parse(readFileSync(join(web, "index.json"), "utf8")));
    expect(realIndex.some((e) => e.runId.startsWith("demo-"))).toBe(false);
    // Pointing export at the fixture dir is refused before anything is written.
    await expect(runExport({ ...common, exportDir: join(root, "export2"), webBundlesDir: fixtureDir })).rejects.toThrow(/fixture-demo directory/);
    expect(existsSync(join(root, "export2"))).toBe(false);
    expect(snapshot(fixtureDir)).toEqual(fixtureBefore);
  });

  it("the local API does not merge bundles/fixture/ into the real bundle list", async () => {
    const { web, real } = await dashboard();
    await publishFixtureBundles([fixtureBundle("demo-run-naive")], { webBundlesDir: web });
    const app = createApp({ bundleDirs: [web], runsDir: null });
    const list = (await (await app.request("/api/bundles")).json()) as Array<{ runId: string }>;
    expect(list.map((e) => e.runId)).toContain(real.runId);
    expect(list.some((e) => e.runId.startsWith("demo-"))).toBe(false);
    expect((await app.request("/api/bundles/demo-run-naive")).status).toBe(404);
  });

  it("committed packages/web/public/bundles/fixture/ is fixture-only, hash-valid and separate from the real index", () => {
    const fixtureDir = join(WEB_BUNDLES, FIXTURE_BUNDLES_SUBDIR);
    expect(existsSync(join(fixtureDir, "index.json"))).toBe(true);
    const index = BundleIndexSchema.parse(JSON.parse(readFileSync(join(fixtureDir, "index.json"), "utf8")));
    // v2 timelines (<runId>.timeline.json) sit next to their bundles; test/timeline.test.ts checks them.
    const files = readdirSync(fixtureDir).filter((f) => f !== "index.json" && !f.endsWith(".timeline.json")).sort();
    expect(files).toEqual(index.map((e) => `${e.runId}.json`).sort());
    expect(files.length).toBeGreaterThan(0);
    for (const e of index) {
      const v = verifyBundle(JSON.parse(readFileSync(join(fixtureDir, `${e.runId}.json`), "utf8")));
      expect(v.ok).toBe(true);
      if (!v.ok) continue;
      expect(v.bundle.sample).toBe(true);
      expect(v.bundle.runId.startsWith("demo-")).toBe(true);
      expect(v.bundle.disclosure).toContain(FIXTURE_DISCLOSURE);
      expect(v.bundle.contentHash).toBe(e.contentHash);
    }
    const realIndex = BundleIndexSchema.parse(JSON.parse(readFileSync(join(WEB_BUNDLES, "index.json"), "utf8")));
    expect(realIndex.some((e) => e.runId.startsWith("demo-") || index.some((f) => f.runId === e.runId))).toBe(false);
    expect(readdirSync(WEB_BUNDLES).some((f) => f.startsWith("demo-"))).toBe(false);
  });
});

describe("packages/web/public/evidence/evidence.json", () => {
  const evidence = loadEvidence();
  const by = (n: string) => evidence.find((e) => e.name === n)!;

  it("validates and lists exactly neatlogs, Entire and cfo.ai", () => {
    expect(evidence.map((e) => e.name).sort()).toEqual([...SPONSOR_NAMES].sort());
    expect(EvidenceSchema.safeParse(JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"))).success).toBe(true);
  });

  it("is exactly what `notary export --evidence` generates from facts on disk", () => {
    expect(evidence).toEqual(buildEvidence(gatherEvidenceFacts()));
  });

  it("exported run traces count only finished real runs (a run in progress or a sample run never moves the facts)", () => {
    const runsDir = join(tempDir(), "runs");
    const spans = (runId: string, traceIds: string[]) => {
      mkdirSync(join(runsDir, runId), { recursive: true });
      writeFileSync(join(runsDir, runId, "spans.jsonl"), traceIds.map((t) => JSON.stringify({ name: "notary.probe", traceId: t, spanId: "b".repeat(16), exported: true })).join("\n") + "\n");
    };
    const put = (b: RunBundle) => writeFileSync(join(runsDir, b.runId, `${b.runId}.json`), JSON.stringify(b, null, 2));
    // In progress: spans are appended as the run goes, its bundle is written at the end.
    spans("test-in-progress", ["a".repeat(32)]);
    expect(exportedRunTraceIds(runsDir).size).toBe(0);
    expect(gatherEvidenceFacts({ runsDir, env: {} }).exportedRunTraces).toBe(0);
    // Finished: the hash-verified real bundle makes its exported spans count.
    put(realBundle("test-in-progress"));
    expect([...exportedRunTraceIds(runsDir)]).toEqual(["a".repeat(32)]);
    // A sample run and a tampered bundle never count.
    spans("demo-sample", ["c".repeat(32)]);
    put(fixtureBundle("demo-sample"));
    spans("test-tampered", ["d".repeat(32)]);
    put({ ...realBundle("test-tampered"), metrics: { unsafe_actions_total: 1 } });
    expect([...exportedRunTraceIds(runsDir)]).toEqual(["a".repeat(32)]);
    expect(gatherEvidenceFacts({ runsDir, env: {} }).exportedRunTraces).toBe(1);
  });

  it("has no placeholder link, no private-repo link and no invented trace URL", () => {
    // A neatlogs trace URL is allowed only when built from a template derived from a real trace URL.
    const { template } = resolveTraceLinkTemplate();
    const doctorLink = traceLinkFor("8e4a01d2811652fa2e8c4e4334642137", template);
    for (const e of evidence) {
      for (const l of e.links) {
        expect(l.url).toMatch(/^https:\/\//);
        expect(PLACEHOLDER_URL.test(l.url)).toBe(false);
        expect(l.url.toLowerCase().startsWith(PRIVATE_REPO_URL)).toBe(false);
        if (l.url !== doctorLink) {
          expect(l.url).not.toMatch(/neatlogs\.com/);
          expect(l.url).not.toMatch(/8e4a01d2811652fa2e8c4e4334642137/);
        }
      }
    }
    // The schema itself rejects placeholders and the private repo.
    const bad = (url: string) => EvidenceSchema.safeParse(evidence.map((e) => (e.name === "cfo.ai" ? { ...e, links: [{ label: "x", url }] } : e))).success;
    expect(bad("https://example.com/plan")).toBe(false);
    expect(bad(`${PRIVATE_REPO_URL}`)).toBe(false);
    expect(bad("https://neatlogs.example/TODO")).toBe(false);
    expect(bad("http://docs.entire.io/cli-reference/graph")).toBe(false);
  });

  it("status rules follow the facts: neatlogs live from the recorded doctor success; Entire and cfo.ai only with their facts", () => {
    const facts = gatherEvidenceFacts();
    // The last recorded `notary doctor` success (seeded from DECISIONS #93, overwritten by later real runs).
    expect(facts.doctor?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(by("neatlogs").status).toBe("live");
    expect(by("neatlogs").notes).toContain(facts.doctor!.traceId);
    expect(by("neatlogs").notes).toMatch(/neatlogs-cli is (not installed|installed)/);
    expect(by("Entire").status).toBe(facts.entire.onPath && facts.entire.checkpointRefs.length > 0 ? "live" : "pending");
    expect(by("Entire").links.map((l) => l.url)).toEqual(["https://docs.entire.io/cli-reference/graph"]);
    expect(by("cfo.ai").status).toBe(facts.businessPlan && facts.cfoPlanImported ? "live" : "pending");
    expect(by("cfo.ai").links).toEqual([]);
    // The Entire docs URL is the one recorded in DECISIONS #61.
    const decisions = readFileSync(fileURLToPath(new URL("../../../docs/DECISIONS.md", import.meta.url)), "utf8");
    expect(decisions).toMatch(/\| 61 \|[^\n]*https:\/\/docs\.entire\.io\/cli-reference\/graph/);
  });
});
