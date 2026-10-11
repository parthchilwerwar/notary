/**
 * docs/EVALUATION.md, generated from bundles (TDD "What we publish": every metric with the command
 * that produced it, including results that went the wrong way). Rules:
 *   - every number in a Value / Noise floor / Comparison cell is copied from a bundle's metrics,
 *     noiseFloor, credits or usageByRole; nothing is typed in, rounded or derived;
 *   - a null metric is printed as "not computable (reason)";
 *   - identifiers (run ids, metric keys, commands) are in backticks.
 * The only numbers that do not come from bundles are in "Checks that don't need API keys", and
 * those are produced by running the commands at export time.
 *
 * The real-run sections use REAL bundles only. The last section, "Evaluation suite" (anchor
 * #evaluation-suite, linked from the landing page's footnote), is the one place fixture data appears:
 * the published FIXTURE bundles (src/export/suite.ts: hash-verified, sample: true), per scenario, every
 * value copied from bundle metrics/credits or counted from its decision records, under a plain-words
 * disclosure that the APIs were simulated (planted quirks and model doubles listed from the demo code)
 * and that these are not live-API results. It is never mixed into a real-run table.
 */
import type { RunBundle } from "../schema/index.js";
import type { CheckResult } from "./checks.js";
import { classify, latest, order, type SkippedBundle } from "./collect.js";
import { commandFor, PRODUCE } from "./commands.js";
import { BELIEF_PRECISION_DISCLOSURE, compareExact } from "../eval/metrics.js";
import { compareValues, directionOf } from "./compare.js";
import type { EvaluationSuite, SuiteScenario } from "./suite.js";
import { AGENTS } from "../schema/agents.js";
import { heldRefunds } from "./suite.js";

// --- table helpers ---------------------------------------------------------------------------

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (s: string): string => `\`${s}\``;
const row = (cells: string[]): string => `| ${cells.map(cell).join(" | ")} |`;

function table(header: string[], rows: string[][]): string[] {
  return [row(header), row(header.map(() => "---")), ...rows.map(row)];
}

export const METRIC_HEADER = ["Metric", "Value", "Source bundle", "Command that produced it", "Noise floor", "Comparison"];
export const PRD_HEADER = ["Metric", "PRD target", "Value", "Source bundle", "Command that produced it", "Noise floor", "Comparison"];

// --- lookups ---------------------------------------------------------------------------------

/** Newest live bundle of a class, else the newest replay. */
function newest(bundles: readonly RunBundle[], cls: ReturnType<typeof classify>, tool?: string): RunBundle | undefined {
  const pred = (b: RunBundle): boolean => classify(b) === cls && (tool === undefined || b.tool === tool);
  return latest(bundles, (b) => pred(b) && b.mode === "live") ?? latest(bundles, pred);
}

interface Floor {
  value: number;
  from: string;
}

/** Noise floor for a key: the bundle's own, else the newest bundle of the same kind that has one. */
function floorFor(bundles: readonly RunBundle[], b: RunBundle, key: string): Floor | undefined {
  const own = b.noiseFloor?.[key];
  if (own !== undefined) return { value: own, from: b.runId };
  const src = latest(bundles, (x) => x.kind === b.kind && x.noiseFloor?.[key] !== undefined);
  return src ? { value: src.noiseFloor![key]!, from: src.runId } : undefined;
}

const floorText = (f: Floor | undefined): string => (f ? `${f.value} (from ${code(f.from)})` : "unknown");

function nullReason(b: RunBundle, key: string): string {
  if (b.status !== "completed") return `run status ${code(b.status)}; see the bundle's stopReason`;
  if (/^unsafe_|^automation_rate$/.test(key) && b.disclosure.some((d) => d.startsWith("Ground truth incomplete"))) {
    return "ground truth incomplete; see the bundle disclosure";
  }
  if (/^probes_to_candidate/.test(key)) return "no claim reached candidate";
  return "the bundle reports null: no data for this metric in this run";
}

