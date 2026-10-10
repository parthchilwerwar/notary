// V5: Certificates "why" column and the Evidence page's fixture pair choice.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RunBundle } from "../../core/src/schema";
import { reasonText } from "../src/Certificates";
import { fixturePair } from "../src/Evidence";

const pub = (p: string) =>
  JSON.parse(readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8"));

describe("reasonText", () => {
  it("drops a reason that only repeats the status pill", () => {
    expect(reasonText({ kind: "never_probed", reason: "never probed" })).toBe("");
  });
  it("strips the repeated status prefix and keeps the rest", () => {
    expect(
      reasonText({ kind: "abstained", reason: "abstained: no further probe design" }),
    ).toBe("no further probe design");
  });
  it("keeps a reason that adds information", () => {
    expect(
      reasonText({ kind: "revoked", reason: "certificate revoked: crossed back over 0.5" }),
    ).toBe("certificate revoked: crossed back over 0.5");
  });
  it("every published not-certified row keeps its recorded reason or the pill says it all", () => {
    for (const s of ["default", "change-api"])
      for (const t of ["crustdata", "dodo"]) {
        const file = pub(`certificates/fixture/${s}/${t}.json`);
        for (const row of file.noCertificates) {
          const text = reasonText(row);
          expect(text === "" || row.reason.endsWith(text)).toBe(true);
        }
      }
  });
});

describe("fixturePair", () => {
  const index = pub("bundles/fixture/index.json") as { runId: string }[];
  const all = index.map((e) => pub(`bundles/fixture/${e.runId}.json`) as RunBundle);
  const byId = (id: string) => all.find((b) => b.runId === id)!;

  it("prefers the selected run's own scenario", () => {
    const pair = fixturePair(all, byId("demo-change-api-run-guarded"))!;
    expect(pair.guarded.runId).toBe("demo-change-api-run-guarded");
    expect(pair.naive.runId).toBe("demo-change-api-run-naive");
    const other = fixturePair(all, byId("demo-notarize-dodo"))!;
    expect(other.guarded.runId).toBe("demo-run-guarded");
    expect(other.naive.runId).toBe("demo-run-naive");
  });
  it("never pairs runs from two scenarios", () => {
    for (const b of all) {
      const pair = fixturePair(all, b);
      if (!pair) continue;
      expect(pair.guarded.runId.replace(/-run-guarded$/, "")).toBe(
        pair.naive.runId.replace(/-run-naive$/, ""),
      );
    }
  });
});
