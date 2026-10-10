import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateBundle } from "../src/data";
import { landingResults, loadEvidence } from "../src/landing-data";
const read = (id: string) =>
  validateBundle(
    JSON.parse(
      readFileSync(
        new URL(`../public/bundles/fixture/${id}.json`, import.meta.url),
        "utf8",
      ),
    ),
  );
const naive = read("demo-run-naive"),
  guarded = read("demo-run-guarded");
afterEach(() => vi.unstubAllGlobals());
describe("landing result provenance", () => {
  it("uses a fixture pair when no live bundle exists", () => {
    const result = landingResults([naive, guarded]);
    expect(result.sample).toBe(true);
    expect(result.naive?.runId).toBe(naive.runId);
    expect(result.guarded?.runId).toBe(guarded.runId);
  });
  it("prefers live runs and never fills a missing live side with fixtures", () => {
    const live = { ...guarded, sample: false, runId: "live-guarded" };
    const result = landingResults([naive, guarded, live]);
    expect(result.sample).toBe(false);
    expect(result.guarded).toBe(live);
    expect(result.naive).toBeUndefined();
  });
  it("does not label fixture queue outcomes live when only live notarization exists", () => {
    const live = { ...guarded, sample: false, kind: "notarize" as const };
    const result = landingResults([naive, guarded, live]);
    expect(result.sample).toBe(false);
    expect(result.guarded).toBeUndefined();
    expect(result.naive).toBeUndefined();
  });
  it("uses the most recent run on each side", () => {
    const earlier = { ...guarded, startedAt: "2020-01-01T00:00:00.000Z" };
    expect(landingResults([earlier, guarded, naive]).guarded).toBe(guarded);
  });
  it("leaves missing tool evidence pending instead of inventing status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    expect(await loadEvidence()).toEqual([]);
  });
  it("rejects an invented tool status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify([
              {
                name: "Entire",
                purpose: "Coverage",
                status: "complete",
                links: [],
              },
            ]),
            { headers: { "content-type": "application/json" } },
          ),
        ),
    );
    await expect(loadEvidence()).rejects.toThrow();
  });
});