function valueText(b: RunBundle, key: string): string {
  if (!(key in b.metrics)) return `not computable (${code(b.runId)} has no ${code(key)})`;
  const v = b.metrics[key];
  return v === null || v === undefined ? `not computable (${nullReason(b, key)})` : String(v);
}

/** A replay that reproduces a recorded run (compare-priors bundles also set replayOf, but they are measurements, not reproductions). */
function isReproduction(b: RunBundle): boolean {
  return b.mode === "replay" && b.replayOf !== undefined && classify(b) !== "notarize-compare-priors";
}

function originalOf(bundles: readonly RunBundle[], replay: RunBundle): RunBundle | undefined {
  if (!isReproduction(replay)) return undefined;
  return latest(
    bundles,
    (b) => b !== replay && b.mode === "live" && (b.runId === replay.replayOf || b.cassettes.includes(replay.replayOf!)),
  );
}

/** Exact per-key match (src/eval compareExact: union of keys, null only matches null). */
function replayMatch(orig: RunBundle, replay: RunBundle): string {
  const { rows, allMatch } = compareExact(orig.metrics, replay.metrics);
  if (allMatch) return `exact match with ${code(orig.runId)} on every metric`;
  return `MISMATCH with ${code(orig.runId)} on ${rows.filter((r) => !r.match).map((r) => code(r.key)).join(", ")}`;
}

// --- PRD success metrics ---------------------------------------------------------------------

const absent = (what: string, cmd: string): string[] => [`not computable (${what})`, "—", `— (would be produced by ${code(cmd)})`, "unknown", "—"];

function metricCells(bundles: readonly RunBundle[], b: RunBundle, key: string, note: string): string[] {
  return [valueText(b, key), code(b.runId), code(commandFor(b)), floorText(floorFor(bundles, b, key)), note];
}

function costText(b: RunBundle): string {
  const u = b.usageByRole;
  return `credits ${b.credits.total} of budget ${b.credits.budget}; USD by role: executor ${u.executor.usd}, reflector ${u.reflector.usd}, adversary ${u.adversary.usd}`;
}

