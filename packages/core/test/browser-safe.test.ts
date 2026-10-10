import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Imported exactly as packages/web would: the browser-safe schema and hash only, never src/certify.
import { canonicalJson, sha256Hex } from "../src/bundle/hash.js";
import { BundleIndexSchema, CertificateReportSchema, FixtureIndexSchema, ToolCertificatesSchema } from "../src/schema/index.js";

// packages/web imports the schema and the bundle hash in the browser, so these modules (and
// everything they import) must not touch Node-only modules or globals.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
// schema/certificate.ts: the certificate / revocation / report / fixture-index schemas the dashboard
// parses. certify/certificates.ts + report.ts: the dashboard can re-verify certificate sha256s in the browser.
const ENTRIES = ["schema/index.ts", "schema/bundle.ts", "schema/certificate.ts", "bundle/hash.ts", "certify/certificates.ts", "certify/report.ts"];
const ALLOWED_PACKAGES = new Set(["zod"]);
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const NODE_GLOBALS = /\b(process\.|Buffer\b|require\(|__dirname|__filename)/;

function importsOf(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
    specs.push((m[1] ?? m[2])!);
  }
  return specs;
}

function walk(): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const stack = ENTRIES.map((e) => resolve(SRC, e));
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    const specs = importsOf(readFileSync(file, "utf8"));
    seen.set(file, specs);
    for (const s of specs) if (s.startsWith(".")) stack.push(resolve(dirname(file), s.replace(/\.js$/, ".ts")));
  }
  return seen;
}

describe("browser-safe shared modules (schema/*, bundle/hash.ts)", () => {
  const graph = walk();

  it("the detector itself flags Node imports and globals (no vacuous pass)", () => {
    expect(importsOf(`import { createHash } from "node:crypto";\nexport * from "./x.js";\nconst m = await import("fs");`)).toEqual([
      "node:crypto",
      "./x.js",
      "fs",
    ]);
    expect(NODE_GLOBALS.test("const k = process.env.KEY;")).toBe(true);
  });

  it("reaches the expected modules", () => {
    const rel = [...graph.keys()].map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"));
    expect(rel).toEqual(expect.arrayContaining(ENTRIES));
  });

  it("imports nothing Node-only, transitively", () => {
    const bad: string[] = [];
    for (const [file, specs] of graph) {
      for (const s of specs) {
        if (s.startsWith(".")) continue;
        if (NODE_BUILTINS.has(s) || s.startsWith("node:") || !ALLOWED_PACKAGES.has(s)) bad.push(`${file}: ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("uses no Node-only globals", () => {
    const bad = [...graph.keys()].filter((f) => {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      return NODE_GLOBALS.test(code);
    });
    expect(bad).toEqual([]);
  });
});

// The committed certificate files parse with the browser-safe schemas, and every seal verifies with
// the browser-safe hash (sha256Hex(canonicalJson(record without sha256))), with no src/certify code.
const WEB_CERTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/public/certificates");
const WEB_BUNDLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/public/bundles");

function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? jsonFiles(p) : name.endsWith(".json") ? [p] : [];
    });
}

function seal(record: { sha256: string } & Record<string, unknown>): string {
  const { sha256: _omit, ...rest } = record;
  return sha256Hex(canonicalJson(rest));
}

describe("packages/web/public/certificates/** with the browser-safe schemas and hash", () => {
  const files = jsonFiles(WEB_CERTS);
  const rel = (p: string) => relative(WEB_CERTS, p).split(sep).join("/");
  const read = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

  it("finds the real and fixture certificate files", () => {
    const names = files.map(rel);
    expect(names).toEqual(expect.arrayContaining(["report.json", "crustdata.json", "dodo.json", "fixture/index.json"]));
  });

  it("every file parses: fixture/index.json, report.json files and per-tool files", () => {
    const failed: string[] = [];
    for (const f of files) {
      const name = rel(f);
      const schema = name === "fixture/index.json" ? FixtureIndexSchema : name.endsWith("report.json") ? CertificateReportSchema : ToolCertificatesSchema;
      const r = schema.safeParse(read(f));
      if (!r.success) failed.push(`${name}: ${r.error.message}`);
    }
    expect(failed).toEqual([]);
  });

  it("every certificate and revocation seal verifies; revoked certificates point at a revocation in the file", () => {
    const bad: string[] = [];
    let fixtureSealed = 0;
    for (const f of files) {
      const name = rel(f);
      if (name === "fixture/index.json" || name.endsWith("report.json")) continue;
      const t = ToolCertificatesSchema.parse(read(f));
      for (const c of t.certificates) {
        if (t.sample) fixtureSealed += 1;
        if (seal(c) !== c.sha256) bad.push(`${name}: certificate ${c.id}`);
        if (c.status === "revoked" && !t.revocations.some((r) => r.id === c.revocation?.id && r.certificateId === c.id)) bad.push(`${name}: ${c.id} has no matching revocation`);
      }
      for (const r of t.revocations) {
        if (t.sample) fixtureSealed += 1;
        if (seal(r) !== r.sha256) bad.push(`${name}: revocation ${r.id}`);
      }
    }
    expect(bad).toEqual([]);
    // Real data may honestly have none yet (no real runs); the fixture scenarios do, so the check is not vacuous.
    expect(fixtureSealed).toBeGreaterThan(0);
  });

  it("each report pins its per-tool files by sha256 of their canonical JSON", () => {
    const bad: string[] = [];
    for (const f of files.filter((p) => rel(p).endsWith("report.json"))) {
      const report = CertificateReportSchema.parse(read(f));
      for (const t of report.tools) {
        const p = join(dirname(f), t.file);
        const actual = sha256Hex(canonicalJson(read(p)));
        if (report.toolFileHashes[t.file] !== actual) bad.push(`${rel(f)} -> ${t.file}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every source bundle a certificate file cites is the published bundle (same contentHash) in public/bundles", () => {
    // Fixture certificates must be regenerated whenever `notary demo --fixture --publish` republishes bundles.
    const indexOf = (p: string) => new Map(BundleIndexSchema.parse(read(p)).map((e) => [e.runId, e.contentHash]));
    const real = indexOf(join(WEB_BUNDLES, "index.json"));
    const fixture = indexOf(join(WEB_BUNDLES, "fixture", "index.json"));
    const bad: string[] = [];
    for (const f of files) {
      const name = rel(f);
      if (name === "fixture/index.json") continue;
      const doc = (name.endsWith("report.json") ? CertificateReportSchema : ToolCertificatesSchema).parse(read(f));
      const published = doc.sample ? fixture : real;
      for (const s of doc.sourceBundles) if (published.get(s.runId) !== s.contentHash) bad.push(`${name}: ${s.runId} ${s.contentHash.slice(0, 12)}`);
    }
    expect(bad).toEqual([]);
  });

  it("fixture/index.json lists files that exist, and each scenario's counts equal its report's", () => {
    const index = FixtureIndexSchema.parse(read(join(WEB_CERTS, "fixture", "index.json")));
    expect(index.scenarios.length).toBeGreaterThan(0);
    for (const s of index.scenarios) {
      const report = CertificateReportSchema.parse(read(join(WEB_CERTS, "fixture", s.report)));
      expect(report.sample).toBe(true);
      expect(report.scenario).toBe(s.scenario);
      expect(report.overall).toEqual(s.overall);
      for (const file of s.files) expect(files.map(rel)).toContain(`fixture/${file}`);
    }
  });
});
