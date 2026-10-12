// K2 lint rule: dashboard pages and the shell build their UI from the kit in src/ui only, and no
// dashboard or kit file defines its own colors or fonts — raw hex colors and literal font families
// belong in src/design/tokens.css alone. K4 adds rgb()/hsl() color literals and the theme-color.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const rel = (p: string) => relative(SRC, p).replaceAll("\\", "/");
const files = (dirs: string[], ext: RegExp) => dirs.flatMap((d) => walk(join(SRC, d))).filter((p) => ext.test(p));

/** Source without comments (block, line and JSX comments), so prose like "DECISIONS #143" is ignored. */
function code(path: string): string {
  const text = readFileSync(path, "utf8");
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return path.endsWith(".css") ? noBlock : noBlock.replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const DASHBOARD = ["pages", "components/shell"];
const STYLED = ["pages", "components/shell", "components/trail", "ui"];

describe("UI kit boundary (K2)", () => {
  it("dashboard pages and the shell import UI components only from src/ui", () => {
    const banned = /from\s+["'](?:[./]+components\/(?:ui|landing|brand)(?:\/[^"']*)?|[./]+components\/SelectControl|@\/components\/[^"']*)["']/;
    const offenders = files(DASHBOARD, /\.(tsx?|mjs)$/)
      .filter((p) => banned.test(code(p)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("no raw hex color outside src/design/tokens.css in dashboard, trail or kit files", () => {
    const hex = /#[0-9a-fA-F]{3,8}\b/;
    const offenders = files(STYLED, /\.(tsx?|css)$/)
      .filter((p) => hex.test(code(p)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("no raw rgb()/rgba()/hsl()/hsla() color literal outside src/design/tokens.css in dashboard, trail or kit files", () => {
    const fn = /\b(?:rgba?|hsla?)\(/;
    const offenders = files(STYLED, /\.(tsx?|css)$/)
      .filter((p) => fn.test(code(p)))
      .map(rel);
    expect(offenders).toEqual([]);
    // The tokens file is where they belong (the overlay scrim is one).
    expect(readFileSync(join(SRC, "design/tokens.css"), "utf8")).toMatch(/--overlay:\s*rgb\(/);
  });

  it("the dashboard is light only: one page token, matching the browser theme-color, and nothing sets dark", () => {
    const tokens = readFileSync(join(SRC, "design/tokens.css"), "utf8");
    const pages = [...tokens.matchAll(/--page:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1]!.toUpperCase());
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const themeColor = /<meta name="theme-color" content="(#[0-9a-fA-F]{6})"/.exec(html)?.[1]?.toUpperCase();
    expect(pages).toEqual([themeColor]);
    expect(html).toMatch(/<html lang="en" data-theme="light">/);
    expect(tokens).not.toMatch(/data-theme="dark"/);
    const setsDark = walk(SRC)
      .filter((p) => /\.(tsx?|css)$/.test(p))
      .filter((p) => /dataset\.theme\s*=|data-theme="dark"\]\s*\{|notary-theme/.test(code(p)))
      .map(rel)
      // Chat's own token file is another page's; it only reacts to the attribute, which nothing sets.
      .filter((p) => !p.startsWith("pages/chat/"));
    expect(setsDark).toEqual([]);
  });

  it("font families come only from the token variables", () => {
    const offenders: string[] = [];
    for (const p of files(STYLED, /\.(tsx?|css)$/)) {
      const src = code(p);
      for (const m of src.matchAll(/font-family\s*:\s*([^;}]+)/g))
        if (!/^(var\(--[\w-]+\)|inherit)$/.test(m[1]!.trim())) offenders.push(`${rel(p)}: ${m[0]}`);
      for (const m of src.matchAll(/fontFamily\s*:\s*([^,}]+)/g)) offenders.push(`${rel(p)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the kit re-exports the landing's own components instead of forking them", () => {
    const index = readFileSync(join(SRC, "ui/index.ts"), "utf8");
    expect(index).toMatch(/export \{ Clouds \} from "\.\.\/components\/brand\/Clouds"/);
    expect(index).toMatch(/export \{ BrowserFrame \} from "\.\.\/components\/landing\/BrowserFrame"/);
    expect(index).toMatch(/ActionsChart as DitherChart/);
  });
});
