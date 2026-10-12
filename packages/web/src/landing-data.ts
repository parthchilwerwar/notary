// Data for the landing page (`/`). Every number the landing shows is derived here from data the
// data layer (src/data) verified: run bundles (hash-checked), timelines (tied to their bundle),
// certificates (seals recomputed) and the optional cfo.ai plan (public/economics.json). Nothing
// here fetches and no result is typed by hand. The only literals are copy (step and feature
// sentences, the "Built with" credits) and links.
import { RequestTypeSchema } from "../../core/src/schema";
import type { Certificate, Decision, FixtureIndex, RequestType, Revocation, RunBundle } from "../../core/src/schema";
import { label, scenarioKey, type CertificateWorld } from "./data";
import { GITHUB_URL } from "./lib/site";
import { verifyEconomicsFile } from "./data/economics";
import type { EvidenceEntry } from "./data/published";
import { isReplayRun, isSyntheticSample } from "./app/links";

/** The repository, linked from the nav and the footer (one site-wide constant, AUDIT H-44). */
export { GITHUB_URL };

/**
 * Candidate names for the credits line ("Built with") and the chat showcase's chips, in order.
 * Which of them are shown, and how, is decided by `builtWith` from evidence/evidence.json: never
 * from this list alone.
 */
export const BUILT_WITH = ["neatlogs", "Entire", "cfo.ai", "Crustdata", "Dodo Payments", "AWS Bedrock"] as const;

/** What a pending integration waits for, by name (evidence.json status "pending"); else "pending". */
export const PENDING_NOTE: Readonly<Record<string, string>> = {};

/**
 * Integrations credited without a pending label even while evidence.json says "pending": cfo.ai is
 * integrated in code and connected over MCP (notary cfo connect/sync, the cost export); only its
 * plan import is outstanding, which the Business tab shows. It is still never a chat chip until a
 * plan is imported.
 */
const INTEGRATED_CREDITS = new Set(["cfo.ai"]);

export type Credit = { name: string; /** Set when evidence.json says the integration is not live yet. */ pending?: string };

/**
 * The credits and the chat chips, from evidence/evidence.json (validated by the data layer):
 *   - a name evidence.json lists is an integration: active only when its status is "live"; a
 *     "pending" one is a credit labelled with what it waits for (PENDING_NOTE) and never a chip
 *   - a name evidence.json does not list is a plain credit (a library or service it does not track)
 *   - cfo.ai is also pending while public/economics.json has no imported plan (`cfoPlan` false)
 *   - evidence not loaded (still loading, or withheld): nothing can be confirmed, so nothing is shown
 */
export function builtWith(
  evidence: readonly Pick<EvidenceEntry, "name" | "status">[] | null,
  opts: { cfoPlan?: boolean | null } = {},
): { credits: Credit[]; chips: string[] } {
  if (!evidence) return { credits: [], chips: [] };
  const statusOf = (name: string) => evidence.find((e) => e.name.toLowerCase() === name.toLowerCase())?.status;
  const credits = BUILT_WITH.map((name): Credit => {
    const status = statusOf(name);
    const pending = status === "pending" || (name === "cfo.ai" && opts.cfoPlan === false);
    return pending && !INTEGRATED_CREDITS.has(name) ? { name, pending: PENDING_NOTE[name] ?? "pending" } : { name };
  });
  // A chip says the chat showcase draws on it: only live integrations (cfo.ai: live with a plan).
  const chip = (name: string) => statusOf(name) !== "pending" && !(name === "cfo.ai" && opts.cfoPlan === false);
  return { credits, chips: credits.filter((c) => !c.pending && chip(c.name)).map((c) => c.name) };
}

/**
 * Whether public/economics.json carries an imported cfo.ai plan, from the hash-verified file (a
 * missing or failed file counts as no plan).
 */
export function cfoPlanImported(raw: unknown): boolean {
  const state = verifyEconomicsFile(raw);
  return state.status === "ready" && state.file.plan !== null;
}

