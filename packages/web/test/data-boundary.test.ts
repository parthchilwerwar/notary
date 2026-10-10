// Redesign R1: no file outside src/data/ may fetch or import published data files directly.
// Scans every .ts/.tsx under src/ (comments stripped) for references to public/ data paths.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Drop block and line comments (keeping "https://" inside strings). */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "bundles/", re: /\bbundles\// },
  // Dashboard routes (/app/certificates/:id) are not data paths.
  { name: "certificates/", re: /(?<!\/app\/)\bcertificates\// },
  { name: "content/explain", re: /\bcontent\/explain/ },
  { name: "content/glossary", re: /\bcontent\/glossary/ },
  { name: "evidence/evidence", re: /\bevidence\/evidence/ },
  { name: ".timeline.json", re: /\.timeline\.json/ },
  { name: "economics.json", re: /\beconomics\.json/ },
  { name: "import of ../public", re: /from\s+["'][^"']*\/public\b|import\(\s*["'][^"']*\/public\b/ },
  { name: "import.meta.env.BASE_URL", re: /import\.meta\.env\.BASE_URL/ },
  { name: "import.meta.env.VITE_NOTARY_API", re: /import\.meta\.env\.VITE_NOTARY_API/ },
];

export function violations(files: string[], root: string) {
  const out: string[] = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    if (rel.startsWith("data/")) continue;
    const lines = stripComments(readFileSync(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { name, re } of FORBIDDEN) if (re.test(line)) out.push(`src/${rel}:${i + 1} references ${name}`);
    });
  }
  return out;
}

describe("data boundary", () => {
  it("only src/data/ references published data paths (bundles, certificates, content, evidence, timelines)", () => {
    expect(violations(walk(SRC), SRC)).toEqual([]);
  });

  it("the scan catches a direct fixture fetch and ignores routes and comments", () => {
    const sample = [
      'fetch(`${base}bundles/fixture/index.json`)',
      'readOptionalJSON("certificates/report.json")',
      'const x = "content/explain.json";',
      'import data from "../public/evidence/evidence.json";',
      "`${id}.timeline.json`",
    ];
    for (const line of sample)
      expect(FORBIDDEN.some(({ re }) => re.test(stripComments(line))), line).toBe(true);
    for (const line of [
      'path: "/app/certificates/:certificateId"',
      "certificate: (id) => `/app/certificates/${id}`",
      "// reads public/bundles/index.json",
      "/* bundles/fixture */ const y = 1;",
      'const url = "https://example.com/x"; // bundles/',
    ])
      expect(FORBIDDEN.some(({ re }) => re.test(stripComments(line))), line).toBe(false);
  });
});