function prdRows(bundles: readonly RunBundle[]): string[][] {
  const naive = newest(bundles, "run-naive");
  const guarded = newest(bundles, "run-guarded");
  const rows: string[][] = [];
  const pair = (metric: string, target: string, key: string, guardedNote: (n: RunBundle | undefined, g: RunBundle) => string): void => {
    if (!naive && !guarded) {
      rows.push([metric, target, ...absent("no naive or guarded run bundle", PRODUCE.naive)]);
      return;
    }
    if (naive) rows.push([`${metric} — naive (baseline)`, target, ...metricCells(bundles, naive, key, "naive baseline")]);
    else rows.push([`${metric} — naive (baseline)`, target, ...absent("no naive run bundle", PRODUCE.naive)]);
    if (guarded) rows.push([`${metric} — guarded`, target, ...metricCells(bundles, guarded, key, guardedNote(naive, guarded))]);
    else rows.push([`${metric} — guarded`, target, ...absent("no guarded run bundle", PRODUCE.guarded)]);
  };
  const vsNaive = (key: string) => (n: RunBundle | undefined, g: RunBundle): string =>
    n ? compareValues({ key, before: n.metrics[key], after: g.metrics[key], floor: floorFor(bundles, g, key)?.value, labels: ["naive", "guarded"] }).note : "no naive run to compare with";

  // 1. Unsafe money actions
  pair("Unsafe money actions", "Run 1 baseline > 0; run 2 = 0", "unsafe_actions_total", (n, g) => {
    const base = vsNaive("unsafe_actions_total")(n, g);
    const nv = n?.metrics.unsafe_actions_total;
    const gv = g.metrics.unsafe_actions_total;
    if (nv === null || nv === undefined || gv === null || gv === undefined) return `${base}; target not assessable`;
    return `${base}; target ${nv > 0 && gv === 0 ? "met" : "NOT met"}`;
  });

  // 2. Belief precision (AUDIT A-14: the note is printed next to the row whatever the value)
  const bp = latest(bundles, (b) => "belief_precision" in b.metrics);
  rows.push(
    bp
      ? ["Belief precision", "≥ 0.8, false beliefs = 0", ...metricCells(bundles, bp, "belief_precision", withBpNote(directionNote(bp, "belief_precision")))]
      : ["Belief precision", "≥ 0.8, false beliefs = 0", ...absent(`no bundle reports ${code("belief_precision")}; needs notarized beliefs`, PRODUCE.notarize("crustdata")).slice(0, -1), withBpNote("—")],
  );
  const fb = latest(bundles, (b) => "beliefs_false" in b.metrics);
  if (fb) rows.push(["False beliefs", "≥ 0.8, false beliefs = 0", ...metricCells(bundles, fb, "beliefs_false", "—")]);

  // 3. Unguarded call sites
  const ucs = latest(bundles, (b) => "unguarded_call_sites" in b.metrics);
  const liveNote = "also measured live at export time: see Checks that don't need API keys";
  rows.push(
    ucs
      ? ["Unguarded call sites", "0", ...metricCells(bundles, ucs, "unguarded_call_sites", liveNote)]
      : ["Unguarded call sites", "0", `not computable (no bundle records ${code("unguarded_call_sites")})`, "—", "—", "unknown", liveNote],
  );

  // 4. Cost per queue run
  if (!naive && !guarded) {
    rows.push(["Cost per queue run", "Run 2 lower than run 1", ...absent("no naive or guarded run bundle", PRODUCE.naive)]);
  } else {
    for (const [label, b, cmd] of [
      ["naive (baseline)", naive, PRODUCE.naive],
      ["guarded", guarded, PRODUCE.guarded],
    ] as const) {
      if (!b) {
        rows.push([`Cost per queue run — ${label}`, "Run 2 lower than run 1", ...absent(`no ${label.split(" ")[0]} run bundle`, cmd)]);
        continue;
      }
      let note = "naive baseline";
      if (b === guarded) {
        note = naive
          ? [
              `credits: ${compareValues({ key: "credits", before: naive.credits.total, after: b.credits.total, floor: floorFor(bundles, b, "credits")?.value, labels: ["naive", "guarded"] }).note}`,
              ...(["executor", "reflector", "adversary"] as const).map(
                (r) => `${r} USD: ${compareValues({ key: "usd", before: naive.usageByRole[r].usd, after: b.usageByRole[r].usd, labels: ["naive", "guarded"] }).note}`,
              ),
            ].join("; ")
          : "no naive run to compare with";
      }
      rows.push([`Cost per queue run — ${label}`, "Run 2 lower than run 1", costText(b), code(b.runId), code(commandFor(b)), floorText(floorFor(bundles, b, "credits")), note]);
    }
  }

  // 5. Probes to confirm on tool 2
  const cp = newest(bundles, "notarize-compare-priors", "dodo");
  if (cp) {
    const w = "probes_to_candidate_with_priors";
    const wo = "probes_to_candidate_without_priors";
    rows.push(["Probes to confirm on Dodo — without priors", "Fewer with priors", ...metricCells(bundles, cp, wo, "baseline arm")]);
    rows.push([
      "Probes to confirm on Dodo — with Crustdata priors",
      "Fewer with priors",
      ...metricCells(bundles, cp, w, compareValues({ key: w, before: cp.metrics[wo], after: cp.metrics[w], floor: floorFor(bundles, cp, w)?.value, labels: ["without priors", "with priors"] }).note),
    ]);
  } else {
    rows.push(["Probes to confirm on Dodo (with vs without priors)", "Fewer with priors", ...absent("no compare-priors bundle for dodo", PRODUCE.comparePriors)]);
  }

  // 6. Automation rate
  pair("Automation rate", "Reported honestly, not maximized", "automation_rate", vsNaive("automation_rate"));

  // 7. Reproducibility
  const rp = latest(bundles, (b) => originalOf(bundles, b) !== undefined);
  if (rp) {
    const orig = originalOf(bundles, rp)!;
    rows.push(["Reproducibility", "Exact match", replayMatch(orig, rp), code(rp.runId), code(commandFor(rp)), "—", `replay of ${code(orig.runId)}`]);
  } else {
    rows.push(["Reproducibility", "Exact match", ...absent("no replay bundle whose original live bundle is present", PRODUCE.replay)]);
  }
  return rows;
}

