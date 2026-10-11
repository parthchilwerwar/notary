/**
 * docs/EVALUATION.md "Evaluation suite" section (anchor #evaluation-suite, linked from the landing
 * page): generated from the PUBLISHED fixture bundles (packages/web/public/bundles/fixture/,
 * hash-verified), every number equal to the bundles' metrics/records, a plain-words disclosure that the
 * APIs were simulated, and the real-run sections left exactly as they are.
 */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CHANGE_API_DISCLOSURE, scenarioQuirks } from "../src/demo/index.js";
import { FIXTURE_MODELS } from "../src/demo/fixture-llm.js";
import { SUITE_DISCLOSURE_LEAD, SUITE_HEADING, renderEvaluationMd } from "../src/export/evaluation.js";
import type { EvaluationInput } from "../src/export/evaluation.js";
import { collectEvaluationSuite, heldRefunds } from "../src/export/suite.js";
import { AGENTS } from "../src/schema/agents.js";
import { BundleIndexSchema } from "../src/schema/bundle.js";
import { CertificateReportSchema } from "../src/schema/certificate.js";
import type { RunBundle } from "../src/schema/index.js";

const WEB_PUBLIC = fileURLToPath(new URL("../../web/public/", import.meta.url));
const FIXTURE_DIR = join(WEB_PUBLIC, "bundles", "fixture");
const EVALUATION_MD = fileURLToPath(new URL("../../../docs/EVALUATION.md", import.meta.url));
const LABEL = "packages/web/public/bundles/fixture";

const BASE: EvaluationInput = { bundles: [], skipped: [], excluded: [], checks: null, driftFixtures: [], generatedAt: "2026-10-11T00:00:00.000Z" };

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Cells of the markdown table rows that follow `heading`, up to the next heading. */
function tablesUnder(md: string, heading: string): string[][][] {
  const start = md.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  const body = end === -1 ? rest : rest.slice(0, end);
  const tables: string[][][] = [];
  let cur: string[][] | null = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("|")) {
      const cells = line.slice(1, -1).split(" | ").map((c) => c.trim());
      if (cells.every((c) => c === "---")) continue;
      if (!cur) tables.push((cur = []));
      cur.push(cells);
    } else cur = null;
  }
  return tables;
}

describe("evaluation suite: data", () => {
  it("reads every published fixture bundle (hash-verified), both scenarios, none skipped", () => {
    const suite = collectEvaluationSuite(FIXTURE_DIR, LABEL);
    expect(suite.skipped).toEqual([]);
    expect(suite.scenarios.map((s) => s.scenario)).toEqual(["default", "change-api"]);
    const index = BundleIndexSchema.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, "index.json"), "utf8")));
    const read = suite.scenarios.flatMap((s) => s.bundles.map((b) => [b.runId, b.contentHash]));
    expect(read.sort()).toEqual(index.map((e) => [e.runId, e.contentHash]).sort());
    for (const s of suite.scenarios) {
      expect(s.naive?.variant).toBe("naive");
      expect(s.guarded?.variant).toBe("guarded");
      for (const b of s.bundles) expect(b.sample).toBe(true);
    }
  });

  it("refuses a tampered fixture bundle (never used, listed as skipped)", () => {
    const dir = mkdtempSync(join(tmpdir(), "notary-suite-"));
    tmp.push(dir);
    for (const f of readdirSync(FIXTURE_DIR)) if (f.startsWith("demo-run-") && !f.endsWith(".timeline.json")) copyFileSync(join(FIXTURE_DIR, f), join(dir, f));
    const naive = JSON.parse(readFileSync(join(dir, "demo-run-naive.json"), "utf8")) as RunBundle;
    naive.metrics.unsafe_actions_total = 0; // edited after hashing
    writeFileSync(join(dir, "demo-run-naive.json"), JSON.stringify(naive));
    const suite = collectEvaluationSuite(dir, "tmp");
    expect(suite.skipped.map((s) => s.file)).toEqual(["demo-run-naive.json"]);
    expect(suite.skipped[0]!.reason).toMatch(/fails verification/);
    const s = suite.scenarios.find((x) => x.scenario === "default")!;
    expect(s.naive).toBeUndefined();
    const md = renderEvaluationMd({ ...BASE, suite });
    expect(md).toContain("| Naive (none published) |");
    expect(md).toContain("`demo-run-naive.json`: fails verification");
  });
});

