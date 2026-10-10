import { afterEach, describe, expect, it, vi } from "vitest";
import { readOptionalJSON } from "../src/optional-json";
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