/** AUDIT A-14: belief_precision's note always carries the same-recording disclosure. */
function withBpNote(note: string): string {
  // Same text as the bundle disclosure, identifiers in backticks (the table rule: no bare numbers
  // outside bundle values, and "A-14" is an identifier, not a number).
  const disclosure = `Note: ${BELIEF_PRECISION_DISCLOSURE.replace("belief_precision", code("belief_precision")).replace("docs/AUDIT.md A-14", code("docs/AUDIT.md A-14"))}`;
  return note === "—" || note === "" ? disclosure : `${note}; ${disclosure}`;
}

function directionNote(b: RunBundle, key: string): string {
  const v = b.metrics[key];
  return v === null || v === undefined ? "—" : `${directionOf(key)} is better; no earlier value to compare with`;
}

// --- every metric in every bundle --------------------------------------------------------------

function comparisonFor(bundles: readonly RunBundle[], b: RunBundle, key: string): string {
  const floor = floorFor(bundles, b, key)?.value;
  if (b.mode === "replay") {
    const orig = originalOf(bundles, b);
    if (orig && key in orig.metrics) {
      return orig.metrics[key] === b.metrics[key] ? `replay of ${code(orig.runId)}: identical` : `replay of ${code(orig.runId)}: DIFFERS (original ${orig.metrics[key] ?? "null"})`;
    }
  }
  switch (classify(b)) {
    case "run-naive":
      return "naive baseline";
    case "run-guarded": {
      const n = newest(bundles, "run-naive");
      if (!n || !(key in n.metrics)) return "no naive run with this metric to compare with";
      return compareValues({ key, before: n.metrics[key], after: b.metrics[key], floor, labels: ["naive", "guarded"] }).note;
    }
    case "notarize-compare-priors": {
      if (!key.includes("_with_priors")) return key.includes("_without_priors") ? "baseline arm" : "—";
      const other = key.replace("_with_priors", "_without_priors");
      return compareValues({ key, before: b.metrics[other], after: b.metrics[key], floor, labels: ["without priors", "with priors"] }).note;
    }
    default:
      return "—";
  }
}

function bundleSection(bundles: readonly RunBundle[], b: RunBundle): string[] {
  const keys = Object.keys(b.metrics);
  const out = [`### ${code(b.runId)} — ${b.kind} / ${b.variant}${b.tool ? ` / ${b.tool}` : ""} (${b.mode}, ${b.status})`, ""];
  if (keys.length === 0) return [...out, "This bundle has no metrics.", ""];
  const rows = keys.map((k) => [
    code(k),
    valueText(b, k),
    code(b.runId),
    code(commandFor(b)),
    floorText(floorFor(bundles, b, k)),
    k === "belief_precision" ? withBpNote(comparisonFor(bundles, b, k)) : comparisonFor(bundles, b, k),
  ]);
  return [...out, ...table(METRIC_HEADER, rows), ""];
}

// --- blocked -----------------------------------------------------------------------------------

const BOTH_TOOLS = "CRUSTDATA_API_KEY, DODO_PAYMENTS_API_KEY (test mode), a seeded Dodo test world (`seed:dodo` plus human test checkouts)";
const MODELS = "NOTARY_MODEL_REFLECTOR, NOTARY_MODEL_ADVERSARY and a model provider (LiteLLM: LITELLM_BASE_URL + LITELLM_API_KEY, or Bedrock: AWS_REGION + AWS credentials; check with `pnpm notary doctor --llm`)";

