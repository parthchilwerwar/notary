// Data for the landing page (`/`). Every number the landing shows is derived here from a
// published, verified data file: run bundles (hash-checked by data.ts), timeline files (tied to
// their bundle by bundleHash), certificate reports (schema + seals checked by state/certificates)
// and evidence.json. Nothing here is typed by hand.
import { z } from "zod";
import { TimelineFileSchema } from "../../core/src/schema";
import type {
  Decision,
  Effect,
  RunBundle,
  TimelineEvent,
  TimelineFile,
  TimelineStage,
} from "../../core/src/schema";
import { readOptionalJSON } from "./optional-json";

export const evidenceSchema = z.array(
  z.object({
    name: z.string(),
    purpose: z.string(),
    status: z.enum(["live", "pending"]),
    links: z.array(z.object({ label: z.string(), url: z.string() })),
    notes: z.string().optional(),
  }),
);
export async function loadEvidence(signal?: AbortSignal) {
  const r = await fetch(`${import.meta.env.BASE_URL}evidence/evidence.json`, {
    signal,
    cache: "no-store",
  });
  if (
    r.status === 404 ||
    (r.ok && !r.headers.get("content-type")?.includes("json"))
  )
    return [];
  if (!r.ok) throw new Error("Tool evidence could not be loaded.");
  let raw: unknown;
  try {
    raw = await r.json();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error("evidence/evidence.json is not valid JSON. Data withheld.");
  }
  const parsed = evidenceSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "evidence/evidence.json does not match the evidence schema. Data withheld.",
    );
  return parsed.data;
}

/** The three sponsor tools the hackathon requires (hackathon.md; core export/evidence.ts). */
export const REQUIRED_TOOLS = ["neatlogs", "Entire", "cfo.ai"] as const;

export function landingResults(all: RunBundle[]) {
  const live = all.some((b) => !b.sample);
  const cohort = all
    .filter((b) => b.sample !== live && b.kind === "run")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    sample: !live,
    naive: cohort.find((b) => b.variant === "naive"),
    guarded: cohort.find((b) => b.variant === "guarded"),
  };
}

/** The fixture naive/guarded pair, regardless of live data (the problem section is fixture-only). */
export function fixturePair(all: RunBundle[]) {
  return landingResults(all.filter((b) => b.sample));
}

/** Real (non-sample) bundles: the only source of "recorded" results. */
export function realRuns(all: RunBundle[]) {
  const real = all.filter((b) => !b.sample);
  return {
    total: real.length,
    queueRuns: real.filter((b) => b.kind === "run").length,
    notarizeRuns: real.filter((b) => b.kind === "notarize").length,
  };
}

// ------------------------------------------------------------- the double-refund problem

export type WriteAttempt = {
  at: string;
  /** HTTP status; null = outcome unknown (client timeout). */
  status: number | null;
  amount?: number;
  currency?: string;
  resultId?: string;
};

export type Incident = {
  requestId: string;
  action: string;
  naive: {
    decisionId: string;
    status: Decision["status"];
    attempts: WriteAttempt[];
    /** Writes that reached the API with a 2xx or an unknown outcome. */
    writes: number;
    /** Sum of items[].amount sent, when the write carried line items. */
    requestedAmount?: number;
  };
  guarded?: {
    runId: string;
    decisionId: string;
    status: Decision["status"];
    missingBeliefs: string[];
    guardsApplied: string[];
    writes: number;
  };
};

const attemptsOf = (d: Decision): Effect[] =>
  d.effects.filter((e) => e.op === d.action);

const isWrite = (e: Effect) =>
  e.status === null || (e.status >= 200 && e.status < 300);

function requestedItemsAmount(e: Effect | undefined): number | undefined {
  const items = e?.params.items;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  let sum = 0;
  for (const item of items) {
    const amount = (item as { amount?: unknown }).amount;
    if (typeof amount !== "number") return undefined;
    sum += amount;
  }
  return sum;
}

function incidentFor(
  d: Decision,
  guarded: RunBundle | undefined,
): Incident {
  const attempts = attemptsOf(d);
  const counterpart = guarded?.decisions.find(
    (g) => g.requestId === d.requestId,
  );
  return {
    requestId: d.requestId,
    action: d.action,
    naive: {
      decisionId: d.id,
      status: d.status,
      attempts: attempts.map((e) => ({
        at: e.at,
        status: e.status,
        ...(e.amount !== undefined ? { amount: e.amount } : {}),
        ...(e.currency ? { currency: e.currency } : {}),
        ...(e.resultId ? { resultId: e.resultId } : {}),
      })),
      writes: attempts.filter(isWrite).length,
      ...(requestedItemsAmount(attempts[0]) !== undefined
        ? { requestedAmount: requestedItemsAmount(attempts[0]) }
        : {}),
    },
    ...(counterpart
      ? {
          guarded: {
            runId: guarded!.runId,
            decisionId: counterpart.id,
            status: counterpart.status,
            missingBeliefs: counterpart.missingBeliefs,
            guardsApplied: counterpart.guardsApplied,
            writes: attemptsOf(counterpart).filter(isWrite).length,
          },
        }
      : {}),
  };
}

/**
 * The first graded-unsafe decision of `kind` in the naive run, with the same request in the
 * guarded run. Prefers a decision whose write attempts show the problem (two writes for a
 * duplicate, line items for a wrong unit).
 */
