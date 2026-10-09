/**
 * Transfer priors (TDD "The notarization loop", step 9; PRD FR-15).
 *
 * When tool 2 is probed, each claim's belief starts from a Beta prior built from what tool 1's
 * notarization settled, instead of Beta(1, 1). Deterministic: same source beliefs + target claims
 * + strength in, same priors out (input order does not matter). No model is involved.
 *
 * SETTLED source beliefs. A source belief counts when its status is `notarized` or `candidate`:
 * both have P(holds) past a threshold (> 0.9 or < 0.1) with at least 2 independent probes; a
 * candidate counts too because the adversary reviews scope, not which side the evidence fell on.
 * `hypothesis`, `abstained` (budget ended between thresholds), `unlearned` (learning undone) and
 * `refuted` do not count. Side: P(holds) > 0.5 → honored, else violated with `belief.class`.
 *
 * BASE RATE of defect class c on the source tool. Every claim has a suspected class
 * (src/contracts/priors-map.ts, copied from the contract comments). For c ≠ honored:
 *     relevant(c) = settled source beliefs whose claim was suspected of c, plus settled beliefs
 *                   that settled violated WITH class c (whatever their claim was suspected of)
 *     hits(c)     = beliefs in relevant(c) that settled violated with class c
 * For c = honored (control claims): relevant = settled beliefs of claims suspected `honored`,
 * hits = those that settled violated (any class).
 *     rate(c) = hits(c) / |relevant(c)|        (the observed violation rate; undefined when empty)
 *
 * PRIOR of a target claim with suspected class c, strength s (pseudo-counts):
 *     α = 1 + s · (1 − rate(c))      (pseudo-observations of the doc claim holding)
 *     β = 1 + s · rate(c)            (pseudo-observations of a violation)
 * No settled source belief relevant to c (or a claim missing from the map) → Beta(1, 1).
 * s defaults to 2 (env NOTARY_PRIOR_STRENGTH, a positive number): the prior is worth two probes,
 * enough to save about one probe when the transfer is right and small enough that two contrary
 * probes outweigh it (from Beta(1,3), two honored probes give Beta(3,3) = 0.5 again).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyBundle } from "../bundle/hash.js";
import { suspectedClassOf } from "../contracts/priors-map.js";
import type { Belief, BeliefStatus, Claim, DefectClass, RunBundle, Tool } from "../schema/index.js";
import type { BeliefPrior } from "./store.js";

/** Default prior strength in pseudo-counts (env NOTARY_PRIOR_STRENGTH). */
export const DEFAULT_PRIOR_STRENGTH = 2;

/** Source statuses that count as settled for the base rate. */
export const SETTLED_STATUSES: ReadonlySet<BeliefStatus> = new Set<BeliefStatus>(["notarized", "candidate"]);

/** NOTARY_PRIOR_STRENGTH: a positive finite number, else the default (2). */
export function priorStrengthFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NOTARY_PRIOR_STRENGTH?.trim();
  if (!raw) return DEFAULT_PRIOR_STRENGTH;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PRIOR_STRENGTH;
}

export interface BaseRate {
  /** Settled source beliefs relevant to the class. */
  settled: number;
  /** Of those, settled violated with this class (for `honored`: violated with any class). */
  violated: number;
  /** violated / settled; null when settled = 0. */
  rate: number | null;
}

export interface ClaimPrior {
  claimId: string;
  /** Suspected class used for the base rate (null: claim not in the suspected-class map). */
  class: DefectClass | null;
  prior: BeliefPrior;
  /** False when the prior is Beta(1, 1) (no source evidence for the class). */
  informative: boolean;
  basis: string;
}

export interface TransferPriorsInput {
  sourceBeliefs: readonly Belief[];
  targetClaims: readonly Claim[];
  /** Pseudo-counts; default DEFAULT_PRIOR_STRENGTH. */
  strength?: number;
  /** Source tool; default the tool of the source beliefs (they must agree). */
  from?: Tool;
}

