// The replay data the landing's showcase pieces render (hero mockup, feature mini-cards, chat):
// always the published, hash-verified files through the data layer's ReplaySource, so a live
// local server never changes what the marketing page shows. When the page already replays, its
// own source is reused (same cache, nothing fetched or hashed twice).
import type { BundleIndexEntry, RunBundle } from "../../../../core/src/schema";
import { finishedEntries, ReplaySource, type DataSource } from "../../data";
import { proofPair } from "../../landing-data";
import { fixturesInLocation } from "../../app/links";

let fallback: ReplaySource | undefined;

export function replayFor(source: DataSource): ReplaySource {
  if (source instanceof ReplaySource) return source;
  return (fallback ??= new ReplaySource());
}

export type ReplayPair = {
  entries: BundleIndexEntry[];
  naive?: RunBundle;
  guarded?: RunBundle;
  /**
   * The run the showcase pieces render (hero preview, certificate card, chat, how-it-works): the
   * guarded queue run when there is one, else the newest visible notarize run that probed
   * something (its certificate world is the same). Undefined only when no visible run exists.
   */
  preview?: RunBundle;
  sample: boolean;
};

const pairs = new WeakMap<ReplaySource, Promise<ReplayPair>>();

/**
 * The same pair the Proof section would pick, from the published files (memoized per source): real
 * runs only, or fixture runs only under the development-only ?fixtures=1. Empty when none exist.
 */
export function replayPair(replay: ReplaySource): Promise<ReplayPair> {
  let p = pairs.get(replay);
  if (!p) {
    p = (async () => {
      const entries = finishedEntries(await replay.listRuns());
      const pair = proofPair(entries, { fixtures: fixturesInLocation() });
      const guarded = pair.guarded ? await replay.getRun(pair.guarded.runId) : undefined;
      const naive = pair.naive ? await replay.getRun(pair.naive.runId) : undefined;
      let preview = guarded;
      if (!preview) {
        const notarize = entries
          .filter((e) => e.sample === pair.sample && e.kind === "notarize")
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        for (const e of notarize) {
          const b = await replay.getRun(e.runId);
          if (b.probes.length > 0) {
            preview = b;
            break;
          }
        }
      }
      return { entries, naive, guarded, preview, sample: pair.sample };
    })();
    p.catch(() => pairs.delete(replay));
    pairs.set(replay, p);
  }
  return p;
}
