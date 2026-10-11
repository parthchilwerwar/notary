/**
 * The evaluation suite: the published FIXTURE bundles (packages/web/public/bundles/fixture/,
 * written by `notary demo --fixture --publish`) read back for docs/EVALUATION.md#evaluation-suite.
 *
 * The suite is the real Notary pipeline run against SIMULATED Crustdata and Dodo APIs (an in-process
 * fixture world with planted quirks, src/demo/fixture-api.ts) with deterministic model doubles
 * (src/demo/fixture-llm.ts). Its numbers are not live-API results and are never mixed into the real
 * sections of EVALUATION.md; the renderer prints them in their own section with a disclosure.
 *
 * Rules (same as the rest of EVALUATION.md):
 *   - only bundles that pass `fixturePublishRefusal` (schema + recomputed content hash, sample: true,
 *     the FIXTURE disclosure, a demo-* runId) and whose file name is their runId are read; anything
 *     else is listed as skipped, never used;
 *   - scenarios (runId prefix, `demoScenarioOf`) are separate simulated worlds and are never merged;
 *   - every value is copied from a bundle (metrics, credits) or counted from its records (held refund
 *     decisions, the way the landing page counts them); certificate counts are built by the same
 *     certify code `notary export --certificates --fixture` uses, from the same scenario's bundles;
 *   - the planted quirks and model doubles listed come from the demo code, not from prose.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildCertificates } from "../certify/certificates.js";
import { bundleOrder } from "../certify/ledger.js";
import { buildReport } from "../certify/report.js";
import { CHANGE_API_DISCLOSURE, DEMO_SCENARIOS, demoScenarioOf, scenarioQuirks } from "../demo/index.js";
import type { DemoScenario } from "../demo/index.js";
import type { FixtureQuirk } from "../demo/fixture-api.js";
import { FIXTURE_MODELS } from "../demo/fixture-llm.js";
import { fixturePublishRefusal } from "../demo/publish.js";
import { verifyBundle } from "../bundle/hash.js";
import { RequestTypeSchema } from "../schema/common.js";
import type { Decision, RunBundle } from "../schema/index.js";
import type { ReportCounts } from "../schema/certificate.js";
import { classify, latest } from "./collect.js";
import type { SkippedBundle } from "./collect.js";

/** Request types that move money back to a customer (refund, partial_refund), read from the schema. */
export const SUITE_REFUND_TYPES: ReadonlySet<string> = new Set(RequestTypeSchema.options.filter((t) => t.includes("refund")));

export interface SuiteScenario {
  scenario: DemoScenario;
  /** Every verified bundle of this scenario, oldest first. */
  bundles: RunBundle[];
  naive?: RunBundle;
  guarded?: RunBundle;
  /** Certificate counts over this scenario's notarize bundles and belief-event runs (certify code). */
  certificates: ReportCounts;
  /** Runs the certificate counts were built from. */
  certificateSources: string[];
  /** The planted quirks as this scenario applies them (src/demo/index.ts scenarioQuirks). */
  quirks: readonly FixtureQuirk[];
  /** The simulated mid-run API change, when the scenario has one. */
  apiChange?: string;
}

export interface EvaluationSuite {
  /** The fixture bundles directory as shown in the document (repo-relative when inside the repo). */
  dirLabel: string;
  scenarios: SuiteScenario[];
  skipped: SkippedBundle[];
  /** Model ids of the deterministic doubles (src/demo/fixture-llm.ts FIXTURE_MODELS), per role. */
  modelDoubles: Readonly<Record<string, string>>;
}

/** Held decisions on refund request types (the landing page's "refunds held"). */
export function heldRefunds(b: RunBundle): Decision[] {
  return b.decisions.filter((d) => d.status === "held" && SUITE_REFUND_TYPES.has(d.requestType));
}

/** Read and verify the published fixture bundles in `dir`, grouped by scenario. Pure apart from reading `dir`. */
export function collectEvaluationSuite(dir: string, dirLabel: string): EvaluationSuite {
  const skipped: SkippedBundle[] = [];
  const bundles: RunBundle[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!name.startsWith("demo-") || !name.endsWith(".json") || name.endsWith(".timeline.json")) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        skipped.push({ file: name, reason: "unreadable JSON" });
        continue;
      }
      const refusal = fixturePublishRefusal(raw);
      if (refusal) {
        skipped.push({ file: name, reason: refusal });
        continue;
      }
      const v = verifyBundle(raw);
      if (!v.ok) continue; // unreachable: fixturePublishRefusal already verified it
      if (`${v.bundle.runId}.json` !== name) {
        skipped.push({ file: name, reason: `file name does not match its runId (${v.bundle.runId})` });
        continue;
      }
      bundles.push(v.bundle);
    }
  }

  const scenarios: SuiteScenario[] = [];
  for (const scenario of DEMO_SCENARIOS) {
    const own = bundles.filter((b) => demoScenarioOf(b.runId) === scenario).sort(bundleOrder);
    if (own.length === 0) continue;
    const certSources = own.filter((b) => b.kind === "notarize" || b.beliefEvents.length > 0);
    const set = buildCertificates(certSources, { fixture: true, scenario });
    const report = buildReport(set, {}, (tool) => `${tool}.json`);
    const naive = latest(own, (b) => b.kind === "run" && classify(b) === "run-naive");
    const guarded = latest(own, (b) => b.kind === "run" && classify(b) === "run-guarded");
    scenarios.push({
      scenario,
      bundles: own,
      ...(naive ? { naive } : {}),
      ...(guarded ? { guarded } : {}),
      certificates: report.overall,
      certificateSources: report.sourceBundles.map((s) => s.runId),
      quirks: scenarioQuirks(scenario),
      ...(scenario === "change-api" ? { apiChange: CHANGE_API_DISCLOSURE } : {}),
    });
  }
  return { dirLabel, scenarios, skipped, modelDoubles: { ...FIXTURE_MODELS } };
}
