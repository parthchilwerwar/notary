import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { BundleIndexSchema } from "../../core/src/schema/bundle";
import type { BundleIndexEntry } from "../../core/src/schema";
import { PublishedFiles, safeLink, validateBundle } from "../src/data";

// Moved to the data layer (src/data/published.ts): the old loadIndex/loadBundle/loadFixtureEntries.
const files = () => new PublishedFiles({ base: "/" });
const loadIndex = () => files().primaryIndex();
const loadFixtureEntries = () => files().fixtureIndex();
const loadBundle = async (entry: BundleIndexEntry) => {
  const f = files();
  vi.spyOn(f, "entry").mockResolvedValue({ ...entry, dir: "bundles" });
  return f.bundle(entry.runId);
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../public/bundles/sample-42.json", import.meta.url),
    "utf8",
  ),
);
const entries = BundleIndexSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../public/bundles/index.json", import.meta.url),
      "utf8",
    ),
  ),
);
afterEach(() => vi.unstubAllGlobals());
describe("bundle trust boundary", () => {
  it("validates every published fixture against the shared schema and browser hash function", () => {
    for (const entry of entries) {
      const raw = JSON.parse(
        readFileSync(
          new URL(`../public/bundles/${entry.runId}.json`, import.meta.url),
          "utf8",
        ),
      );
      expect(validateBundle(raw, entry).contentHash).toBe(entry.contentHash);
    }
    const fixtureIndex = new URL(
      "../public/bundles/fixture/index.json",
      import.meta.url,
    );
    if (existsSync(fixtureIndex)) {
      for (const entry of BundleIndexSchema.parse(
        JSON.parse(readFileSync(fixtureIndex, "utf8")),
      )) {
        const raw = JSON.parse(
          readFileSync(
            new URL(
              `../public/bundles/fixture/${entry.runId}.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        );
        expect(validateBundle(raw, entry).sample).toBe(true);
      }
    }
  });
  it("rejects altered content before it can be rendered", () => {
    expect(() =>
      validateBundle({
        ...fixture,
        metrics: { ...fixture.metrics, unsafe_actions_total: 999 },
      }),
    ).toThrow("hash mismatch");
  });
  it("rejects malformed data", () =>
    expect(() => validateBundle({ runId: "bad" })).toThrow("schema"));
  it("rejects an index that tries to relabel a fixture as live", () => {
    expect(() =>
      validateBundle(fixture, { ...entries[0], sample: false }),
    ).toThrow("index entry");
  });
  it("honors the server mismatch header even on an HTTP success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fixture), {
          headers: { "X-Notary-Hash-Mismatch": "1" },
        }),
      ),
    );
    await expect(loadBundle(entries[0])).rejects.toThrow("server reported");
  });
  it("shows a missing bundle as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 404, statusText: "Not Found" }),
        ),
    );
    await expect(loadBundle(entries[0])).rejects.toThrow("Not Found");
  });
  it("validates the index and rejects duplicate run identifiers", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify([entries[0], entries[0]])),
        ),
    );
    await expect(loadIndex()).rejects.toThrow("Duplicate");
  });
  it("allows recorded receipts and rejects executable links", () => {
    expect(safeLink("runs/example/spans.jsonl")).toBe(
      "runs/example/spans.jsonl",
    );
    expect(safeLink("javascript:alert(1)")).toBeUndefined();
    expect(safeLink("//unknown.example")).toBeUndefined();
  });
});

describe("unreadable data is a visible, plain-language error", () => {
  it("names a bundle that is not valid JSON and withholds it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{not json")));
    await expect(loadBundle(entries[0])).rejects.toThrow("is not valid JSON. Data withheld.");
  });
  it("rejects a fixture index that is not JSON or not the shared schema", async () => {
    const json = { "content-type": "application/json" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{not json", { headers: json })));
    await expect(loadFixtureEntries()).rejects.toThrow("not valid JSON");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('[{"runId":1}]', { headers: json })));
    await expect(loadFixtureEntries()).rejects.toThrow("shared Notary schema");
  });
});
