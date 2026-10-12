// Explain: a replay bundle re-serves its recorded run's probes from the cassette, so tool knowledge
// counts those probes once when the recorded run is published next to its replay.
// Uses one published fixture bundle (read-only) and a constructed replay copy of it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeBundle } from "../src/bundle/hash.js";
import { toolKnowledge } from "../src/explain/index.js";
import { EXPLAIN_PATHS } from "../src/explain/export.js";
import type { RunBundle } from "../src/schema/index.js";

const FIXTURE_DIR = join(EXPLAIN_PATHS.webBundlesDir, "fixture");
const withProbes = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json") && f !== "index.json" && !f.endsWith(".timeline.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as RunBundle)
  .find((b) => b.kind === "notarize" && b.probes.length > 0)!;

const count = (text: string): number => Number(/(\d+) probes? ran on/.exec(text)?.[1] ?? 0);

describe("toolKnowledge with replay bundles", () => {
  it("counts a recorded run's probes once, not once more per published replay", () => {
    const tool = withProbes.tool!;
    const own = withProbes.probes.filter((p) => p.tool === tool).length;
    expect(own).toBeGreaterThan(0);
    const replay = finalizeBundle({ ...withProbes, runId: `${withProbes.runId}-replay`, mode: "replay", replayOf: withProbes.runId });

    expect(count(toolKnowledge(tool, [withProbes])!.answer)).toBe(own);
    expect(count(toolKnowledge(tool, [withProbes, replay])!.answer)).toBe(own);
    // A replay published without its recorded run still reports the probes it reproduced.
    expect(count(toolKnowledge(tool, [replay])!.answer)).toBe(own);
  });
});