describe("evaluation suite: EVALUATION.md section", () => {
  const suite = collectEvaluationSuite(FIXTURE_DIR, LABEL);
  const md = renderEvaluationMd({ ...BASE, suite });
  const section = md.slice(md.indexOf(SUITE_HEADING));

  it("every number equals the bundles' metrics, credits and decision records; certificates equal the published fixture reports", () => {
    for (const s of suite.scenarios) {
      const [measures, certs] = tablesUnder(md, `### Scenario \`${s.scenario}\``);
      expect(measures![0]).toEqual(["Measure", `Naive (\`${s.naive!.runId}\`)`, `Guarded (\`${s.guarded!.runId}\`)`, "Copied from"]);
      const rows = measures!.slice(1);
      let metricRows = 0;
      for (const [label, naive, guarded, source] of rows) {
        const key = /^`metrics\.(.+)`$/.exec(source!)?.[1];
        if (key) {
          metricRows += 1;
          expect(naive, `${s.scenario} ${label} naive`).toBe(String(s.naive!.metrics[key]));
          expect(guarded, `${s.scenario} ${label} guarded`).toBe(String(s.guarded!.metrics[key]));
        }
      }
      expect(metricRows).toBe(9);
      const row = (label: string) => rows.find((r) => r[0] === label)!;
      expect(row("Refunds held").slice(1, 3)).toEqual([String(heldRefunds(s.naive!).length), String(heldRefunds(s.guarded!).length)]);
      expect(row("Credits used").slice(1, 3)).toEqual([
        `${s.naive!.credits.total} of ${s.naive!.credits.budget}`,
        `${s.guarded!.credits.total} of ${s.guarded!.credits.budget}`,
      ]);
      // The landing page's three numbers are in the table, as the landing computes them.
      expect(row("Unsafe money actions").slice(1, 3)).toEqual([String(s.naive!.metrics.unsafe_actions_total), String(s.guarded!.metrics.unsafe_actions_total)]);

      const report = CertificateReportSchema.parse(JSON.parse(readFileSync(join(WEB_PUBLIC, "certificates", "fixture", s.scenario, "report.json"), "utf8")));
      const o = report.overall;
      expect(certs).toEqual([
        ["Claims", "Certified", "Matches docs", "Contradicts docs", "Revoked"],
        [o.claimsTotal, o.certified, o.matchesDocs, o.contradictsDocs, o.revoked].map(String),
      ]);
      expect(s.certificateSources).toEqual(report.sourceBundles.map((b) => b.runId));
    }
  });

  it("states plainly that the APIs were simulated, lists the planted quirks and model doubles from the demo code, and points to the real sections", () => {
    expect(section).toContain(SUITE_DISCLOSURE_LEAD);
    expect(section).toContain("against **simulated** Crustdata and Dodo APIs");
    expect(section).toContain("These are not live-API results");
    expect(section).toContain("Real-run results stay in the sections above (no real runs yet).");
    for (const [role, id] of Object.entries(FIXTURE_MODELS)) expect(section).toContain(`\`${id}\` (${AGENTS[role as keyof typeof FIXTURE_MODELS].name})`);
    for (const q of scenarioQuirks("default")) expect(section).toContain(`- \`${q.id}\` ${q.tool}, ${q.where}: ${q.behaviour}`);
    const q1 = scenarioQuirks("change-api").find((q) => q.id === "Q1")!;
    expect(section).toContain(`- \`Q1\` ${q1.tool}, ${q1.where}: ${q1.behaviour}`);
    expect(section).toContain(CHANGE_API_DISCLOSURE);
  });

  it("leaves the real-run sections exactly as they are", () => {
    const without = renderEvaluationMd(BASE);
    expect(md.slice(0, md.indexOf(SUITE_HEADING))).toBe(without.slice(0, without.indexOf(SUITE_HEADING)));
    expect(without.slice(without.indexOf(SUITE_HEADING))).toContain("Not generated for this export");
    // No fixture run is ever a real-run source.
    expect(md.slice(0, md.indexOf(SUITE_HEADING))).not.toMatch(/demo-(change-api-)?(run|notarize)-/);
  });

  it("the committed docs/EVALUATION.md carries the same suite section (regenerated with `pnpm notary export`)", () => {
    const committed = readFileSync(EVALUATION_MD, "utf8").replace(/\r\n/g, "\n");
    expect(committed).toContain(`\n${SUITE_HEADING}\n`);
    const from = (s: string) => s.slice(s.indexOf("### Scenario `default`"));
    expect(from(committed)).toBe(from(md));
    expect(committed).toContain(SUITE_DISCLOSURE_LEAD);
  });
});