/** The Run page for one run (the dashboard reads `?run=`). */
export const runHref = (runId: string) => `/app/run?run=${encodeURIComponent(runId)}`;

/** What the hero mockup's address bar shows: where this app is actually served, never a made-up domain. */
export const mockupAddress = (origin: string) => `${origin.replace(/\/+$/, "")}/app/run`;

// --------------------------------------------------------------------------- navigation

export type NavLink = { label: string; href: string; external?: boolean };

/** The documentation, served by the app itself at /docs. */
export const DOCS_HREF = "/docs";

/** Center links of the nav. Pricing only when the pricing section is shown. */
export function navLinks(showPricing: boolean): NavLink[] {
  return [
    { label: "How it works", href: "#how" },
    { label: "Features", href: "#features" },
    { label: "Chat", href: "#chat" },
    ...(showPricing ? [{ label: "Pricing", href: "#pricing" }] : []),
    { label: "Docs", href: DOCS_HREF },
    { label: "GitHub", href: GITHUB_URL, external: true },
  ];
}

/** In-app routes ("/docs", "/app") go through the router; hash and external links stay plain anchors. */
export const isRoute = (l: NavLink) => !l.external && l.href.startsWith("/");

export const FOOTER_LINKS: readonly NavLink[] = [
  { label: "GitHub", href: GITHUB_URL, external: true },
  { label: "Dashboard", href: "/app" },
  { label: "Docs", href: DOCS_HREF },
];

// --------------------------------------------------------------------------- copy

/**
 * How it works, in three columns. Copy only, matching what packages/core does (README "How it
 * works"): no counts, no provider names, no claim that code makes every decision (AUDIT H-36).
 */
export const HOW_STEPS = [
  {
    id: "predict",
    title: "Predict, then test",
    body: "Every probe commits its prediction before the API is called. When the response disagrees, the mismatch is on the record.",
    wash: "sky",
  },
  {
    id: "challenge",
    title: "Challenge",
    body: "The Reflector explains each mismatch; the Adversary reads the raw records and tries to knock the belief down.",
    wash: "lavender",
  },
  {
    id: "certify",
    title: "Certify & enforce",
    body: "Beliefs that survive become sealed certificates. The Guard lets covered money actions through and holds the rest.",
    wash: "mint",
  },
] as const;

export type HowStepId = (typeof HOW_STEPS)[number]["id"];

export type FeatureKey = "certificates" | "held" | "chat" | "revocation";

export const FEATURES: readonly { key: FeatureKey; n: string; title: string; body: string; wash: string }[] = [
  {
    key: "certificates",
    n: "01",
    title: "Certificates",
    body: "Every belief that survives testing and review becomes a sha256-sealed certificate, with the scope it was tested in and the probes behind it.",
    wash: "lavender",
  },
  {
    key: "held",
    n: "02",
    title: "Held actions",
    body: "A refund that depends on a claim without a certificate waits for a person, evidence attached. Approve or reject it from the dashboard.",
    wash: "peach",
  },
  {
    key: "chat",
    n: "03",
    title: "Notary Chat",
    body: "Ask about a certificate, a run or a held refund. Notary Chat answers from the records, shows every lookup it makes and cites its sources.",
    wash: "mint",
  },
  {
    key: "revocation",
    n: "04",
    title: "Revocation",
    body: "When later evidence contradicts a certificate, Notary revokes it, retires its guards and holds the actions that relied on it.",
    wash: "sky",
  },
];

// --------------------------------------------------------------------------- run pairing

type PairEntry = {
  runId: string;
  kind: string;
  variant: string;
  sample: boolean;
  startedAt: string;
  /** "replay" = re-serves a recorded run: never the landing's showcase or one side of a pair. */
  mode?: string;
};

export type LandingView = {
  /** The development-only fixture view (`?fixtures=1`): fixture runs only. Default: real runs only. */
  fixtures?: boolean;
};