function blockedRows(bundles: readonly RunBundle[], driftFixtures: readonly string[]): string[][] {
  const rows: string[][] = [];
  const has = (pred: (b: RunBundle) => boolean): boolean => bundles.some(pred);
  if (!has((b) => classify(b) === "run-naive")) rows.push(["Naive run (unsafe-action baseline)", "no naive run bundle", code(PRODUCE.naive), BOTH_TOOLS]);
  if (!has((b) => classify(b) === "run-guarded")) rows.push(["Guarded run (run 2)", "no guarded run bundle", code(PRODUCE.guarded), `${BOTH_TOOLS}; notarized beliefs from the notarize runs`]);
  for (const tool of ["crustdata", "dodo"] as const) {
    if (!has((b) => classify(b) === "notarize-full" && b.tool === tool)) {
      const key = tool === "crustdata" ? "CRUSTDATA_API_KEY" : "DODO_PAYMENTS_API_KEY (test mode)";
      rows.push([`Notarized beliefs for ${tool}`, `no notarize bundle for ${tool}`, code(PRODUCE.notarize(tool)), `${key}; ${MODELS}`]);
    }
  }
  if (!has((b) => classify(b) === "notarize-compare-priors" && b.tool === "dodo")) {
    rows.push(["Probes to candidate with vs without priors", "no compare-priors bundle for dodo", code(PRODUCE.comparePriors), "a crustdata notarize bundle and a recorded probes-dodo cassette"]);
  }
  if (!has((b) => b.noiseFloor !== undefined)) rows.push(["Noise floor (three identical guarded runs)", "no bundle carries a noiseFloor", `${code(PRODUCE.noiseFloor)} (re-seed Dodo between runs); the floor goes into bundle.noiseFloor`, BOTH_TOOLS]);
  if (!has(isReproduction)) rows.push(["Reproducibility (replay)", "no replay bundle", code(PRODUCE.replay), "recorded cassettes from the live runs above (no keys needed once recorded)"]);
  if (!has((b) => b.disclosure.some((d) => d.includes("DRIFT FIXTURE")))) {
    const fx = driftFixtures.length ? `drift fixtures on disk: ${driftFixtures.map(code).join(", ")}` : "no drift fixture exists";
    rows.push(["Drift un-learning (FR-16)", `no bundle from a drift replay; ${fx}`, `${code(PRODUCE.drift)}, then replay the fixture`, "a real recorded cassette to alter"]);
  }
  return rows;
}

// --- document ----------------------------------------------------------------------------------

export interface EvaluationInput {
  bundles: readonly RunBundle[];
  skipped: readonly SkippedBundle[];
  excluded: readonly SkippedBundle[];
  /** null = checks were not run (e.g. --no-checks). */
  checks: readonly CheckResult[] | null;
  driftFixtures: readonly string[];
  generatedAt: string;
  /**
   * The evaluation suite read from the published fixture bundles (src/export/suite.ts); null = not
   * generated for this export (no fixture bundles directory configured). Undefined is treated as null.
   */
  suite?: EvaluationSuite | null;
}

