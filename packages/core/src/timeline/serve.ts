/**
 * GET /api/bundles/:id/timeline (src/api/server.ts): the run's timeline as a TimelineFile.
 *
 * Source, first match wins:
 *   1. runs/<id>/timeline.jsonl — the source of truth (includes approvals appended after the run);
 *      sample/bundleHash from runs/<id>/index.json's entry for <id>, else the served index entry
 *   2. <dir of the indexed bundle>/<id>.timeline.json — a published TimelineFile; must match the
 *      indexed bundle (same runId, sample flag and bundleHash = contentHash), else it is not served
 * null when neither exists. Only paths built from a SAFE_RUN_ID-checked id inside known dirs are read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BundleIndexSchema } from "../schema/bundle.js";
import type { BundleIndexEntry } from "../schema/index.js";
import { TimelineFileSchema } from "../schema/timeline.js";
import type { TimelineFile } from "../schema/timeline.js";
import { readTimeline, timelinePath } from "./store.js";
import { publishedTimelineName } from "./write.js";

export type ServedTimeline = { ok: true; file: TimelineFile } | { ok: false; status: 404 | 500; error: string };

function runIndexEntry(runDir: string, id: string): BundleIndexEntry | undefined {
  const p = join(runDir, "index.json");
  if (!existsSync(p)) return undefined;
  try {
    const parsed = BundleIndexSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success ? parsed.data.find((e) => e.runId === id) : undefined;
  } catch {
    return undefined;
  }
}

export function servedTimeline(opts: { id: string; entry: BundleIndexEntry; dir: string; runsDir: string | null }): ServedTimeline {
  const { id, entry, dir } = opts;
  const runDir = opts.runsDir === null ? null : join(opts.runsDir, id);
  if (runDir && existsSync(timelinePath(runDir))) {
    try {
      const own = runIndexEntry(runDir, id) ?? entry;
      const file = TimelineFileSchema.parse({ runId: id, sample: own.sample, bundleHash: own.contentHash, events: readTimeline(runDir) });
      return { ok: true, file };
    } catch (err) {
      return { ok: false, status: 500, error: `timeline for ${id} is invalid: ${(err as Error).message}` };
    }
  }
  const published = join(dir, publishedTimelineName(id));
  if (existsSync(published)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(published, "utf8"));
    } catch (err) {
      return { ok: false, status: 500, error: `timeline for ${id} is not valid JSON: ${(err as Error).message}` };
    }
    const parsed = TimelineFileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, status: 500, error: `timeline for ${id} fails the timeline schema` };
    const f = parsed.data;
    if (f.runId !== id || f.sample !== entry.sample || f.bundleHash !== entry.contentHash) {
      return { ok: false, status: 500, error: `timeline for ${id} does not belong to the indexed bundle (runId, sample or bundleHash differ)` };
    }
    return { ok: true, file: f };
  }
  return { ok: false, status: 404, error: `no timeline for bundle ${id}` };
}