export interface TransferPriorsResult {
  from: Tool;
  strength: number;
  /** Base rate per defect class seen in the source (classes with no relevant belief are absent). */
  baseRates: Partial<Record<DefectClass, BaseRate>>;
  /** Prior per target claim id (every target claim, Beta(1,1) when uninformative). */
  priors: Record<string, BeliefPrior>;
  perClaim: ClaimPrior[];
  /** Settled source beliefs used. */
  settledSource: number;
}

const round = (x: number): number => Math.round(x * 1e9) / 1e9;

function settledSide(b: Belief): { side: "honored" | "violated"; cls: DefectClass | null } {
  if (b.confidence > 0.5) return { side: "honored", cls: "honored" };
  return { side: "violated", cls: b.class && b.class !== "honored" ? b.class : null };
}

/** Base rate of every class that has at least one relevant settled source belief. */
export function baseRates(settled: readonly Belief[]): Partial<Record<DefectClass, BaseRate>> {
  const classes = new Set<DefectClass>();
  for (const b of settled) {
    const s = suspectedClassOf(b.claimId);
    if (s) classes.add(s);
    const { side, cls } = settledSide(b);
    if (side === "violated" && cls) classes.add(cls);
  }
  const out: Partial<Record<DefectClass, BaseRate>> = {};
  for (const c of [...classes].sort()) {
    let n = 0;
    let v = 0;
    for (const b of settled) {
      const suspected = suspectedClassOf(b.claimId);
      const { side, cls } = settledSide(b);
      if (c === "honored") {
        if (suspected !== "honored") continue;
        n += 1;
        if (side === "violated") v += 1;
        continue;
      }
      const hit = side === "violated" && cls === c;
      if (suspected !== c && !hit) continue;
      n += 1;
      if (hit) v += 1;
    }
    out[c] = { settled: n, violated: v, rate: n > 0 ? round(v / n) : null };
  }
  return out;
}