export function renderEvaluationMd(input: EvaluationInput): string {
  const bundles = [...input.bundles].sort(order);
  const out: string[] = [
    "# Evaluation",
    "",
    `> Generated by \`pnpm notary export\` at ${input.generatedAt} from ${bundles.length} bundles — do not edit by hand.`,
    "",
    "Every value in the real-run sections below is copied from a hash-verified, non-sample run bundle (`bundle.metrics`, `credits`, `usageByRole`, `noiseFloor`).",
    "The [Evaluation suite](#evaluation-suite) section at the end is kept apart: it reports Notary's evaluation suite, which runs against simulated APIs, and is never mixed with real results.",
    "Bundles do not store their argv, so each command is reconstructed from the bundle's kind, variant, mode, tool and disclosure fields.",
    "A change no larger than the noise floor is reported as no change; results that went the wrong way are kept and marked.",
    "",
    "## Source bundles",
    "",
  ];
  if (bundles.length === 0) {
    out.push("**No real runs yet.** No hash-verified, non-sample bundle exists under `packages/core/runs/`; the synthetic SAMPLE bundle is never a source of results.", "");
  } else {
    out.push(
      ...table(
        ["Run", "Kind / variant", "Mode", "Tool", "Status", "Content hash", "Command"],
        bundles.map((b) => [code(b.runId), `${b.kind} / ${b.variant}`, b.mode, b.tool ?? "—", b.status, code(b.contentHash), code(commandFor(b))]),
      ),
      "",
    );
  }
  if (input.skipped.length) {
    out.push("Skipped (failed verification, never used):", "");
    for (const s of input.skipped) out.push(`- ${code(s.file)}: ${s.reason}`);
    out.push("");
  }
  if (input.excluded.length) {
    out.push("Excluded:", "");
    for (const s of input.excluded) out.push(`- ${code(s.file)}: ${s.reason}`);
    out.push("");
  }

  out.push("## Success metrics (PRD)", "", ...table(PRD_HEADER, prdRows(bundles)), "");

  out.push("## Every metric in the bundles", "");
  if (bundles.length === 0) out.push("No real runs yet, so there are no `bundle.metrics` to report.", "");
  else for (const b of bundles) out.push(...bundleSection(bundles, b));

  out.push("## Checks that don't need API keys", "");
  if (input.checks === null) {
    out.push("Not run for this export (`--no-checks`).", "");
  } else {
    out.push(
      `Run by \`pnpm notary export\` at ${input.generatedAt}; re-run each command to reproduce.`,
      "",
      ...table(
        ["Command", "Result", "Exit code", "How export ran it"],
        input.checks.map((c) => [code(c.command), `${c.ok ? "PASS" : "FAIL"}: ${c.summary}`, String(c.exitCode ?? "none"), c.ranAs]),
      ),
      "",
    );
  }

  out.push("## Not yet measured (blocked)", "");
  const blocked = blockedRows(bundles, input.driftFixtures);
  if (blocked.length === 0) out.push("Nothing blocked: every bundle kind exists.", "");
  else out.push(...table(["What", "Missing", "Command to produce it", "Needs"], blocked), "");

  out.push(...suiteSection(input.suite ?? null, bundles.length));

  return `${out.join("\n").trimEnd()}\n`;
}

// --- evaluation suite (fixture data, kept apart) ------------------------------------------------

/** The heading the landing page links to (`docs/EVALUATION.md#evaluation-suite`). */
export const SUITE_HEADING = "## Evaluation suite";

/** The disclosure paragraph's opening words; tests and readers can find it by these. */
export const SUITE_DISCLOSURE_LEAD = "**Simulated APIs, not live results.**";

const metricText = (b: RunBundle | undefined, key: string): string => {
  if (!b) return "—";
  const v = b.metrics[key];
  return v === null || v === undefined ? "not recorded" : String(v);
};

function runCell(b: RunBundle | undefined, label: string): string {
  return b ? `${label} (${code(b.runId)})` : `${label} (none published)`;
}

/** The scenario table's rows: [measure, naive, guarded, where the value is copied from]. */
export function suiteRows(naive: RunBundle | undefined, guarded: RunBundle | undefined): string[][] {
  const m = (label: string, key: string): string[] => [label, metricText(naive, key), metricText(guarded, key), code(`metrics.${key}`)];
  return [
    m("Unsafe money actions", "unsafe_actions_total"),
    m("— duplicates", "unsafe_duplicates"),
    m("— wrong unit", "unsafe_wrong_unit"),
    m("— missed existing refund", "unsafe_missed_existing_refund"),
    m("Requests in the queue", "items_total"),
    m("Held", "holds"),
    [
      "Refunds held",
      naive ? String(heldRefunds(naive).length) : "—",
      guarded ? String(heldRefunds(guarded).length) : "—",
      "decision records: status `held`, request type `refund` or `partial_refund`",
    ],
    m("Executed", "executed"),
    m("Decision accuracy", "decision_accuracy"),
    m("Automation rate", "automation_rate"),
    [
      "Credits used",
      naive ? `${naive.credits.total} of ${naive.credits.budget}` : "—",
      guarded ? `${guarded.credits.total} of ${guarded.credits.budget}` : "—",
      `${code("credits.total")} of ${code("credits.budget")}`,
    ],
  ];
}

