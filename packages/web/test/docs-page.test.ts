// /docs: the guide's sidebar and sections come from one list, and every command, flag and variable
// it documents exists in the code (packages/core/src/cli.ts, .env.example), so the docs can't drift.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import DocsPage, { DOCS_TITLE, groupedSections } from "../src/docs/DocsPage";
import { COMMANDS, ENV_GROUPS, INSTALL_COMMANDS, QUICK_LINKS, SECTIONS, flagName } from "../src/docs/content";
import { copyText } from "../src/docs/parts";

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const cli = repoFile("packages/core/src/cli.ts");

const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/docs"] }, createElement(DocsPage)));

/** The inner HTML of the first <nav> with this aria-label. */
function navHtml(label: string): string {
  const start = html.indexOf(`<nav aria-label="${label}"`);
  expect(start, `nav "${label}"`).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</nav>", start));
}
const hrefsIn = (fragment: string) => [...fragment.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
const sectionIds = () => [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]!);

/** The source of one top-level command's builder chain in cli.ts. */
function commandBlock(top: string): string {
  const start = cli.indexOf(`.command("${top}")`);
  expect(start, `cli.ts declares .command("${top}")`).toBeGreaterThanOrEqual(0);
  const next = cli.indexOf("\n  program\n", start);
  return cli.slice(start, next === -1 ? cli.indexOf("return program;", start) : next);
}

