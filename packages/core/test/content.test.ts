// Dashboard glossary (src/export/content.ts): generated from code, so it must cover every claim and
// every enum value exactly once, read as plain one-sentence explanations, and match the committed
// packages/web/public/content/glossary.json byte for byte (read-only here; writes go to temp dirs).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allContracts } from "../src/contracts/index.js";
import { CONTENT_GENERATED_BY, GLOSSARY_PATH, GlossarySchema, buildGlossary, renderGlossary, writeGlossary } from "../src/export/content.js";
import {
  BeliefStatusSchema,
  DecisionStatusSchema,
  DefectClassSchema,
  GuardKindSchema,
  PolicyOutcomeSchema,
  ProbeTemplateSchema,
  ProbeVerdictSchema,
} from "../src/schema/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const glossary = buildGlossary();

const EXPECTED_IDS = {
  claims: allContracts.map((e) => e.claim.id),
  defectClasses: DefectClassSchema.options,
  guardKinds: GuardKindSchema.options,
  beliefStatuses: BeliefStatusSchema.options,
  decisionStatuses: DecisionStatusSchema.options,
  probeVerdicts: ProbeVerdictSchema.options,
  policyOutcomes: PolicyOutcomeSchema.options,
  probeTemplates: ProbeTemplateSchema.options,
} as const;

const sectionKeys = Object.keys(EXPECTED_IDS) as Array<keyof typeof EXPECTED_IDS>;

describe("glossary coverage", () => {
  it.each(sectionKeys)("%s: exactly one entry per source id, no extras", (key) => {
    const ids = glossary.sections[key].map((e) => e.id);
    const expected: readonly string[] = EXPECTED_IDS[key];
    expect(expected.length).toBeGreaterThan(0);
    for (const id of expected) expect(ids.filter((x) => x === id), `${key}: ${id}`).toHaveLength(1);
    expect(ids.filter((id) => !expected.includes(id)), `${key}: extra ids`).toEqual([]);
    expect(ids).toHaveLength(expected.length);
    expect(glossary.counts[key]).toBe(expected.length);
  });

  it("claim entries carry the claim's tool, operation, docText and docUrl", () => {
    for (const { claim } of allContracts) {
      const e = glossary.sections.claims.find((x) => x.id === claim.id);
      expect(e).toMatchObject({ tool: claim.tool, operation: claim.operation, docText: claim.docText, docUrl: claim.docUrl });
    }
  });

  it("derives claim words from the expect rule", () => {
    const byId = new Map(glossary.sections.claims.map((e) => [e.id, e]));
    expect(byId.get("dodo.refunds.page-size-max-100")).toMatchObject({
      name: "Dodo list refunds: page size max 100",
      explanation: "Dodo says a page of refunds never holds more than 100 items.",
      example: "Asking for 101 refunds per page should return at most 100 or an error.",
    });
    expect(byId.get("dodo.customer.missing-email-422")?.example).toBe("Try it: omit the required email, and the reply should be status 422.");
  });
});

describe("glossary wording", () => {
  const all = sectionKeys.flatMap((k) => glossary.sections[k].map((e) => ({ key: k, ...e })));

  it("every explanation is one non-empty sentence (a single period, at the end, no newline)", () => {
    for (const e of all) {
      expect(e.explanation.trim().length, `${e.key}/${e.id}`).toBeGreaterThan(1);
      expect(e.explanation, `${e.key}/${e.id}`).not.toMatch(/\n/);
      expect(e.explanation.endsWith("."), `${e.key}/${e.id}`).toBe(true);
      expect(e.explanation.split(".").length - 1, `${e.key}/${e.id}: ${e.explanation}`).toBe(1);
    }
  });

  it("every name and example is non-empty", () => {
    for (const e of all) {
      expect(e.name.trim(), `${e.key}/${e.id}`).not.toBe("");
      expect(e.example.trim(), `${e.key}/${e.id}`).not.toBe("");
    }
  });

  it("no raw field paths or snake_case ids leak into explanations", () => {
    for (const e of all) expect(e.explanation, `${e.key}/${e.id}`).not.toMatch(/\[\]|[a-z]_[a-z]/);
  });
});

describe("glossary file", () => {
  it("validates with the zod schema and carries the header", () => {
    const parsed = GlossarySchema.parse(JSON.parse(renderGlossary(glossary)));
    expect(parsed.generatedBy).toBe(CONTENT_GENERATED_BY);
    expect(parsed.note).toMatch(/generated from code/i);
    expect(JSON.stringify(parsed)).not.toMatch(/generatedAt|timestamp/);
  });

  it("is deterministic: building twice is byte-identical", () => {
    expect(renderGlossary(buildGlossary())).toBe(renderGlossary(buildGlossary()));
  });

  it("writeGlossary writes exactly renderGlossary() into the given directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notary-content-test-"));
    dirs.push(dir);
    const { path } = await writeGlossary(join(dir, "content"));
    expect(readFileSync(path, "utf8")).toBe(renderGlossary());
  });

  it("the committed glossary.json equals a fresh build (if this fails: rerun `pnpm notary export --content`)", () => {
    expect(existsSync(GLOSSARY_PATH), `${GLOSSARY_PATH} missing: run \`pnpm notary export --content\``).toBe(true);
    const committed = readFileSync(GLOSSARY_PATH, "utf8").replace(/\r\n/g, "\n");
    expect(committed, "glossary.json is stale: rerun `pnpm notary export --content` and commit it").toBe(renderGlossary());
  });
});
