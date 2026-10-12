// Real runs only: the dashboard and the landing never show fixture data unless the development-only
// `?fixtures=1` view asks for it, and only that view carries the fixture disclosure. These tests
// read the published files in public/ (no network) and the pure selection the provider, the Run
// page, the landing and the approvals count all use.
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BundleIndexEntry } from "../../core/src/schema";
import { finishedEntries, PublishedFiles, ReplaySource, type RunEntry } from "../src/data";
import { FIXTURE_BANNER } from "../src/data/types";
import {
  defaultRunId,
  fixturesRequested,
  groupRuns,
  keepView,
  NO_RUNS_COMMANDS,
  recordPath,
  resolveDataMode,
  visibleRuns,
  withRun,
} from "../src/app/links";
import { NoRunsPage } from "../src/components/shell/AppShell";
import { FixtureNote, Note, PageHeader, PageHeaderContext } from "../src/ui";

/** PublishedFiles over the files in public/ (no network). */
const files = () =>
  new PublishedFiles({
    base: "/",
    fetchImpl: (async (url: string) => {
      const p = new URL(`../public/${decodeURIComponent(String(url).replace(/^\//, ""))}`, import.meta.url);
      return existsSync(p)
        ? new Response(readFileSync(p), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch,
  });

/** The published sample runs (fixtures and the synthetic SAMPLE); real exports in public/ vary, so tests add their own. */
const sampleRuns = async () =>
  (await new ReplaySource({ published: files() }).listRuns()).filter((r) => r.state === "finished" && r.sample);
const asReal = (e: RunEntry, runId: string): RunEntry => ({ ...(e as BundleIndexEntry & { state: "finished" }), runId, sample: false });

afterEach(() => vi.unstubAllGlobals());

describe("which runs the dashboard shows", () => {
  it("reads the fixture flag only from ?fixtures=1", () => {
    expect(fixturesRequested("?fixtures=1")).toBe(true);
    expect(fixturesRequested("?run=x&fixtures=1")).toBe(true);
    expect(fixturesRequested(new URLSearchParams("fixtures=1"))).toBe(true);
    for (const q of ["", "?fixtures=0", "?fixtures=true", "?fixture=1", null, undefined]) expect(fixturesRequested(q)).toBe(false);
  });

  it("real runs exist: only real runs are listed, no fixture run and no fixture group", async () => {
    const published = await sampleRuns();
    expect(published.length).toBeGreaterThan(0);
    const runs = [...published, asReal(published[0]!, "real-1"), asReal(published[1]!, "real-2")];
    const visible = visibleRuns(runs, false);
    expect(visible.map((r) => r.runId).sort()).toEqual(["real-1", "real-2"]);
    const entries = finishedEntries(visible);
    expect(groupRuns(entries, "static").map((g) => g.kind)).toEqual(["recorded"]);
    expect(entries.find((e) => e.runId === defaultRunId(entries))!.sample).toBe(false);
    // A live run still running is real and stays visible.
    const running: RunEntry = { runId: "live-1", state: "running", kind: "run", startedAt: "2026-10-12T00:00:00.000Z" };
    expect(visibleRuns([...runs, running], false).map((r) => r.runId)).toContain("live-1");
  });

  it("no real run: nothing is listed (the empty state), never the fixture runs", async () => {
    const published = await sampleRuns();
    const visible = visibleRuns(published, false);
    expect(visible).toEqual([]);
    expect(groupRuns(finishedEntries(visible), "static")).toEqual([]);
    expect(defaultRunId(finishedEntries(visible))).toBeUndefined();
  });

  it("?fixtures=1: fixture runs only (never a real or running run), and the mode is Fixture", async () => {
    const published = await sampleRuns();
    const running: RunEntry = { runId: "live-1", state: "running", kind: "run", startedAt: "2026-10-12T00:00:00.000Z" };
    const visible = visibleRuns([...published, asReal(published[0]!, "real-1"), running], true);
    expect(visible.length).toBe(published.length);
    expect(visible.every((r) => r.state === "finished" && r.sample)).toBe(true);
    const entries = finishedEntries(visible);
    expect(groupRuns(entries, "static").map((g) => g.kind)).toEqual(["fixture"]);
    expect(resolveDataMode("static", entries.find((e) => e.runId === defaultRunId(entries)))).toBe("fixture");
  });

  it("keeps ?fixtures=1 on in-app links while it is on, and adds nothing otherwise", () => {
    expect(withRun("/app/run", "r")).toBe("/app/run?run=r");
    expect(recordPath.run("r")).toBe("/app/run?run=r");
    vi.stubGlobal("location", { search: "?run=r&fixtures=1" });
    expect(withRun("/app/certificates", "r")).toBe("/app/certificates?run=r&fixtures=1");
    expect(recordPath.run("r")).toBe("/app/run?run=r&fixtures=1");
    expect(withRun(recordPath.decision("d"), "r")).toBe("/app/run?run=r&decision=d&fixtures=1");
    expect(keepView("/app/run?fixtures=1")).toBe("/app/run?fixtures=1");
  });
});

describe("what the dashboard renders", () => {
  const inShell = (node: ReturnType<typeof createElement>, note?: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(PageHeaderContext.Provider, { value: { inShell: true, note } }, node)),
    );

  it("no real run: a clean empty state with the two commands, no fixture data and no banner", () => {
    const html = inShell(createElement(NoRunsPage, { title: "Run", fixtures: false }));
    expect(html).toContain("No runs recorded yet");
    for (const c of NO_RUNS_COMMANDS) expect(html).toContain(c);
    expect(NO_RUNS_COMMANDS).toEqual(["pnpm notary notarize --tool crustdata", "pnpm notary export"]);
    expect(html).not.toContain(FIXTURE_BANNER);
    expect(html).not.toMatch(/demo-|simulated/i);
  });

  it("the fixture banner appears only in the ?fixtures=1 view (the shell passes it for a sample run only)", () => {
    const header = createElement(PageHeader, { title: "Run", summary: "s" });
    expect(inShell(header)).not.toContain(FIXTURE_BANNER);
    expect(inShell(header, createElement(FixtureNote)).split(FIXTURE_BANNER).length - 1).toBe(1);
    const shell = readFileSync(new URL("../src/components/shell/AppShell.tsx", import.meta.url), "utf8");
    expect(shell).toMatch(/note: sample \? <FixtureNote/);
    // FixtureNote is the only place the banner text is rendered from.
    const users = ["pages/approvals/RecordedHolds.tsx", "pages/report/ReportPage.tsx"].map((p) =>
      readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8"),
    );
    for (const src of users) expect(src).not.toMatch(/<FixtureNote/);
  });

  it("notes carry an icon and no accent rule", () => {
    const html = renderToStaticMarkup(createElement(Note, { tone: "warning", children: "Held." }));
    expect(html).toContain('role="note"');
    expect(html).toContain("<svg");
    expect(html).toContain('data-tone="warning"');
    for (const css of ["ui/kit.css", "pages/approvals/approvals.css", "pages/certificates/certificates.css", "pages/chat/chat.css", "components/trail/trail.css"]) {
      const text = readFileSync(new URL(`../src/${css}`, import.meta.url), "utf8");
      expect(text, css).not.toMatch(/border-left:\s*[23]px/);
      expect(text, css).not.toMatch(/inset [23]px 0 0/);
    }
  });
});