function scenarioSection(s: SuiteScenario): string[] {
  const { naive, guarded } = s;
  const out: string[] = [`### Scenario ${code(s.scenario)}`, ""];
  if (naive || guarded) out.push(...table(["Measure", runCell(naive, "Naive"), runCell(guarded, "Guarded"), "Copied from"], suiteRows(naive, guarded)), "");
  else out.push("No naive or guarded queue run is published for this scenario.", "");
  const c = s.certificates;
  out.push(
    `Certificates, built by the same code as \`pnpm notary export --certificates --fixture\` from ${
      s.certificateSources.length ? s.certificateSources.map(code).join(", ") : "no notarize bundle"
    }:`,
    "",
    ...table(
      ["Claims", "Certified", "Matches docs", "Contradicts docs", "Revoked"],
      [[String(c.claimsTotal), String(c.certified), String(c.matchesDocs), String(c.contradictsDocs), String(c.revoked)]],
    ),
    "",
  );
  return out;
}

function suiteSection(suite: EvaluationSuite | null, realRuns: number): string[] {
  const out: string[] = [SUITE_HEADING, ""];
  if (suite === null) return [...out, "Not generated for this export (no fixture bundles directory was given).", ""];
  const doubles = Object.entries(suite.modelDoubles)
    .map(([role, id]) => `${code(id)} (${(AGENTS as Readonly<Record<string, { name: string } | undefined>>)[role]?.name ?? role})`)
    .join(", ");
  out.push(
    `${SUITE_DISCLOSURE_LEAD} Notary's evaluation suite runs the real Notary pipeline (the checker, the ${AGENTS.reflector.name}'s hypotheses, probes, the ${AGENTS.adversary.name}'s review, certificates, the ${AGENTS.guard.name} and the queue executor) against **simulated** Crustdata and Dodo APIs: an in-process fixture world with the planted quirks listed below. Deterministic model doubles stand in for the models: ${doubles}. These are not live-API results and say nothing about how the real Crustdata or Dodo APIs behave. Real-run results stay in the sections above${
      realRuns === 0 ? " (no real runs yet)" : ""
    }.`,
    "",
    `Source: the published fixture bundles in ${code(suite.dirLabel)} (written by \`pnpm notary demo --fixture --publish\`), each hash-verified and marked \`sample: true\`. Every number below is copied from those bundles or counted from their records; nothing is typed in.`,
    "",
  );
  if (suite.skipped.length) {
    out.push("Skipped (never used):", "");
    for (const s of suite.skipped) out.push(`- ${code(s.file)}: ${s.reason}`);
    out.push("");
  }
  if (suite.scenarios.length === 0) {
    out.push("No fixture bundles are published, so the suite has nothing to report (run `pnpm notary demo --fixture --publish`).", "");
    return out;
  }

  // Planted quirks, from the demo code; a scenario that applies one differently says how.
  const base = suite.scenarios[0]!;
  out.push(`Planted quirks (from the demo code), as scenario ${code(base.scenario)} applies them:`, "");
  for (const q of base.quirks) out.push(`- ${code(q.id)} ${q.tool}, ${q.where}: ${q.behaviour}`);
  out.push("");
  for (const s of suite.scenarios.slice(1)) {
    const changed = s.quirks.filter((q) => {
      const b = base.quirks.find((x) => x.id === q.id);
      return !b || b.where !== q.where || b.behaviour !== q.behaviour;
    });
    if (changed.length || s.apiChange) {
      out.push(`Scenario ${code(s.scenario)} differs:`, "");
      for (const q of changed) out.push(`- ${code(q.id)} ${q.tool}, ${q.where}: ${q.behaviour}`);
      if (s.apiChange) out.push(`- ${s.apiChange}`);
      out.push("");
    }
  }

  out.push(
    ...table(
      ["Run", "Scenario", "Kind / variant", "Status", "Content hash"],
      suite.scenarios.flatMap((s) => s.bundles.map((b) => [code(b.runId), code(s.scenario), `${b.kind} / ${b.variant}`, b.status, code(b.contentHash)])),
    ),
    "",
  );
  for (const s of suite.scenarios) out.push(...scenarioSection(s));
  return out;
}

