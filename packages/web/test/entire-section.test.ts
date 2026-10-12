// Entire on the Report page: the published public/evidence/entire.json validates against the shared
// schema, the loader withholds anything else, and the view renders only what the file says. The
// checkpoint used for the row test is the REAL one Entire recorded for a headless adversary review on
// 2026-10-12 (core/test/fixtures/entire/), shaped the way `notary export --entire` writes it.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EntireFileSchema, type EntireFile } from "../../core/src/schema/entire";
import { ENTIRE_FILE, loadEntireFile } from "../src/data/entire";
import { EntireView } from "../src/pages/report/EntireSection";

const published = (): EntireFile | undefined => {
  try {
    return EntireFileSchema.parse(JSON.parse(readFileSync(new URL("../public/evidence/entire.json", import.meta.url), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

const render = (file: EntireFile) => renderToStaticMarkup(createElement(EntireView, { file }));

const withCheckpoint = (base: EntireFile): EntireFile =>
  EntireFileSchema.parse({
    ...base,
    checkpoints: [
      {
        id: "01M4PYAG60V4ZBFR9WN79VAWB1",
        at: "2026-10-12T02:15:49.000Z",
        agent: "Claude Code",
        sessionIds: ["f5cf4a6a-3f07-4c6d-8b51-e9ecce71d467"],
        model: "claude-opus-5-5",
        commit: "e6cb269672b674cd3990aac2b212134419ce66c0",
        message: "adversary: downgrade belief-crustdata.enrich.headcount-total-integer",
        filesTouched: ["adversary/verdicts/belief-crustdata.enrich.headcount-total-integer.json"],
        tokens: { input: 6, output: 1894, cacheRead: 17027, cacheCreation: 8670, apiCalls: 3 },
        kind: "adversary-review",
        review: { verdict: "downgrade", beliefId: "belief-crustdata.enrich.headcount-total-integer" },
        logsOnly: true,
      },
    ],
    checkpointsNote: null,
  });

describe("public/evidence/entire.json", () => {
  it("validates against the shared schema (written by `pnpm notary export --entire`)", () => {
    const file = published();
    if (!file) return; // not published yet; the page shows the export command
    expect(file.kind).toBe("notary-entire/1");
    if (file.coverage) expect(file.coverage.unguarded).toHaveLength(file.coverage.unguardedCallSites);
  });

  it("renders the published file: its numbers and its own reason when a list is empty", () => {
    const file = published();
    if (!file) return;
    const html = render(file);
    expect(html).toContain(`>${file.checkpoints.length}<`);
    if (file.checkpoints.length === 0) expect(html).toContain("Entire-Checkpoint");
    if (file.coverage) {
      expect(html).toContain("unguarded call sites");
      expect(html).toContain(file.coverage.command);
    } else expect(html).toContain(file.coverageNote!.split("`")[0]!.slice(0, 30));
  });
});

describe("EntireView", () => {
  const base = published() ?? EntireFileSchema.parse({
    kind: "notary-entire/1", repoHead: null, branch: "main",
    cli: { installed: true, version: "0.11.4", graphPlugin: "v0.4.0" },
    repo: { enabled: true, agents: ["Claude Code"], checkpointStore: "git-refs", commitLinking: "always" },
    checkpoints: [], checkpointsNote: "none yet", coverage: null, coverageNote: "skipped",
  });

  it("lists a checkpoint row: id, time, session, commit, files touched, and the review it records", () => {
    const html = render(withCheckpoint(base));
    expect(html).toContain("01M4PYAG60V4ZBFR9WN79VAWB1");
    expect(html).toContain('dateTime="2026-10-12T02:15:49.000Z"');
    expect(html).toContain("Claude Code");
    expect(html).toContain("f5cf4a6a");
    expect(html).toContain("e6cb269672b6");
    expect(html).toContain("adversary/verdicts/belief-crustdata.enrich.headcount-total-integer.json");
    expect(html).toContain("<strong>downgrade</strong>");
    expect(html).toMatch(/entire-figure">1<\/span><span class="entire-figure-label">adversary review/);
  });

  it("shows unguarded call sites in the unsafe color when coverage finds any", () => {
    if (!base.coverage) return;
    const bad = EntireFileSchema.parse({
      ...base,
      coverage: { ...base.coverage, unguardedCallSites: 1, unguarded: [{ op: "dodo.createRefund", file: "packages/core/src/x.ts", line: 4, detail: "called from x (entire graph)" }] },
    });
    const html = render(bad);
    expect(html).toContain("entire-figure entire-figure-bad");
    expect(html).toContain("packages/core/src/x.ts:4");
  });
});

describe("loadEntireFile", () => {
  const respond = (status: number, body: string, type = "application/json"): typeof fetch =>
    (async () => new Response(body, { status, headers: { "content-type": type } })) as typeof fetch;

  it("is undefined when the file is not published, and withholds anything that fails the schema", async () => {
    expect(ENTIRE_FILE).toBe("public/evidence/entire.json");
    expect(await loadEntireFile(undefined, respond(404, ""))).toBeUndefined();
    expect(await loadEntireFile(undefined, respond(200, "<!doctype html>", "text/html"))).toBeUndefined();
    await expect(loadEntireFile(undefined, respond(200, JSON.stringify({ kind: "notary-entire/1" })))).rejects.toThrow(/does not match the Entire schema/);
    await expect(loadEntireFile(undefined, respond(200, "{"))).rejects.toThrow(/not valid JSON/);
  });
});