describe("docs page structure", () => {
  it("every sidebar item links to a section with that id, in page order", () => {
    const sidebar = hrefsIn(navHtml("Guide contents"));
    const ids = sectionIds();
    expect(sidebar.length).toBe(SECTIONS.length);
    for (const id of sidebar) expect(ids, `section #${id}`).toContain(id);
    expect(sidebar).toEqual(ids);
    expect(ids).toEqual(SECTIONS.map((s) => s.id));
  });

  it("the phone Contents list matches the sidebar", () => {
    expect(hrefsIn(navHtml("Guide contents, compact"))).toEqual(hrefsIn(navHtml("Guide contents")));
  });

  it("section ids are unique, each section has a labelled h2, and every group is used", () => {
    expect(new Set(SECTIONS.map((s) => s.id)).size).toBe(SECTIONS.length);
    for (const s of SECTIONS) {
      expect(html).toContain(`aria-labelledby="${s.id}-heading"`);
      expect(html).toContain(`<h2 id="${s.id}-heading">`);
    }
    expect(groupedSections().flatMap((g) => g.items)).toHaveLength(SECTIONS.length);
  });

  it("quick links point at real sections", () => {
    for (const q of QUICK_LINKS) expect(SECTIONS.map((s) => `#${s.id}`)).toContain(q.href);
  });

  it("has a skip link, one h1, the eyebrow and the top-bar links", () => {
    expect(html).toContain('href="#docs-main"');
    expect(html).toContain('id="docs-main"');
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain("The Notary guide");
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Notary<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/app"[^>]*>Open dashboard<\/a>/);
    expect(DOCS_TITLE).toBe("Docs · Notary");
  });

  it("wears the landing site's chrome: its nav classes in ink, its footer, no paper color of its own", () => {
    expect(html).toMatch(/<header class="l-nav docs-nav" data-tone="dark"/);
    expect(html).toContain('class="l-footer"');
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/docs"[^>]*>Docs<\/a>|<a[^>]*href="\/docs"[^>]*aria-current="page"[^>]*>Docs<\/a>/);
    const css = readFileSync(new URL("../src/docs/docs.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/--docs-paper/);
    expect(css, "colors come from tokens.css").not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/);
    expect(css, "no vertical accent rules: the Hook Sidebar rail is the only one").not.toMatch(/border-left\s*:/);
    expect(css, "the sidebar scrolls without a visible scrollbar").toMatch(/\.docs-side,\s*\.docs-toc-compact\s*\{\s*scrollbar-width:\s*none/);
  });

  it("each sidebar group is a Hook Sidebar whose rail follows the section in view", () => {
    const sidebar = navHtml("Guide contents");
    expect(sidebar.match(/data-slot="hook-sidebar"/g)).toHaveLength(groupedSections().length);
    // Server render: the first section is the one in view, marked in its group only.
    expect(sidebar.match(/aria-current="location"/g)).toHaveLength(1);
    expect(sidebar).toMatch(new RegExp(`data-active="true"[^>]*href="#${SECTIONS[0]!.id}"`));
  });

  it("credits Rare UI with a visible link and keeps its copyright notice in the ported source", () => {
    expect(html).toMatch(/Sidebar component by\s*<a href="https:\/\/rareui\.com"[^>]*>Rare UI<\/a>/);
    const source = readFileSync(new URL("../src/components/ui/hook-sidebar.tsx", import.meta.url), "utf8");
    expect(source.slice(0, 2000)).toContain("Copyright (c) 2026 Swami Malode");
    expect(source.slice(0, 2000)).toContain("MIT + Commons Clause License Condition v1.0 + Attribution");
    const credits = readFileSync(new URL("../docs/CREDITS.md", import.meta.url), "utf8");
    expect(credits).toContain("https://github.com/swamimalode07/rare-ui");
    expect(credits).toContain("hook-sidebar.tsx");
  });

  it("is routed lazily above the catch-all", () => {
    const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
    expect(main).toMatch(/lazy\(\(\) => import\("\.\/docs\/DocsPage"\)\)/);
    const docs = main.indexOf('path="/docs"');
    expect(docs).toBeGreaterThanOrEqual(0);
    expect(docs).toBeLessThan(main.indexOf('path="*"'));
  });
});

describe("docs match the code", () => {
  it("every documented command exists in cli.ts, with its flags", () => {
    for (const c of COMMANDS) {
      const [top, ...subs] = c.name.split(" ");
      const block = commandBlock(top!);
      for (const sub of subs) expect(block, `${c.name}: .command("${sub}")`).toContain(`.command("${sub}")`);
      for (const f of c.flags) {
        const name = flagName(f);
        expect(name, `${c.name}: flag "${f}"`).toMatch(/^--[a-z][a-z-]*$/);
        expect(block, `${c.name}: ${name} is declared on this command`).toMatch(new RegExp(`"${name}[ "]`));
      }
    }
  });

  it("every command in cli.ts is documented", () => {
    const declared = [...cli.matchAll(/\.command\("([^"]+)"\)/g)].map((m) => m[1]!);
    const documented = new Set(COMMANDS.flatMap((c) => c.name.split(" ")));
    for (const name of declared) expect(documented, `cli.ts command "${name}"`).toContain(name);
  });

  it("the Commands table renders every command", () => {
    for (const c of COMMANDS) expect(html).toContain(`<code class="docs-inline">${c.name}</code>`);
  });

  it("every documented variable is in .env.example", () => {
    const example = repoFile(".env.example");
    for (const v of ENV_GROUPS.flatMap((g) => g.vars)) expect(example, v.name).toMatch(new RegExp(`^${v.name}=`, "m"));
  });

  it("the README's install commands match the guide", () => {
    const readme = repoFile("README.md").replace(/\r\n/g, "\n");
    expect(readme).toContain(INSTALL_COMMANDS);
  });

  it("documents the pinned pnpm version and the Node floor", () => {
    const pkg = JSON.parse(repoFile("package.json")) as { packageManager: string; engines: { node: string } };
    const pnpm = pkg.packageManager.replace(/^pnpm@/, "");
    expect(html).toContain(`pnpm ${pnpm}`);
    expect(pkg.engines.node).toBe(">=22");
    expect(html).toContain("Node 22 or newer");
  });
});

describe("code blocks", () => {
  it("Copy leaves out comment-only and blank lines", () => {
    expect(copyText("pnpm notary serve\n# in a second terminal\n\npnpm --filter @notary/web dev")).toBe("pnpm notary serve\npnpm --filter @notary/web dev");
  });
});
