// Data for the landing page (`/`). Every number the landing shows is derived here from data the
// data layer (src/data) verified: run bundles (hash-checked) and timelines (tied to their bundle
// by bundleHash). Nothing here fetches and no result is typed by hand. The only literals are copy
// (step sentences, the "Built with" credits) and the repository URL.
import { RequestTypeSchema, TimelineStageSchema } from "../../core/src/schema";
import type { Decision, RunBundle, TimelineEvent, TimelineStage } from "../../core/src/schema";
import { scenarioKey } from "./data";

/** The repository, linked from the hero and the footer (one site-wide constant, AUDIT H-44). */
export { GITHUB_URL } from "./lib/site";

/** Credits line ("Built with"). Text only. Presentation, not data: no status is claimed. */
export const BUILT_WITH = ["neatlogs", "Entire", "cfo.ai", "Crustdata", "Dodo Payments", "AWS Bedrock"] as const;

/** The Run page for one run (the dashboard reads `?run=`). */
export const runHref = (runId: string) => `/app/run?run=${encodeURIComponent(runId)}`;

// --------------------------------------------------------------------------- the five steps

/** Stage names from the timeline schema, so the steps can't drift from the records (AUDIT H-42). */
export const STAGES: readonly TimelineStage[] = TimelineStageSchema.options;

export const STAGE_LABEL = Object.fromEntries(
  STAGES.map((s) => [s, s.charAt(0).toUpperCase() + s.slice(1)]),
) as Record<TimelineStage, string>;

/**
 * One sentence per stage, matching what packages/core does (README "How it works"). Copy only:
 * no counts, no provider names, no claim that code makes every decision (AUDIT H-36).
 */
export const STEP_COPY: Record<TimelineStage, string> = {
  read: "Turns each API's documentation into checkable claims, then a deterministic checker compares recorded responses with them and flags every mismatch.",
  test: "A model proposes rival explanations for each mismatch; each probe's prediction is committed before the API is called, and fixed rules turn the verdicts into a belief per claim.",
  challenge: "A separate reviewer model reads only the raw probe records and tries to knock each belief down: uphold it, narrow its scope or downgrade it.",
  certify: "Beliefs that survive become sha256-sealed certificates with a scope and their evidence, and later contrary evidence revokes them.",
  enforce: "Guards built from the certificates wrap every API call, and a money action missing a certificate it depends on is held for a person, with its evidence.",
};

// --------------------------------------------------------------------------- run pairing

type PairEntry = {
  runId: string;
  kind: string;
  variant: string;
  sample: boolean;
  startedAt: string;
};

/**
 * The newest naive/guarded queue-run pair. Real runs win over fixtures; a missing real side is
 * never filled with a fixture run, and the naive side must come from the guarded run's world
 * (same scenario key), so the landing never compares two different simulated worlds.
 */
export function landingResults<T extends PairEntry>(all: readonly T[]) {
  const live = all.some((b) => !b.sample);
  const cohort = all
    .filter((b) => b.sample !== live && b.kind === "run")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const guarded = cohort.find((b) => b.variant === "guarded");
  const naive = guarded
    ? cohort.find((b) => b.variant === "naive" && scenarioKey(b.runId) === scenarioKey(guarded.runId))
    : cohort.find((b) => b.variant === "naive");
  return { sample: !live, naive, guarded };
}

/** The fixture naive/guarded pair, regardless of real runs. */
export function fixturePair<T extends PairEntry>(all: readonly T[]) {
  return landingResults(all.filter((b) => b.sample));
}

/**
 * The pair the Proof section shows: the newest complete pair. When real runs exist but no
 * complete real pair does, it shows the fixture pair instead (labelled as fixture, with the
 * reason) rather than half a comparison. Never one real side and one fixture side.
 */
