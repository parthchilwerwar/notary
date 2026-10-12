// The hosted site (packages/web/vercel.json): client routes load the app on a direct visit or a
// refresh, the published data files are never rewritten to index.html (a missing bundle must stay a
// 404, not an HTML page), and every data file is served with no-cache. Plus the static SEO basics.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Rule = { source: string; destination?: string; headers?: { key: string; value: string }[] };
const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { rewrites: Rule[]; headers: Rule[] };
const publicFile = (path: string) => new URL(`../public/${path}`, import.meta.url);

/** Vercel source pattern (path-to-regexp subset used here: `:name*`, `:name`, regex groups) → RegExp. */
function sourceRegex(source: string): RegExp {
  // `(...)` groups are raw regex; everything outside them is a literal path with named params.
  const pattern = source
    .split(/(\([^)]*\))/)
    .map((part) =>
      part.startsWith("(")
        ? part
        : part
            .replace(/[.+?^${}|[\]\\]/g, "\\$&")
            .replace(/:[A-Za-z]+\*/g, ".*")
            .replace(/:[A-Za-z]+/g, "[^/]+"),
    )
    .join("");
  return new RegExp(`^${pattern}$`);
}
const rewritten = (path: string) => config.rewrites.find((r) => sourceRegex(r.source).test(path))?.destination;
const headerFor = (path: string, key: string) =>
  config.headers.filter((r) => sourceRegex(r.source).test(path)).flatMap((r) => r.headers ?? []).find((h) => h.key === key)?.value;

const DATA_PATHS = [
  "/bundles/index.json",
  "/bundles/fixture/index.json",
  "/bundles/missing-run.json",
  "/certificates/dodo.json",
  "/certificates/fixture/index.json",
  "/incidents/index.json",
  "/evidence/evidence.json",
  "/content/glossary.json",
  "/economics.json",
];

describe("vercel.json", () => {
  it("client routes are rewritten to the app: /app, its pages and /docs", () => {
    for (const path of ["/app", "/app/run", "/app/certificates/cert-1", "/docs"]) expect(rewritten(path), path).toBe("/index.html");
  });

  it("published data and built assets are never rewritten to index.html", () => {
    for (const path of [...DATA_PATHS, "/assets/index-abc.js", "/robots.txt", "/favicon.svg", "/og.png"]) expect(rewritten(path), path).toBeUndefined();
  });

  it("every published data file is served with no-cache", () => {
    for (const path of DATA_PATHS) expect(headerFor(path, "Cache-Control"), path).toBe("no-cache");
    expect(headerFor("/assets/index-abc.js", "Cache-Control")).toMatch(/immutable/);
  });
});

describe("static SEO basics", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  it("robots.txt is published", () => {
    expect(readFileSync(publicFile("robots.txt"), "utf8")).toMatch(/^User-agent: \*$/m);
  });

  it("the favicon is a real file", () => {
    const href = /<link rel="icon"[^>]*href="\/([^"]+)"/.exec(html)?.[1];
    expect(href).toBeTruthy();
    expect(existsSync(publicFile(href!)), `public/${href}`).toBe(true);
  });

  it("has Open Graph and Twitter tags; the preview image, when named, is a published file", () => {
    for (const tag of ['property="og:title"', 'property="og:description"', 'name="twitter:card"', 'name="twitter:title"', 'name="twitter:description"'])
      expect(html).toContain(tag);
    for (const m of html.matchAll(/(?:property="og:image"|name="twitter:image") content="\/([^"]+)"/g))
      expect(existsSync(publicFile(m[1]!)), `public/${m[1]} (written by scripts/screenshots.mjs)`).toBe(true);
  });
});

describe("404 pages", () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

  it("the site-wide catch-all has its own h1", () => {
    const main = source("main.tsx");
    const catchAll = main.slice(main.indexOf('path="*"'));
    expect(catchAll).toMatch(/<h1[^>]*>Page not found<\/h1>/);
  });

  it("the dashboard's NotFound is titled by the page header (the page's h1)", () => {
    const app = source("App.tsx");
    const notFound = app.slice(app.indexOf("function NotFound"), app.indexOf("export default function App"));
    expect(notFound).toMatch(/<PageHeader[\s\S]*title="Page not found"/);
    expect(source("ui/PageHeader.tsx")).toMatch(/<h1 className="[^"]*ui-title-page/);
  });
});
