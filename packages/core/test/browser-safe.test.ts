import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// packages/web imports the schema and the bundle hash in the browser, so these modules (and
// everything they import) must not touch Node-only modules or globals.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
// certify/certificates.ts + report.ts: the dashboard can re-verify certificate sha256s in the browser.
const ENTRIES = ["schema/index.ts", "schema/bundle.ts", "bundle/hash.ts", "certify/certificates.ts", "certify/report.ts"];
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

describe("browser-safe shared modules (schema/bundle.ts, bundle/hash.ts)", () => {
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
