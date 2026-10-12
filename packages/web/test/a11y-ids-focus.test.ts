// Accessibility: Hook Sidebar ids stay unique when the component is used more than once on a page
// (the /docs sidebar and its phone "Contents" copy, one rail per stage on the Run transcript), and a
// /docs table-of-contents jump moves keyboard focus to the chosen section.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { HookSidebar } from "../src/components/ui/hook-sidebar";
import DocsPage, { jumpToSection } from "../src/docs/DocsPage";
import { SECTIONS } from "../src/docs/content";

const inRouter = (path: string, ...children: ReactElement[]) =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, ...children));

const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
const labelledBy = (html: string) => [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]!);
const duplicates = (list: string[]) => list.filter((v, i) => list.indexOf(v) !== i);

describe("Hook Sidebar ids", () => {
  it("two sidebars with the same label render distinct label ids, each referenced by its own group", () => {
    const items = [
      { label: "Install", href: "#install" },
      { label: "Commands", href: "#commands" },
    ];
    const html = inRouter(
      "/docs",
      createElement(HookSidebar, { as: "div", label: "Start", items, value: 0 }),
      createElement(HookSidebar, { as: "div", label: "Start", items, value: 0 }),
    );
    const all = ids(html);
    expect(all).toHaveLength(2);
    expect(duplicates(all)).toEqual([]);
    // Each group names its own label, and every reference resolves to an id on the page.
    const refs = labelledBy(html);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
    for (const ref of refs) expect(all).toContain(ref);
  });

  it("the /docs page (sidebar + phone Contents list) has no duplicate ids and every aria-labelledby resolves", () => {
    const html = inRouter("/docs", createElement(DocsPage));
    const all = ids(html);
    expect(duplicates(all)).toEqual([]);
    for (const ref of labelledBy(html)) expect(all, `aria-labelledby="${ref}"`).toContain(ref);
  });
});

describe("/docs table-of-contents focus", () => {
  it("every section can take programmatic focus (tabindex -1) without joining the tab order", () => {
    const html = inRouter("/docs", createElement(DocsPage));
    for (const s of SECTIONS) expect(html).toMatch(new RegExp(`<section id="${s.id}"[^>]*tabindex="-1"`));
  });

  it("a jump scrolls the section into place, then focuses it without a second, instant scroll", () => {
    const calls: [string, unknown][] = [];
    const el = {
      scrollIntoView: (opts?: unknown) => void calls.push(["scroll", opts]),
      focus: (opts?: unknown) => void calls.push(["focus", opts]),
    } as Pick<HTMLElement, "scrollIntoView" | "focus">;

    jumpToSection(el, true);
    expect(calls).toEqual([
      ["scroll", { behavior: "smooth", block: "start" }],
      ["focus", { preventScroll: true }],
    ]);

    calls.length = 0;
    jumpToSection(el, false);
    expect(calls).toEqual([
      ["scroll", { behavior: "instant", block: "start" }],
      ["focus", { preventScroll: true }],
    ]);
  });
});
