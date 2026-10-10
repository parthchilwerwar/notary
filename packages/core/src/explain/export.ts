/**
 * `notary export --explain`: precomputed explain answers for every PUBLISHED run, written to
 * packages/web/public/content/explain.json (an ExplainFile).
 *
 * Sources (read-only):
 *   packages/web/public/bundles/*.json          real bundles (sample: false only; the synthetic
 *                                               SAMPLE bundle and anything else sample is skipped)
 *   packages/web/public/bundles/fixture/*.json  fixture bundles, one world per demo scenario
 * Every bundle must pass verifyBundle (schema + content hash) and be named after its runId;
 * `*.timeline.json` and `index.json` are not bundles. Certificates are derived from each world's
 * own bundles with the same builder `notary export --certificates` uses, so their ids match the
 * published certificate files when those are current.
 *
 * Per world (real first, then fixture scenarios by name): why_held for every held decision of every
 * guarded run (bundle order, then decision order); tool_knowledge per tool; run_diff naive → guarded
 * for every naive/guarded pair; revocations. An answer with nothing to cite is not written. Every
 * citation is validated against that world's records only, so no answer can mix worlds.
 * Pure function of the files: regenerating is byte-identical.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundle } from "../bundle/hash.js";
import { TOOLS, buildCertificates } from "../certify/certificates.js";
import type { ToolCertificates } from "../schema/certificate.js";
import { realCertificateSources } from "../certify/index.js";
import { demoScenarioOf } from "../demo/index.js";
import { fixturePublishRefusal } from "../demo/publish.js";
import type { ExplainAnswer, ExplainFile } from "../schema/explain.js";
import { ExplainFileSchema } from "../schema/explain.js";
import type { RunBundle } from "../schema/index.js";
import { revocations, runDiff, toolKnowledge, whyHeld } from "./answers.js";
import { validateCitations } from "./citations.js";
import type { World } from "./world.js";
import { indexWorld, makeWorld, worldKeyOf } from "./world.js";

export const EXPLAIN_GENERATED_BY = "notary export --explain" as const;
export const EXPLAIN_FILE = "explain.json";

export const EXPLAIN_PATHS = {
  webBundlesDir: fileURLToPath(new URL("../../../web/public/bundles/", import.meta.url)),
  contentDir: fileURLToPath(new URL("../../../web/public/content/", import.meta.url)),
};

export interface SkippedFile {
  file: string;
  reason: string;
}

export interface PublishedWorlds {
  worlds: World[];
  skipped: SkippedFile[];
}

function bundleFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json" && !f.endsWith(".timeline.json"))
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();
}

function readBundle(dir: string, f: string, label: string, skipped: SkippedFile[]): RunBundle | undefined {
  const file = `${label}${f}`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
  } catch {
    skipped.push({ file, reason: "unreadable JSON" });
    return undefined;
  }
  const v = verifyBundle(raw);
  if (!v.ok) {
    skipped.push({ file, reason: v.reason === "hash" ? "content hash mismatch (tampered or edited after writing)" : "not a run bundle" });
    return undefined;
  }
  if (`${v.bundle.runId}.json` !== f) {
    skipped.push({ file, reason: `file name does not match its runId (${v.bundle.runId})` });
    return undefined;
  }
  return v.bundle;
}

/** Certificates for one world, from its own bundles only. */
export function worldCertificates(key: string, bundles: readonly RunBundle[]): ToolCertificates[] {
  if (key === "real") return buildCertificates(realCertificateSources(bundles)).tools;
  if (!key.startsWith("fixture:")) return [];
  return buildCertificates(bundles, { fixture: true, scenario: key.slice("fixture:".length) }).tools;
}