export function findIncident(
  kind: "duplicate" | "wrong_unit",
  naive: RunBundle | undefined,
  guarded: RunBundle | undefined,
): Incident | undefined {
  if (!naive) return undefined;
  const unsafe = naive.decisions.filter((d) => d.grade?.unsafe.includes(kind));
  const telling = unsafe.find((d) =>
    kind === "duplicate"
      ? attemptsOf(d).filter(isWrite).length > 1
      : requestedItemsAmount(attemptsOf(d)[0]) !== undefined,
  );
  const chosen = telling ?? unsafe[0];
  return chosen ? incidentFor(chosen, guarded) : undefined;
}

/** Unsafe money actions by kind, from the bundle's metrics (null = not computable). */
export function unsafeBreakdown(b: RunBundle | undefined) {
  if (!b) return undefined;
  return {
    total: b.metrics.unsafe_actions_total ?? null,
    duplicates: b.metrics.unsafe_duplicates ?? null,
    wrongUnit: b.metrics.unsafe_wrong_unit ?? null,
    missedExisting: b.metrics.unsafe_missed_existing_refund ?? null,
    executed: b.metrics.executed ?? null,
    held: b.metrics.holds ?? null,
  };
}

/** Minor units → "$99.00" (currency from the effect; minor units per the bundle schema). */
export function money(minor: number, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(minor / 100);
  } catch {
    return `${minor} ${currency} minor units`;
  }
}

// --------------------------------------------------------------- mission control replay

export const STAGES: TimelineStage[] = [
  "read",
  "test",
  "challenge",
  "certify",
  "enforce",
];

export const STAGE_LABEL: Record<TimelineStage, string> = {
  read: "Read",
  test: "Test",
  challenge: "Challenge",
  certify: "Certify",
  enforce: "Enforce",
};

/**
 * The runs the landing replays, in order: one fixture world's notarize runs (oldest first), then
 * its guarded queue run. The world is the guarded fixture run's scenario (scenarioKey prefix).
 */
export function replayRunIds(all: RunBundle[]): string[] {
  const guarded = fixturePair(all).guarded;
  if (!guarded) return [];
  const world = guarded.runId.replace(/-(run|notarize)-[a-z]+$/, "");
  const notarize = all
    .filter(
      (b) =>
        b.sample &&
        b.kind === "notarize" &&
        b.runId.replace(/-(run|notarize)-[a-z]+$/, "") === world,
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return [...notarize.map((b) => b.runId), guarded.runId];
}

/**
 * Parse a published timeline and tie it to its verified bundle: same run, fixture only, the
 * bundle's content hash, strictly increasing seq. Throws (data withheld) otherwise.
 */
export function verifyTimeline(raw: unknown, bundle: RunBundle): TimelineFile {
  const parsed = TimelineFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `The timeline for ${bundle.runId} does not match the shared schema. Replay withheld.`,
    );
  const file = parsed.data;
  if (file.runId !== bundle.runId || file.sample !== bundle.sample)
    throw new Error(
      `The timeline for ${bundle.runId} belongs to a different run. Replay withheld.`,
    );
  if (!file.sample)
    throw new Error("The landing replay plays fixture timelines only.");
  if (file.bundleHash !== bundle.contentHash)
    throw new Error(
      `The timeline for ${bundle.runId} does not match its bundle's content hash. Replay withheld.`,
    );
  file.events.forEach((e, i) => {
    if (e.runId !== bundle.runId || (i > 0 && e.seq <= file.events[i - 1]!.seq))
      throw new Error(
        `The timeline for ${bundle.runId} is out of order. Replay withheld.`,
      );
  });
  return file;
}

export async function loadReplay(
  all: RunBundle[],
  signal?: AbortSignal,
): Promise<TimelineFile[]> {
  const ids = replayRunIds(all);
  const files = await Promise.all(
    ids.map(async (runId) => {
      const bundle = all.find((b) => b.runId === runId)!;
      const raw = await readOptionalJSON(
        `bundles/fixture/${encodeURIComponent(runId)}.timeline.json`,
        signal,
      );
      return raw === undefined ? undefined : verifyTimeline(raw, bundle);
    }),
  );
  return files.filter((f): f is TimelineFile => !!f);
}

/** All events of the replayed runs, in play order. */
export function replayEvents(files: TimelineFile[]): TimelineEvent[] {
  return files.flatMap((f) => f.events);
}

/** Events per stage among the first `cursor` events (the replay's position). */
export function stageCounts(
  events: TimelineEvent[],
  cursor: number = events.length,
): Record<TimelineStage, number> {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<
    TimelineStage,
    number
  >;
  for (const e of events.slice(0, Math.max(0, cursor))) counts[e.stage] += 1;
  return counts;
}

/** Counts of selected event types among the first `cursor` events. */
export function typeCounts(events: TimelineEvent[], cursor: number) {
  const out = {
    certificatesIssued: 0,
    certificatesRevoked: 0,
    held: 0,
    executed: 0,
  };
  for (const e of events.slice(0, Math.max(0, cursor))) {
    if (e.type === "certificate.issued") out.certificatesIssued += 1;
    if (e.type === "certificate.revoked") out.certificatesRevoked += 1;
    if (e.type === "decision") {
      if (e.data?.status === "held") out.held += 1;
      if (e.data?.status === "executed") out.executed += 1;
    }
  }
  return out;
}
