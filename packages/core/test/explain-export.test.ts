// `notary export --explain` → packages/web/public/content/explain.json: deterministic, every citation
// resolving, one world per answer, equal to what the command generates (read-only here; writes go
// to temp dirs).
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeBundle } from "../src/bundle/hash.js";
import { indexWorld, validateCitations, worldKeyOf } from "../src/explain/index.js";
import {
  EXPLAIN_FILE,
  EXPLAIN_GENERATED_BY,
  EXPLAIN_PATHS,
  buildExplainFile,
  loadPublishedWorlds,
  renderExplainFile,
  writeExplain,
} from "../src/explain/export.js";
import { ExplainFileSchema } from "../src/schema/explain.js";
import type { ToolCertificates } from "../src/schema/certificate.js";
import type { RunBundle } from "../src/schema/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "notary-explain-"));
  dirs.push(d);
  return d;
};

const PUBLISHED = join(EXPLAIN_PATHS.contentDir, EXPLAIN_FILE);
const CERTS_DIR = join(EXPLAIN_PATHS.webBundlesDir, "..", "certificates");

describe("explain.json", () => {
  const { worlds } = loadPublishedWorlds();
  const built = buildExplainFile(worlds);

  it("is deterministic: two builds render byte-identical JSON", () => {
    const again = buildExplainFile(loadPublishedWorlds().worlds);
    expect(renderExplainFile(again)).toBe(renderExplainFile(built));
  });

  it("the committed file equals what `notary export --explain` generates", async () => {
    expect(existsSync(PUBLISHED)).toBe(true);
    const out = tmp();
    const { path } = await writeExplain({ contentDir: out });
    expect(readFileSync(path, "utf8")).toBe(readFileSync(PUBLISHED, "utf8"));
  });

  it("validates against ExplainFileSchema with stable, unique ids", () => {
    const file = ExplainFileSchema.parse(JSON.parse(readFileSync(PUBLISHED, "utf8")));
    expect(file.generatedBy).toBe(EXPLAIN_GENERATED_BY);
    const ids = file.answers.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of file.answers) expect(a.id.startsWith(`${a.kind}:`)).toBe(true);
  });

  it("covers every held decision of every published guarded run, each tool, naive vs guarded and revocations per world", () => {
    const ids = new Set(built.answers.map((a) => a.id));
    for (const w of worlds.filter((x) => x.bundles.length)) {
      for (const b of w.bundles.filter((x) => x.kind === "run" && x.variant === "guarded")) {
        for (const d of b.decisions.filter((x) => x.status === "held")) expect(ids.has(`why_held:${b.runId}:${d.id}`)).toBe(true);
      }
      expect(ids.has(`tool_knowledge:${w.key}:crustdata`)).toBe(true);
      expect(ids.has(`tool_knowledge:${w.key}:dodo`)).toBe(true);
      const naive = w.bundles.find((b) => b.variant === "naive")!;
      const guarded = w.bundles.find((b) => b.variant === "guarded")!;
      expect(ids.has(`run_diff:${naive.runId}:${guarded.runId}`)).toBe(true);
      expect(ids.has(`revocations:${w.key}`)).toBe(true);
    }
  });

  it("every citation in the file resolves against its world's records", () => {
    const file = ExplainFileSchema.parse(JSON.parse(readFileSync(PUBLISHED, "utf8")));
    const byRun = new Map<string, (typeof worlds)[number]>();
    for (const w of worlds) for (const b of w.bundles) byRun.set(b.runId, w);
    for (const a of file.answers) {
      const w = byRun.get(a.runIds[0]!)!;
      expect(w, a.id).toBeDefined();
      expect(validateCitations(a.citations, indexWorld(w)), a.id).toEqual({ ok: true, invalid: [] });
    }
  });

  it("no answer mixes sample and non-sample runs, or two fixture scenarios", () => {
    const file = ExplainFileSchema.parse(JSON.parse(readFileSync(PUBLISHED, "utf8")));
    const keyOf = new Map<string, string>();
    for (const w of worlds) for (const b of w.bundles) keyOf.set(b.runId, worldKeyOf(b));
    for (const a of file.answers) {
      const runs = new Set([...a.runIds, ...a.citations.map((c) => c.runId).filter((r): r is string => !!r)]);
      const keys = new Set([...runs].map((r) => keyOf.get(r)));
      expect(keys.size, `${a.id}: ${[...keys].join(", ")}`).toBe(1);
      const key = [...keys][0]!;
      expect(key).toBeDefined();
      expect(a.sample).toBe(key !== "real");
      if (a.sample) expect(a.answer.startsWith(`FIXTURE scenario ${key.slice("fixture:".length)} `)).toBe(true);
    }
  });

  it("cited certificate and revocation ids exist in the published certificate files of the same world", () => {
    const file = ExplainFileSchema.parse(JSON.parse(readFileSync(PUBLISHED, "utf8")));
    const published = new Map<string, Set<string>>();
    for (const w of worlds.filter((x) => x.sample)) {
      const dir = join(CERTS_DIR, "fixture", w.key.slice("fixture:".length));
      const ids = new Set<string>();
      for (const f of readdirSync(dir).filter((x) => x !== "report.json")) {
        const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as ToolCertificates;
        for (const s of t.sourceBundles) {
          const b = w.bundles.find((x) => x.runId === s.runId);
          expect(b?.contentHash, `certificates/fixture/${w.key.slice(8)}/${f} is stale for ${s.runId}: rerun \`pnpm notary export --certificates --fixture\`, then \`--explain\``).toBe(s.contentHash);
        }
        for (const c of t.certificates) ids.add(c.id);
        for (const r of t.revocations) ids.add(r.id);
      }
      for (const b of w.bundles) published.set(b.runId, ids);
    }
    for (const a of file.answers) {
      for (const c of a.citations.filter((x) => x.kind === "certificate" || x.kind === "revocation")) {
        expect(published.get(c.runId!)?.has(c.id), `${a.id} cites ${c.id}`).toBe(true);
      }
    }
  });
});