export function transferPriors(input: TransferPriorsInput): TransferPriorsResult {
  const strength = input.strength ?? DEFAULT_PRIOR_STRENGTH;
  if (!(Number.isFinite(strength) && strength > 0)) throw new RangeError(`prior strength must be a positive number, got ${strength}`);
  const tools = [...new Set(input.sourceBeliefs.map((b) => b.tool))];
  const from = input.from ?? tools[0];
  if (!from) throw new Error("transferPriors: no source beliefs and no `from` tool");
  if (!input.from && tools.length > 1) throw new Error(`transferPriors: source beliefs span several tools (${tools.join(", ")}); pass \`from\``);
  // Sorted by id so the input order never matters.
  const settled = input.sourceBeliefs
    .filter((b) => b.tool === from && SETTLED_STATUSES.has(b.status))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rates = baseRates(settled);

  const perClaim: ClaimPrior[] = [];
  for (const claim of [...input.targetClaims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const cls = suspectedClassOf(claim.id) ?? null;
    const r = cls ? rates[cls] : undefined;
    if (!cls || !r || r.rate === null) {
      perClaim.push({
        claimId: claim.id,
        class: cls,
        prior: { alpha: 1, beta: 1, from },
        informative: false,
        basis: cls ? `no settled ${from} belief relevant to ${cls}: Beta(1, 1)` : "claim not in the suspected-class map: Beta(1, 1)",
      });
      continue;
    }
    const alpha = round(1 + strength * (1 - r.rate));
    const beta = round(1 + strength * r.rate);
    perClaim.push({
      claimId: claim.id,
      class: cls,
      prior: { alpha, beta, from },
      informative: true,
      basis: `${cls} on ${from}: ${r.violated}/${r.settled} settled violated (rate ${r.rate}), strength ${strength}`,
    });
  }
  return {
    from,
    strength,
    baseRates: rates,
    priors: Object.fromEntries(perClaim.map((p) => [p.claimId, p.prior])),
    perClaim,
    settledSource: settled.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Probes-to-candidate (the FR-15 measurement)

export interface ProbesToCandidate {
  /** Per claim: Belief.probesToCandidate (probes applied before it first became a candidate), null if never. */
  perClaim: Record<string, number | null>;
  /** Mean over the claims that reached candidate; null when none did. */
  mean: number | null;
  reached: number;
}

/** Probes-to-candidate of the given claims, read from their beliefs (deterministic, claim-id order). */
export function probesToCandidateMetrics(beliefs: readonly Belief[], claimIds: readonly string[]): ProbesToCandidate {
  const byClaim = new Map(beliefs.map((b) => [b.claimId, b]));
  const perClaim: Record<string, number | null> = {};
  const values: number[] = [];
  for (const id of [...new Set(claimIds)].sort()) {
    const n = byClaim.get(id)?.probesToCandidate;
    perClaim[id] = n ?? null;
    if (n !== undefined) values.push(n);
  }
  return { perClaim, mean: meanOf(values), reached: values.length };
}

export function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------------------------
// Source bundle

export interface PriorsSource {
  bundle?: RunBundle;
  bundlePath?: string;
  /** Set when no usable source bundle exists (BLOCKED line). */
  blocked?: string;
  /** Bundles skipped while searching (tampered, unreadable). */
  notes: string[];
}

function bundleFiles(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(runsDir).sort()) {
    const full = join(runsDir, dir);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const f of readdirSync(full).sort()) if (f.endsWith(".json") && f !== "index.json") out.push(join(full, f));
  }
  return out;
}

/** Bundles written by `notarize --compare-priors` are measurements, never a priors source. */
export const COMPARE_PRIORS_RUN_PREFIX = "compare-priors-";

/**
 * The newest notarize bundle for `tool` that carries beliefs (recon-only bundles have none), from
 * runs/<runId>/<runId>.json; or the bundle at `bundlePath`. Every bundle is schema- and
 * hash-verified; a tampered or unreadable one is skipped with a note (or blocks, when named).
 */
export function loadPriorsSource(opts: { tool: Tool; runsDir: string; bundlePath?: string }): PriorsSource {
  const notes: string[] = [];
  const read = (file: string): { bundle?: RunBundle; error?: string } => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      return { error: `unreadable ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const v = verifyBundle(raw);
    if (!v.ok) return { error: `${file}: ${v.error.split("\n")[0]}` };
    return { bundle: v.bundle };
  };

  if (opts.bundlePath) {
    if (!existsSync(opts.bundlePath)) return { blocked: `BLOCKED: priors bundle ${opts.bundlePath} not found`, notes };
    const r = read(opts.bundlePath);
    if (!r.bundle) return { blocked: `BLOCKED: priors bundle rejected (${r.error})`, notes };
    if (r.bundle.kind !== "notarize" || r.bundle.tool !== opts.tool) {
      return { blocked: `BLOCKED: ${opts.bundlePath} is not a notarize bundle for ${opts.tool} (kind ${r.bundle.kind}, tool ${r.bundle.tool ?? "none"})`, notes };
    }
    if (r.bundle.beliefs.after.length === 0) return { blocked: `BLOCKED: ${opts.bundlePath} has no beliefs (recon-only?) — run notarize --tool ${opts.tool} first`, notes };
    return { bundle: r.bundle, bundlePath: opts.bundlePath, notes };
  }

  let best: { bundle: RunBundle; path: string; at: string } | undefined;
  for (const file of bundleFiles(opts.runsDir)) {
    const r = read(file);
    if (!r.bundle) {
      notes.push(`skipped ${r.error}`);
      continue;
    }
    const b = r.bundle;
    if (b.kind !== "notarize" || b.tool !== opts.tool || b.sample) continue;
    if (b.runId.startsWith(COMPARE_PRIORS_RUN_PREFIX) || b.beliefs.after.length === 0) continue;
    const at = b.finishedAt ?? b.startedAt;
    if (!best || at > best.at || (at === best.at && b.runId > best.bundle.runId)) best = { bundle: b, path: file, at };
  }
  if (!best) return { blocked: `BLOCKED: no notarize bundle for ${opts.tool} — run notarize --tool ${opts.tool} first`, notes };
  return { bundle: best.bundle, bundlePath: best.path, notes };
}