/**
 * The newest naive/guarded queue-run pair of the visible cohort: real runs only, or fixture runs
 * only under `?fixtures=1`. There is no fallback from one cohort to the other: with no real run the
 * pair is empty and the landing says so. The naive side must come from the guarded run's world
 * (same scenario key), so the landing never compares two different worlds.
 */
export function landingResults<T extends PairEntry>(all: readonly T[], view: LandingView = {}) {
  const fixtures = !!view.fixtures;
  const cohort = all
    .filter((b) => b.sample === fixtures && b.kind === "run" && !isReplayRun(b))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const guarded = cohort.find((b) => b.variant === "guarded");
  const naive = guarded
    ? cohort.find((b) => b.variant === "naive" && scenarioKey(b.runId) === scenarioKey(guarded.runId))
    : cohort.find((b) => b.variant === "naive");
  return { sample: fixtures, naive, guarded };
}

/** The fixture naive/guarded pair (the `?fixtures=1` view). */
export function fixturePair<T extends PairEntry>(all: readonly T[]) {
  return landingResults(all, { fixtures: true });
}

/**
 * The pair the Proof section, the hero preview and the feature cards show: the visible cohort's
 * newest pair, possibly incomplete. Never a fixture run in the default view, never one real side
 * and one fixture side. `visible` counts the visible cohort's runs, so the page can tell "nothing
 * yet" from "no complete pair yet".
 */
export function proofPair<T extends PairEntry>(all: readonly T[], view: LandingView = {}) {
  const pair = landingResults(all, view);
  const visible = all.filter((b) => b.sample === !!view.fixtures && !isSyntheticSample(b as { kind?: string; variant?: string })).length;
  return { ...pair, visible };
}

/** The landing's empty state when no run is published: the two commands that record and publish one. */
export const NO_RUNS_YET = {
  title: "No runs yet",
  body: "Notarize a real API, then publish the run. Every number on this page comes from it.",
  commands: ["pnpm notary notarize --tool crustdata", "pnpm notary export"],
} as const;

/**
 * The fixture scenario whose certificate export records a revocation (today: change-api), and one
 * of its source runs (to ask the data layer for that world's certificates). Undefined when no
 * published scenario records one.
 */
export function revocationScenario(index: FixtureIndex | null): { scenario: string; runId: string } | undefined {
  const s = index?.scenarios.find((x) => x.overall.revoked > 0 && x.sourceBundles.length > 0);
  return s ? { scenario: s.scenario, runId: s.sourceBundles[0]! } : undefined;
}

// --------------------------------------------------------------------------- the numbers

/** Request types that move money back to a customer, read from the schema (refund, partial_refund). */
export const REFUND_TYPES: ReadonlySet<string> = new Set(
  RequestTypeSchema.options.filter((t) => t.includes("refund")),
);

export const isRefund = (d: Pick<Decision, "requestType">) => REFUND_TYPES.has(d.requestType);

export type ProofNumbers = {
  /** metrics.unsafe_actions_total of the naive run (null = not computable). */
  naiveUnsafe: number | null;
  /** metrics.unsafe_actions_total of the guarded run. */
  guardedUnsafe: number | null;
  /** Guarded decisions on refund requests whose status is held. */
  refundsHeld: number;
  /** metrics.items_total (queue length) of the guarded run, else its decision count. */
  requests: number;
};

/** The three Proof numbers, straight from the two bundles' records and grader metrics. */
export function proofNumbers(naive: RunBundle, guarded: RunBundle): ProofNumbers {
  return {
    naiveUnsafe: naive.metrics.unsafe_actions_total ?? null,
    guardedUnsafe: guarded.metrics.unsafe_actions_total ?? null,
    refundsHeld: guarded.decisions.filter((d) => d.status === "held" && isRefund(d)).length,
    requests: guarded.metrics.items_total ?? guarded.decisions.length,
  };
}