export function proofPair<T extends PairEntry>(all: readonly T[]) {
  const first = landingResults(all);
  if (first.naive && first.guarded) return { ...first, note: undefined };
  if (first.sample) return { ...first, note: undefined };
  const fixture = fixturePair(all);
  return {
    ...fixture,
    note: "No complete recorded naive and guarded pair yet, so this shows the fixture pair.",
  };
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

/** Minor units → "$19.99" (currency from the record). */
export function money(minor: number, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${minor} ${currency} minor units`;
  }
}

// --------------------------------------------------------------------------- the excerpt

/**
 * The notarize runs whose timelines can explain the guarded run's holds: same data world
 * (`sample` flag), started before it, and for fixtures the same simulated world (scenario key).
 * Oldest first.
 */
export function sourceRuns<T extends PairEntry>(all: readonly T[], guarded: T): T[] {
  return all
    .filter(
      (b) =>
        b.kind === "notarize" &&
        b.sample === guarded.sample &&
        b.startedAt <= guarded.startedAt &&
        (!guarded.sample || scenarioKey(b.runId) === scenarioKey(guarded.runId)),
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export type ExcerptRow = {
  key: string;
  runId: string;
  seq: number;
  stage: TimelineStage;
  type: TimelineEvent["type"];
  summary: string;
};

export type HeldCard = {
  runId: string;
  decisionId: string;
  requestId: string;
  requestType: string;
  action: string;
  amount?: number;
  currency?: string;
  missingBeliefs: string[];
  reason?: string;
};

export type Excerpt = { rows: ExcerptRow[]; held: HeldCard; sample: boolean };

const rowOf = (e: TimelineEvent): ExcerptRow => ({
  key: `${e.runId}#${e.seq}`,
  runId: e.runId,
  seq: e.seq,
  stage: e.stage,
  type: e.type,
  summary: e.summary,
});

/**
 * A short story from published timelines, ending on a held refund:
 *   the guarded run's first held refund decision, its first missing belief, and from the source
 *   notarize runs the events about that belief's claim: the first anomaly, the first probe
 *   committed, the first verdict, the adversary's verdict, and the belief's last change.
 * Every row is a recorded event (summary generated by code), in recorded order. Returns
 * undefined when the guarded run held no refund.
 */
export function buildExcerpt(
  guarded: RunBundle,
  guardedEvents: readonly TimelineEvent[],
  sources: readonly { runId: string; events: readonly TimelineEvent[] }[],
): Excerpt | undefined {
  const heldEvent = guardedEvents.find(
    (e) =>
      e.type === "decision" &&
      e.data?.status === "held" &&
      typeof e.data?.requestType === "string" &&
      REFUND_TYPES.has(e.data.requestType),
  );
  const decision = heldEvent && guarded.decisions.find((d) => heldEvent.recordIds.includes(d.id));
  if (!heldEvent || !decision) return undefined;

  const held: HeldCard = {
    runId: guarded.runId,
    decisionId: decision.id,
    requestId: decision.requestId,
    requestType: decision.requestType,
    action: decision.action,
    ...(typeof heldEvent.data?.amount === "number" ? { amount: heldEvent.data.amount } : {}),
    ...(typeof heldEvent.data?.currency === "string" ? { currency: heldEvent.data.currency } : {}),
    missingBeliefs: decision.missingBeliefs,
    ...(decision.evidencePack?.reason ? { reason: decision.evidencePack.reason } : {}),
  };

  const belief = decision.missingBeliefs[0];
  const events = sources.flatMap((s) => s.events);
  const claim =
    belief &&
    events.find((e) => e.type === "belief.changed" && e.data?.beliefId === belief && typeof e.data?.claimId === "string")
      ?.data?.claimId;
  const about = (e: TimelineEvent) =>
    (!!belief && e.recordIds.includes(belief)) ||
    (typeof claim === "string" && (e.data?.claimId === claim || e.recordIds.includes(claim)));
  const related = events.filter(about);
  const first = (type: TimelineEvent["type"]) => related.find((e) => e.type === type);
  const last = (type: TimelineEvent["type"]) => related.filter((e) => e.type === type).at(-1);
  const picked = [
    first("anomaly.detected"),
    first("probe.committed"),
    first("probe.verdict"),
    first("adversary.verdict"),
    last("certificate.revoked") ?? last("certificate.issued"),
    last("belief.changed"),
  ].filter((e): e is TimelineEvent => !!e);
  // Recorded order: by source run (oldest first), then seq.
  const order = new Map(sources.map((s, i) => [s.runId, i]));
  picked.sort((a, b) => (order.get(a.runId)! - order.get(b.runId)!) || a.seq - b.seq);

  return { rows: [...picked.map(rowOf), rowOf(heldEvent)], held, sample: guarded.sample };
}
