// The replay data the landing's showcase pieces render (hero mockup, feature mini-cards, chat):
// always the published, hash-verified files through the data layer's ReplaySource, so a live
// local server never changes what the marketing page shows. When the page already replays, its
// own source is reused (same cache, nothing fetched or hashed twice).
import type { BundleIndexEntry, RunBundle } from "../../../../core/src/schema";
import { finishedEntries, ReplaySource, type DataSource } from "../../data";
import { proofPair } from "../../landing-data";

let fallback: ReplaySource | undefined;

export function replayFor(source: DataSource): ReplaySource {
  if (source instanceof ReplaySource) return source;
  return (fallback ??= new ReplaySource());
}

export type ReplayPair = {
  entries: BundleIndexEntry[];
  naive?: RunBundle;
  guarded?: RunBundle;
  sample: boolean;
};

const pairs = new WeakMap<ReplaySource, Promise<ReplayPair>>();

/** The same pair the Proof section would pick, from the published files (memoized per source). */
export function replayPair(replay: ReplaySource): Promise<ReplayPair> {
  let p = pairs.get(replay);
  if (!p) {
    p = (async () => {
      const entries = finishedEntries(await replay.listRuns());
      const pair = proofPair(entries);
      const guarded = pair.guarded ? await replay.getRun(pair.guarded.runId) : undefined;
      const naive = pair.naive ? await replay.getRun(pair.naive.runId) : undefined;
      return { entries, naive, guarded, sample: pair.sample };
    })();
    p.catch(() => pairs.delete(replay));
    pairs.set(replay, p);
  }
  return p;
}