/** The published worlds: real bundles, then one world per fixture scenario. */
export function loadPublishedWorlds(webBundlesDir: string = EXPLAIN_PATHS.webBundlesDir): PublishedWorlds {
  const skipped: SkippedFile[] = [];
  const real: RunBundle[] = [];
  for (const f of bundleFiles(webBundlesDir)) {
    const b = readBundle(webBundlesDir, f, "", skipped);
    if (!b) continue;
    if (b.sample || b.kind === "sample" || b.variant === "sample") {
      skipped.push({ file: f, reason: "SAMPLE bundle (synthetic) in the real directory: never explained as a result" });
      continue;
    }
    real.push(b);
  }
  const fixtureDir = join(webBundlesDir, "fixture");
  const byScenario = new Map<string, RunBundle[]>();
  for (const f of bundleFiles(fixtureDir)) {
    const b = readBundle(fixtureDir, f, "fixture/", skipped);
    if (!b) continue;
    const refusal = fixturePublishRefusal(b);
    if (refusal) {
      skipped.push({ file: `fixture/${f}`, reason: `not a fixture bundle: ${refusal}` });
      continue;
    }
    const key = worldKeyOf(b);
    const expected = `fixture:${demoScenarioOf(b.runId)}`;
    if (key !== expected) throw new Error(`notary export --explain: ${b.runId} discloses world ${key} but its runId says ${expected}`);
    byScenario.set(key, [...(byScenario.get(key) ?? []), b]);
  }
  const worlds: World[] = [];
  worlds.push(makeWorld(real, worldCertificates("real", real), "real"));
  for (const key of [...byScenario.keys()].sort()) {
    const bundles = byScenario.get(key)!;
    worlds.push(makeWorld(bundles, worldCertificates(key, bundles), key));
  }
  return { worlds, skipped };
}

/** Every answer for one world, in a fixed order. */
export function worldAnswers(world: World): ExplainAnswer[] {
  const out: ExplainAnswer[] = [];
  const guarded = world.bundles.filter((b) => b.kind === "run" && b.variant === "guarded");
  for (const b of guarded) for (const d of b.decisions) if (d.status === "held") out.push(whyHeld(b, d.id, world));
  for (const tool of TOOLS) {
    const a = toolKnowledge(tool, world);
    if (a) out.push(a);
  }
  const naive = world.bundles.filter((b) => b.kind === "run" && b.variant === "naive");
  for (const n of naive) {
    for (const g of guarded) {
      const a = runDiff(n, g, world);
      if (a) out.push(a);
    }
  }
  const r = revocations(world);
  if (r) out.push(r);

  // Every citation must resolve inside this world, and carry this world's sample flag.
  const index = indexWorld(world);
  for (const a of out) {
    const check = validateCitations(a.citations, index);
    if (!check.ok) throw new Error(`notary export --explain: ${a.id} has unresolved citations: ${check.invalid.map((c) => `${c.kind}:${c.id}@${c.runId ?? "-"}`).join(", ")}`);
    for (const c of a.citations) {
      if (index.find(c.kind, c.id, c.runId).some((r) => r.sample !== world.sample)) throw new Error(`notary export --explain: ${a.id} cites a record outside world ${world.key}`);
    }
    if (a.sample !== world.sample) throw new Error(`notary export --explain: ${a.id} sample flag differs from world ${world.key}`);
  }
  const ids = out.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new Error("notary export --explain: duplicate answer ids");
  return out;
}

export function buildExplainFile(worlds: readonly World[]): ExplainFile {
  return ExplainFileSchema.parse({ generatedBy: EXPLAIN_GENERATED_BY, answers: worlds.flatMap(worldAnswers) });
}

export function renderExplainFile(file: ExplainFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export interface ExplainExportOptions {
  webBundlesDir?: string;
  /** Directory explain.json is written to (default packages/web/public/content). */
  contentDir?: string;
}

export interface ExplainExportResult {
  path: string;
  file: ExplainFile;
  lines: string[];
}

export async function writeExplain(opts: ExplainExportOptions = {}): Promise<ExplainExportResult> {
  const { worlds, skipped } = loadPublishedWorlds(opts.webBundlesDir);
  const file = buildExplainFile(worlds);
  const dir = opts.contentDir ?? EXPLAIN_PATHS.contentDir;
  await mkdir(dir, { recursive: true });
  const path = join(dir, EXPLAIN_FILE);
  await writeFile(path, renderExplainFile(file), "utf8");
  const lines = [`notary export --explain: ${file.answers.length} answer(s) from ${worlds.reduce((n, w) => n + w.bundles.length, 0)} published bundle(s)`];
  for (const w of worlds) {
    const answers = file.answers.filter((a) => a.runIds.some((r) => w.bundles.some((b) => b.runId === r)));
    const kinds = new Map<string, number>();
    for (const a of answers) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
    lines.push(
      `  ${w.key}${w.sample ? " (FIXTURE, sample: true)" : ""}: ${w.bundles.length ? `${w.bundles.length} bundle(s)` : "no live runs recorded"}; ${answers.length} answer(s)${
        kinds.size ? ` (${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")})` : ""
      }`,
    );
  }
  for (const s of skipped) lines.push(`  SKIPPED ${s.file}: ${s.reason}`);
  lines.push(`  ${path}`);
  return { path, file, lines };
}