export type ActionCounts = { executed: number; held: number; unsafe: number };
export type ActionRow = { type: RequestType; label: string; naive: ActionCounts; guarded: ActionCounts };

/**
 * Money actions by request type (schema order), naive vs guarded: decisions whose action is not
 * "none", split into executed and held (held = waited for a person; drawn hatched). `unsafe` =
 * executed decisions the deterministic grader marked unsafe.
 */
export function actionsByType(naive: RunBundle, guarded: RunBundle): ActionRow[] {
  const count = (b: RunBundle, type: RequestType): ActionCounts => {
    const ds = b.decisions.filter((d) => d.requestType === type && d.action !== "none");
    return {
      executed: ds.filter((d) => d.status === "executed").length,
      held: ds.filter((d) => d.status === "held").length,
      unsafe: ds.filter((d) => d.status === "executed" && (d.grade?.unsafe?.length ?? 0) > 0).length,
    };
  };
  return RequestTypeSchema.options.map((type) => ({
    type,
    label: sentence(label(type)),
    naive: count(naive, type),
    guarded: count(guarded, type),
  }));
}

/** The chart's takeaway, summed over request types from the same rows the bars draw. */
export function actionTotals(rows: readonly ActionRow[]) {
  const sum = (pick: (r: ActionRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  return {
    naiveExecuted: sum((r) => r.naive.executed),
    naiveUnsafe: sum((r) => r.naive.unsafe),
    guardedUnsafe: sum((r) => r.guarded.unsafe),
    guardedHeld: sum((r) => r.guarded.held),
  };
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Minor units → "$19.99" (currency from the record). */
export function money(minor: number, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${minor} ${currency} minor units`;
  }
}

/** The guarded run's first held refund decision (by queue order), if any. */
export function firstHeldRefund(guarded: RunBundle): Decision | undefined {
  return guarded.decisions.find((d) => d.status === "held" && isRefund(d));
}

// --------------------------------------------------------------------------- certificates

/** The certificate the Certificates card shows: the active one with the most evidence (ties: report order). */
export function featuredCertificate(world: CertificateWorld): Certificate | undefined {
  const active = world.tools.flatMap((t) => t.certificates).filter((c) => c.status === "active");
  return active.reduce<Certificate | undefined>((best, c) => (!best || c.evidence.length > best.evidence.length ? c : best), undefined);
}

/** The first recorded revocation of a world, with the certificate it revoked. */
export function featuredRevocation(world: CertificateWorld): { revocation: Revocation; certificate?: Certificate } | undefined {
  const revocation = world.tools.flatMap((t) => t.revocations)[0];
  if (!revocation) return undefined;
  const certificate = world.tools.flatMap((t) => t.certificates).find((c) => c.id === revocation.certificateId);
  return { revocation, certificate };
}

// --------------------------------------------------------------------------- chat

/**
 * Questions the landing's chat turn tries, in order: why the guarded run's first held refund was
 * held (with the naive vs guarded comparison, then alone), then what each tool's certificates say.
 * All built from the runs; the first one with a presentable answer is shown.
 */
export function chatQuestions(guarded: RunBundle, tools: readonly string[]): string[] {
  const held = firstHeldRefund(guarded);
  return [
    ...(held
      ? [`Why was ${held.requestId} held, and what changed between the naive and guarded runs?`, `Why was ${held.requestId} held?`]
      : []),
    ...tools.map((t) => `What do the ${t} certificates say?`),
  ];
}

/** Answer markdown → paragraphs, minus the engine's "_Answering from …_" disclosure line. */
export function answerParagraphs(markdown: string): { disclosure?: string; paragraphs: string[] } {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const first = blocks[0];
  // The engine writes it in emphasis: _…_ or *…*.
  const disclosure = first && /^([_*])[^_*\n]+\1$/.test(first) ? first.slice(1, -1) : undefined;
  return { disclosure, paragraphs: disclosure ? blocks.slice(1) : blocks };
}

/** Text clipped at a sentence or word boundary, with an ellipsis when anything was cut. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("] "));
  const at = sentenceEnd > max * 0.5 ? sentenceEnd + 1 : cut.lastIndexOf(" ");
  return `${cut.slice(0, at > 0 ? at : max).trimEnd()}…`;
}

// --------------------------------------------------------------------------- pricing

/**
 * The pricing cards come from public/economics.json (the cfo.ai plan, schema/economics.ts, hash
 * verified in the browser) and only when the imported plan lists exactly three priced tiers.
 * Anything else (no file, a failed check, no plan, another tier count) hides the section: prices
 * are never invented.
 */
export type PricingPlan = {
  name: string;
  price: number;
  currency?: string;
  period: string;
  description?: string;
  features?: string[];
};

export function pricingPlans(raw: unknown): PricingPlan[] | null {
  const state = verifyEconomicsFile(raw);
  if (state.status !== "ready") return null;
  const tiers = state.file.plan?.tiers ?? [];
  if (tiers.length !== 3) return null;
  return tiers.map((t) => ({
    name: t.name,
    price: t.price,
    currency: t.currency,
    period: t.period,
    ...(t.description ? { description: t.description } : {}),
    ...(t.features.length ? { features: t.features.slice(0, 8) } : {}),
  }));
}

/** "$49" from a plan's price (whole units) and currency. */
export function planPrice(plan: PricingPlan): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: plan.currency ?? "USD",
      maximumFractionDigits: Number.isInteger(plan.price) ? 0 : 2,
    }).format(plan.price);
  } catch {
    return `${plan.price} ${plan.currency ?? ""}`.trim();
  }
}

// --------------------------------------------------------------------------- how it works (real records)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const words = (s: string) => s.replaceAll("_", " ");

/** Probe ids carry their run id ("<run>-p004"); the landing shows the short probe id ("p004"). */
export const shortIds = (text: string) => text.replace(/\b[\w.-]*-(p\d{3,})\b/g, "$1");

export type ObservedField = { key: string; value: string; mismatch: boolean };
export type PredictView = {
  probe: string;
  claimId: string;
  template: string;
  committedAt: string;
  /** The outcome the "docs hold" rival predicted. */
  expected: string;
  call?: { op: string; args: string };
  observed: ObservedField[];
};

const classOf = (v: unknown) => (isObj(v) && typeof v.class === "string" ? v.class : undefined);
const outcomeOf = (v: unknown) =>
  isObj(v) && Array.isArray(v.outcomes) && typeof v.outcomes[0] === "string" ? v.outcomes[0] : undefined;

/**
 * "Predict, then test": a probe whose committed "docs hold" prediction was contradicted (the
 * winning hypothesis is a defect; the honored rival predicted another outcome). Fields come from
 * the probe's treatment step and observation; `outcome` is the mismatched field.
 */
export function predictView(bundle: RunBundle): PredictView | undefined {
  const views = bundle.probes.flatMap((p): (PredictView & { rich: boolean })[] => {
    const obs = p.observed;
    if (p.verdict !== "confirmed" || !isObj(obs) || typeof obs.outcome !== "string") return [];
    const honored = Object.entries(p.prediction).find(([, v]) => classOf(v) === "honored");
    const won = p.winningHypothesisId ? p.prediction[p.winningHypothesisId] : undefined;
    const expected = honored ? outcomeOf(honored[1]) : undefined;
    if (!expected || !won || classOf(won) === "honored" || expected === obs.outcome) return [];
    const steps = Array.isArray(p.params.steps) ? (p.params.steps as unknown[]) : [];
    const step = steps.find((x): x is Record<string, unknown> => isObj(x) && typeof x.tag === "string" && isObj(obs[x.tag]));
    const tagged = step ? (obs[step.tag as string] as Record<string, unknown>) : {};
    const fields = Object.entries(tagged).filter(
      ([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean",
    );
    const args = step && isObj(step.params)
      ? Object.entries(step.params)
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
          .join(" ")
      : "";
    return [
      {
        probe: shortIds(p.id),
        claimId: p.claimId,
        template: words(p.template),
        committedAt: p.committedAt,
        expected: words(expected),
        ...(step && typeof step.op === "string" ? { call: { op: step.op, args } } : {}),
        observed: [
          ...fields.map(([k, v]) => ({ key: k === "length" ? "items" : words(k), value: String(v), mismatch: false })),
          { key: "outcome", value: words(obs.outcome), mismatch: true },
        ],
        rich: fields.length > 0 && !!step,
      },
    ];
  });
  const pick = views.find((v) => v.rich) ?? views[0];
  if (!pick) return undefined;
  const { rich: _rich, ...view } = pick;
  return view;
}

/** Commit time as "HH:MM:SS UTC" (UTC, labelled, like the Run transcript and the app's dates). */
export const clockTime = (iso: string) =>
  `${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(
    new Date(iso),
  )} UTC`;

export type ChallengeView = {
  claimId: string;
  /** The Reflector's hypothesis behind the certified side, when the source bundles carry it. */
  hypothesis?: string;
  /** The Adversary's review as recorded (probe ids shortened). */
  counter: string;
  verdict: "uphold" | "narrow" | "downgrade";
  /** Adversary reviews recorded for the belief, and how many it survived (upheld). */
  challenges: number;
  survived: number;
};

/**
 * "Challenge": a certificate the Adversary reviewed (an upheld one that contradicts the docs
 * first), the Reflector hypothesis behind its evidence probes, and the review count from the
 * belief events.
 */
export function challengeView(world: CertificateWorld, sources: readonly RunBundle[]): ChallengeView | undefined {
  const probes = new Map(sources.flatMap((b) => b.probes.map((p) => [p.id, p] as const)));
  const hyps = sources.flatMap((b) => b.hypotheses);
  const anomalies = sources.flatMap((b) => b.anomalies);
  // Code-built verification rivals say so in their statement; only model-proposed ones are the Reflector's.
  const byReflector = (statement: string) => !/not model-proposed|^verification rival/i.test(statement);
  const reflectorHypothesis = (c: Certificate) => {
    const winners = new Set(c.evidence.map((e) => probes.get(e.probeId)?.winningHypothesisId).filter(Boolean));
    const anomalyIds = new Set(anomalies.filter((a) => a.claimId === c.claimId).map((a) => a.id));
    const forClaim = hyps.filter((h) => winners.has(h.id) || anomalyIds.has(h.anomalyId));
    const winnerClass = hyps.find((h) => winners.has(h.id))?.class;
    return (
      forClaim.find((h) => winners.has(h.id) && byReflector(h.statement)) ??
      forClaim.find((h) => h.class === winnerClass && byReflector(h.statement)) ??
      forClaim.find((h) => h.class !== "honored" && byReflector(h.statement))
    )?.statement;
  };
  const candidates = world.tools
    .flatMap((t) => t.certificates)
    .filter((c) => c.adversary)
    .map((c) => ({ c, hypothesis: reflectorHypothesis(c) }));
  const rank = ({ c, hypothesis }: (typeof candidates)[number]) =>
    (c.adversary!.verdict === "uphold" ? 0 : 4) + (hypothesis ? 0 : 2) + (c.verdictKind === "contradicts_docs" ? 0 : 1);
  const pick = [...candidates].sort((a, b) => rank(a) - rank(b))[0];
  const adv = pick?.c.adversary;
  if (!pick || !adv) return undefined;
  const { c, hypothesis } = pick;
  const reviews = sources
    .flatMap((b) => b.beliefEvents)
    .filter((e) => e.beliefId === c.beliefId && /^adversary\b/i.test(e.reason));
  const challenges = Math.max(1, reviews.length);
  return {
    claimId: c.claimId,
    ...(hypothesis ? { hypothesis: shortIds(hypothesis) } : {}),
    counter: shortIds(adv.reason),
    verdict: adv.verdict,
    challenges,
    survived: adv.verdict === "uphold" ? challenges : 0,
  };
}

export type GuardRow = { title: string; action: string; outcome: "allowed" | "held" };
export type CertifyView = {
  certificateId: string;
  claimId: string;
  scope: string;
  evidence: number;
  issuedAt: string;
  rows: GuardRow[];
};

/**
 * "Certify & enforce": the featured certificate, then two of the guarded run's real decisions:
 * an executed money action (a refund when one exists) and a held refund.
 */
export function certifyView(world: CertificateWorld, guarded: RunBundle): CertifyView | undefined {
  const c = featuredCertificate(world);
  if (!c) return undefined;
  const money = guarded.decisions.filter((d) => d.action !== "none");
  const allowed = money.find((d) => d.status === "executed" && isRefund(d)) ?? money.find((d) => d.status === "executed");
  const held = firstHeldRefund(guarded) ?? money.find((d) => d.status === "held");
  const row = (d: Decision, outcome: GuardRow["outcome"]): GuardRow => ({
    title: `${sentence(label(d.requestType))} ${d.requestId}`,
    action: d.action,
    outcome,
  });
  return {
    certificateId: c.id,
    claimId: c.claimId,
    scope: c.scope.text,
    evidence: c.evidence.length,
    issuedAt: c.issuedAt,
    rows: [...(allowed ? [row(allowed, "allowed")] : []), ...(held ? [row(held, "held")] : [])],
  };
}

/** Notarize runs of the guarded run's world (same sample flag and, for simulated worlds, the same scenario). */
export function worldNotarizeRuns<T extends PairEntry>(all: readonly T[], guarded: T): T[] {
  return all.filter(
    (b) =>
      b.kind === "notarize" &&
      !isReplayRun(b) &&
      b.sample === guarded.sample &&
      (!guarded.sample || scenarioKey(b.runId) === scenarioKey(guarded.runId)),
  );
}

// --------------------------------------------------------------------------- copy rules

/**
 * Words the landing never shows (it is a product site, not a sandbox). The footer line ("Built for
 * neatHack 2026") and the evaluation-suite link are the only allowed occurrences; test/landing.test.ts
 * greps the landing's copy for them and data-derived text is filtered with `showable`.
 */
export const BANNED_WORDS = [
  "demo",
  "fixture",
  "replay",
  "recorded",
  "mock",
  "sample",
  "simulated",
  "test mode",
  "placeholder",
  "hackathon",
] as const;

export const BANNED_RE = new RegExp(BANNED_WORDS.map((w) => w.replace(" ", "[\\s-]+")).join("|"), "i");

/** True when a data-derived string may be shown on the landing. */
export const showable = (text: string) => !BANNED_RE.test(text);

/** The one footnote under the stats: the suite and its disclosure live in docs/EVALUATION.md. */
export const EVALUATION_URL = `${GITHUB_URL}/blob/main/docs/EVALUATION.md#evaluation-suite`;

/**
 * The small tag on a frame that renders the published evaluation-suite runs (the data layer's
 * fixture bundles, `sample: true`). Shown only when the rendered bundle is one; real runs carry no
 * tag. It is the landing's data-driven fixture disclosure, worded for a product site.
 */
export const EVALUATION_TAG = "Evaluation suite";

/** "See it work": an optional video (VITE_NOTARY_VIDEO_URL, http(s) only), else the How it works section. */
export function seeItWorkHref(videoUrl: string | undefined): { href: string; external: boolean } {
  const v = videoUrl?.trim();
  return v && /^https?:\/\//i.test(v) ? { href: v, external: true } : { href: "#how", external: false };
}