describe("loadPublishedWorlds", () => {
  it("skips the synthetic SAMPLE bundle, tampered files and timelines; keeps a real bundle in its own world", () => {
    const web = tmp();
    cpSync(EXPLAIN_PATHS.webBundlesDir, web, { recursive: true });
    const fx = join(web, "fixture");
    const anyFixture = readdirSync(fx).find((f) => f.startsWith("demo-run-guarded"))!;
    const src = JSON.parse(readFileSync(join(fx, anyFixture), "utf8")) as RunBundle;
    // A tampered fixture bundle is skipped, never explained.
    writeFileSync(join(fx, "demo-run-naive.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(fx, "demo-run-naive.json"), "utf8")), seed: 999 }));
    // A timeline file next to bundles is not a bundle.
    writeFileSync(join(fx, "demo-run-guarded.timeline.json"), JSON.stringify({ runId: "demo-run-guarded", sample: true, bundleHash: src.contentHash, events: [] }));
    // A (constructed) real bundle lands in the real world only.
    const real = finalizeBundle({ ...src, runId: "real-run-guarded", sample: false, disclosure: [] });
    writeFileSync(join(web, "real-run-guarded.json"), JSON.stringify(real));
    const { worlds, skipped } = loadPublishedWorlds(web);
    expect(skipped.map((s) => s.file)).toEqual(expect.arrayContaining(["sample-42.json", "fixture/demo-run-naive.json"]));
    expect(skipped.find((s) => s.file === "fixture/demo-run-naive.json")!.reason).toMatch(/hash mismatch/);
    expect(skipped.some((s) => s.file.endsWith(".timeline.json"))).toBe(false);
    const realWorld = worlds.find((w) => w.key === "real")!;
    expect(realWorld.bundles.map((b) => b.runId)).toEqual(["real-run-guarded"]);
    for (const w of worlds.filter((x) => x.key !== "real")) expect(w.bundles.every((b) => b.sample)).toBe(true);
    const file = buildExplainFile(worlds);
    const realAnswers = file.answers.filter((a) => !a.sample);
    expect(realAnswers.length).toBeGreaterThan(0);
    for (const a of realAnswers) expect(a.runIds).toEqual(["real-run-guarded"]);
    // The default world lost its naive run, so it has no naive vs guarded diff.
    expect(file.answers.some((a) => a.id === "run_diff:demo-run-naive:demo-run-guarded")).toBe(false);
  });
});
