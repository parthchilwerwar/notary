import { afterEach, describe, expect, it, vi } from "vitest";
import { readOptionalJson } from "../src/data/http";
// Moved to the data layer: the published-file reader (src/data/http.ts).
const readOptionalJSON = (path: string) => readOptionalJson(`/${path}`, path);
afterEach(() => vi.unstubAllGlobals());
const reply = (response: Response) =>
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
describe("pending public exports", () => {
  it("treats missing files as pending", async () => {
    reply(new Response(null, { status: 404 }));
    expect(await readOptionalJSON("certificates/report.json")).toBeUndefined();
  });
  it("treats an HTML SPA fallback as pending", async () => {
    reply(
      new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    expect(await readOptionalJSON("certificates/report.json")).toBeUndefined();
  });
  it("does not disguise an upstream failure as missing data", async () => {
    reply(new Response(null, { status: 503 }));
    await expect(readOptionalJSON("certificates/report.json")).rejects.toThrow(
      "Data withheld",
    );
  });
  it("withholds data when the server reports a hash mismatch", async () => {
    reply(
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "x-notary-hash-mismatch": "1",
        },
      }),
    );
    await expect(readOptionalJSON("certificates/report.json")).rejects.toThrow(
      "hash mismatch",
    );
  });
  it("does not accept malformed JSON", async () => {
    reply(
      new Response("{", { headers: { "content-type": "application/json" } }),
    );
    await expect(
      readOptionalJSON("certificates/report.json"),
    ).rejects.toThrow();
  });
});

describe("invalid JSON is a plain-language error", () => {
  it("names the file and withholds it", async () => {
    reply(new Response("{oops", { headers: { "content-type": "application/json" } }));
    await expect(readOptionalJSON("certificates/report.json")).rejects.toThrow(
      "certificates/report.json is not valid JSON. Data withheld.",
    );
  });
  it("does the same for the tool evidence file", async () => {
    const { loadEvidence } = await import("../src/data");
    reply(new Response("{oops", { headers: { "content-type": "application/json" } }));
    await expect(loadEvidence()).rejects.toThrow("evidence/evidence.json is not valid JSON. Data withheld.");
    reply(new Response('[{"name":1}]', { headers: { "content-type": "application/json" } }));
    await expect(loadEvidence()).rejects.toThrow("does not match the evidence schema");
    // The cold dynamic import of the whole data layer took over 5 s once under full-suite load (K4).
  }, 20_000);
});
