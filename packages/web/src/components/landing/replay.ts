// The replay data the landing's showcase pieces render (hero mockup, feature mini-cards, chat):
// always the published, hash-verified files through the data layer's ReplaySource, so a live
// local server never changes what the marketing page shows. When the page already replays, its
// own source is reused (same cache, nothing fetched or hashed twice).
//
// Every cache here is keyed by (source, view): the view is the development-only fixture flag
// (`?fixtures=1`), re-read on every call. The landing's JS module stays loaded across client-side
// navigation (/?fixtures=1 → /app → /), so a cache keyed by the source alone would show fixture
// data in the real view (or real data in the fixture view). Never both: each view has its own entry.
import type { BundleIndexEntry, RunBundle } from "../../../../core/src/schema";
import { finishedEntries, ReplaySource, type DataSource } from "../../data";
import { proofPair } from "../../landing-data";
import { fixturesInLocation, isReplayRun, isSyntheticSample } from "../../app/links";

/** One fallback source per view (used when the page's own source is live). */
const fallbacks = new Map<boolean, ReplaySource>();

export function replayFor(source: DataSource, fixtures: boolean = fixturesInLocation()): ReplaySource {
  if (source instanceof ReplaySource) return source;
  let r = fallbacks.get(fixtures);
  if (!r) {
    r = new ReplaySource();
    fallbacks.set(fixtures, r);
  }
  return r;
}

/**
 * Memoize a landing loader per (source, view). The flag is read when the loader is called (never
 * captured at module load), and a failed load is forgotten so the next call retries.
 */
export function memoByView<T>(fn: (r: ReplaySource, fixtures: boolean) => Promise<T>) {
  const cache = new WeakMap<ReplaySource, Map<boolean, Promise<T>>>();
  return (r: ReplaySource, fixtures: boolean = fixturesInLocation()): Promise<T> => {
    let byView = cache.get(r);
    if (!byView) {
      byView = new Map();
      cache.set(r, byView);
    }
    let p = byView.get(fixtures);
    if (!p) {
      p = fn(r, fixtures);
      const views = byView;
      p.catch(() => views.delete(fixtures));
      byView.set(fixtures, p);
    }
    return p;
  };
}

export type ReplayPair = {
  entries: BundleIndexEntry[];
  naive?: RunBundle;
  guarded?: RunBundle;
  /**
   * The run the showcase pieces render (hero preview, certificate card, chat, how-it-works): the
   * guarded queue run when there is one, else the visible LIVE run that probed the most (newest on
   * a tie). Never a replay: a replay re-serves an older run's cassettes. Undefined only when no
   * visible live run probed anything.
   */
  preview?: RunBundle;
  sample: boolean;
};

/**
 * The visible live runs (never replays, never the synthetic sample) that may be the showcase, in
 * the order they are checked: newest first, so the newest wins a tie on probes.
 */
export function previewCandidates(entries: readonly BundleIndexEntry[], fixtures: boolean): BundleIndexEntry[] {
  return entries
    .filter((e) => e.sample === fixtures && !isReplayRun(e) && !isSyntheticSample(e))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** The bundle with the most probes (the first one on a tie); undefined when none probed anything. */
export function mostProbed(bundles: readonly RunBundle[]): RunBundle | undefined {
  return bundles.reduce<RunBundle | undefined>((best, b) => (b.probes.length > (best?.probes.length ?? 0) ? b : best), undefined);
}

/**
 * The same pair the Proof section would pick, from the published files (memoized per source and
 * view): real runs only, or fixture runs only under the development-only ?fixtures=1. Empty when
 * none exist. Only that view's bundles are fetched.
 */
export const replayPair = memoByView<ReplayPair>(async (replay, fixtures) => {
  const entries = finishedEntries(await replay.listRuns());
  const pair = proofPair(entries, { fixtures });
  const guarded = pair.guarded ? await replay.getRun(pair.guarded.runId) : undefined;
  const naive = pair.naive ? await replay.getRun(pair.naive.runId) : undefined;
  // Fetched in parallel; each bundle's hash check still runs in its own task as its response lands.
  const preview = guarded ?? mostProbed(await Promise.all(previewCandidates(entries, fixtures).map((e) => replay.getRun(e.runId))));
  return { entries, naive, guarded, preview, sample: pair.sample };
});

/** The hero preview's data: the showcase run and its verified timeline (null when there is none). */
export const previewData = memoByView<{ bundle: RunBundle; events: Awaited<ReturnType<ReplaySource["getTimeline"]>> } | null>(
  async (replay, fixtures) => {
    const { preview } = await replayPair(replay, fixtures);
    return preview ? { bundle: preview, events: await replay.getTimeline(preview.runId) } : null;
  },
);
